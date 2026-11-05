import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	BUNDLE_DIR,
	buildDiagnostics,
	DEBUG_FILE_LIMIT,
	DEBUG_KEEP,
	DEBUG_TOTAL_LIMIT,
	type DiagnosticFile,
	decodeWhole,
	foldAccents,
	LOG_FILE_LIMIT,
	LOGS_TOTAL_LIMIT,
	PREVIEW_LIMIT,
	previewOf,
	readHead,
	readTail,
	redactDiagnostics,
	zipDiagnostics,
} from "../src/main/diagnostics";
import { personalFields } from "../src/worker/diagnostics";

/**
 * Export Diagnostics (issue #54): canaries planted in every place the bundle reads from (logs,
 * site-debug pages, the settings summary, the system lines, file names) must not survive in
 * any file of the bundle, the manifest included. Fabricated data only.
 */
const HOME = "/Users/canaryhome";
const known = {
	names: ["Avery Quinlan"],
	emails: ["avery.quinlan@example.com"],
	phones: ["+1 (555) 010-0147"],
	links: ["https://www.linkedin.com/in/avery-quinlan-example"],
};

/** Every string that must be gone, and a line that plants it. */
const CANARIES: [string, string][] = [
	["Avery Quinlan", "profile saved for Avery Quinlan"],
	["Quinlan", "greeting QUINLAN in capitals"],
	["avery.quinlan@example.com", "sent to Avery.Quinlan@Example.com"],
	["other.person@example.org", "reply-to other.person@example.org"],
	["010-0147", "call +1 (555) 010-0147 or 555.010.0147"],
	["555 010 0199", "another phone +1 555 010 0199"],
	["15550100188", "sms +15550100188 and 0015550100177"],
	["0015550100177", "intl 0015550100177"],
	["avery-quinlan-example", "linkedin.com/in/avery-quinlan-example/details"],
	["canaryhome", `opened ${HOME}/Library/Application Support/OfferFinch`],
	["otheruser", "read /Users/otheruser/Downloads/cv.pdf"],
	[
		"windowscanary",
		String.raw`opened C:\Users\windowscanary\AppData\Roaming\OfferFinch`,
	],
	["slashcanary", "opened C:/Users/slashcanary/AppData/Roaming/OfferFinch"],
	[
		"escapedcanary",
		String.raw`{"path":"C:\\Users\\escapedcanary\\AppData\\Roaming\\OfferFinch"}`,
	],
	["sk-ant-FAKE0canary0key0", "key sk-ant-FAKE0canary0key0abcdefgh"],
	["sk-proj-FAKEcanary", "openai sk-proj-FAKEcanary1234567890"],
	["FAKEbearerTOKEN", "Authorization: Bearer FAKEbearerTOKEN.abc-123"],
	["hunter2canary", '{"password":"hunter2canary"}'],
	["cookieCANARY", "Cookie: li_at=cookieCANARY; JSESSIONID=x"],
	[
		"querySECRET",
		"GET https://jobs.example.com/view?id=1&auth=querySECRET#frag",
	],
	["fragSECRET", "https://example.net/path#access_token=fragSECRET"],
	[
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ",
		"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJl",
	],
	[
		"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		"digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
	],
	["QmFzZTY0Q2FuYXJ5VG9rZW4x", "blob QmFzZTY0Q2FuYXJ5VG9rZW4xMjM0NTY3ODkwYWJj"],
	["api_key=plainCANARY", "url api_key=plainCANARY"],
];

const planted = CANARIES.map(([, line]) => line).join("\n");

function folders() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "of-diagnostics-"));
	const logsDir = path.join(root, "logs");
	const userDataDir = path.join(root, "data");
	fs.mkdirSync(logsDir);
	fs.mkdirSync(path.join(userDataDir, "site-debug"), { recursive: true });
	return { root, logsDir, userDataDir };
}

