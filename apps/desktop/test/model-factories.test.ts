import { priceOf } from "@offerfinch/core/scoring/pricing";
import { describe, expect, it } from "vitest";

import {
	createClaimsLlm,
	createLlm,
	createPipelineDeps,
	createTailorLlm,
	type LocalLlmFactory,
} from "../src/worker/model-factories";

describe("createLlm", () => {
	it("treats empty model settings as unset", () => {
		expect(
			createLlm({ scoringProvider: "", anthropicKey: "sk-test" }).name,
		).toBe("anthropic:claude-opus-5-5");
		expect(
			createLlm({
				scoringProvider: "",
				anthropicKey: "sk-test",
				scoringModel: "",
			}).name,
		).toBe("anthropic:claude-opus-5-5");
	});

	it("fails loudly without a key unless the fake is allowed or asked for", () => {
		expect(() => createLlm({ scoringProvider: "", anthropicKey: "" })).toThrow(
			/No LLM configured/,
		);
		expect(createLlm({}, { allowFake: true }).name).toBe("fake");
		expect(createLlm({ scoringProvider: "fake" }).name).toBe("fake");
	});
});

describe("createTailorLlm", () => {
	const env = { anthropicKey: "sk-test" };
	it("tailors with Sonnet by default, TAILOR_MODEL overriding, while scoring keeps Opus", () => {
		const llm = createLlm(env);
		expect(llm.name).toBe("anthropic:claude-opus-5-5");
		expect(createTailorLlm(env, llm).name).toBe("anthropic:claude-sonnet-5-5");
		expect(
			createTailorLlm({ ...env, scoringModel: "claude-opus-5" }, llm).name,
		).toBe("anthropic:claude-sonnet-5-5");
		expect(
			createTailorLlm({ ...env, tailoringModel: "claude-opus-5-5" }, llm).name,
		).toBe("anthropic:claude-opus-5-5");
		expect(createTailorLlm({ ...env, tailoringEffort: "low" }, llm).name).toBe(
			"anthropic:claude-sonnet-5-5",
		);
		expect(() =>
			createTailorLlm({ ...env, tailoringEffort: "lowest" }, llm),
		).toThrow(/Unknown effort "lowest"/);
		const fake = createLlm({ scoringProvider: "fake" });
		expect(createTailorLlm({}, fake)).toBe(fake);
	});

	it("prices the tailoring default from the table, not the fallback rate", () => {
		expect(priceOf("claude-sonnet-5-5")).toMatchObject({
			input: 2,
			cachedInput: 0.2,
			output: 10,
		});
	});
});

describe("createClaimsLlm", () => {
	it("uses OpenAI when configured, needs a model, and never the tailoring provider", () => {
		expect(
			createClaimsLlm({ openaiKey: "sk-o", openaiModel: "model-x" }).name,
		).toBe("openai:model-x");
		expect(() => createClaimsLlm({ openaiKey: "sk-o" })).toThrow(
			/OPENAI_MODEL/,
		);
		expect(() =>
			createClaimsLlm({ claimsProvider: "", openaiKey: "" }),
		).toThrow(/No claims-check LLM configured/);
		expect(createClaimsLlm({}, { allowFake: true }).name).toBe("fake");
		expect(() =>
			createClaimsLlm(
				{ openaiKey: "sk-o", openaiModel: "m" },
				{
					tailoring: {
						name: "openai:m",
						generateObject: async () => ({}) as never,
					},
				},
			),
		).toThrow(/different provider/);
	});
});

describe("createPipelineDeps", () => {
	it("builds a worker pipeline with only an Anthropic key, leaving the claims model unset", () => {
		const deps = createPipelineDeps({
			env: {
				scoringProvider: "",
				anthropicKey: "sk-test",
				claimsProvider: "",
				openaiKey: "",
				openaiModel: "",
			},
			db: {} as never,
			workflows: {} as never,
		});
		expect(deps.llm.name).toBe("anthropic:claude-opus-5-5");
		expect(deps.claimsLlm).toBeUndefined();
		// A half-configured claims model still fails loudly.
		expect(() =>
			createPipelineDeps({
				env: { anthropicKey: "sk-test", openaiKey: "sk-o" },
				db: {} as never,
				workflows: {} as never,
			}),
		).toThrow(/OPENAI_MODEL/);
	});

	it("gives the scrape source no model of its own, so extraction is metered per scan user", () => {
		const deps = createPipelineDeps({
			env: { anthropicKey: "sk-test" },
			db: {} as never,
			workflows: {} as never,
			browser: {} as never,
		});
		expect(deps.sources.scrape).toBeDefined();
		expect(
			(deps.sources.scrape as unknown as { options: { llm?: unknown } }).options
				.llm,
		).toBeUndefined();
	});
});

