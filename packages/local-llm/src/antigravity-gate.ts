import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The local gate the Antigravity server's model requests go through (`AGY_ACP_CCPA_BASE_URL`).
 * It forwards the model list (`fetchAvailableModels`) and at most one model request, after
 * checking that request offers no tools and asks for the chosen model; everything else is
 * refused. The server retries a rejected tool call or a 503 with another request, so this cap is
 * what holds a call to one request (docs/research/antigravity-1.4.1-pin.md).
 */

/** The consumer tier's endpoint (Google AI Pro/Ultra and free), where model requests go. */
export const ANTIGRAVITY_UPSTREAM = "https://daily-cloudcode-pa.googleapis.com";

const LIST = "fetchAvailableModels";
const GENERATE = new Set(["streamGenerateContent", "generateContent"]);
/** The server lists models once per session; a few more are tolerated, never unbounded. */
const MAX_LISTS = 4;
/** An answer larger than this is not kept for reading (it is still passed through). */
const MAX_KEPT = 4 * 1024 * 1024;

export interface GateUsage {
	promptTokens: number;
	outputTokens: number;
	thoughtTokens: number;
	cachedTokens: number;
}

export interface UpstreamError {
	status: number;
	message: string;
	/** `QUOTA_EXHAUSTED`, `MODEL_CAPACITY_EXHAUSTED`, … from the error's ErrorInfo. */
	reason: string | null;
	resetsAt: Date | null;
}

export interface GateRecord {
	/** The one model request was sent upstream. */
	forwarded: boolean;
	/** The model request broke the lockdown (tools offered, another model, more turns). */
	violation: string | null;
	/** Requests refused: extra model requests and anything not allowed, by method. */
	refused: string[];
	/** The upstream's status for the model request. */
	status: number | null;
	error: UpstreamError | null;
	usage: GateUsage | null;
	/** The model that answered, as the upstream named it. */
	modelVersion: string | null;
	/** Function calls the model asked for (the server rejects them; the call fails). */
	functionCalls: string[];
}

export interface GateOptions {
	/** The model slug the one model request must name; null (until `expect`) allows none. */
	model?: string | null;
	upstream?: string;
	fetch?: typeof fetch;
	/** The model request is about to be sent upstream (the call's prompt leaves now). */
	onForward?: () => void;
}

export interface Gate {
	url: string;
	record: GateRecord;
	/** The model slug the one model request must name, known once the session lists models. */
	expect(model: string): void;
	close(): Promise<void>;
}

function methodOf(url: string): string {
	return /^\/v1internal:(\w+)/.exec(url)?.[1] ?? "";
}

/** Headers passed upstream: what the server's request needs, nothing of this process. */
function upstreamHeaders(req: IncomingMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (typeof value !== "string") continue;
		if (
			key === "content-type" ||
			key === "user-agent" ||
			key === "authorization" ||
			key.startsWith("x-goog-")
		)
			out[key] = value;
	}
	return out;
}

/** Why a model request breaks the lockdown, or null. */
export function generateViolation(
	body: unknown,
	model: string | null,
): string | null {
	if (model === null) return "a model request where none may be sent";
	if (!body || typeof body !== "object") return "an unreadable model request";
	const b = body as { model?: unknown; request?: Record<string, unknown> };
	if (b.model !== model)
		return `a model request for ${String(b.model).slice(0, 80)}, not ${model}`;
	const request = b.request;
	if (!request || typeof request !== "object")
		return "a model request without a request";
	if ("tools" in request) return "tools offered to the model";
	const contents = request.contents;
	if (!Array.isArray(contents) || contents.length !== 1)
		return "more than the one prompt in the model request";
	return null;
}

/** Tokens, the answering model and any function calls, from a streamed (SSE) or JSON answer. */
export function readAnswer(text: string): {
	usage: GateUsage | null;
	modelVersion: string | null;
	functionCalls: string[];
} {
	let usage: GateUsage | null = null;
	let modelVersion: string | null = null;
	const functionCalls: string[] = [];
	const chunks = text.includes("data:")
		? text
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
		: [text];
	for (const chunk of chunks) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(chunk);
		} catch {
			continue;
		}
		const response = ((parsed as { response?: unknown }).response ??
			parsed) as {
			usageMetadata?: Record<string, number>;
			modelVersion?: string;
			candidates?: {
				content?: { parts?: { functionCall?: { name?: string } }[] };
			}[];
		};
		const meta = response.usageMetadata;
		if (meta)
			usage = {
				promptTokens: meta.promptTokenCount ?? 0,
				outputTokens: meta.candidatesTokenCount ?? 0,
				thoughtTokens: meta.thoughtsTokenCount ?? 0,
				cachedTokens: meta.cachedContentTokenCount ?? 0,
			};
		if (typeof response.modelVersion === "string")
			modelVersion = response.modelVersion;
		for (const candidate of response.candidates ?? [])
			for (const part of candidate.content?.parts ?? [])
				if (part.functionCall)
					functionCalls.push(String(part.functionCall.name ?? "unnamed"));
	}
	return { usage, modelVersion, functionCalls };
}

