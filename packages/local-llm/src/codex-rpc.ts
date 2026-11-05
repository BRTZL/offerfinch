import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * A minimal client for `codex app-server`: newline-delimited JSON-RPC over stdio (the wire
 * format omits the `jsonrpc` field). Message shapes follow `codex app-server generate-ts
 * --experimental` for codex-cli 0.166.0; only the fields this package uses are typed.
 */
export interface RpcMessage {
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
}

export type ServerRequestAnswer =
	| { result: unknown }
	| { error: { code: number; message: string } };

export interface AppServerProcess {
	request<T = unknown>(method: string, params: unknown): Promise<T>;
	notify(method: string, params?: unknown): void;
	/** SIGKILL the whole process group (the CLI and anything it started). */
	kill(): void;
	/** Close stdin and wait (bounded) for a clean exit, then kill. */
	close(timeoutMs?: number): Promise<void>;
	readonly exited: Promise<{ code: number | null; signal: string | null }>;
	/** stderr, kept in memory only; may hold paths, never written anywhere by this module. */
	stderrTail(): string;
}

export function startAppServer(input: {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	onServerRequest: (message: RpcMessage) => ServerRequestAnswer;
	onNotification: (message: RpcMessage) => void;
}): AppServerProcess {
	const child: ChildProcess = spawn(input.command, input.args, {
		env: input.env,
		cwd: input.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	let nextId = 1;
	const pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	// The process may be killed mid-turn (abort): a write or close on a dead pipe must never
	// become an uncaught EPIPE that takes down the CLI or the desktop worker.
	child.stdin?.on("error", () => {});
	child.stdout?.on("error", () => {});
	child.stderr?.on("error", () => {});
	let stderr = "";
	child.stderr?.on("data", (d: Buffer) => {
		stderr = (stderr + d.toString("utf8")).slice(-4000);
	});
	const write = (message: RpcMessage) => {
		if (child.stdin?.writable)
			child.stdin.write(`${JSON.stringify(message)}\n`);
	};
	const lines = createInterface({
		input: child.stdout as NodeJS.ReadableStream,
	});
	lines.on("line", (line) => {
		let message: RpcMessage;
		try {
			message = JSON.parse(line) as RpcMessage;
		} catch {
			return;
		}
		if (message.id !== undefined && message.method) {
			const answer = input.onServerRequest(message);
			write({ id: message.id, ...answer });
		} else if (message.id !== undefined) {
			const waiter = pending.get(Number(message.id));
			pending.delete(Number(message.id));
			if (!waiter) return;
			if (message.error)
				waiter.reject(
					Object.assign(new Error(message.error.message), {
						code: message.error.code,
					}),
				);
			else waiter.resolve(message.result);
		} else if (message.method) input.onNotification(message);
	});
	const exited = new Promise<{ code: number | null; signal: string | null }>(
		(resolve) => {
			const done = (code: number | null, signal: string | null) => {
				for (const waiter of pending.values())
					waiter.reject(
						new Error(`codex app-server exited (${code ?? signal ?? "?"})`),
					);
				pending.clear();
				resolve({ code, signal });
			};
			child.on("exit", done);
			child.on("error", (error) => {
				for (const waiter of pending.values()) waiter.reject(error);
				pending.clear();
				resolve({ code: null, signal: "spawn-error" });
			});
		},
	);
	const kill = () => {
		if (child.pid === undefined) return;
		try {
			if (process.platform === "win32") child.kill("SIGKILL");
			else process.kill(-child.pid, "SIGKILL");
		} catch {
			try {
				child.kill("SIGKILL");
			} catch {}
		}
	};
	return {
		request<T>(method: string, params: unknown): Promise<T> {
			const id = nextId++;
			return new Promise<T>((resolve, reject) => {
				pending.set(id, {
					resolve: resolve as (v: unknown) => void,
					reject,
				});
				write({ id, method, params: params as Record<string, unknown> });
			});
		},
		notify(method, params) {
			write({ method, params: params as Record<string, unknown> });
		},
		kill,
		async close(timeoutMs = 3000) {
			child.stdin?.end();
			await Promise.race([
				exited,
				new Promise((r) => setTimeout(r, timeoutMs)),
			]);
			kill();
		},
		exited,
		stderrTail: () => stderr,
	};
}
