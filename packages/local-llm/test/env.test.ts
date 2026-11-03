import { describe, expect, it } from "vitest";

import { subscriptionEnv } from "../src/env";

describe("subscriptionEnv", () => {
	it("keeps only the allowlist and reports credentials by name", () => {
		const { env, removed } = subscriptionEnv({
			PATH: "/usr/bin",
			HOME: "/Users/me",
			ANTHROPIC_API_KEY: "sk-ant-secret",
			ANTHROPIC_BASE_URL: "https://proxy.example",
			OPENAI_API_KEY: "sk-secret",
			CODEX_API_KEY: "sk-codex",
			CLAUDE_CODE_USE_BEDROCK: "1",
			CLAUDE_CODE_OAUTH_TOKEN: "oauth",
			CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/parent.sock",
			CLAUDECODE: "1",
			AWS_SECRET_ACCESS_KEY: "aws",
			DATABASE_URL: "postgres://x",
			DEBUG_CLAUDE_AGENT_SDK: "1",
			DEBUG: "1",
			NODE_OPTIONS: "--require /tmp/x.js",
			CLAUDE_CONFIG_DIR: "/Users/me/.claude",
		});
		expect(env).toEqual({
			PATH: "/usr/bin",
			HOME: "/Users/me",
			CLAUDE_CONFIG_DIR: "/Users/me/.claude",
		});
		expect(removed).toEqual([
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_BASE_URL",
			"AWS_SECRET_ACCESS_KEY",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CODE_USE_BEDROCK",
			"CODEX_API_KEY",
			"DEBUG",
			"DEBUG_CLAUDE_AGENT_SDK",
			"NODE_OPTIONS",
			"OPENAI_API_KEY",
		]);
		expect(JSON.stringify({ env, removed })).not.toContain("secret");
	});
});
