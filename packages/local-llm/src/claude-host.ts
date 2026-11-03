/**
 * The Claude Agent SDK's own process. The parent (`isolated.ts`) forks this file with only the
 * allowlisted environment (`env.ts`) and no Node flags, so whatever the SDK reads from its own
 * process (DEBUG_CLAUDE_AGENT_SDK, DEBUG, CLAUDE_CONFIG_DIR for its debug log, NODE_OPTIONS)
 * is what the allowlist passed, never the CLI's or the server's environment.
 *
 * Options and the prompt arrive over IPC only (never argv or environment, which `ps` shows),
 * and the prompt only after the parent has checked the login. Nothing here touches the disk.
 *
 * Run directly by Node (type stripping): erasable syntax only, and no imports but the SDK.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

type FromParent =
	| { t: "start"; options: Record<string, unknown> }
	| { t: "prompt"; message: unknown }
	| { t: "end_input" }
	| { t: "usage"; id: number }
	| { t: "close" };

function send(message: Record<string, unknown>): void {
	process.send?.(message);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const prompts: unknown[] = [];
let inputEnded = false;
let wake: () => void = () => {};

async function* input(): AsyncGenerator<never> {
	while (true) {
		const next = prompts.shift();
		if (next !== undefined) {
			yield next as never;
			continue;
		}
		if (inputEnded) return;
		await new Promise<void>((resolve) => {
			wake = resolve;
		});
	}
}

let session: ReturnType<typeof query> | null = null;
const abort = new AbortController();

function close(): void {
	try {
		abort.abort();
		session?.close();
	} catch {
		// Closing an ended session is not an error.
	}
	process.disconnect?.();
	setTimeout(() => process.exit(0), 200).unref();
}

process.on("disconnect", () => {
	// The parent went away: stop the CLI and leave.
	try {
		abort.abort();
		session?.close();
	} catch {}
	setTimeout(() => process.exit(0), 200).unref();
});

process.on("message", (raw: FromParent) => {
	if (raw.t === "start") {
		if (session) return;
		session = query({
			prompt: input(),
			options: { ...raw.options, abortController: abort },
		});
		const running = session;
		running.initializationResult().then(
			(result) => send({ t: "init", result }),
			(error: unknown) => send({ t: "init_error", error: messageOf(error) }),
		);
		void (async () => {
			try {
				for await (const message of running) send({ t: "message", message });
				send({ t: "done" });
			} catch (error) {
				send({ t: "error", error: messageOf(error) });
			}
		})();
		return;
	}
	if (raw.t === "prompt") {
		prompts.push(raw.message);
		wake();
		return;
	}
	if (raw.t === "end_input") {
		inputEnded = true;
		wake();
		return;
	}
	if (raw.t === "usage") {
		// The plan's limits and extra-usage state, from the claude.ai usage endpoint; no prompt.
		const id = raw.id;
		if (!session) {
			send({ t: "usage", id, error: "no session" });
			return;
		}
		session
			.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
				skipBehaviors: true,
			})
			.then(
				(result) => send({ t: "usage", id, result }),
				(error: unknown) => send({ t: "usage", id, error: messageOf(error) }),
			);
		return;
	}
	if (raw.t === "close") close();
});

send({ t: "ready" });
