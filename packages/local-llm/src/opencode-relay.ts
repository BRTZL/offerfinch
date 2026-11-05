import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The single-request relay an OpenCode call goes through (docs/research/opencode-v2-lockdown.md,
 * "Relay contract"). It is the source's `baseURL` in OpenCode's config, in this process, on a
 * random localhost port. It forwards exactly one `POST …/chat/completions` to the real upstream,
 * streams the answer back, and refuses every later request: OpenCode's session path retries a
 * 429 or 5xx on its own, and each retry would be another prompt nobody reserved. An upstream 429
 * or 5xx is passed back as 400, which OpenCode does not retry; the real status is kept here for
 * the error mapping.
 */

/** Request headers never forwarded: hop-by-hop, length and encoding. */
const DROPPED = new Set([
	"host",
	"connection",
	"content-length",
	"accept-encoding",
	"transfer-encoding",
	"keep-alive",
]);

/** The completion endpoint, the only one forwarded (every tested source package posts here). */
export const RELAY_PATH = "/chat/completions";

export interface RelayLog {
	/** Requests forwarded upstream: 0 or 1. */
	forwarded: number;
	/** Later requests answered 400 without forwarding. */
	refused: number;
	/** Requests that were not a completion POST (404). */
	other: number;
	/** The upstream's own status, before 429/5xx became 400; null when nothing was forwarded. */
	upstreamStatus: number | null;
	/** The upstream's `retry-after` (seconds, or an HTTP date), when it sent one. */
	retryAfter: string | null;
	/** A network error reaching the upstream. */
	upstreamError: string | null;
	/** The forwarded request's JSON body (tests: tools and system text on the wire). */
	body: unknown;
}

export interface Relay {
	/** The base URL to give OpenCode (`http://127.0.0.1:<port>`). */
	url: string;
	log: RelayLog;
	close(): Promise<void>;
}

function forwardedHeaders(headers: IncomingHttpHeaders): Headers {
	const out = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (DROPPED.has(name) || value === undefined) continue;
		out.set(name, Array.isArray(value) ? value.join(", ") : value);
	}
	return out;
}

/** A retryable upstream failure, passed back as a non-retryable 400. */
export function relayedStatus(upstream: number): number {
	return upstream === 429 || upstream >= 500 ? 400 : upstream;
}

/**
 * Starts the relay for one call. `upstream` is the source's real base URL (e.g.
 * `https://opencode.ai/inference/openai/v1`); `fetchImpl` is for tests.
 */
export function startRelay(
	upstream: string,
	fetchImpl: typeof fetch = fetch,
): Promise<Relay> {
	const log: RelayLog = {
		forwarded: 0,
		refused: 0,
		other: 0,
		upstreamStatus: null,
		retryAfter: null,
		upstreamError: null,
		body: null,
	};
	const base = upstream.replace(/\/+$/, "");
	const refuse = (res: ServerResponse, message: string) =>
		res
			.writeHead(400, { "content-type": "application/json" })
			.end(
				JSON.stringify({ error: { message, type: "invalid_request_error" } }),
			);
	const forward = async (
		req: IncomingMessage,
		res: ServerResponse,
		body: Buffer,
	) => {
		log.forwarded++;
		try {
			log.body = JSON.parse(body.toString("utf8"));
		} catch {
			log.body = null;
		}
		try {
			const answer = await fetchImpl(`${base}${RELAY_PATH}`, {
				method: "POST",
				headers: forwardedHeaders(req.headers),
				body,
			});
			log.upstreamStatus = answer.status;
			log.retryAfter = answer.headers.get("retry-after");
			res.writeHead(relayedStatus(answer.status), {
				"content-type":
					answer.headers.get("content-type") ?? "application/json",
			});
			if (answer.body) for await (const chunk of answer.body) res.write(chunk);
			res.end();
		} catch (error) {
			log.upstreamError =
				error instanceof Error ? error.message : String(error);
			if (res.headersSent) res.end();
			else refuse(res, "OfferFinch relay: the upstream could not be reached");
		}
	};
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const path = (req.url ?? "").split("?")[0] ?? "";
			if (req.method !== "POST" || !path.endsWith(RELAY_PATH)) {
				log.other++;
				res.writeHead(404).end();
			} else if (log.forwarded >= 1) {
				log.refused++;
				refuse(res, "OfferFinch relay: one request per call");
			} else void forward(req, res, Buffer.concat(chunks));
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				log,
				close: () =>
					new Promise<void>((done) => {
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}
