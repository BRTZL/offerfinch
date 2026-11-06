// A stand-in for `codex app-server` (newline-delimited JSON-RPC on stdio) whose failures carry a
// canary in every free-text field, for codex-provider.test.ts. The scenario is the name of the
// wrapper that runs it: `codex-<scenario>.mjs`.
//   stderr  writes the canary to stderr and exits before answering initialize
//   hang    writes the canary to stderr and never answers (the call times out)
//   retry   an `error` notification that says Codex will retry
//   error   an `error` notification, then a failed turn
//   rpc     turn/start answered with a JSON-RPC error
//   tool    a raw item of an unknown type named by the model
// The rest put identifiers that are not the protocol's (no spaces: the shape of a name, the
// content of the user's text) in every field an error or the session log may name:
//   kind      an error kind, a turn status and a failed turn's kind
//   retrykind a retry's kind
//   rpccode   a JSON-RPC error with a string code and a message like this side's own
//   request   a server request's method
//   item      a thread item's type
//   rawtool   a function call's tool name
//   tools     the tools Codex offers
//   thread    an event from another thread
import { basename } from "node:path";
import { createInterface } from "node:readline";

const CANARY = "ANSWER_CANARY_CX_51d0 my CV says";
const ID = "PRIVATE_CV_CANARY";
const LOWER = "privatecanary";
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
			if (scenario === "rpccode")
				return send({
					id: message.id,
					error: { code: ID, message: "codex app-server exited (1)" },
				});
			answer({ turn: { id: "turn_1" } });
			if (scenario === "kind") {
				notify("error", {
					willRetry: false,
					error: { message: ID, codexErrorInfo: ID },
				});
				notify("turn/completed", {
					turn: {
						id: "turn_1",
						status: LOWER,
						error: { message: ID, codexErrorInfo: { [LOWER]: { httpStatusCode: 500 } } },
					},
				});
			} else if (scenario === "retrykind")
				notify("error", {
					willRetry: true,
					error: { message: ID, codexErrorInfo: { [ID]: { httpStatusCode: 502 } } },
				});
			else if (scenario === "request")
				send({ id: 900, method: ID, params: { threadId: "thr_1", reason: ID } });
			else if (scenario === "item")
				notify("item/started", { item: { type: ID, id: LOWER } });
			else if (scenario === "rawtool")
				notify("rawResponseItem/completed", {
					item: { type: "function_call", name: LOWER, arguments: ID },
				});
			else if (scenario === "tools")
				notify("rawResponseItem/completed", {
					item: {
						type: "additional_tools",
						tools: [
							{ name: "functions", tools: [{ name: "exec" }, { name: ID }] },
							{ name: LOWER, tools: [{ name: LOWER }] },
						],
					},
				});
			else if (scenario === "thread")
				send({ method: ID, params: { threadId: "thr_other" } });
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