function bundleWithCanaries() {
	const dirs = folders();
	fs.writeFileSync(
		path.join(dirs.logsDir, "main.log"),
		`2026-11-03T09:00:00.000Z worker info: start\n${planted}\n2026-11-03T09:00:01.000Z done\n`,
	);
	fs.writeFileSync(
		path.join(
			dirs.userDataDir,
			"site-debug",
			"2026-11-03T09-00-00-000Z-linkedin-selectors.html",
		),
		`<!--\nreason: ${planted}\n-->\n<main><p>${planted}</p></main>`,
	);
	const files = buildDiagnostics({
		...dirs,
		system: { OfferFinch: "0.1.0", Profile: planted },
		settings: {
			sources: [{ source: "linkedin", stop: { reason: planted } }],
			note: planted,
		},
		known,
		home: HOME,
		now: new Date("2026-11-03T10:00:00Z"),
	});
	return { files, dirs };
}

function expectClean(files: readonly DiagnosticFile[]) {
	for (const file of files)
		for (const [canary] of CANARIES) {
			expect(file.name.toLowerCase(), `${canary} in a file name`).not.toContain(
				canary.toLowerCase(),
			);
			expect(
				file.text.toLowerCase(),
				`${canary} survived in ${file.name}`,
			).not.toContain(canary.toLowerCase());
		}
}

describe("diagnostics redaction", () => {
	it("removes every planted canary from every file of the bundle", () => {
		const { files } = bundleWithCanaries();
		expect(files.map((f) => f.name)).toEqual([
			"manifest.json",
			"system.txt",
			"settings.json",
			"logs/main.log",
			"site-debug/2026-11-03T09-00-00-000Z-linkedin-selectors.html",
		]);
		expectClean(files);
		// The manifest names what the bundle never holds and how it was redacted.
		const manifest = JSON.parse(files[0]?.text ?? "{}");
		expect(manifest.files).toHaveLength(4);
		expect(manifest.neverIncluded.join(" ")).toMatch(/API keys/);
	});

	it("keeps what diagnoses a problem readable", () => {
		const out = redactDiagnostics(
			[
				'2026-11-03T09:00:00.000Z worker info: scan done {"jobsFetched":42}',
				"run 8f57b868-5318-4ad1-9c3e-0d2b6a1f4e77 step draft#1",
				"GET https://boards.example.com/v1/jobs/123",
				"Error: ENOENT at out/worker/index.mjs:10:5",
				"Hiring for Senior Engineer, $95,000 - $120,000",
				'migrations applied {"applied":["20261101120000_init"]} at 1762160400000',
			].join("\n"),
			known,
			HOME,
		);
		expect(out).toContain("2026-11-03T09:00:00.000Z");
		expect(out).toContain('"jobsFetched":42');
		expect(out).toContain("8f57b868-5318-4ad1-9c3e-0d2b6a1f4e77");
		expect(out).toContain("https://boards.example.com/v1/jobs/123");
		expect(out).toContain("out/worker/index.mjs:10:5");
		expect(out).toContain("$95,000 - $120,000");
		expect(out).toContain("20261101120000_init");
		expect(out).toContain("1762160400000");
	});

	it("writes what it replaced in a recognisable way", () => {
		const out = redactDiagnostics(planted, known, HOME);
		expect(out).toContain("[name]");
		expect(out).toContain("[email]");
		expect(out).toContain("[phone]");
		expect(out).toContain("[link]");
		expect(out).toContain("~/Library/Application Support/OfferFinch");
		expect(out).toContain("Authorization: [redacted] [token]");
		expect(out).toContain("https://jobs.example.com/view");
	});
});

