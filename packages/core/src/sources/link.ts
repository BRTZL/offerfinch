import { type FoundPosting, postingFromUrl } from "./search";

/**
 * "Add job from link": one URL the user pastes. Only public http(s) pages are read: anything on
 * this Mac or a private network is refused before any request (no SSRF), first by its literal
 * host, then by every address its name resolves to.
 */

export type LinkCheck = { ok: true; url: URL } | { ok: false; reason: string };

const PRIVATE_NAMES =
	/^(?:localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.(?:localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/i;

/** An IPv4 address in any form the URL parser accepts, as four octets; null if not one. */
function ipv4(host: string): [number, number, number, number] | null {
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const parts = m.slice(1).map(Number) as [number, number, number, number];
	return parts.every((p) => p <= 255) ? parts : null;
}

function privateV4([a, b]: [number, number, number, number]): boolean {
	return (
		a === 0 || // "this" network
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		(a === 169 && b === 254) || // link-local, cloud metadata
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0) ||
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		a >= 224 // multicast and reserved
	);
}

/** True for an address that is this Mac, a private network, link-local or reserved. */
export function isPrivateAddress(address: string): boolean {
	const host = address.replace(/^\[|\]$/g, "").toLowerCase();
	const v4 = ipv4(host);
	if (v4) return privateV4(v4);
	if (!host.includes(":")) return false;
	if (host === "::" || host === "::1") return true;
	// IPv4-mapped or -compatible IPv6 (::ffff:10.0.0.1, ::ffff:a00:1).
	const mapped = host.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped?.[1]) return isPrivateAddress(mapped[1]);
	const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (hex?.[1] && hex[2]) {
		const hi = Number.parseInt(hex[1], 16);
		const lo = Number.parseInt(hex[2], 16);
		return privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
	}
	return /^(?:f[cd]|fe[89ab]|ff)/.test(host); // unique local, link-local, multicast
}

/**
 * The URL the user pasted, if it may be read: http or https, no user name or password, and a
 * public host. The WHATWG parser has already turned decimal, octal and hex IPv4 forms into
 * dotted quads, so "http://2130706433" is seen as 127.0.0.1.
 */
export function checkJobLink(input: string): LinkCheck {
	const text = input.trim();
	if (!text) return { ok: false, reason: "Paste a link to a job posting." };
	let url: URL;
	try {
		url = new URL(/^[a-z][\w+.-]*:/i.test(text) ? text : `https://${text}`);
	} catch {
		return { ok: false, reason: "That is not a link." };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		return { ok: false, reason: "Only http and https links can be read." };
	if (url.username || url.password)
		return {
			ok: false,
			reason: "Links with a user name or password are not read.",
		};
	// A trailing dot ("localhost.") names the same host.
	const host = url.hostname.toLowerCase().replace(/\.+$/, "");
	if (!host.includes(".") && !host.includes(":") && !ipv4(host))
		return { ok: false, reason: "That link has no public host name." };
	if (PRIVATE_NAMES.test(host) || isPrivateAddress(host))
		return {
			ok: false,
			reason: "Links to this Mac or a private network are not read.",
		};
	return { ok: true, url };
}

/** Refuses a host whose name resolves to a private address (checked again just before reading). */
export async function checkResolvedHost(
	host: string,
	lookup: (host: string) => Promise<string[]>,
): Promise<LinkCheck | null> {
	if (ipv4(host) || host.includes(":")) return null;
	let addresses: string[];
	try {
		addresses = await lookup(host);
	} catch {
		return { ok: false, reason: `${host} could not be found.` };
	}
	if (addresses.length === 0)
		return { ok: false, reason: `${host} could not be found.` };
	if (addresses.some(isPrivateAddress))
		return {
			ok: false,
			reason: "That link points to a private network address; it is not read.",
		};
	return null;
}

export type LinkRoute =
	| { kind: "board"; posting: FoundPosting }
	| { kind: "linkedin"; jobId: string }
	| { kind: "indeed"; jobId: string }
	| { kind: "glassdoor"; jobId: string }
	| { kind: "page" };

/** How a link is read: a board's public data, a site's read-only reader, or the page itself. */
export function routeJobLink(url: URL): LinkRoute {
	const posting = postingFromUrl(url.toString());
	if (posting) return { kind: "board", posting };
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	if (/(^|\.)linkedin\.com$/.test(host)) {
		const id =
			url.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/)?.[1] ??
			url.searchParams.get("currentJobId");
		if (id && /^\d+$/.test(id)) return { kind: "linkedin", jobId: id };
	}
	if (/(^|\.)indeed\.[a-z.]+$/.test(host)) {
		const jk = url.searchParams.get("jk") ?? url.searchParams.get("vjk");
		if (jk && /^[0-9a-f]{8,32}$/i.test(jk))
			return { kind: "indeed", jobId: jk };
	}
	if (/(^|\.)glassdoor\.[a-z.]+$/.test(host)) {
		const jl = url.searchParams.get("jl");
		if (jl && /^\d+$/.test(jl)) return { kind: "glassdoor", jobId: jl };
	}
	return { kind: "page" };
}
