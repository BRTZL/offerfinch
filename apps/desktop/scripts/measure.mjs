// Measures the packaged app on this Mac: start to interactive, idle memory of every process
// after 5 minutes (window open; window closed), peak memory during a scan whose preparation
// prints PDFs in Chrome, and the installer size. Test mode: fake models, fixture boards, a mock
// Keychain, data in temporary folders.
// Usage: node scripts/measure.mjs <path to OfferFinch.app> <prepared userData> [--quick] [--foreground]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import { assertSafeBuild } from "./safe-build.mjs";

const appPath = path.resolve(process.argv[2]);
if (!process.argv.includes("--baseline")) assertSafeBuild(appPath);
const prepared = path.resolve(process.argv[3]);
// --baseline: an Electron hello world (scripts/baseline) with the same Electron, for comparison.
const baseline = process.argv.includes("--baseline");
const quick = process.argv.includes("--quick");
// Showing windows and taking focus requires an explicit command-line opt-in.
const foreground = process.argv.includes("--foreground");
// --only start,open,closed,scan: run just those parts.
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice(7).split(",")) : null;
const want = (part) => !only || only.has(part);
const IDLE_MS = quick ? 30_000 : 5 * 60_000;
// --env=KEY=VALUE (repeatable): extra environment for every launch, e.g. an A/B arm.
const extraEnv = Object.fromEntries(
	process.argv
		.filter((a) => a.startsWith("--env="))
		.map((a) => {
			const [k, ...v] = a.slice(6).split("=");
			return [k, v.join("=")];
		}),
);
// --out=<file>: where the results go (default: measurements.json next to the installers).
const outArg = process.argv.find((a) => a.startsWith("--out="));
const exe = baseline
	? path.join(appPath, "Contents/MacOS/Electron")
	: path.join(appPath, "Contents/MacOS/OfferFinch");
const baseArgs = baseline
	? [path.resolve(import.meta.dirname, "baseline")]
	: [];
const baseEnv = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE"),
);
const testEnv = (userData, extra = {}) => ({
	...baseEnv,
	OFFERFINCH_USER_DATA: userData,
	OFFERFINCH_TEST: "1",
	OFFERFINCH_FAKE_MODELS: "1",
	OFFERFINCH_NO_SCHEDULE: "1",
	...extraEnv,
	...extra,
	OFFERFINCH_TEST_BACKGROUND: foreground ? "0" : "1",
});
const copyData = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jp-measure-"));
	fs.cpSync(prepared, dir, { recursive: true });
	return dir;
};

/** Physical footprint (what Activity Monitor shows as Memory), in KB, per pid. */
function footprints(pids) {
	if (pids.length === 0) return {};
	const out = execFileSync(
		"top",
		[
			"-l",
			"1",
			"-stats",
			"pid,mem",
			...pids.flatMap((p) => ["-pid", String(p)]),
		],
		{ encoding: "utf8" },
	);
	const map = {};
	for (const line of out.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+([\d.]+)([KMG])B?\+?-?$/);
		if (m) map[+m[1]] = +m[2] * { K: 1, M: 1024, G: 1048576 }[m[3]];
	}
	return map;
}

