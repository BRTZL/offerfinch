import type {
	Options,
	Query,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { fitAssessmentSchema } from "@offerfinch/core/scoring/fit";
import { SubscriptionUnavailableError } from "@offerfinch/core/scoring/llm";
import {
	meteredFor,
	type SpendStore,
	SUBSCRIPTION_BASIS,
} from "@offerfinch/core/scoring/metered";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Breaker } from "../src/breaker";
import {
	ClaudeSubscriptionProvider,
	jsonSchemaOf,
	resumeClaudeCalls,
	USAGE_PROBE_SYSTEM,
} from "../src/claude";

/**
 * The provider's decisions, against a scripted stand-in for the SDK's `query`: what it starts
 * the CLI with, when it lets the prompt go, how it reads limits, logouts and bad answers.
 */

interface Script {
	account?: Record<string, unknown>;
	/** Messages after the prompt was sent, one list per run. */
	runs?: SDKMessage[][];
	initTools?: string[];
	/** The plan's usage report; default: extra usage off. `"throw"`: the control fails. */
	usage?: Record<string, unknown> | "throw";
	/** After its messages, the session neither ends nor emits anything more. */
	hang?: boolean;
	/** After its messages, the stream fails (a lost connection, the CLI killed). */
	lose?: boolean;
	/** The message the lost stream throws; default "lost response". */
	loseWith?: string;
	/** Emitted before the prompt is read (a result here answers nothing that was sent). */
	early?: SDKMessage[];
}

const EXTRA_OFF = {
	rate_limits_available: true,
	rate_limits: {
		extra_usage: {
			is_enabled: false,
			monthly_limit: null,
			used_credits: null,
			utilization: null,
		},
	},
};

const SUBSCRIBED = {
	email: "owner@example.test",
	subscriptionType: "max",
	tokenSource: "claude.ai",
	apiKeySource: "none",
	apiProvider: "firstParty",
};

function init(tools = ["StructuredOutput"], cwd = ""): SDKMessage {
	return {
		type: "system",
		subtype: "init",
		apiKeySource: "none",
		claude_code_version: "test",
		cwd,
		tools,
		mcp_servers: [],
		model: "claude-sonnet-5-5",
		permissionMode: "dontAsk",
		slash_commands: [],
		output_style: "default",
		skills: [],
		plugins: [],
		uuid: "u",
		session_id: "s",
	} as unknown as SDKMessage;
}

function result(output: unknown, tokens = 100): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		structured_output: output,
		result: "",
		modelUsage: {
			"claude-sonnet-5-5": {
				inputTokens: tokens,
				outputTokens: tokens / 10,
				cacheReadInputTokens: 5,
				cacheCreationInputTokens: 0,
			},
		},
	} as unknown as SDKMessage;
}

function scripted(script: Script) {
	const seen: { options: Options; prompts: string[] }[] = [];
	const probes: Options[] = [];
	let run = 0;
	const query = ((params: {
		prompt: AsyncIterable<SDKUserMessage>;
		options: Options;
	}) => {
		// The extra-usage probe: login and usage report, never a prompt.
		if (params.options.systemPrompt === USAGE_PROBE_SYSTEM) {
			probes.push(params.options);
			const empty = (async function* (): AsyncGenerator<SDKMessage> {})();
			return Object.assign(empty, {
				initializationResult: () =>
					Promise.resolve({ account: script.account ?? SUBSCRIBED }),
				usage: async () => {
					if (script.usage === "throw")
						throw new Error("usage endpoint failed");
					return script.usage ?? EXTRA_OFF;
				},
				close: () => {},
			}) as unknown as Query;
		}
		const record = { options: params.options, prompts: [] as string[] };
		seen.push(record);
		const messages = script.runs?.[run++] ?? [];
		const lost = new Error(script.loseWith || "lost response");
		const ready = Promise.resolve({ account: script.account ?? SUBSCRIBED });
		// Like the isolated session: an abort closes it at once, and it ends as if cleanly.
		const aborted = () => params.options.abortController?.signal.aborted;
		async function* stream(): AsyncGenerator<SDKMessage> {
			for (const m of script.early ?? []) yield m;
			for await (const user of params.prompt) {
				record.prompts.push(String(user.message.content));
				yield init(script.initTools, params.options.cwd ?? "");
				for (const m of messages) {
					if (aborted()) return;
					yield m;
				}
				if (aborted()) return;
				if (script.lose) throw lost;
				if (script.hang) await new Promise(() => {});
				return;
			}
		}
		return Object.assign(stream(), {
			initializationResult: () => ready,
			usage: async () => {
				if (script.usage === "throw") throw new Error("usage endpoint failed");
				return script.usage ?? EXTRA_OFF;
			},
			close: () => {},
		}) as unknown as Query;
	}) as unknown as NonNullable<
		ConstructorParameters<typeof ClaudeSubscriptionProvider>[0]["query"]
	>;
	return { query, seen, probes };
}

