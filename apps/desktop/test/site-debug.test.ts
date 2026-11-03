import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	debugSnapshot,
	FILE_LIMIT,
	KEEP,
	SITE_DEBUG_DIR,
	saveDebugSnapshot,
	TOTAL_LIMIT,
} from "../src/worker/site-debug";

const page = {
	url: "https://www.indeed.com/jobs?q=x&token=PRIVATE_URL#PRIVATE_FRAGMENT",
	status: 200,
	html: '<html><head><meta name="csrf-token" content="PRIVATE_CSRF"><script>window.token="PRIVATE_SCRIPT"</script></head><body><header>Signed in as Sam Rivera</header><input type="hidden" name="session_token" value="PRIVATE_SESSION"><main><a href="mailto:sam&#64;example.test">account</a><h3 class="jobTitle">Engineer</h3></main></body></html>',
};
const stop = {
	kind: "selectors",
	reason: 'Indeed: "cardTitle" (.jobTitle span[title]) found nothing',
};

function folder() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "of-debug-"));
}

describe("site debug snapshots", () => {
	it("keep what stopped and the page's structure, nothing private", () => {
		const saved = debugSnapshot(page, stop, new Date("2026-11-02T10:00:00Z"));
		expect(saved).toContain("stopped: selectors");
		expect(saved).toContain(stop.reason);
		expect(saved).toContain("url: https://www.indeed.com/jobs\n");
		expect(saved).toContain('<h3 class="jobTitle">Engineer</h3>');
		for (const secret of [
			"PRIVATE",
			"Sam Rivera",
			"sam@example.test",
			"sam&#64;example.test",
		])
			expect(saved, secret).not.toContain(secret);
	});

	it("are kept in the app's folder, the newest five only", () => {
		const userData = folder();
		try {
			for (let i = 0; i < KEEP + 3; i++)
				saveDebugSnapshot(
					userData,
					"indeed",
					page,
					stop,
					new Date(Date.UTC(2026, 10, 2, 10, i)),
				);
			const files = fs.readdirSync(path.join(userData, SITE_DEBUG_DIR)).sort();
			expect(files).toHaveLength(KEEP);
			expect(files[0]).toMatch(
				/^2026-11-02T10-03-00-000Z-indeed-selectors\.html$/,
			);
		} finally {
			fs.rmSync(userData, { recursive: true, force: true });
		}
	});

	// A 10 MB page is parsed once: the timeout allows for a busy machine.
	it("are bounded in size: each file, and the folder in all", () => {
		const userData = folder();
		try {
			// One 10 MB page: the read stops at its input cap, the file at its size cap.
			const huge = {
				...page,
				html: `<main>${"<p>job posting text</p>".repeat(450_000)}</main>`,
			};
			const file = saveDebugSnapshot(userData, "indeed", huge, stop);
			expect(fs.statSync(file).size).toBeLessThanOrEqual(FILE_LIMIT);
			// Then pages just over the file cap (quick to read), until the folder's total binds.
			const big = {
				...page,
				html: `<main>${"<p>job posting text</p>".repeat(40_000)}</main>`,
			};
			for (let i = 0; i < KEEP; i++)
				saveDebugSnapshot(
					userData,
					"glassdoor",
					big,
					stop,
					new Date(Date.UTC(2026, 10, 3, 10, i)),
				);
			const dir = path.join(userData, SITE_DEBUG_DIR);
			const total = fs
				.readdirSync(dir)
				.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
			expect(total).toBeLessThanOrEqual(TOTAL_LIMIT);
		} finally {
			fs.rmSync(userData, { recursive: true, force: true });
		}
	}, 30_000);
});
