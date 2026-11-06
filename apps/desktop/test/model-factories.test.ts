import {
	DEFAULT_ANTHROPIC_MODEL,
	DEFAULT_TAILOR_MODEL,
} from "@offerfinch/core/scoring/anthropic";
import { priceOf } from "@offerfinch/core/scoring/pricing";
import { describe, expect, it } from "vitest";
import { CLAUDE_DEFAULTS, FAKE_MODEL_REF } from "../src/shared/providers";
import {
	createClaimsLlm,
	createLlm,
	createPipelineDeps,
	createTailorLlm,
	type LocalLlmFactory,
	type ModelConfig,
} from "../src/worker/model-factories";

const made: Parameters<LocalLlmFactory>[0][] = [];
/** Names each model as the real providers do (`claude-subscription:…`, `codex-subscription:…`). */
const local: LocalLlmFactory = (input) => {
	made.push(input);
	return {
		name: `${input.provider}-subscription:${input.model}`,
		billing: "subscription",
		vendor: input.provider === "codex" ? "openai" : "anthropic",
		ownerUserId: input.ownerUserId,
		generateObject: async () => ({}) as never,
	};
};
const OWNER = { ownerUserId: "user-123" };

describe("Claude's defaults", () => {
	it("are core's: Opus finds matches and checks, Sonnet drafts", () => {
		expect(CLAUDE_DEFAULTS).toEqual({
			scoring: DEFAULT_ANTHROPIC_MODEL,
			tailoring: DEFAULT_TAILOR_MODEL,
			claims: DEFAULT_ANTHROPIC_MODEL,
		});
	});

	it("prices the tailoring default from the table, not the fallback rate", () => {
		expect(priceOf("claude-sonnet-5-5")).toMatchObject({
			input: 2,
			cachedInput: 0.2,
			output: 10,
		});
	});
});

describe("createLlm", () => {
	it("fails loudly without a model unless the fake is allowed or asked for", () => {
		expect(() => createLlm({})).toThrow(/No model chosen for Finding matches/);
		expect(createLlm({}, { allowFake: true }).name).toBe("fake");
		expect(createLlm({ scoring: { model: FAKE_MODEL_REF } }).name).toBe("fake");
	});

	it("refuses an unknown reference", () => {
		expect(() =>
			createLlm({ scoring: { model: "nope:x" as never } }, { local }),
		).toThrow(/Unknown model for Finding matches/);
	});
});

describe("createTailorLlm", () => {
	it("drafts with the scoring model when Drafting is unset", () => {
		const fake = createLlm({ scoring: { model: FAKE_MODEL_REF } });
		expect(createTailorLlm({}, fake)).toBe(fake);
	});
});

describe("createClaimsLlm", () => {
	it("needs a model unless the fake is allowed", () => {
		expect(() => createClaimsLlm({})).toThrow(
			/No model chosen for Checking drafts/,
		);
		expect(createClaimsLlm({}, { allowFake: true }).name).toBe("fake");
	});
});

describe("createPipelineDeps", () => {
	it("leaves the claims model unset when none is chosen", () => {
		const deps = createPipelineDeps({
			env: { scoring: { model: FAKE_MODEL_REF } },
			db: {} as never,
			workflows: {} as never,
		});
		expect(deps.llm.name).toBe("fake");
		expect(deps.claimsLlm).toBeUndefined();
	});

	it("gives the scrape source no model of its own, so extraction is metered per scan user", () => {
		const deps = createPipelineDeps({
			env: { scoring: { model: FAKE_MODEL_REF } },
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

describe("models on the user's own sign-ins", () => {
	const claude: ModelConfig = {
		...OWNER,
		scoring: { model: "claude:claude-opus-5-5" },
	};

	it("are refused where no local CLI can run them, at start", () => {
		expect(() => createLlm(claude)).toThrow(/this runtime cannot start one/);
		expect(() => createClaimsLlm({ claims: { model: "codex:" } })).toThrow(
			/this runtime cannot start one/,
		);
		expect(() =>
			createPipelineDeps({
				env: claude,
				db: {} as never,
				workflows: {} as never,
			}),
		).toThrow(/this runtime cannot start one/);
	});

	it("need the owner's account id", () => {
		expect(() => createLlm({ scoring: claude.scoring }, { local })).toThrow(
			/no local owner is configured/,
		);
		expect(() =>
			createLlm({ ...claude, ownerUserId: "me@example.com" }, { local }),
		).toThrow(/id, not its email/);
	});

	it("serve each step with its own provider, model and effort", () => {
		made.length = 0;
		const env: ModelConfig = {
			...OWNER,
			scoring: { model: "claude:claude-opus-5-5", effort: "high" },
			tailoring: { model: "codex:gpt-6.1-sol", effort: "low" },
			claims: { model: "codex:" },
		};
		const scoring = createLlm(env, { local });
		const tailoring = createTailorLlm(env, scoring, { local });
		const claims = createClaimsLlm(env, { local });
		expect(scoring.name).toBe("claude-subscription:claude-opus-5-5");
		expect(tailoring.name).toBe("codex-subscription:gpt-6.1-sol");
		expect(claims.name).toBe("codex-subscription:");
		expect(made).toEqual([
			{
				role: "scoring",
				provider: "claude",
				model: "claude-opus-5-5",
				effort: "high",
				ownerUserId: "user-123",
			},
			{
				role: "tailoring",
				provider: "codex",
				model: "gpt-6.1-sol",
				effort: "low",
				ownerUserId: "user-123",
			},
			{
				role: "claims",
				provider: "codex",
				model: "",
				effort: undefined,
				ownerUserId: "user-123",
			},
		]);
	});

	it("draft at the scoring effort when Drafting has none", () => {
		made.length = 0;
		const env: ModelConfig = {
			...OWNER,
			scoring: { model: "claude:claude-opus-5-5", effort: "high" },
			tailoring: { model: "claude:claude-sonnet-5-5" },
		};
		createTailorLlm(env, createLlm(env, { local }), { local });
		expect(made.at(-1)).toMatchObject({ role: "tailoring", effort: "high" });
	});

	it("may run all three steps on one model, the draft checked by the model that wrote it", () => {
		const same = { model: "claude:claude-opus-5-5" } as const;
		const deps = createPipelineDeps({
			env: { ...OWNER, scoring: same, tailoring: same, claims: same },
			db: {} as never,
			workflows: {} as never,
			localLlm: local,
		});
		expect(deps.llm.name).toBe("claude-subscription:claude-opus-5-5");
		expect(deps.tailorLlm?.name).toBe("claude-subscription:claude-opus-5-5");
		expect(deps.claimsLlm?.name).toBe("claude-subscription:claude-opus-5-5");
		expect(deps.llm.billing).toBe("subscription");
	});
});
