import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
	AccountInfo,
	Options,
	SDKControlGetUsageResponse,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { subscriptionEnv } from "./env";

/** What the provider and the login check use of an SDK session. */
export interface ClaudeSession extends AsyncIterable<SDKMessage> {
	initializationResult(): Promise<{ account: AccountInfo }>;
	/**
	 * The plan's usage and extra-usage state (the SDK's experimental `get_usage` control, with
	 * `skipBehaviors`, so no local transcript is read). Sends no prompt.
	 */
	usage(): Promise<SDKControlGetUsageResponse>;
	close(): void;
}

export type ClaudeQuery = (params: {
	prompt: AsyncIterable<SDKUserMessage>;
	options: Options;
}) => ClaudeSession;

const HOST = fileURLToPath(new URL("./claude-host.ts", import.meta.url));

/** How long a closed host may take to stop its CLI before it is killed. */
const CLOSE_GRACE_MS = 2_000;

type FromHost =
	| { t: "ready" }
	| { t: "init"; result: { account: AccountInfo } }
	| { t: "init_error"; error: string }
	| { t: "message"; message: SDKMessage }
	| { t: "done" }
	| { t: "error"; error: string }
	| {
			t: "usage";
			id: number;
			result?: SDKControlGetUsageResponse;
			error?: string;
	  };

/**
 * The SDK in a child process of its own (`claude-host.ts`), started with only the allowlisted
 * environment and no Node flags. The SDK reads its own process's environment, not just
 * `options.env`: in this process, DEBUG_CLAUDE_AGENT_SDK=1 makes the pinned SDK turn on the
 * CLI's debug log under CLAUDE_CONFIG_DIR, prompt included, whatever `persistSession` says.
 * In the host, that variable (and DEBUG, NODE_OPTIONS and everything else off the allowlist)
 * does not exist. This process never loads the SDK at run time.
 */
export const isolatedQuery: ClaudeQuery = ({ prompt, options }) => {
	const { abortController, env: cliEnv, ...rest } = options;
	// The host's own environment: the allowlist, taken from the CLI's (already allowlisted).
	const { env: hostEnv } = subscriptionEnv(cliEnv ?? {});
	const child: ChildProcess = fork(HOST, [], {
		env: hostEnv,
		execArgv: [],
		serialization: "advanced",
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	const queue: SDKMessage[] = [];
	let ended = false;
	let failure: Error | null = null;
	let wake: () => void = () => {};
	let resolveInit: (value: { account: AccountInfo }) => void = () => {};
	let rejectInit: (error: Error) => void = () => {};
	const init = new Promise<{ account: AccountInfo }>((resolve, reject) => {
		resolveInit = resolve;
		rejectInit = reject;
	});
	init.catch(() => {});
	const usageCalls = new Map<
		number,
		{
			resolve: (value: SDKControlGetUsageResponse) => void;
			reject: (error: Error) => void;
		}
	>();
	let usageId = 0;
	const finish = (error: Error | null) => {
		if (ended) return;
		ended = true;
		failure = error;
		if (error) rejectInit(error);
		for (const call of usageCalls.values())
			call.reject(error ?? new Error("the session ended"));
		usageCalls.clear();
		wake();
	};
	const post = (message: Record<string, unknown>) => {
		if (child.connected) child.send(message);
	};
	child.on("message", (raw: FromHost) => {
		if (raw.t === "init") resolveInit(raw.result);
		else if (raw.t === "init_error") rejectInit(new Error(raw.error));
		else if (raw.t === "message") {
			queue.push(raw.message);
			wake();
		} else if (raw.t === "done") finish(null);
		else if (raw.t === "error") finish(new Error(raw.error));
		else if (raw.t === "usage") {
			const call = usageCalls.get(raw.id);
			usageCalls.delete(raw.id);
			if (raw.result) call?.resolve(raw.result);
			else call?.reject(new Error(raw.error ?? "no usage answer"));
		}
	});
	child.on("error", (error) => finish(error));
	child.on("exit", (code, signal) =>
		finish(
			ended
				? null
				: new Error(
						`the Claude Agent SDK host exited (${signal ?? `code ${code}`}) before the session ended`,
					),
		),
	);
	post({ t: "start", options: { ...rest, env: cliEnv } });
	// The prompt goes over IPC only when the caller's generator yields it (after its checks).
	void (async () => {
		try {
			for await (const message of prompt) post({ t: "prompt", message });
		} finally {
			post({ t: "end_input" });
		}
	})();
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		post({ t: "close" });
		const timer = setTimeout(() => child.kill("SIGKILL"), CLOSE_GRACE_MS);
		timer.unref();
		child.once("exit", () => clearTimeout(timer));
		finish(null);
	};
	abortController?.signal.addEventListener("abort", close, { once: true });
	async function* messages(): AsyncGenerator<SDKMessage> {
		while (true) {
			const next = queue.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (ended) {
				if (failure) throw failure;
				return;
			}
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	}
	const stream = messages();
	return {
		[Symbol.asyncIterator]: () => stream,
		initializationResult: () => init,
		usage: () =>
			new Promise<SDKControlGetUsageResponse>((resolve, reject) => {
				if (ended) {
					reject(new Error("the session ended"));
					return;
				}
				const id = ++usageId;
				usageCalls.set(id, { resolve, reject });
				post({ t: "usage", id });
			}),
		close,
	};
};
