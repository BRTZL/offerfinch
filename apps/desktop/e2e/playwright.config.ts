import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /.*\.spec\.ts/,
	timeout: 240_000,
	workers: 1,
	fullyParallel: false,
	reporter: [["list"]],
	use: { trace: "retain-on-failure" },
});
