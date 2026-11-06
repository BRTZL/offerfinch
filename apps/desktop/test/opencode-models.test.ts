import type { OpenCodeModelEntry } from "@offerfinch/local-llm/opencode";
import { describe, expect, it } from "vitest";

import {
	type CliChecks,
	openCodeLogin,
	openCodeModelInfo,
	withProviders,
} from "../src/worker/subscriptions";

const entry = (over: Partial<OpenCodeModelEntry> = {}): OpenCodeModelEntry => ({
	source: "opencode",
	model: "deepseek-v4.1-flash-free",
	name: "DeepSeek V4.1 Flash Free",
	billing: "subscription",
	variants: ["none", "low", "high", "max"],
	price: { input: 0, cachedInput: 0, output: 0, source: "t" },
	baseURL: "https://opencode.ai/inference/openai/v1",
	unavailable: null,
	...over,
});

describe("OpenCode in Settings › Models", () => {
	it("shows a model with its source, billing and the effort levels it takes", () => {
		expect(openCodeModelInfo(entry())).toEqual({
			ref: "opencode:opencode/deepseek-v4.1-flash-free",
			name: "DeepSeek V4.1 Flash Free",
			provider: "opencode",
			source: "opencode",
			billing: "subscription",
			efforts: ["low", "high", "max"],
		});
		expect(
			openCodeModelInfo(
				entry({
					model: "gpt-5.5-pro",
					billing: "api",
					price: { input: 30, cachedInput: 30, output: 180, source: "t" },
				}),
			).price,
		).toEqual({ input: 30, output: 180 });
	});

	it("says which sources are signed in and which are not used, never a secret", () => {
		const login = openCodeLogin(
			[
				{
					integration: "opencode",
					type: "oauth",
					method: "device",
					active: true,
					expiresAt: new Date("2026-12-05"),
				},
				{
					integration: "openai",
					type: "oauth",
					method: "chatgpt-browser",
					active: true,
					expiresAt: null,
				},
			],
			[entry(), entry({ source: "openai", model: "gpt", unavailable: "x" })],
			new Date("2026-11-06"),
		);
		expect(login.state).toBe("logged_in");
		expect(login.detail).toMatch(/Signed in: opencode, openai\./);
		expect(login.detail).toMatch(/Models from opencode\./);
		expect(login.detail).toMatch(/Not used yet: openai/);
	});

	it("asks for a new login when OpenCode's own login has expired", () => {
		expect(
			openCodeLogin(
				[
					{
						integration: "opencode",
						type: "oauth",
						method: "device",
						active: true,
						expiresAt: new Date("2026-11-01"),
					},
				],
				[],
				new Date("2026-11-06"),
			).state,
		).toBe("logged_out");
		expect(openCodeLogin([], null).detail).toMatch(
			/only OpenCode's free models/,
		);
	});

	it("routes OpenCode's state and models to the run's checks", async () => {
		const state = {
			path: "/x",
			version: "2.2.5",
			tested: "2.2.5",
			login: { state: "logged_in" as const, detail: "" },
			command: null,
			fix: null,
		};
		const checks = {
			refresh: async () => "",
			usePath: () => {},
			factory: () => {
				throw new Error("unused");
			},
			claude: async () => state,
			codex: async () => state,
		} satisfies CliChecks;
		const reject = () => Promise.reject(new Error("unused"));
		const subscriptions = withProviders(checks, {
			opencode: {
				state: async () => ({ ...state, path: "/opencode" }),
				models: async () => [openCodeModelInfo(entry())],
				factory: () => {
					throw new Error("unused");
				},
				install: reject,
				signIn: reject,
			},
		});
		expect((await subscriptions.state("opencode")).path).toBe("/opencode");
		expect((await subscriptions.models("opencode")).map((m) => m.ref)).toEqual([
			"opencode:opencode/deepseek-v4.1-flash-free",
		]);
		const without = withProviders(checks);
		expect((await without.state("opencode")).path).toBeNull();
		expect(await without.models("opencode")).toEqual([]);
	});
});
