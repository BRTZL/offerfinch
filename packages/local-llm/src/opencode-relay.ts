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
 *
 * It also holds the request to the output limit the call was reserved for: every limit field the
 * body carries is lowered to it, and a body without one gets `max_completion_tokens` (what
 * OpenCode 2.2.5 sends on the tested wire). A body that is not a JSON object is refused unsent.
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
const RELAY_PATH = "/chat/completions";

/**
 * The output-limit fields of a chat completion body. `max_completion_tokens` counts reasoning
 * tokens with the answer (OpenAI's definition, which OpenAI-compatible APIs follow).
 */
const LIMIT_FIELDS = [
	"max_completion_tokens",
	"max_tokens",
	"max_output_tokens",
] as const;

export interface RelayLog {
	/** Requests forwarded upstream: 0 or 1. */
	forwarded: number;
	/** Later requests, and a body that is not JSON, answered 400 without forwarding. */
	refused: number;
	/** Requests that were not a completion POST (404). */
	other: number;
	/** The upstream's own status, before 429/5xx became 400; null when nothing was forwarded. */
	upstreamStatus: number | null;
	/** The upstream's `retry-after` (seconds, or an HTTP date), when it sent one. */
	retryAfter: string | null;
	/** A network error reaching the upstream. */
	upstreamError: string | null;
	/** The forwarded request's JSON body, as sent (tests: tools and system text on the wire). */
	body: unknown;
	/** OpenCode asked for more output than reserved (or for no limit): the relay lowered it. */
	limitClamped: boolean;
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
 * The body held to `maxTokens`: each limit field it carries at most that, and
 * `max_completion_tokens` added when it has none. Null when it is not a JSON object.
 */
export function limitedBody(
	raw: Buffer,
	maxTokens: number,
): { body: Record<string, unknown>; clamped: boolean } | null {
	let body: unknown;
	try {
		body = JSON.parse(raw.toString("utf8"));
	} catch {
		return null;
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const out = { ...(body as Record<string, unknown>) };
	let clamped = false;
	let present = false;
	for (const field of LIMIT_FIELDS) {
		if (!(field in out)) continue;
		present = true;
		const value = out[field];
		if (
			typeof value !== "number" ||
			!Number.isInteger(value) ||
			value < 1 ||
			value > maxTokens
		) {
			out[field] = maxTokens;
			clamped = true;
		}
	}
	if (!present) {
		out.max_completion_tokens = maxTokens;
		clamped = true;
	}
	return { body: out, clamped };
}

/**
 * Starts the relay for one call. `upstream` is the source's real base URL (e.g.
 * `https://opencode.ai/inference/openai/v1`); `maxTokens` is the output limit the call was
 * reserved for; `fetch` is for tests.
 */
export function startRelay(
	upstream: string,
	options: { maxTokens: number; fetch?: typeof fetch },
): Promise<Relay> {
	const fetchImpl = options.fetch ?? fetch;
	const maxTokens = Math.max(1, Math.floor(options.maxTokens));
	const log: RelayLog = {
		forwarded: 0,
		refused: 0,
		other: 0,
		upstreamStatus: null,
		retryAfter: null,
		upstreamError: null,
		body: null,
		limitClamped: false,
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
		raw: Buffer,
	) => {
		const limited = limitedBody(raw, maxTokens);
		if (!limited) {
			log.refused++;
			refuse(res, "OfferFinch relay: the request body is not a JSON object");
			return;
		}
		log.forwarded++;
		log.body = limited.body;
		log.limitClamped = limited.clamped;
		try {
			const answer = await fetchImpl(`${base}${RELAY_PATH}`, {
				method: "POST",
				headers: forwardedHeaders(req.headers),
				body: JSON.stringify(limited.body),
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
			} else if (log.forwarded + log.refused >= 1) {
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
