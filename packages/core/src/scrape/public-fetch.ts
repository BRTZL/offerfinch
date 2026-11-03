import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";

import { isPrivateAddress } from "../sources/link";

/**
 * Fetching a page a user linked, without reaching this Mac or a private network (no SSRF). Every
 * connection's host name is resolved once, here; if any address it resolves to is private the
 * request is refused, otherwise the connection is made to that same address (pinned), so a name
 * that answers differently a moment later (DNS rebinding) cannot redirect it. Redirects are
 * followed one hop at a time, each hop checked the same way. Only GET and HEAD.
 */

export interface DestinationPolicy {
	/** Every address a host name resolves to. */
	lookup(host: string): Promise<string[]>;
	/** May a connection go to this address? */
	allowAddress(address: string): boolean;
}

/** The default: public addresses only (not loopback, private, link-local, CGNAT, mapped, …). */
export function publicOnly(
	lookup: DestinationPolicy["lookup"],
): DestinationPolicy {
	return { lookup, allowAddress: (address) => !isPrivateAddress(address) };
}

export class RefusedDestination extends Error {
	constructor(url: string) {
		super(
			`the page tried to reach a private network address (${safeHost(url)})`,
		);
		this.name = "RefusedDestination";
	}
}

const safeHost = (url: string) => {
	try {
		return new URL(url).host;
	} catch {
		return "an invalid address";
	}
};

export interface FetchedResponse {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
	/** The URL this response is for (the last hop, when redirects were followed). */
	url: string;
}

export interface FetchOptions {
	method?: "GET" | "HEAD";
	headers?: Record<string, string>;
	timeoutMs?: number;
	/** The body is cut off (and the request refused) past this many bytes. Default 5 MB. */
	maxBytes?: number;
}

const ipLiteral = (host: string) =>
	/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");

/** Resolves and checks a host once; the address every connection to it will use. */
async function pin(
	url: URL,
	policy: DestinationPolicy,
): Promise<{ address: string; family: 4 | 6 }> {
	const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
	const addresses = ipLiteral(host) ? [host] : await policy.lookup(host);
	if (addresses.length === 0) throw new Error(`${host} could not be found`);
	// Any private answer refuses the host: a mixed answer is how rebinding starts.
	if (addresses.some((a) => !policy.allowAddress(a)))
		throw new RefusedDestination(url.href);
	const address = addresses[0] as string;
	return { address, family: address.includes(":") ? 6 : 4 };
}

/** One request, no redirects followed: a 3xx comes back as it is, with its Location. */
export async function fetchOnce(
	input: string,
	policy: DestinationPolicy,
	options: FetchOptions = {},
): Promise<FetchedResponse> {
	const url = new URL(input);
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Only http and https links can be read");
	if (url.username || url.password)
		throw new Error("Links with a user name or password are not read");
	const pinned = await pin(url, policy);
	const lookup: LookupFunction = (_host, opts, callback) => {
		// Node asks for every address when it races IPv4 and IPv6 (autoSelectFamily).
		if ((opts as { all?: boolean }).all)
			(callback as unknown as (e: null, a: object[]) => void)(null, [
				{ address: pinned.address, family: pinned.family },
			]);
		else callback(null, pinned.address, pinned.family);
	};
	const maxBytes = options.maxBytes ?? 5_000_000;
	const client = url.protocol === "https:" ? https : http;
	return new Promise<FetchedResponse>((resolve, reject) => {
		const request = client.request(
			url,
			{
				method: options.method ?? "GET",
				lookup,
				// A fresh connection per request: a pooled one could be to another address.
				agent: false,
				headers: {
					"accept-encoding": "identity",
					...options.headers,
				},
				timeout: options.timeoutMs ?? 20_000,
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > maxBytes) {
						request.destroy(new Error("The page is too large to read"));
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					const headers: Record<string, string> = {};
					for (const [key, value] of Object.entries(response.headers))
						if (value !== undefined)
							headers[key] = Array.isArray(value) ? value.join(", ") : value;
					resolve({
						status: response.statusCode ?? 0,
						headers,
						body: Buffer.concat(chunks),
						url: url.href,
					});
				});
				response.on("error", reject);
			},
		);
		request.on("timeout", () =>
			request.destroy(new Error("The page took too long to load")),
		);
		request.on("error", reject);
		request.end();
	});
}

/** A page, following up to `maxRedirects` redirects, each hop checked and pinned. */
export async function fetchPublic(
	input: string,
	policy: DestinationPolicy,
	options: FetchOptions & { maxRedirects?: number } = {},
): Promise<FetchedResponse> {
	let target = input;
	for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
		const response = await fetchOnce(target, policy, options);
		const location = response.headers.location;
		if (response.status >= 300 && response.status < 400 && location) {
			target = new URL(location, target).href;
			continue;
		}
		return response;
	}
	throw new Error("The page redirects too many times");
}

/** The body as text, in the charset the response names (UTF-8 otherwise). */
export function responseText(response: FetchedResponse): string {
	const charset = response.headers["content-type"]?.match(
		/charset=["']?([\w-]+)/i,
	)?.[1];
	try {
		return new TextDecoder(charset ?? "utf-8").decode(response.body);
	} catch {
		return new TextDecoder("utf-8").decode(response.body);
	}
}