describe("diagnostics size limits", () => {
	it("keeps each log's newest lines, within the per-file and total limits", () => {
		const { logsDir, userDataDir } = folders();
		const line = (i: number) =>
			`2026-11-03T09:00:00.000Z line ${i} ${"x".repeat(80)}\n`;
		for (const name of [
			"main.log",
			"a.log",
			"b.log",
			"c.log",
			"d.log",
			"e.log",
		]) {
			let text = "";
			for (let i = 0; i < 4000; i++) text += line(i);
			fs.writeFileSync(path.join(logsDir, name), text);
		}
		const files = buildDiagnostics({
			logsDir,
			userDataDir,
			system: {},
			settings: {},
			known,
			home: HOME,
		});
		const logs = files.filter((f) => f.name.startsWith("logs/"));
		expect(logs.length).toBeGreaterThan(0);
		let total = 0;
		for (const log of logs) {
			const bytes = Buffer.byteLength(log.text);
			total += bytes;
			// The tail note adds one short line to the limit.
			expect(bytes).toBeLessThanOrEqual(LOG_FILE_LIMIT + 100);
			expect(log.text).toContain("line 3999 ");
			expect(log.text).not.toContain("line 0 ");
			expect(log.text.split("\n")[1]).toMatch(/^2026-11-03T/);
		}
		expect(total).toBeLessThanOrEqual(LOGS_TOTAL_LIMIT);
		const manifest = JSON.parse(files[0]?.text ?? "{}");
		expect(manifest.leftOutForSize.length).toBe(6 - logs.length);
	});

	it("keeps only the newest site-debug pages, each and all within limits", () => {
		const { logsDir, userDataDir } = folders();
		const dir = path.join(userDataDir, "site-debug");
		for (let i = 0; i < 6; i++) {
			const file = path.join(dir, `2026-11-0${i + 1}-page-${i}.html`);
			fs.writeFileSync(file, `<p>page ${i}</p>${"<i>y</i>".repeat(60_000)}`);
			fs.utimesSync(file, new Date(2026, 10, i + 1), new Date(2026, 10, i + 1));
		}
		const files = buildDiagnostics({
			logsDir,
			userDataDir,
			system: {},
			settings: {},
			known,
			home: HOME,
		});
		const pages = files.filter((f) => f.name.startsWith("site-debug/"));
		expect(pages.length).toBeLessThanOrEqual(DEBUG_KEEP);
		expect(pages[0]?.name).toContain("page-5");
		let total = 0;
		for (const page of pages) {
			const bytes = Buffer.byteLength(page.text);
			total += bytes;
			expect(bytes).toBeLessThanOrEqual(DEBUG_FILE_LIMIT);
		}
		expect(total).toBeLessThanOrEqual(DEBUG_TOTAL_LIMIT);
	});

	it("previews the start of a long file and says it was cut", () => {
		const preview = previewOf({
			name: "logs/main.log",
			text: "z".repeat(PREVIEW_LIMIT * 2),
		});
		expect(preview.cut).toBe(true);
		expect(Buffer.byteLength(preview.preview)).toBeLessThanOrEqual(
			PREVIEW_LIMIT,
		);
		expect(preview.bytes).toBe(PREVIEW_LIMIT * 2);
	});
});

describe.skipIf(process.platform !== "darwin")("diagnostics zip", () => {
	it("holds exactly the reviewed files, and none of the canaries", async () => {
		const { files, dirs } = bundleWithCanaries();
		const zip = path.join(dirs.root, "out.zip");
		await zipDiagnostics(files, zip);
		const unzipped = path.join(dirs.root, "unzipped");
		execFileSync("/usr/bin/ditto", ["-x", "-k", zip, unzipped]);
		const read = (dir: string, prefix = ""): DiagnosticFile[] =>
			fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const name = `${prefix}${entry.name}`;
				const full = path.join(dir, entry.name);
				return entry.isDirectory()
					? read(full, `${name}/`)
					: [{ name, text: fs.readFileSync(full, "utf8") }];
			});
		const inZip = read(path.join(unzipped, BUNDLE_DIR));
		expect(inZip.map((f) => f.name).sort()).toEqual(
			files.map((f) => f.name).sort(),
		);
		for (const file of files)
			expect(inZip.find((f) => f.name === file.name)?.text).toBe(file.text);
		expectClean(inZip);
	});

	it("refuses a file name that would leave the bundle's folder", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "of-diagnostics-"));
		await expect(
			zipDiagnostics(
				[{ name: "../escape.txt", text: "x" }],
				path.join(root, "x.zip"),
			),
		).rejects.toThrow(/Bad file name/);
	});
});

describe("the profile details used for redaction", () => {
	it("reads personal.md as records render it and as earlier profile files wrote it", () => {
		const rendered = [
			"# Personal",
			"",
			"- **Name:** Avery Quinlan",
			"- **Email:** avery.quinlan@example.com",
			"- **Phone:** +1 555 010 0147",
			"- **LinkedIn:** linkedin.com/in/avery-quinlan-example",
			"- **Website:** avery.example",
		].join("\n");
		expect(personalFields(rendered)).toEqual({
			names: ["Avery Quinlan"],
			emails: ["avery.quinlan@example.com"],
			phones: ["+1 555 010 0147"],
			links: ["linkedin.com/in/avery-quinlan-example", "avery.example"],
		});
		const handWritten =
			"**Full name**: Avery Quinlan\n* **E-mail:** a.q@example.com";
		expect(personalFields(handWritten)).toMatchObject({
			names: ["Avery Quinlan"],
			emails: ["a.q@example.com"],
		});
		expect(personalFields("")).toEqual({
			names: [],
			emails: [],
			phones: [],
			links: [],
		});
	});
});