/**
 * The upstream's error body (`{error: {code, message, details}}`), read. A body that is not that
 * JSON is not kept: only its length.
 */
export function readError(status: number, text: string): UpstreamError {
	let message = `(an error body of ${text.length} characters that is not Google's JSON)`;
	let reason: string | null = null;
	let resetsAt: Date | null = null;
	try {
		const body = JSON.parse(text) as {
			error?: {
				message?: string;
				details?: {
					reason?: string;
					metadata?: Record<string, string>;
				}[];
			};
		};
		if (body.error?.message) message = body.error.message;
		for (const detail of body.error?.details ?? []) {
			if (detail.reason) reason = detail.reason;
			const at = detail.metadata?.quotaResetTimeStamp;
			if (at && !Number.isNaN(Date.parse(at))) resetsAt = new Date(at);
		}
	} catch {}
	return { status, message, reason, resetsAt };
}

function refuse(
	record: GateRecord,
	res: ServerResponse,
	status: number,
	method: string,
): void {
	record.refused.push(method || "unknown");
	res.writeHead(status, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			error: {
				code: status,
				message: "OfferFinch: this request is not allowed",
				status: status === 400 ? "FAILED_PRECONDITION" : "PERMISSION_DENIED",
			},
		}),
	);
}

/** Sends the request upstream and streams the answer back; keeps its text when asked. */
async function forward(
	doFetch: typeof fetch,
	target: string,
	req: IncomingMessage,
	res: ServerResponse,
	body: string,
): Promise<{ status: number; text: string }> {
	const up = await doFetch(target, {
		method: "POST",
		headers: upstreamHeaders(req),
		body,
	});
	res.writeHead(up.status, {
		"content-type": up.headers.get("content-type") ?? "application/json",
	});
	let kept = "";
	if (up.body) {
		const decoder = new TextDecoder();
		for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
			res.write(chunk);
			if (kept.length < MAX_KEPT)
				kept += decoder.decode(chunk, { stream: true });
		}
	}
	res.end();
	return { status: up.status, text: kept };
}

/** Starts the gate on 127.0.0.1 (a free port). */
export async function startGate(options: GateOptions): Promise<Gate> {
	const upstream = options.upstream ?? ANTIGRAVITY_UPSTREAM;
	const doFetch = options.fetch ?? fetch;
	const record: GateRecord = {
		forwarded: false,
		violation: null,
		refused: [],
		status: null,
		error: null,
		usage: null,
		modelVersion: null,
		functionCalls: [],
	};
	let lists = 0;
	let generates = 0;
	let model = options.model ?? null;

	const generate = async (
		req: IncomingMessage,
		res: ServerResponse,
		method: string,
		body: string,
	) => {
		if (++generates > 1) return refuse(record, res, 400, method);
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(body);
		} catch {}
		const violation = generateViolation(parsed, model);
		if (violation) {
			record.violation = violation;
			return refuse(record, res, 400, method);
		}
		record.forwarded = true;
		options.onForward?.();
		try {
			const answer = await forward(
				doFetch,
				upstream + (req.url ?? ""),
				req,
				res,
				body,
			);
			record.status = answer.status;
			if (answer.status >= 200 && answer.status < 300)
				Object.assign(record, readAnswer(answer.text));
			else record.error = readError(answer.status, answer.text);
		} catch (error) {
			if (!record.status)
				record.error = {
					status: 502,
					message: `the model request failed: ${String(error).slice(0, 200)}`,
					reason: null,
					resetsAt: null,
				};
			throw error;
		}
	};

	const handle = async (
		req: IncomingMessage,
		res: ServerResponse,
		body: string,
	) => {
		const method = methodOf(req.url ?? "");
		if (req.method !== "POST") return refuse(record, res, 403, method);
		if (method === LIST) {
			if (++lists > MAX_LISTS) return refuse(record, res, 403, method);
			await forward(doFetch, upstream + (req.url ?? ""), req, res, body);
			return;
		}
		if (!GENERATE.has(method)) return refuse(record, res, 403, method);
		await generate(req, res, method, body);
	};

	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			handle(req, res, Buffer.concat(chunks).toString("utf8")).catch(() => {
				if (!res.headersSent) res.writeHead(502);
				res.end();
			});
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		record,
		expect: (slug) => {
			model = slug;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
