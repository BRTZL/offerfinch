import { randomBytes } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/**
 * A fake OpenAI Responses server for `codex app-server`: every request body is recorded, and
 * `plan` decides which output items each request gets back (SSE). Nothing reaches OpenAI.
 */
/** Request bodies as Codex sent them: untyped wire JSON. */
// biome-ignore lint/suspicious/noExplicitAny: wire JSON from Codex, inspected by the tests
export type WireJson = Record<string, any>;

interface CapturedRequest {
	url: string;
	raw: string;
	body: WireJson | null;
}

export type ModelPlan = (
	body: WireJson,
	index: number,
) =>
	| unknown[]
	| { status: number; body: unknown }
	/** The stream starts, then closes before `response.completed`. */
	| { drop: true };

export async function fakeResponses(plan: ModelPlan) {
	const requests: CapturedRequest[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			let raw = Buffer.concat(chunks);
			if (req.headers["content-encoding"] === "zstd")
				raw = zstdDecompressSync(raw);
			const entry: CapturedRequest = {
				url: req.url ?? "",
				raw: raw.toString("utf8"),
				body: null,
			};
			requests.push(entry);
			if (req.method === "GET" || !/\/responses$/.test(entry.url)) {
				// 426 refuses the WebSocket upgrade, so Codex falls back to a plain POST.
				res.writeHead(req.headers.upgrade ? 426 : 404, {
					"content-type": "application/json",
				});
				res.end("{}");
				return;
			}
			try {
				entry.body = JSON.parse(entry.raw);
			} catch {}
			const answer = plan(
				entry.body ?? {},
				requests.filter((r) => r.body).length - 1,
			);
			if ("drop" in answer) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(
					`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_dropped" } })}\n\n`,
				);
				res.end();
				return;
			}
			if (!Array.isArray(answer)) {
				res.writeHead(answer.status, { "content-type": "application/json" });
				res.end(JSON.stringify(answer.body));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const send = (data: Record<string, unknown>) =>
				res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
			const id = `resp_${requests.length}`;
			send({ type: "response.created", response: { id } });
			for (const item of answer)
				send({ type: "response.output_item.done", item });
			send({
				type: "response.completed",
				response: {
					id,
					usage: {
						input_tokens: 120,
						input_tokens_details: { cached_tokens: 20 },
						output_tokens: 7,
						output_tokens_details: { reasoning_tokens: 0 },
						total_tokens: 127,
					},
				},
			});
			res.end();
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		posts: () => requests.filter((r) => r.body),
		wire: () => requests.map((r) => r.raw).join("\n"),
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export function assistantMessage(text: string) {
	return {
		type: "message",
		role: "assistant",
		id: "msg_1",
		content: [{ type: "output_text", text, annotations: [] }],
	};
}

function functionCall(
	name: string,
	args: unknown,
	extra: Record<string, unknown> = {},
) {
	return {
		type: "function_call",
		id: `fc_${name}`,
		call_id: `call_${name}`,
		name,
		arguments: JSON.stringify(args),
		...extra,
	};
}

/** Forged tool calls a hostile posting could steer the model into, each reading `path`. */
export function attacks(path: string): Record<string, unknown[]> {
	const cmd = `cat ${path}`;
	return {
		exec_command: [functionCall("exec_command", { cmd })],
		shell: [functionCall("shell", { command: ["cat", path] })],
		code_mode: [
			{
				type: "custom_tool_call",
				id: "ctc_1",
				call_id: "call_exec",
				name: "exec",
				input: `try { text(JSON.stringify(await tools.exec_command({ cmd: ${JSON.stringify(cmd)} }))); } catch (e) { text("ERR " + e); }`,
			},
		],
		spawn_agent: [
			functionCall(
				"spawn_agent",
				{ task_name: "t1", message: `run ${cmd}`, fork_turns: "none" },
				{ namespace: "collaboration" },
			),
		],
	};
}

/** A canary file in its own temp directory (outside every Codex root), and its secret. */
export async function makeCanary() {
	const dir = await mkdtemp(
		join(await realpath(tmpdir()), "offerfinch-canary-"),
	);
	await mkdir(join(dir, ".ssh"));
	const secret = `CANARY-${randomBytes(8).toString("hex")}`;
	const path = join(dir, ".ssh", "config");
	await writeFile(path, `Host ${secret}\n  User canary\n`);
	return {
		dir,
		path,
		secret,
		remove: () => rm(dir, { recursive: true, force: true }),
	};
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) await walk(path, out);
		else if (entry.isFile()) out.push(path);
	}
	return out;
}

/** Files under `dirs` (changed since `since`, when given) that contain any of `needles`. */
export async function filesContaining(
	dirs: string[],
	needles: string[],
	since?: number,
) {
	const hits: string[] = [];
	let scanned = 0;
	for (const dir of dirs)
		for (const file of await walk(dir)) {
			try {
				const info = await stat(file);
				if (since !== undefined && info.mtimeMs < since) continue;
				if (info.size > 100e6) continue;
				scanned++;
				const bytes = await readFile(file);
				for (const needle of needles)
					if (bytes.includes(needle)) hits.push(file);
			} catch {}
		}
	return { hits, scanned };
}
