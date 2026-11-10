import type { BlobStore } from "@offerfinch/core/export/export";
import type { BrowserProvider } from "@offerfinch/core/scrape/browser";
import { describe, expect, it } from "vitest";

import { applyFixturesAllowed } from "../src/main/apply-fixtures";
import { buildPipeline } from "../src/worker/pipeline";
import { DEFAULT_AI } from "../src/worker/settings";

/**
 * Codex review of PR #149 (2026-11-09), P1: `OFFERFINCH_TEST=1` turned on the local stand-in
 * boards (loopback allowed, private networks not refused) even in a packaged app. Main decides it
 * from `app.isPackaged`, and the worker takes it only from that decision, never from test mode.
 */
describe("the local stand-in boards", () => {
	it("are never allowed in a packaged app, test mode or not", () => {
		expect(applyFixturesAllowed({ testMode: true, isPackaged: true })).toBe(
			false,
		);
		expect(applyFixturesAllowed({ testMode: false, isPackaged: true })).toBe(
			false,
		);
	});

	it("are allowed only in an unpackaged build in test mode", () => {
		expect(applyFixturesAllowed({ testMode: true, isPackaged: false })).toBe(
			true,
		);
		expect(applyFixturesAllowed({ testMode: false, isPackaged: false })).toBe(
			false,
		);
	});

	const build = (input: { test?: boolean; applyFixtures?: boolean }) =>
		buildPipeline({
			db: {} as never,
			ai: DEFAULT_AI,
			workflows: { runtime: "local" } as never,
			browser: {} as BrowserProvider,
			blobs: {} as BlobStore,
			notifier: { notifyStrongMatch: async () => {} },
			fakeModels: true,
			ownerUserId: "local",
			userData: "/tmp/offerfinch-test",
			siteHost: {
				site: async () => {
					throw new Error("no site tabs in tests");
				},
				onCheck: () => {},
				onCheckDone: () => {},
			},
			log: () => {},
			...input,
		}).deps.apply;

	it("are not implied by the worker's test mode", () => {
		expect(build({ test: true })).toMatchObject({
			fixtures: false,
			allowedHosts: [],
		});
	});

	it("open only when main passes the decision", () => {
		expect(build({ test: true, applyFixtures: true })).toMatchObject({
			fixtures: true,
			allowedHosts: ["127.0.0.1", "localhost"],
		});
	});
});
