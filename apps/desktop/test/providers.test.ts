import { describe, expect, it } from "vitest";
import {
	FAKE_MODEL_REF,
	formatModelRef,
	isModelRef,
	PROVIDER_IDS,
	PROVIDER_PLATFORMS,
	parseModelRef,
	providerOff,
} from "../src/shared/providers";

describe("model references", () => {
	it("parse into provider and model, the model keeping its own colons and slashes", () => {
		expect(parseModelRef("claude:claude-opus-5-5")).toEqual({
			provider: "claude",
			model: "claude-opus-5-5",
		});
		expect(parseModelRef("codex:")).toEqual({ provider: "codex", model: "" });
		expect(parseModelRef("opencode:opencode-go/glm-5.1")).toEqual({
			provider: "opencode",
			model: "opencode-go/glm-5.1",
		});
		expect(parseModelRef("antigravity:gemini-3.8-flash")).toEqual({
			provider: "antigravity",
			model: "gemini-3.8-flash",
		});
		expect(parseModelRef(FAKE_MODEL_REF)).toEqual({
			provider: "fake",
			model: "test",
		});
	});

	it("refuse unknown providers, empty models (but Codex's default), spaces and bad OpenCode ids", () => {
		for (const bad of [
			"",
			"claude",
			"anthropic:claude-opus-5-5",
			"claude:",
			"antigravity:",
			"claude:claude opus",
			"opencode:glm-5.1",
			"opencode:/glm",
			`claude:${"x".repeat(201)}`,
		])
			expect(isModelRef(bad), bad).toBe(false);
	});

	it("format what parses, and throw on what does not", () => {
		expect(formatModelRef("codex", "gpt-6.1-sol")).toBe("codex:gpt-6.1-sol");
		expect(formatModelRef("codex", "")).toBe("codex:");
		expect(() => formatModelRef("claude", "")).toThrow(/no model named/);
		expect(() => formatModelRef("opencode", "glm")).toThrow(
			/<source>\/<model>/,
		);
	});
});

describe("platforms", () => {
	it("keeps Claude on everywhere and the others off on Windows, with a reason", () => {
		for (const id of PROVIDER_IDS) expect(providerOff(id, "darwin")).toBeNull();
		expect(providerOff("claude", "win32")).toBeNull();
		for (const id of ["codex", "opencode", "antigravity"] as const)
			expect(providerOff(id, "win32")).toBe(PROVIDER_PLATFORMS[id].win32);
		expect(providerOff("codex", "win32")).toMatch(/macOS/);
	});
});
