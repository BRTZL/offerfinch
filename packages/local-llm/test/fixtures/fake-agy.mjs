// A stand-in for Google's Antigravity ACP server 1.4.1 for the provider tests: newline JSON-RPC
// over stdio, the 1.4.1 handshake shapes, and the model request sent to AGY_ACP_CCPA_BASE_URL
// like the real server does. The scenario is the first argument.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "ok";
const env = process.env;
// What the test reads back through `inspectRoot` (TMPDIR is inside the call's root).
writeFileSync(
	join(env.TMPDIR ?? "/tmp", "fake-agy.json"),
	JSON.stringify({ env, argv: process.argv.slice(2), cwd: process.cwd() }),
);

const send = (message) =>
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, u) =>
	send({ method: "session/update", params: { sessionId, update: u } });
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
	new Promise((resolve) => {
		const id = nextId++;
		waiting.set(id, resolve);
		send({ id, method, params });
	});

const families = [
	["gemini-4-argon", "Gemini 4 Argon"],
	["gemini-3.8-flash", "Gemini 3.8 Flash"],
	["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
];
const config = { model: "gemini-3.8-flash", thinking_level: "high" };
const configOptions = () => [
	{
		id: "model",
		currentValue: config.model,
		options: families.map(([value, name]) => ({ value, name })),
	},
	{
		id: "thinking_level",
		currentValue: config.thinking_level,
		options: ["low", "medium", "high"].map((value) => ({ value, name: value })),
	},
];
const slugs = [
	...["gemini-4-argon", "gemini-3.8-flash"].flatMap((f) =>
		["low", "medium", "high"].map((l) => `${f}-${l}`),
	),
	"gpt-oss-120b-medium",
];

function browse(url) {
	spawnSync(env.BROWSER, [url], { stdio: "ignore" });
}

async function generate(extra = {}) {
	const slug =
		config.model === "gpt-oss-120b-medium"
			? config.model
			: `${config.model}-${config.thinking_level}`;
	const body = {
		project: "aicode-consumers",
		model: slug,
		request: {
			contents: [{ role: "user", parts: [{ text: "<USER_REQUEST>…" }] }],
			generationConfig: { maxOutputTokens: 65536 },
			toolConfig: { functionCallingConfig: { mode: "AUTO" } },
			...extra,
		},
	};
	const res = await fetch(
		`${env.AGY_ACP_CCPA_BASE_URL}/v1internal:streamGenerateContent?alt=sse`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer fake-access-token",
			},
			body: JSON.stringify(body),
		},
	);
	return { status: res.status, text: await res.text() };
}

function answerText(sse) {
	let text = "";
	let call = false;
	for (const line of sse.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const r = JSON.parse(line.slice(5)).response;
		for (const part of r?.candidates?.[0]?.content?.parts ?? []) {
			if (part.text) text += part.text;
			if (part.functionCall) call = true;
		}
	}
	return { text, call };
}

async function prompt(id, params) {
	const sid = params.sessionId;
	if (scenario === "tool-call") {
		update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "view_file" });
		await new Promise((r) => setTimeout(r, 5000));
	}
	if (scenario === "permission") {
		const answer = await ask("session/request_permission", {
			sessionId: sid,
			options: [{ optionId: "allow", kind: "allow_once" }],
		});
		writeFileSync(join(env.TMPDIR, "permission-answer.json"), JSON.stringify(answer));
		await new Promise((r) => setTimeout(r, 5000));
	}
	if (scenario === "fs") {
		await ask("fs/read_text_file", { sessionId: sid, path: "/etc/hosts" });
		await new Promise((r) => setTimeout(r, 5000));
	}
	const first = await generate(scenario === "tools" ? { tools: [{ functionDeclarations: [] }] } : {});
	let text;
	if (first.status !== 200) {
		text = scenario === "quota"
			? "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 4 hours, 12 minutes."
			: (JSON.parse(first.text).error?.message ?? "error");
	} else {
		const read = answerText(first.text);
		text = read.text;
		if (read.call) {
			// As 1.4.1 does after an unknown_tool rejection: one more model request.
			const second = await generate();
			text = second.status === 200 ? answerText(second.text).text : "gate refused";
		}
		if (first.status === 200)
			update(sid, { sessionUpdate: "usage_update", used: 3754, size: 1048576 });
	}
	for (const chunk of [text.slice(0, 5), text.slice(5)])
		if (chunk)
			update(sid, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: chunk },
			});
	send({ id, result: { stopReason: "end_turn" } });
}

async function handle(m) {
	if (m.id !== undefined && !m.method) {
		waiting.get(m.id)?.(m.result ?? m.error);
		waiting.delete(m.id);
		return;
	}
	const { id, method, params } = m;
	switch (method) {
		case "initialize":
			return send({
				id,
				result: {
					protocolVersion: 1,
					agentInfo: {
						name: "antigravity-acp",
						version: scenario === "old-version" ? "1.3.0" : "1.4.1",
					},
				},
			});
		case "authenticate": {
			const token = join(env.GEMINI_HOME, "antigravity-acp", "acp_token.json");
			if (scenario === "sign-in" || scenario === "sign-in-bad-url") {
				browse(
					scenario === "sign-in"
						? "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2F"
						: "https://evil.example/o/oauth2?redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2F",
				);
				await new Promise((r) => setTimeout(r, 500));
				mkdirSync(join(env.GEMINI_HOME, "antigravity-acp"), { recursive: true });
				writeFileSync(token, '{"refresh_token":"fake"}');
				writeFileSync(join(env.GEMINI_HOME, "antigravity-acp", "brain.db"), "x");
				return send({ id, result: {} });
			}
			if (scenario === "logged-out") {
				browse(
					"https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2F",
				);
				return; // blocks, as the real server does while it waits for the browser
			}
			return send({
				id,
				result: { _meta: { antigravity: { tier: { name: "Google AI Pro" } } } },
			});
		}
		case "session/new":
			if (scenario === "list") {
				const res = await fetch(
					`${env.AGY_ACP_CCPA_BASE_URL}/v1internal:fetchAvailableModels?alt=json`,
					{ method: "POST", body: "{}" },
				);
				await res.text();
			}
			return send({
				id,
				result: {
					sessionId: "s1",
					configOptions: configOptions(),
					models: { availableModels: slugs.map((modelId) => ({ modelId })) },
				},
			});
		case "session/set_mode":
			return send({ id, result: {} });
		case "session/set_config_option":
			config[params.configId] = params.value;
			return send({ id, result: { configOptions: configOptions() } });
		case "session/prompt":
			return prompt(id, params);
		default:
			return send({ id, error: { code: -32601, message: "unknown" } });
	}
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (line.trim()) void handle(JSON.parse(line));
});