/** Every process of the app (Chrome it started included): RSS and footprint, by role. */
function tree(rootPid, { withFootprint = true } = {}) {
	const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,args="], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
		.trim()
		.split("\n")
		.map((l) => {
			const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
			return m && { pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] };
		})
		.filter(Boolean);
	const keep = new Set([rootPid]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const r of rows)
			if (!keep.has(r.pid) && keep.has(r.ppid)) {
				keep.add(r.pid);
				grew = true;
			}
	}
	const procs = rows.filter((r) => keep.has(r.pid));
	// `top` takes about a second per sample; fast sampling (Chrome's short print sessions) skips it.
	const fp = withFootprint ? footprints(procs.map((p) => p.pid)) : {};
	const role = (a) => {
		if (/Google Chrome|Chromium|chrome-headless/.test(a))
			return "chrome (headless, for PDFs/pages)";
		if (/node\.mojom\.NodeService/.test(a)) return "worker (utility)";
		if (/network\.mojom\.NetworkService/.test(a)) return "network service";
		if (/--type=gpu-process/.test(a)) return "gpu";
		if (/--type=renderer/.test(a)) return "renderer (window)";
		if (/--type=/.test(a)) return "other helper";
		return "main";
	};
	const by = {};
	for (const p of procs) {
		const r = role(p.args);
		by[r] ??= { rssMb: 0, footprintMb: 0, n: 0 };
		by[r].rssMb += p.rss / 1024;
		by[r].footprintMb += (fp[p.pid] ?? 0) / 1024;
		by[r].n++;
	}
	for (const v of Object.values(by)) {
		v.rssMb = Math.round(v.rssMb);
		v.footprintMb = Math.round(v.footprintMb);
	}
	return {
		rssMb: Math.round(procs.reduce((a, p) => a + p.rss, 0) / 1024),
		footprintMb: Math.round(
			procs.reduce((a, p) => a + (fp[p.pid] ?? 0), 0) / 1024,
		),
		count: procs.length,
		by,
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

// 1. Start to interactive, 5 runs: process start until the home screen shows its data.
if (want("start")) {
	const times = [];
	for (let i = 0; i < 5; i++) {
		const userData = copyData();
		const t0 = performance.now();
		const app = await electron.launch({
			executablePath: exe,
			args: baseArgs,
			env: { ...testEnv(userData), BASE_DATA: userData },
		});
		const page = await app.firstWindow();
		if (baseline) await page.locator("h1").waitFor({ timeout: 30_000 });
		else {
			await page.getByTestId("home").waitFor({ timeout: 30_000 });
			await page.getByTestId("home-scans").waitFor({ timeout: 30_000 });
		}
		times.push(Math.round(performance.now() - t0));
		await app.close();
	}
	results[baseline ? "baselineStartMs" : "startMs"] = {
		runs: times,
		median: [...times].sort((a, b) => a - b)[2],
	};
	console.log("start to interactive (ms):", times.join(", "));
}

// 2. Idle memory after IDLE_MS: window open, then launched with the window closed.
async function idle(args, label) {
	const userData = copyData();
	const child = spawn(exe, [...baseArgs, ...args], {
		env: { ...testEnv(userData), BASE_DATA: userData },
		stdio: "ignore",
	});
	await sleep(IDLE_MS);
	const m = tree(child.pid);
	child.kill("SIGTERM");
	await sleep(3_000);
	results[baseline ? `baseline_${label}` : label] = m;
	console.log(label, JSON.stringify(results[label]));
}
if (want("open")) await idle([], "idleWindowOpen");
if (want("closed")) await idle(["--hidden"], "idleWindowClosed");

// 3. Peak during a scan: a new fixture job is scored, prepared, checked and printed to PDF.
if (want("scan")) {
	const { startFixtureBoards } = await import("../e2e/fixture-boards.ts");
	const boards = await startFixtureBoards();
	boards.addJob(4099, "Principal Full-Stack Engineer");
	const userData = copyData();
	// Job-board search through this run's SearXNG stand-in (the copy points at an older one).
	const { default: Database } = await import("better-sqlite3");
	const dbFile = path.join(userData, "offerfinch.sqlite");
	const db = new Database(dbFile);
	db.prepare(
		"update source_providers set config = ? where provider = 'job-board-search'",
	).run(JSON.stringify({ backend: "searxng", searxngUrl: boards.base }));
	db.close();
	const app = await electron.launch({
		executablePath: exe,
		env: testEnv(userData, {
			OFFERFINCH_FETCH_REWRITE: JSON.stringify(boards.rewrite),
		}),
	});
	const page = await app.firstWindow();
	await page.getByTestId("scan-now").click();
	const pid = app.process().pid;
	// Tailoring is on demand: press Prepare on the new match once it is listed, so the scan's
	// peak includes drafting, the check and the PDFs.
	void (async () => {
		const read = new Database(dbFile, { readonly: true });
		try {
			for (let i = 0; i < 240; i++) {
				const row = read
					.prepare(
						"select a.id from applications a join jobs j on j.id = a.job_id where j.title = ? and a.state = 'scored'",
					)
					.get("Principal Full-Stack Engineer");
				if (row) {
					await app.evaluate(
						(_e, to) => globalThis.__offerfinchTest.open(to),
						`/applications/${row.id}`,
					);
					await page.getByTestId("prepare").click({ timeout: 30_000 });
					return;
				}
				await new Promise((r) => setTimeout(r, 250));
			}
		} finally {
			read.close();
		}
	})();
	// Separate maxima: the app's own processes, Chrome's processes (all of them, summed), and
	// both together at the same moment.
	const CHROME = "chrome (headless, for PDFs/pages)";
	const peak = {
		appFootprintMb: 0,
		appRssMb: 0,
		chromeFootprintMb: 0,
		chromeRssMb: 0,
		chromeProcesses: 0,
		totalFootprintMb: 0,
		appByRole: {},
	};
	let chromeSeen = false;
	const deadline = Date.now() + 120_000;
	let quietSince = 0;
	// Chrome's print sessions last about a second: a separate sampler with process names only
	// (cheap) every 50 ms keeps Chrome's peak RSS, summed over all its processes.
	let sampling = true;
	const chromeSampler = (async () => {
		while (sampling) {
			const rows = execFileSync("ps", ["-axwwo", "pid=,ppid=,rss=,args="], {
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			})
				.trim()
				.split("\n")
				.map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
				.filter(Boolean)
				.map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], comm: m[4] }));
			const keep = new Set([pid]);
			for (let grew = true; grew; ) {
				grew = false;
				for (const r of rows)
					if (!keep.has(r.pid) && keep.has(r.ppid)) {
						keep.add(r.pid);
						grew = true;
					}
			}
			const chrome = rows.filter(
				(r) => keep.has(r.pid) && /Google Chrome|Chromium/.test(r.comm),
			);
			if (chrome.length) {
				chromeSeen = true;
				peak.chromeRssMb = Math.max(
					peak.chromeRssMb,
					Math.round(chrome.reduce((a, r) => a + r.rss, 0) / 1024),
				);
				peak.chromeProcesses = Math.max(peak.chromeProcesses, chrome.length);
			}
			await sleep(50);
		}
	})();
	let lastFootprintAt = 0;
	while (Date.now() < deadline) {
		// RSS every pass (fast), footprint about once a second.
		const slow = Date.now() - lastFootprintAt > 1_000;
		if (slow) lastFootprintAt = Date.now();
		const m = tree(pid, { withFootprint: slow });
		const chrome = m.by[CHROME];
		const appFp = slow ? m.footprintMb - (chrome?.footprintMb ?? 0) : 0;
		const appRss = m.rssMb - (chrome?.rssMb ?? 0);
		if (appFp > peak.appFootprintMb) {
			peak.appFootprintMb = appFp;
			peak.appByRole = Object.fromEntries(
				Object.entries(m.by).filter(([k]) => k !== CHROME),
			);
		}
		peak.appRssMb = Math.max(peak.appRssMb, appRss);
		peak.chromeFootprintMb = Math.max(
			peak.chromeFootprintMb,
			chrome?.footprintMb ?? 0,
		);
		if (slow)
			peak.totalFootprintMb = Math.max(peak.totalFootprintMb, m.footprintMb);
		const busy = await page.evaluate(
			() =>
				document.querySelector('[data-testid="scan-status"]')?.textContent ??
				"",
		);
		if (
			chromeSeen &&
			!chrome &&
			!/Scanning/.test(busy) &&
			peak.chromeRssMb > 0
		) {
			if (!quietSince) quietSince = Date.now();
			if (Date.now() - quietSince > 5_000) break;
		}
		await sleep(100);
	}
	sampling = false;
	await chromeSampler;
	results.peakDuringScan = { ...peak, chromeLaunched: chromeSeen };
	console.log("peak during scan", JSON.stringify(results.peakDuringScan));
	await app.close();
	await boards.close();
}

// 4. Installer and app size.
const dist = path.resolve(path.dirname(appPath), "..");
results.installers = fs
	.readdirSync(dist)
	.filter((f) => f.endsWith(".dmg"))
	.map((f) => ({
		file: f,
		mb: +(fs.statSync(path.join(dist, f)).size / 1048576).toFixed(1),
	}));
results.appMb = Number(
	execFileSync("du", ["-sm", appPath], { encoding: "utf8" }).split("\t")[0],
);
console.log(JSON.stringify(results, null, 2));
fs.writeFileSync(
	outArg ? path.resolve(outArg.slice(6)) : path.join(dist, "measurements.json"),
	JSON.stringify(results, null, 2),
);