describe("subscription providers", () => {
	const made: Parameters<LocalLlmFactory>[0][] = [];
	const local: LocalLlmFactory = (input) => {
		made.push(input);
		return {
			name: `${input.provider}:${input.model}`,
			billing: "subscription",
			vendor: input.provider === "codex-subscription" ? "openai" : "anthropic",
			ownerUserId: input.ownerUserId,
			generateObject: async () => ({}) as never,
		};
	};
	const env = {
		scoringProvider: "claude-subscription",
		ownerUserId: "user-123",
		anthropicKey: "sk-ant",
	};

	it("are refused where no local CLI can run them (the worker), at start", () => {
		expect(() => createLlm({ scoringProvider: "claude-subscription" })).toThrow(
			/runs only on the user's Mac.*mode menu under Who does each step in Settings › Models/,
		);
		expect(() =>
			createClaimsLlm({ claimsProvider: "codex-subscription" }),
		).toThrow(/runs only on the user's Mac/);
		expect(() =>
			createPipelineDeps({
				env,
				db: {} as never,
				workflows: {} as never,
			}),
		).toThrow(/This runtime cannot start a local subscription CLI/);
	});

	it("need the owner's account id", () => {
		expect(() =>
			createLlm({ scoringProvider: "claude-subscription" }, { local }),
		).toThrow(
			/no local owner is configured.*mode menu under Who does each step to switch to API key and back to the subscription/,
		);
		expect(() =>
			createLlm({ ...env, ownerUserId: "me@example.com" }, { local }),
		).toThrow(
			/id, not its email.*mode menu under Who does each step to switch to API key and back to the subscription/,
		);
	});

	it("serve scoring and tailoring per role with their own models and efforts", () => {
		made.length = 0;
		const scoring = createLlm(
			{ ...env, scoringEffort: "high", tailoringEffort: "low" },
			{ local },
		);
		const tailoring = createTailorLlm(
			{ ...env, scoringEffort: "high", tailoringEffort: "low" },
			scoring,
			{ local },
		);
		expect(scoring.name).toBe("claude-subscription:claude-opus-5-5");
		expect(tailoring.name).toBe("claude-subscription:claude-sonnet-5-5");
		expect(made).toEqual([
			{
				role: "scoring",
				provider: "claude-subscription",
				model: "claude-opus-5-5",
				effort: "high",
				ownerUserId: "user-123",
			},
			{
				role: "tailoring",
				provider: "claude-subscription",
				model: "claude-sonnet-5-5",
				effort: "low",
				ownerUserId: "user-123",
			},
		]);
	});

	it("can put only tailoring on the subscription", () => {
		const scoring = createLlm({ anthropicKey: "sk-ant" });
		const tailoring = createTailorLlm(
			{
				anthropicKey: "sk-ant",
				tailoringProvider: "claude-subscription",
				ownerUserId: "user-123",
			},
			scoring,
			{ local },
		);
		expect(scoring.name).toBe("anthropic:claude-opus-5-5");
		expect(tailoring.name).toBe("claude-subscription:claude-sonnet-5-5");
	});

	it("keep the claims check on another vendor than tailoring", () => {
		const tailoring = createTailorLlm(env, createLlm(env, { local }), {
			local,
		});
		expect(() =>
			createClaimsLlm(
				{ ...env, claimsProvider: "claude-subscription" },
				{ tailoring, local },
			),
		).toThrow(/different provider from tailoring \(both anthropic\)/);
		expect(
			createClaimsLlm(
				{ ...env, openaiKey: "sk-o", openaiModel: "gpt-6.1-terra" },
				{ tailoring, local },
			).name,
		).toBe("openai:gpt-6.1-terra");
	});

	it("run the claims check on codex-subscription with its own model and effort", () => {
		const tailoring = createTailorLlm(env, createLlm(env, { local }), {
			local,
		});
		made.length = 0;
		const claims = createClaimsLlm(
			{
				...env,
				claimsProvider: "codex-subscription",
				codexModel: "gpt-6.1-sol",
				codexEffort: "low",
				openaiModel: "gpt-api-model",
			},
			{ tailoring, local },
		);
		expect(claims.name).toBe("codex-subscription:gpt-6.1-sol");
		expect(made.at(-1)).toMatchObject({
			role: "claims",
			provider: "codex-subscription",
			model: "gpt-6.1-sol",
			effort: "low",
			ownerUserId: "user-123",
		});
	});

	it("run finding matches and drafting on Codex, with the account's default model, and check on Claude", () => {
		made.length = 0;
		const codexEnv = {
			...env,
			scoringProvider: "codex-subscription",
			tailoringProvider: "codex-subscription",
		};
		const scoring = createLlm(codexEnv, { local });
		const tailoring = createTailorLlm(codexEnv, scoring, { local });
		expect(scoring.name).toBe("codex-subscription:");
		expect(tailoring.name).toBe("codex-subscription:");
		expect(made.map((m) => [m.role, m.provider, m.model])).toEqual([
			["scoring", "codex-subscription", ""],
			["tailoring", "codex-subscription", ""],
		]);
		// Drafts by Codex: never checked by Codex or an OpenAI key.
		expect(() =>
			createClaimsLlm(
				{ ...codexEnv, claimsProvider: "codex-subscription" },
				{ tailoring, local },
			),
		).toThrow(/different provider from tailoring \(both openai\)/);
		expect(() =>
			createClaimsLlm(
				{ ...codexEnv, openaiKey: "sk-o", openaiModel: "gpt-6.1-terra" },
				{ tailoring, local },
			),
		).toThrow(/both openai/);
		// Checked by Claude: the plan with Claude's model (never an OpenAI one), or an Anthropic key.
		const plan = createClaimsLlm(
			{
				...codexEnv,
				claimsProvider: "claude-subscription",
				openaiModel: "gpt-api-model",
			},
			{ tailoring, local },
		);
		expect(plan.name).toBe("claude-subscription:claude-opus-5-5");
		expect(made.at(-1)).toMatchObject({
			role: "claims",
			provider: "claude-subscription",
			model: "claude-opus-5-5",
		});
		const key = createClaimsLlm(
			{ ...codexEnv, claimsProvider: "anthropic" },
			{ tailoring, local },
		);
		expect(key.name).toBe("anthropic:claude-opus-5-5");
		expect(() =>
			createClaimsLlm(
				{ ownerUserId: "user-123", claimsProvider: "anthropic" },
				{ tailoring, local },
			),
		).toThrow(/needs ANTHROPIC_API_KEY/);
	});

	it("wire a local pipeline end to end: subscription scoring and tailoring, API claims", () => {
		const deps = createPipelineDeps({
			env: { ...env, openaiKey: "sk-o", openaiModel: "gpt-6.1-terra" },
			db: {} as never,
			workflows: {} as never,
			localLlm: local,
		});
		expect(deps.llm.billing).toBe("subscription");
		expect(deps.tailorLlm?.name).toBe("claude-subscription:claude-sonnet-5-5");
		expect(deps.claimsLlm?.name).toBe("openai:gpt-6.1-terra");
	});

	it("leave the API-key defaults unchanged", () => {
		const deps = createPipelineDeps({
			env: {
				anthropicKey: "sk-ant",
				openaiKey: "sk-o",
				openaiModel: "gpt-6.1-terra",
			},
			db: {} as never,
			workflows: {} as never,
			localLlm: local,
		});
		expect(deps.llm.name).toBe("anthropic:claude-opus-5-5");
		expect(deps.llm.billing).toBeUndefined();
		expect(deps.tailorLlm?.name).toBe("anthropic:claude-sonnet-5-5");
		expect(deps.claimsLlm?.name).toBe("openai:gpt-6.1-terra");
	});
});