const schema = z.object({ greeting: z.string() });
const request = (onUsage?: (u: unknown) => void) => ({
	task: "fit-score",
	system: "sys",
	prompt: "Say hi to owner@example.test",
	redact: ["owner@example.test"],
	schema,
	onUsage,
});

function provider(script: Script, drainMs?: number) {
	const { query, seen, probes } = scripted(script);
	return {
		seen,
		probes,
		claude: new ClaudeSubscriptionProvider({
			model: "claude-sonnet-5-5",
			ownerUserId: "u1",
			parentEnv: {
				PATH: "/usr/bin",
				HOME: "/Users/me",
				ANTHROPIC_API_KEY: "sk-ant-secret",
				OPENAI_API_KEY: "sk-secret",
			},
			query,
			breaker: new Breaker(),
			...(drainMs !== undefined ? { drainMs } : {}),
		}),
	};
}

describe("ClaudeSubscriptionProvider", () => {
	it("starts the CLI as a pure model call with no API key, and redacts the prompt", async () => {
		const { claude, seen } = provider({ runs: [[result({ greeting: "hi" })]] });
		const usage: unknown[] = [];
		await expect(
			claude.generateObject(request((u) => usage.push(u))),
		).resolves.toEqual({ greeting: "hi" });
		const options = seen[0]?.options;
		expect(options).toMatchObject({
			tools: [],
			settingSources: [],
			strictMcpConfig: true,
			mcpServers: {},
			plugins: [],
			skills: [],
			persistSession: false,
			permissionMode: "dontAsk",
			systemPrompt: "sys",
		});
		expect(options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(options?.env?.OPENAI_API_KEY).toBeUndefined();
		expect(JSON.stringify(options?.env)).not.toContain("secret");
		expect(options?.cwd).toMatch(/offerfinch-claude-/);
		expect(seen[0]?.prompts[0]).not.toContain("owner@example.test");
		expect(usage).toEqual([
			{
				model: "claude-sonnet-5-5",
				inputTokens: 100,
				outputTokens: 10,
				cachedInputTokens: 5,
				cacheWriteTokens: 0,
			},
		]);
		expect(claude.billing).toBe("subscription");
		expect(claude.name).toBe("claude-subscription:claude-sonnet-5-5");
	});

	it("sends nothing when the CLI would use an API key", async () => {
		const { claude, seen } = provider({
			account: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" },
		});
		const error = await claude.generateObject(request()).catch((e) => e);
		expect(error).toBeInstanceOf(SubscriptionUnavailableError);
		expect(error.kind).toBe("not_subscription");
		expect(seen.flatMap((r) => r.prompts)).toEqual([]);
	});

	it("sends nothing when logged out, and later calls fail fast without starting the CLI", async () => {
		const { claude, seen, probes } = provider({ account: {} });
		const first = await claude.generateObject(request()).catch((e) => e);
		expect(first.kind).toBe("logged_out");
		expect(first.message).toMatch(/Settings › Models/);
		// The probe saw the logout: no prompt session was started at all.
		expect(seen).toHaveLength(0);
		const second = await claude.generateObject(request()).catch((e) => e);
		expect(second).toBe(first);
		expect(probes).toHaveLength(1);
	});

	it("pauses on the plan's usage limit until its reset time", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3600;
		const { claude, seen } = provider({
			runs: [
				[
					{
						type: "rate_limit_event",
						rate_limit_info: {
							status: "rejected",
							resetsAt,
							rateLimitType: "five_hour",
						},
					} as unknown as SDKMessage,
				],
			],
		});
		const error = await claude.generateObject(request()).catch((e) => e);
		expect(error.kind).toBe("usage_limit");
		expect(error.resetsAt?.getTime()).toBe(resetsAt * 1000);
		expect(error.message).toMatch(/five_hour limit/);
		expect(error.message).toContain("Settings › Models");
		await claude.generateObject(request()).catch(() => {});
		expect(seen).toHaveLength(1);
	});

	it("sends nothing when extra usage is on for the Claude account", async () => {
		const { claude, seen } = provider({
			usage: {
				rate_limits_available: true,
				rate_limits: {
					extra_usage: {
						is_enabled: true,
						monthly_limit: 5000,
						used_credits: 0,
						utilization: 0,
						currency: "USD",
					},
				},
			},
			runs: [[result({ greeting: "hi" })]],
		});
		const error = await claude.generateObject(request()).catch((e) => e);
		expect(error).toBeInstanceOf(SubscriptionUnavailableError);
		expect(error.kind).toBe("extra_usage");
		expect(error.paid).toBe(false);
		expect(error.message).toMatch(/claude\.ai > Settings > Usage/);
		expect(seen.flatMap((r) => r.prompts)).toEqual([]);
	});

	it("sends nothing when the plan's usage cannot be read (fails closed)", async () => {
		for (const usage of [
			"throw" as const,
			{ rate_limits_available: false, rate_limits: null },
		]) {
			const { claude, seen } = provider({
				usage,
				runs: [[result({ greeting: "hi" })]],
			});
			const error = await claude.generateObject(request()).catch((e) => e);
			expect(error.kind).toBe("extra_usage");
			expect(seen.flatMap((r) => r.prompts)).toEqual([]);
		}
	});

	it("reads extra usage in a probe session that gets no prompt and may fetch the usage report; the prompt session keeps every switch", async () => {
		const { claude, seen, probes } = provider({
			runs: [[result({ greeting: "hi" })], [result({ greeting: "hi" })]],
		});
		await claude.generateObject(request());
		await claude.generateObject(request());
		// One probe trusted for a minute, two prompt sessions.
		expect(probes).toHaveLength(1);
		expect(probes[0]?.env).not.toHaveProperty(
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
		);
		expect(probes[0]?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(seen).toHaveLength(2);
		for (const run of seen)
			expect(run.options.env).toMatchObject({
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			});
	});

	it("reads a plan with no extra-usage entry as off", async () => {
		const { claude } = provider({
			usage: { rate_limits_available: true, rate_limits: { five_hour: null } },
			runs: [[result({ greeting: "hi" })]],
		});
		await expect(claude.generateObject(request())).resolves.toEqual({
			greeting: "hi",
		});
	});

	it("marks a call that drew on extra usage as paid, and stops every later caller", async () => {
		for (const info of [
			{ status: "allowed_warning", isUsingOverage: true },
			{ status: "allowed", overageInUse: true },
			{ status: "rejected", overageStatus: "allowed" },
		]) {
			const { claude, seen } = provider({
				runs: [
					[
						{
							type: "rate_limit_event",
							rate_limit_info: info,
						} as unknown as SDKMessage,
						result({ greeting: "hi" }),
					],
				],
			});
			const error = await claude.generateObject(request()).catch((e) => e);
			expect(error).toBeInstanceOf(SubscriptionUnavailableError);
			expect(error.kind).toBe("extra_usage");
			expect(error.paid).toBe(true);
			await claude.generateObject(request()).catch(() => {});
			expect(seen).toHaveLength(1);
		}
	});

	it("discards the answer of a session that shows a tool", async () => {
		const { claude } = provider({
			initTools: ["StructuredOutput", "Bash"],
			runs: [[result({ greeting: "hi" })]],
		});
		const error = await claude.generateObject(request()).catch((e) => e);
		expect(error.kind).toBe("boundary");
		expect(error.message).toMatch(/tools Bash/);
	});

	it("sends one prompt for a bad answer, reports its tokens, and fails without a repair", async () => {
		const usage: { inputTokens: number }[] = [];
		const sent: number[] = [];
		const { claude, seen } = provider({
			runs: [[result({ wrong: 1 }, 100)], [result({ greeting: "hi" }, 200)]],
		});
		await expect(
			claude.generateObject({
				...request((u) => usage.push(u as never)),
				onModelCall: () => sent.push(1),
			}),
		).rejects.toBeInstanceOf(z.ZodError);
		// Exactly the request the caller reserved for: one run, the prompt unchanged.
		expect(seen).toHaveLength(1);
		expect(seen[0]?.prompts).toHaveLength(1);
		expect(seen[0]?.prompts[0]).not.toMatch(/previous_answer|did not match/);
		expect(sent).toHaveLength(1);
		expect(usage.map((u) => u.inputTokens)).toEqual([100]);
	});

	it("reports the prompt it sends for the call budget, a refused login none", async () => {
		const sent: number[] = [];
		const answered = provider({ runs: [[result({ greeting: "hi" })]] });
		await answered.claude.generateObject({
			...request(),
			onModelCall: () => sent.push(1),
		});
		expect(sent).toHaveLength(1);
		const refused = provider({ account: {} });
		const none: number[] = [];
		await refused.claude
			.generateObject({ ...request(), onModelCall: () => none.push(1) })
			.catch(() => {});
		expect(none).toEqual([]);
	});

	it("reports the tokens of an answer that came back as an error", async () => {
		const usage: { inputTokens: number }[] = [];
		const { claude } = provider({
			runs: [
				[
					{
						type: "result",
						subtype: "error_during_execution",
						is_error: true,
						errors: ["something broke"],
						modelUsage: {
							"claude-sonnet-5-5": {
								inputTokens: 40,
								outputTokens: 4,
								cacheReadInputTokens: 0,
								cacheCreationInputTokens: 0,
							},
						},
					} as unknown as SDKMessage,
				],
			],
		});
		await expect(
			claude.generateObject(request((u) => usage.push(u as never))),
		).rejects.toThrow(/returned no answer: error_during_execution/);
		expect(usage.map((u) => u.inputTokens)).toEqual([40]);
	});

	it("refuses to be built without an owner", () => {
		expect(
			() =>
				new ClaudeSubscriptionProvider({
					model: "claude-sonnet-5-5",
					ownerUserId: "",
				}),
		).toThrow(/owner's account id/);
	});
});

describe("the session log", () => {
	it("keeps the session's key source apart from the login's fields", async () => {
		const logged: Record<string, unknown>[] = [];
		const { query } = scripted({ runs: [[result({ greeting: "hi" })]] });
		const claude = new ClaudeSubscriptionProvider({
			model: "claude-sonnet-5-5",
			ownerUserId: "u1",
			parentEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-secret" },
			query,
			breaker: new Breaker(),
			log: (_message, data) => logged.push(data ?? {}),
		});
		await claude.generateObject(request());
		expect(logged[0]).toMatchObject({
			apiKeySource: "none",
			tools: ["StructuredOutput"],
			auth: { subscriptionType: "max", apiKeySource: "none" },
			removedEnv: ["ANTHROPIC_API_KEY"],
		});
		expect(JSON.stringify(logged)).not.toContain("secret");
	});
});

/**
 * Message sequences the real CLI (Claude Code 2.1.315) emitted against a local capture server,
 * replayed: a 429, a 401, and a StructuredOutput that failed the CLI's schema check. Each made
 * one request (CLAUDE_CODE_MAX_RETRIES=0, MAX_STRUCTURED_OUTPUT_RETRIES=1).
 */
describe("what the real CLI emits", () => {
	const apiError = (error: string, text: string): SDKMessage[] => [
		{
			type: "assistant",
			error,
			message: { role: "assistant", content: [{ type: "text", text }] },
		} as unknown as SDKMessage,
		{
			type: "result",
			subtype: "success",
			is_error: true,
			result: text,
			modelUsage: {},
		} as unknown as SDKMessage,
	];

	it("a 429 pauses for the usage limit, never a plain error the step would retry", async () => {
		const { claude } = provider({
			runs: [
				apiError(
					"rate_limit",
					"API Error: Request rejected (429) · Number of requests has exceeded your rate limit",
				),
			],
		});
		const error = await claude.generateObject(request()).catch((e) => e);
		expect(error).toBeInstanceOf(SubscriptionUnavailableError);
		expect(error.kind).toBe("usage_limit");
	});

	it("a 401 pauses as logged out", async () => {
		const { claude } = provider({
			runs: [
				apiError(
					"authentication_failed",
					"Invalid API key · Fix external API key",
				),
			],
		});
		const error = await claude.generateObject(request()).catch((e) => e);
		expect(error.kind).toBe("logged_out");
	});

	it("an answer that fails the CLI's schema check is one failed call, its tokens reported", async () => {
		const failed = {
			type: "result",
			subtype: "error_max_structured_output_retries",
			is_error: true,
			errors: [
				"Failed to provide valid structured output after 1 attempts — last StructuredOutput error: Output does not match required schema: root: must have required property 'greeting'",
			],
			modelUsage: {
				"claude-sonnet-5-5": {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
				},
			},
		} as unknown as SDKMessage;
		const usage: { outputTokens: number }[] = [];
		const { claude, seen } = provider({
			runs: [[failed], [result({ greeting: "hi" })]],
		});
		await expect(
			claude.generateObject(request((u) => usage.push(u as never))),
		).rejects.toThrow(/must have required property 'greeting'/);
		expect(seen).toHaveLength(1);
		expect(usage.map((u) => u.outputTokens)).toEqual([5]);
	});

	it("reports the main loop's tokens when a failed answer has no per-model usage, and none when all are zero", async () => {
		const failed = (tokens: number) =>
			({
				type: "result",
				subtype: "error_max_structured_output_retries",
				is_error: true,
				errors: ["Output does not match required schema"],
				modelUsage: {},
				usage: {
					input_tokens: tokens,
					output_tokens: tokens / 10,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			}) as unknown as SDKMessage;
		const usage: { model: string; inputTokens: number }[] = [];
		const { claude } = provider({ runs: [[failed(400)], [failed(0)]] });
		for (let i = 0; i < 2; i++)
			await expect(
				claude.generateObject(request((u) => usage.push(u as never))),
			).rejects.toThrow(/no valid structured output/);
		expect(usage).toEqual([
			expect.objectContaining({
				model: "claude-sonnet-5-5",
				inputTokens: 400,
				outputTokens: 40,
			}),
		]);
	});

	it("does not require a fit status of the model (it may be omitted), and keeps every other field required", () => {
		const json = jsonSchemaOf(fitAssessmentSchema) as {
			properties: {
				requirements: {
					items: {
						required: string[];
						additionalProperties: boolean;
						properties: Record<string, { enum?: string[] }>;
					};
				};
			};
			required: string[];
		};
		const item = json.properties.requirements.items;
		expect(item.required).toEqual([
			"requirement",
			"importance",
			"evidence",
			"note",
		]);
		expect(item.additionalProperties).toBe(false);
		expect(item.properties.status?.enum).toEqual([
			"met",
			"partial",
			"not_met",
			"unknown",
		]);
		expect(json.required).toEqual(["requirements", "summary"]);
	});

	describe("billing from the session", () => {
		const invalid = {
			type: "result",
			subtype: "error_max_structured_output_retries",
			is_error: true,
			errors: ["Output does not match required schema"],
			modelUsage: {},
		} as unknown as SDKMessage;
		const crash = {
			type: "result",
			subtype: "error_during_execution",
			is_error: true,
			errors: ["the CLI crashed"],
			modelUsage: {},
		} as unknown as SDKMessage;
		const overage = {
			type: "rate_limit_event",
			rate_limit_info: { status: "allowed", overageInUse: true },
		} as unknown as SDKMessage;
		const retry = {
			type: "system",
			subtype: "api_retry",
			error: "server_error",
			error_status: 500,
		} as unknown as SDKMessage;
		/** The provider with its log captured: the warnings an unclear ending writes. */
		function logged(script: Script, drainMs?: number) {
			const warnings: string[] = [];
			const { query, seen } = scripted(script);
			const claude = new ClaudeSubscriptionProvider({
				model: "claude-sonnet-5-5",
				ownerUserId: "u1",
				parentEnv: { PATH: "/usr/bin", HOME: "/Users/me" },
				query,
				breaker: new Breaker(),
				log: (message) => {
					if (message.startsWith("warning")) warnings.push(message);
				},
				...(drainMs !== undefined ? { drainMs } : {}),
			});
			return { claude, warnings, seen };
		}
		const outcome = async (script: Script, drainMs?: number) => {
			const { claude, warnings } = logged(script, drainMs);
			const answer = await claude.generateObject(request()).catch((e) => e);
			return {
				error:
					answer instanceof Error
						? (answer as SubscriptionUnavailableError)
						: null,
				answer,
				warnings,
			};
		};

		it("fails an answer that failed the schema as an ordinary unpaid call", async () => {
			const { error, warnings } = await outcome({ runs: [[invalid]] });
			expect(error?.message).toMatch(/no valid structured output/);
			expect(error?.paid).toBeFalsy();
			expect(warnings).toEqual([]);
		});

		it("a sign of paid extra usage wins wherever it is seen", async () => {
			for (const run of [
				[overage, invalid],
				[invalid, overage],
				[overage, retry],
				[result({ greeting: "hi" }), overage],
			]) {
				const { error } = await outcome({ runs: [run] });
				expect(error).toBeInstanceOf(SubscriptionUnavailableError);
				expect(error?.paid).toBe(true);
			}
		});

		it("keeps the answer of a session still open after it, logs a warning, and never calls it paid", async () => {
			const started = Date.now();
			const ok = await outcome(
				{ runs: [[result({ greeting: "hi" })]], hang: true },
				50,
			);
			expect(ok.answer).toEqual({ greeting: "hi" });
			expect(ok.warnings).toHaveLength(1);
			const bad = await outcome({ runs: [[invalid]], hang: true }, 50);
			expect(bad.error?.message).toMatch(/no valid structured output/);
			expect(bad.error?.paid).toBeFalsy();
			expect(Date.now() - started).toBeLessThan(5_000);
		});

		it("keeps a valid answer from a session that also failed, logs a warning, and stops nothing", async () => {
			const ok = result({ greeting: "hi" });
			for (const script of [
				{ runs: [[ok, crash], [ok]] },
				{ runs: [[crash, ok], [ok]] },
				{ runs: [[ok], [ok]], lose: true },
			] as Script[]) {
				const { claude, warnings, seen } = logged(script);
				await expect(claude.generateObject(request())).resolves.toEqual({
					greeting: "hi",
				});
				expect(warnings).toHaveLength(1);
				// No breaker trip: the next call is sent.
				await claude.generateObject(request()).catch(() => {});
				expect(seen).toHaveLength(2);
			}
			// A clean answer logs nothing.
			const clean = await outcome({ runs: [[ok]] });
			expect(clean.warnings).toEqual([]);
		});

		describe("a session that failed around its answer (Codex repros of 39848ba)", () => {
			const res = (
				subtype: string,
				output: unknown,
				tokens: number,
			): SDKMessage =>
				({
					type: "result",
					subtype,
					is_error: subtype !== "success",
					errors: ["crashed"],
					result: "",
					structured_output: output,
					modelUsage: {},
					usage: {
						input_tokens: tokens,
						output_tokens: tokens / 2,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}) as unknown as SDKMessage;
			const serverError = {
				type: "assistant",
				error: "server_error",
				message: { role: "assistant", content: [] },
			} as unknown as SDKMessage;
			/** Records every settlement like the store; refuses nothing itself. */
			function recordingStore() {
				const rows: {
					status: string;
					basis?: string;
					modelCalls?: number;
					costMicros?: number;
					billing?: string;
				}[] = [];
				const stops: string[] = [];
				const store = {
					reserveSpend: async () => {
						rows.push({ status: "reserved" });
						return { ok: true as const, id: String(rows.length - 1) };
					},
					settleSpend: async (
						id: string,
						x: Parameters<SpendStore["settleSpend"]>[1],
					) => {
						Object.assign(rows[Number(id)] ?? {}, { status: "settled", ...x });
					},
					holdSpend: async () => {
						throw new Error("a subscription call is never held");
					},
					recordPaidStop: async (_user: string, vendor: string) => {
						stops.push(vendor);
					},
					recordRefusal: async () => {},
				} as unknown as SpendStore;
				return { rows, store, stops };
			}
			const modes = (output: unknown, tokens: number) => ({
				"success-crash": {
					runs: [
						[
							res("success", output, tokens),
							res("error_during_execution", null, 0),
						],
					],
				},
				"crash-success": {
					runs: [
						[
							res("error_during_execution", null, 0),
							res("success", output, tokens),
						],
					],
				},
				"success-stream-error": {
					runs: [[res("success", output, tokens)]],
					lose: true,
				},
				"invalid-assistant-error": {
					runs: [
						[
							serverError,
							res("error_max_structured_output_retries", null, tokens),
						],
					],
				},
				"success-still-open": {
					runs: [[res("success", output, tokens)]],
					hang: true,
				},
			});
			const schemaOk = z.object({ ok: z.boolean() });
			const call = (claude: ClaudeSubscriptionProvider, store: SpendStore) =>
				meteredFor(claude, store, "u1", null)
					.generateObject({
						task: "fit-score",
						system: "s",
						prompt: "p",
						schema: schemaOk,
					})
					.catch((e: unknown) => e as Error);

			it("settles at $0 on the plan whether the answer passed the schema or not, tokens or not", async () => {
				for (const [output, tokens] of [
					[{ ok: true }, 0],
					[{ wrong: true }, 10],
				] as const)
					for (const [mode, script] of Object.entries(modes(output, tokens))) {
						const { rows, store, stops } = recordingStore();
						const { claude } = provider(script as Script, 50);
						const result = await call(claude, store);
						const label = `${mode} ${JSON.stringify(output)}`;
						expect(rows[0], label).toMatchObject({
							status: "settled",
							costMicros: 0,
							basis: SUBSCRIPTION_BASIS,
							modelCalls: 1,
						});
						expect(rows[0]?.billing, label).not.toBe("api");
						expect(stops, label).toEqual([]);
						// A valid answer is returned; an invalid one fails.
						if ("ok" in output && mode !== "invalid-assistant-error")
							expect(result, label).toEqual({ ok: true });
						else expect(result, label).toBeInstanceOf(Error);
					}
			});

			it("never stops the next Claude call", async () => {
				for (const [mode, script] of Object.entries(modes({ ok: true }, 0))) {
					const { rows, store } = recordingStore();
					const { claude, seen } = provider(
						{
							...(script as Script),
							runs: [
								...((script as Script).runs ?? []),
								[result({ ok: true })],
							],
							hang: false,
						},
						50,
					);
					await call(claude, store);
					expect(await call(claude, store), mode).toEqual({ ok: true });
					expect(seen, mode).toHaveLength(2);
					expect(rows[1]).toMatchObject({ status: "settled", modelCalls: 1 });
				}
			});

			it("settles an answer that failed the schema at $0 when the SDK only repeats its error result on exit", async () => {
				// The 2026-11-03 false hold: the CLI's result is error_max_structured_output_retries,
				// then the pinned SDK throws "Claude Code returned an error result: ..." as it exits.
				const { rows, store, stops } = recordingStore();
				const { query, seen } = scripted({
					runs: [
						[res("error_max_structured_output_retries", null, 0)],
						[result({ ok: true })],
					],
					lose: true,
					loseWith:
						"Claude Code returned an error result: Output does not match required schema",
				});
				const warnings: string[] = [];
				const claude = new ClaudeSubscriptionProvider({
					model: "claude-sonnet-5-5",
					ownerUserId: "u1",
					parentEnv: { PATH: "/usr/bin", HOME: "/Users/me" },
					query,
					breaker: new Breaker(),
					log: (message) => {
						if (message.startsWith("warning")) warnings.push(message);
					},
				});
				const first = await call(claude, store);
				expect(first).toBeInstanceOf(Error);
				expect((first as SubscriptionUnavailableError).paid).toBeFalsy();
				expect(rows[0]).toMatchObject({
					status: "settled",
					costMicros: 0,
					basis: SUBSCRIPTION_BASIS,
					modelCalls: 1,
				});
				expect(rows[0]?.billing).not.toBe("api");
				expect(stops).toEqual([]);
				// The repeat is not a session failure: nothing unclear is logged.
				expect(warnings).toEqual([]);
				// No breaker trip: the next call is sent.
				expect(await call(claude, store)).toEqual({ ok: true });
				expect(seen).toHaveLength(2);
			});

			it("keeps a vendor refusal (a 429) released", async () => {
				const { rows, store } = recordingStore();
				const { claude } = provider({
					runs: [
						[
							{
								type: "assistant",
								error: "rate_limit",
								message: { role: "assistant", content: [] },
							} as unknown as SDKMessage,
							{
								type: "result",
								subtype: "success",
								is_error: true,
								result: "429",
								modelUsage: {},
							} as unknown as SDKMessage,
						],
					],
				});
				const error = await call(claude, store);
				expect((error as SubscriptionUnavailableError).kind).toBe(
					"usage_limit",
				);
				expect(rows[0]).toMatchObject({
					status: "settled",
					costMicros: 0,
					modelCalls: 1,
				});
			});

			it("records a paid call as api at its estimated price and stops Claude", async () => {
				const { rows, store, stops } = recordingStore();
				const { claude, seen } = provider({
					runs: [
						[res("success", { ok: true }, 1_000), overage],
						[result({ ok: true })],
					],
				});
				const error = await call(claude, store);
				expect((error as SubscriptionUnavailableError).paid).toBe(true);
				expect(rows[0]).toMatchObject({ status: "settled", billing: "api" });
				expect(rows[0]?.costMicros).toBeGreaterThan(0);
				expect(rows[0]?.basis).toMatch(/Claude plan/);
				expect(stops).toEqual(["anthropic"]);
				// This process's breaker stops the next call before it is sent.
				const next = await call(claude, store);
				expect((next as SubscriptionUnavailableError).kind).toBe("extra_usage");
				expect(seen).toHaveLength(1);
			});
		});

		describe("resuming Claude after a paid call (Settings > Models)", () => {
			it("lifts only the extra-usage pause: a usage limit or logout stays", () => {
				const now = new Date();
				for (const kind of ["usage_limit", "logged_out"] as const) {
					const breaker = new Breaker();
					breaker.trip(new SubscriptionUnavailableError(kind, "p", "x"), now);
					resumeClaudeCalls(breaker);
					expect(breaker.current(now)?.kind).toBe(kind);
				}
				const breaker = new Breaker();
				breaker.trip(
					new SubscriptionUnavailableError(
						"extra_usage",
						"p",
						"x",
						undefined,
						true,
					),
					now,
				);
				resumeClaudeCalls(breaker);
				expect(breaker.current(now)).toBeNull();
			});

			it("paid, stopped, resumed: the next call is sent, in the same process", async () => {
				const { query, seen } = scripted({
					runs: [
						[result({ ok: true }), overage],
						[result({ ok: true })],
						[result({ ok: true })],
					],
				});
				// The process-wide breaker, as the worker's provider has it.
				const claude = new ClaudeSubscriptionProvider({
					model: "claude-sonnet-5-5",
					ownerUserId: "u1",
					parentEnv: { PATH: "/usr/bin", HOME: "/Users/me" },
					query,
				});
				// Gates like the SQLite store: a paid Claude call stops Claude until resumed.
				let stopped = false;
				const store = {
					reserveSpend: async () =>
						stopped
							? {
									ok: false as const,
									reason: "vendor_stopped" as const,
									detail: "Claude used paid extra usage. Calls are stopped.",
								}
							: { ok: true as const, id: "1" },
					settleSpend: async () => {},
					holdSpend: async () => {},
					recordPaidStop: async () => {
						stopped = true;
					},
					recordRefusal: async () => {},
				} as unknown as SpendStore;
				const call = () =>
					meteredFor(claude, store, "u1", null)
						.generateObject({
							task: "fit-score",
							system: "s",
							prompt: "p",
							schema: z.object({ ok: z.boolean() }),
						})
						.catch((e: unknown) => e as Error);
				try {
					expect((await call()) as SubscriptionUnavailableError).toMatchObject({
						paid: true,
					});
					// Stopped: by the store, and by this process's breaker.
					expect(await call()).toBeInstanceOf(SubscriptionUnavailableError);
					// The user resumes Claude in the store only: the breaker still stops it.
					stopped = false;
					expect(await call()).toBeInstanceOf(SubscriptionUnavailableError);
					expect(seen).toHaveLength(1);
					resumeClaudeCalls();
					expect(await call()).toEqual({ ok: true });
					expect(seen).toHaveLength(2);
				} finally {
					resumeClaudeCalls();
				}
			});
		});

		it("a sign of paid after this side aborted is not seen", async () => {
			const { error } = await outcome({ runs: [[retry, overage]] });
			expect(error?.paid).toBeFalsy();
		});
	});

	it("passes the request's output limit to the CLI", async () => {
		const { claude, seen } = provider({ runs: [[result({ greeting: "hi" })]] });
		await claude.generateObject({ ...request(), maxTokens: 4_000 });
		expect(seen[0]?.options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("4000");
	});
});

describe("plan usage reads", () => {
	const PLAN_USAGE = {
		subscription_type: "max",
		rate_limits_available: true,
		rate_limits: {
			...EXTRA_OFF.rate_limits,
			five_hour: { utilization: 20, resets_at: "2026-11-04T14:00:00Z" },
			seven_day: { utilization: 5, resets_at: "2026-11-09T00:00:00Z" },
		},
	};
	const rateLimitEvent = (utilization: number): SDKMessage =>
		({
			type: "rate_limit_event",
			rate_limit_info: {
				status: "allowed",
				rateLimitType: "five_hour",
				utilization,
				resetsAt: Date.parse("2026-11-04T14:00:00Z") / 1000,
			},
			uuid: "u",
			session_id: "s",
		}) as unknown as SDKMessage;

	it("reports the probe's full read, then the call's own window as it answers", async () => {
		const events: string[] = [];
		const { query } = scripted({
			usage: PLAN_USAGE,
			runs: [[rateLimitEvent(0.23), result({ greeting: "hi" })]],
		});
		const claude = new ClaudeSubscriptionProvider({
			model: "claude-sonnet-5-5",
			ownerUserId: "u1",
			parentEnv: { PATH: "/usr/bin", HOME: "/Users/me" },
			query,
			breaker: new Breaker(),
			planUsage: {
				baselineNeeded: () => false,
				sample: (s) =>
					events.push(
						`probe:${s.complete}:${s.windows.map((w) => `${w.id}=${w.usedPercent}`).join(",")}:${s.account?.plan}`,
					),
				call: () => ({
					sent: () => events.push("sent"),
					sample: (s) =>
						events.push(
							`call:${s.complete}:${s.windows.map((w) => `${w.id}=${w.usedPercent}`).join(",")}`,
						),
					done: () => events.push("done"),
				}),
			},
		});
		await expect(claude.generateObject(request())).resolves.toEqual({
			greeting: "hi",
		});
		expect(events).toEqual([
			"probe:true:five_hour=20,seven_day=5:max",
			"sent",
			"call:false:five_hour=23",
			"done",
		]);
	});

	it("ends the call's handle without a send when the login is refused", async () => {
		const events: string[] = [];
		const { query } = scripted({
			usage: PLAN_USAGE,
			account: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" },
		});
		const claude = new ClaudeSubscriptionProvider({
			model: "claude-sonnet-5-5",
			ownerUserId: "u1",
			parentEnv: { PATH: "/usr/bin", HOME: "/Users/me" },
			query,
			breaker: new Breaker(),
			planUsage: {
				baselineNeeded: () => false,
				sample: () => events.push("probe"),
				call: () => ({
					sent: () => events.push("sent"),
					sample: () => events.push("call"),
					done: () => events.push("done"),
				}),
			},
		});
		await expect(claude.generateObject(request())).rejects.toBeInstanceOf(
			SubscriptionUnavailableError,
		);
		// The probe read the plan (null-login probes report nothing); no call handle was opened.
		expect(events).toEqual([]);
	});
});

describe("plan usage baseline", () => {
	it("probes again before a call when the last read is stale, even while extra usage is trusted", async () => {
		let stale = false;
		const { query, probes } = scripted({
			usage: EXTRA_OFF,
			runs: [
				[result({ greeting: "hi" })],
				[result({ greeting: "hi" })],
				[result({ greeting: "hi" })],
			],
		});
		const claude = new ClaudeSubscriptionProvider({
			model: "claude-sonnet-5-5",
			ownerUserId: "u1",
			parentEnv: { PATH: "/usr/bin", HOME: "/Users/me" },
			query,
			breaker: new Breaker(),
			planUsage: {
				baselineNeeded: () => stale,
				sample: () => {},
				call: () => ({ sent: () => {}, sample: () => {}, done: () => {} }),
			},
		});
		await claude.generateObject(request());
		await claude.generateObject(request());
		// Within the minute: the second call trusted the first probe.
		expect(probes).toHaveLength(1);
		stale = true;
		await claude.generateObject(request());
		expect(probes).toHaveLength(2);
	});
});
