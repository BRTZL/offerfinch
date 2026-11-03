import { createServer, type Server } from "node:http";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

export interface Captured {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

export type Answer =
	| { status: number; body?: unknown }
	| { status: 200; sse: { event: string; data: unknown }[] };

/** A Messages API stream whose one answer is a StructuredOutput call with `output`. */
export function structuredOutputStream(
	model: string,
	output: unknown,
): Answer & { sse: unknown[] } {
	const ev = (event: string, data: Record<string, unknown>) => ({
		event,
		data: { type: event, ...data },
	});
	return {
		status: 200,
		sse: [
			ev("message_start", {
				message: {
					id: "msg_capture",
					type: "message",
					role: "assistant",
					model,
					content: [],
					stop_reason: null,
					usage: {
						input_tokens: 1234,
						output_tokens: 1,
						cache_read_input_tokens: 100,
						cache_creation_input_tokens: 0,
					},
				},
			}),
			ev("content_block_start", {
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_capture",
					name: "StructuredOutput",
					input: {},
				},
			}),
			ev("content_block_delta", {
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify(output),
				},
			}),
			ev("content_block_stop", { index: 0 }),
			ev("message_delta", {
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 56 },
			}),
			ev("message_stop", {}),
		],
	};
}

const REFUSE: Answer = {
	status: 400,
	body: {
		type: "error",
		error: { type: "invalid_request_error", message: "capture only" },
	},
};

/**
 * A local stand-in for a model API: records every request and answers it (by default, a
 * refusal), so nothing reaches a vendor. Bound to 127.0.0.1 on a free port.
 */
export async function captureServer(
	respond: (req: Captured) => Answer = () => REFUSE,
): Promise<{ url: string; requests: Captured[]; close: () => Promise<void> }> {
	const requests: Captured[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			let raw = Buffer.concat(chunks);
			const encoding = req.headers["content-encoding"];
			if (encoding === "gzip") raw = gunzipSync(raw);
			if (encoding === "zstd") raw = zstdDecompressSync(raw);
			let body: unknown = null;
			try {
				body = raw.length ? JSON.parse(raw.toString("utf8")) : null;
			} catch {
				body = raw.toString("utf8");
			}
			const captured = {
				method: req.method ?? "",
				url: req.url ?? "",
				headers: req.headers,
				body,
			};
			requests.push(captured);
			const answer =
				req.method === "HEAD" ? { status: 200 } : respond(captured);
			if ("sse" in answer) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				for (const e of answer.sse)
					res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
				res.end();
				return;
			}
			res.writeHead(answer.status, { "content-type": "application/json" });
			res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