describe("name and handle redaction beyond the name as written", () => {
	// Fabricated: a Turkish name with every letter that loses its accent in logs and URLs.
	const turkish = {
		names: ["Ayşe Gül Öztürk"],
		emails: [],
		phones: [],
		links: [
			"https://www.linkedin.com/in/agozturk-dev/",
			"github.com/ag-ozt",
			"https://ayse.example",
		],
	};
	const redact = (text: string) => redactDiagnostics(text, turkish, HOME);

	it("folds accents, the dotless i included", () => {
		expect(foldAccents("Ayşe Gül Öztürk ığçİŞĞÇÖÜ")).toBe(
			"Ayse Gul Ozturk igcISGCOU",
		);
	});

	it.each([
		"profile for Ayşe Gül Öztürk",
		"AYŞE GÜL ÖZTÜRK",
		"ozturk",
		"OZTURK",
		"Öztürk",
		"aysegul",
		"aysegulozturk",
		"AyseGulOzturk",
		"ayse.gul.ozturk",
		"ayse_gul-ozturk",
		"gul ozturk",
		"ozturk1987",
		"/files/ayse-gul-ozturk-cv.pdf",
		"user agozturk-dev opened",
		"@ag-ozt pushed",
		"https://ayse.example/about",
	])("leaves nothing of the name or a handle in %j", (text) => {
		const out = redact(text).toLowerCase();
		for (const piece of [
			"ayse",
			"ayşe",
			"ozturk",
			"öztürk",
			"agozturk",
			"ag-ozt",
		])
			expect(out, out).not.toContain(piece);
	});

	it("matches a part of one or two letters only inside the whole name", () => {
		const short = { names: ["Bo Li Chen"], emails: [], phones: [], links: [] };
		const out = redactDiagnostics(
			"Bo Li Chen and bolichen, li-ion cells, a Bo, Chen",
			short,
			HOME,
		);
		expect(out).toBe("[name] and [name], li-ion cells, a Bo, [name]");
	});

	it("keeps words that only contain a part", () => {
		expect(redact("a gully, the Aysel account, gulp")).toBe(
			"a gully, the Aysel account, gulp",
		);
	});
});

describe("bounded reads", () => {
	it("decodes without a character cut at either end", () => {
		const bytes = Buffer.from("şğü", "utf8");
		expect(decodeWhole(bytes.subarray(1))).toBe("ğü");
		expect(decodeWhole(bytes.subarray(0, 5))).toBe("şğ");
		expect(decodeWhole(Buffer.from("plain"))).toBe("plain");
	});

	it("reads a multi-MB site-debug page only up to its limit", () => {
		const { userDataDir, logsDir } = folders();
		const file = path.join(userDataDir, "site-debug", "2026-11-03-huge.html");
		// 6 MB of two-byte characters, with an odd limit so the cut falls inside one.
		fs.writeFileSync(file, `<p>${"ş".repeat(3 * 1024 * 1024)}</p>`);
		const whole = vi.spyOn(fs, "readFileSync");
		const head = readHead(file, 1001);
		expect(Buffer.byteLength(head)).toBeLessThanOrEqual(1001);
		expect(head).not.toContain("\uFFFD");
		expect(head).toMatch(/\[cut at the size limit\]\n$/);
		const files = buildDiagnostics({
			logsDir,
			userDataDir,
			system: {},
			settings: {},
			known,
			home: HOME,
		});
		const page = files.find((f) => f.name.endsWith("huge.html"));
		expect(Buffer.byteLength(page?.text ?? "")).toBeLessThanOrEqual(
			DEBUG_FILE_LIMIT,
		);
		expect(page?.text).not.toContain("\uFFFD");
		expect(whole.mock.calls.some(([f]) => String(f) === file)).toBe(false);
		whole.mockRestore();
	});

	it("tails a log with no line break without breaking a character", () => {
		const { logsDir } = folders();
		const file = path.join(logsDir, "main.log");
		// One line of three-byte characters plus one byte: the tail starts inside one.
		fs.writeFileSync(file, `x${"ğ€".repeat(200_000)}`);
		const tail = readTail(file, 1000);
		expect(tail).not.toContain("\uFFFD");
		expect(tail).toMatch(/^\[older lines left out/);
		expect(tail.split("\n")[1]?.length).toBeGreaterThan(300);
	});
});

describe.skipIf(process.platform !== "darwin")("saving the zip", () => {
	it("is private to this user and replaces the earlier file", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-diagnostics-"));
		const target = path.join(dir, "bundle.zip");
		fs.writeFileSync(target, "older", { mode: 0o644 });
		await zipDiagnostics([{ name: "system.txt", text: "x" }], target);
		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(target).subarray(0, 2).toString()).toBe("PK");
		expect(fs.existsSync(`${target}.partial`)).toBe(false);
	});

	it("keeps the earlier file and leaves no partial when it fails", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-diagnostics-"));
		const target = path.join(dir, "bundle.zip");
		fs.writeFileSync(target, "older");
		// A folder this user cannot write to: ditto cannot create the partial file.
		fs.chmodSync(dir, 0o500);
		try {
			await expect(
				zipDiagnostics([{ name: "system.txt", text: "x" }], target),
			).rejects.toThrow();
			expect(fs.readFileSync(target, "utf8")).toBe("older");
			expect(fs.existsSync(`${target}.partial`)).toBe(false);
		} finally {
			fs.chmodSync(dir, 0o700);
		}
	});
});

