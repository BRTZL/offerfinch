import { defineConfig } from "vitest/config";

/**
 * Live dry runs on real board postings (docs/auto-apply-plan.md, step 4). A developer tool: not
 * part of `test` or `test:browser`, never run in CI, and every test skips unless
 * `LIVE_FORM_URLS` names the postings.
 */
export default defineConfig({
	test: {
		include: ["test/live/**/*.test.ts"],
		testTimeout: 240_000,
		hookTimeout: 60_000,
		fileParallelism: false,
	},
});
