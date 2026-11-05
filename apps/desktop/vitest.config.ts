import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Windows runners are slower at process starts and file I/O (backup tests zip, unzip and
		// open SQLite copies): 5 s timed out there with the work still going.
		testTimeout: process.platform === "win32" ? 30_000 : 5_000,
	},
});