describe("Windows home redaction on every host", () => {
	it("redacts an account whose folder starts with the current account name", () => {
		expect(
			redactDiagnostics(
				String.raw`C:\Users\Alex Sample\Documents\cv.pdf`,
				{ names: [], emails: [], phones: [], links: [] },
				String.raw`C:\Users\Alex`,
			),
		).toBe(String.raw`~\Documents\cv.pdf`);
	});
	it.each([
		[
			String.raw`C:\Users\Sample Account\Documents\cv.pdf`,
			String.raw`~\Documents\cv.pdf`,
		],
		[
			String.raw`\Users\Sample Account\Documents\cv.pdf`,
			String.raw`~\Documents\cv.pdf`,
		],
		[
			"C%3A%5CUsers%5CSample%20Account%5CDocuments%5Ccv.pdf",
			"~%5CDocuments%5Ccv.pdf",
		],
		['"C:\\Users\\Sample Account"', '"~"'],
		["C:/Users/Sample Account\nnext line", "~\nnext line"],
	])("redacts the entire account segment in %s", (input, expected) => {
		expect(
			redactDiagnostics(
				input,
				{ names: [], emails: [], phones: [], links: [] },
				String.raw`C:\Users\Alex`,
			),
		).toBe(expected);
	});
	const empty = { names: [], emails: [], phones: [], links: [] };
	it.each([
		[
			String.raw`C:\Users\Alex\AppData\Roaming\OfferFinch`,
			String.raw`~\AppData\Roaming\OfferFinch`,
		],
		[
			"c:/users/ALEX/AppData/Roaming/OfferFinch",
			"~/AppData/Roaming/OfferFinch",
		],
		[
			String.raw`C:\\USERS\\alex\\AppData\\Roaming\\OfferFinch`,
			String.raw`~\\AppData\\Roaming\\OfferFinch`,
		],
		[String.raw`D:\Custom Homes\Alex\Downloads`, String.raw`~\Downloads`],
	])("redacts %s", (input, expected) => {
		const home = input.startsWith("D:")
			? String.raw`D:\Custom Homes\Alex`
			: String.raw`C:\Users\Alex`;
		expect(redactDiagnostics(input, empty, home)).toBe(expected);
	});
	it("redacts other Windows accounts and keeps JSON valid", () => {
		const input = JSON.stringify({
			path: String.raw`C:\Users\OtherSample\AppData\Roaming\OfferFinch`,
		});
		const out = redactDiagnostics(input, empty, String.raw`C:\Users\Alex`);
		expect(JSON.parse(out)).toEqual({
			path: String.raw`~\AppData\Roaming\OfferFinch`,
		});
		expect(out).not.toMatch(/OtherSample|Alex/i);
	});
});
