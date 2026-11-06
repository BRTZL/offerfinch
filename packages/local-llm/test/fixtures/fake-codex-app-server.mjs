// A stand-in for `codex app-server` (newline-delimited JSON-RPC on stdio) whose failures carry a
// canary in every free-text field, for codex-provider.test.ts. The scenario is the name of the
// wrapper that runs it: `codex-<scenario>.mjs`.
//   stderr  writes the canary to stderr and exits before answering initialize
//   hang    writes the canary to stderr and never answers (the call times out)
//   retry   an `error` notification that says Codex will retry
//   error   an `error` notification, then a failed turn
//   rpc     turn/start answered with a JSON-RPC error
//   tool    a raw item of an unknown type named by the model
import { basename } from "node:path";
import { createInterface } from "node:readline";

const CANARY = "ANSWER_CANARY_CX_51d0 my CV says";
const scenario = /^codex-(\w+)\.mjs$/.exec(basename(process.argv[1] ?? ""))?.[1];

if (scenario === "stderr") {
	process.stderr.write(`config error near: ${CANARY}\n`);
	process.exit(3);
}
if (scenario === "hang") {
	process.stderr.write(`config error near: ${CANARY}\n`);
	setInterval(() => {}, 1000);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) =>
	send({ method, params: { threadId: "thr_1", ...params } });

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.id === undefined || !message.method || scenario === "hang") return;
	const answer = (result) => send({ id: message.id, result });
	switch (message.method) {
		case "initialize":
			return answer({ userAgent: "codex_cli_rs/0.166.0" });
		case "account/read":
			return answer({ account: { type: "apiKey" } });
		case "thread/start":
			return answer({
				thread: { id: "thr_1" },
				model: "gpt-6.1-sol",
				instructionSources: [],
			});
		case "turn/start":
			if (scenario === "rpc")
				return send({
					id: message.id,
					error: { code: -32001, message: CANARY },
				});
			answer({ turn: { id: "turn_1" } });
			if (scenario === "retry")
				notify("error", {
					willRetry: true,
					error: {
						message: CANARY,
						codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
					},
				});
			else if (scenario === "error") {
				notify("error", {
					willRetry: false,
					error: { message: CANARY, codexErrorInfo: CANARY },
				});
				notify("turn/completed", {
					turn: { id: "turn_1", status: "failed", error: { message: CANARY } },
				});
			} else if (scenario === "tool")
				notify("rawResponseItem/completed", {
					item: { type: `${CANARY} item`, name: CANARY },
				});
			return;
		default:
			return answer({});
	}
});
lines.on("close", () => process.exit(0));
