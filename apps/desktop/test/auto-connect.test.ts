import { describe, expect, it } from "vitest";
import {
	type AiChoice,
	autoFill,
	readyNow,
	unavailable,
} from "../src/shared/auto-connect";

const fresh: AiChoice = {
	scoring: { mode: "api" },
	tailoring: { mode: "api" },
	claims: { mode: "api" },
};
const noKeys = { anthropic: false, openai: false };

describe("Connect AI picks Claude Code and Codex", () => {
	it("both signed in: Claude finds matches and drafts, Codex checks", () => {
		const r = autoFill({
			settings: fresh,
			claude: true,
			codex: true,
			keys: noKeys,
		});
		expect(r.filled).toEqual(["scoring", "tailoring", "claims"]);
		expect(r.settings).toEqual({
			scoring: { mode: "claude-subscription" },
			tailoring: { mode: "claude-subscription" },
			claims: { mode: "codex-subscription" },
		});
	});

	it("Claude only: drafting and scoring set, the checker stays open", () => {
		const r = autoFill({
			settings: fresh,
			claude: true,
			codex: false,
			keys: noKeys,
		});
		expect(r.filled).toEqual(["scoring", "tailoring"]);
		expect(r.settings.claims).toEqual({ mode: "api" });
	});

	it("Codex only: the checker set, drafting stays open", () => {
		const r = autoFill({
			settings: fresh,
			claude: false,
			codex: true,
			keys: noKeys,
		});
		expect(r.filled).toEqual(["claims"]);
		expect(r.settings.scoring).toEqual({ mode: "api" });
		expect(r.settings.tailoring).toEqual({ mode: "api" });
	});

	it("neither: nothing changes", () => {
		const r = autoFill({
			settings: fresh,
			claude: false,
			codex: false,
			keys: noKeys,
		});
		expect(r.filled).toEqual([]);
		expect(r.settings).toEqual(fresh);
	});

	it("never changes a choice already made", () => {
		const made: AiChoice = {
			scoring: { mode: "fake" },
			tailoring: { mode: "api", model: "claude-sonnet-5-5" },
			claims: { mode: "codex-subscription", model: "gpt-6.1-terra" },
		};
		// A stored Anthropic key: the API choice for tailoring is the user's.
		const r = autoFill({
			settings: made,
			claude: true,
			codex: true,
			keys: { anthropic: true, openai: false },
		});
		expect(r.filled).toEqual([]);
		expect(r.settings).toEqual(made);
	});

	it("an OpenAI key keeps the checker on the API; Claude still fills drafting", () => {
		const r = autoFill({
			settings: fresh,
			claude: true,
			codex: true,
			keys: { anthropic: false, openai: true },
		});
		expect(r.filled).toEqual(["scoring", "tailoring"]);
		expect(r.settings.claims).toEqual({ mode: "api" });
	});

	it("respects unavailable(): Claude never checks, Codex never drafts", () => {
		expect(unavailable("claims", "claude-subscription")).not.toBeNull();
		expect(unavailable("scoring", "codex-subscription")).not.toBeNull();
		expect(unavailable("tailoring", "codex-subscription")).not.toBeNull();
		expect(unavailable("claims", "codex-subscription")).toBeNull();
		expect(unavailable("tailoring", "claude-subscription")).toBeNull();
		for (const claude of [true, false])
			for (const codex of [true, false]) {
				const { settings } = autoFill({
					settings: fresh,
					claude,
					codex,
					keys: noKeys,
				});
				for (const role of ["scoring", "tailoring", "claims"] as const)
					expect(unavailable(role, settings[role].mode)).toBeNull();
			}
	});
});

describe("a role is ready only while its plan's CLI is signed in", () => {
	const roles = [
		{ role: "scoring" as const, mode: "claude-subscription", ready: true },
		{ role: "tailoring" as const, mode: "claude-subscription", ready: true },
		{ role: "claims" as const, mode: "codex-subscription", ready: true },
	];

	it("both signed in: all ready", () => {
		expect(
			readyNow(roles, { claude: true, codex: true }).map((r) => r.ready),
		).toEqual([true, true, true]);
	});

	it("Claude signed out: its roles keep the choice but are not ready", () => {
		const now = readyNow(roles, { claude: false, codex: true });
		expect(now.map((r) => r.mode)).toEqual(roles.map((r) => r.mode));
		expect(now.map((r) => r.ready)).toEqual([false, false, true]);
	});

	it("Codex gone: the checker is not ready", () => {
		expect(
			readyNow(roles, { claude: true, codex: false }).map((r) => r.ready),
		).toEqual([true, true, false]);
	});

	it("API keys and test models do not depend on the CLIs", () => {
		const other = [
			{ role: "scoring" as const, mode: "api", ready: true },
			{ role: "tailoring" as const, mode: "fake", ready: true },
			{ role: "claims" as const, mode: "api", ready: false },
		];
		expect(
			readyNow(other, { claude: false, codex: false }).map((r) => r.ready),
		).toEqual([true, true, false]);
	});
});
