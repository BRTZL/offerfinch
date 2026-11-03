import { defineConfig } from "vitest/config";

/** The tailoring eval only: real model calls, never part of `pnpm test`. */
export default defineConfig({
	test: {
		include: ["eval/**/*.eval.ts"],
		testTimeout: 3_600_000,
		hookTimeout: 120_000,
	},
});
