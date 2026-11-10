import { describe, expect, it } from "vitest";
import {
	approveBlocked,
	barKind,
	exportTarget,
	moreItems,
} from "../src/renderer/components/pipeline/application/bar-model";
import {
	inboxStatus,
	lineAfter,
	rowToOpen,
} from "../src/renderer/components/pipeline/inbox-status";
import { createReadState } from "../src/renderer/lib/read-state";

/** localStorage, in memory. */
function memoryStorage(seed: Record<string, string> = {}) {
	const data = new Map(Object.entries(seed));
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		data,
	};
}

const row = (over: Partial<Parameters<typeof inboxStatus>[0]> = {}) => ({
	state: "scored",
	endedReason: null,
	prepareRequestedAt: null,
	closedAt: null,
	openQuestions: 0,
	...over,
});

describe("Inbox status chips", () => {
	it("names each step as the status filter buckets it", () => {
		expect(inboxStatus(row())).toMatchObject({
			bucket: "matches",
			label: "Match",
		});
		expect(
			inboxStatus(row({ prepareRequestedAt: "2026-11-05T10:00:00Z" })),
		).toMatchObject({ bucket: "drafting", label: "Drafting" });
		expect(inboxStatus(row({ state: "preparing" }))).toMatchObject({
			bucket: "drafting",
			label: "Drafting",
		});
		expect(inboxStatus(row({ state: "needs_answers" }))).toMatchObject({
			bucket: "drafting",
			label: "Needs answers",
		});
		expect(inboxStatus(row({ state: "ready_for_review" }))).toMatchObject({
			bucket: "review",
			label: "To review",
		});
		expect(inboxStatus(row({ state: "needs_human" }))).toMatchObject({
			bucket: "review",
		});
		// An employer's form that was sent waits for the user's email (decision 2026-11-09).
		expect(
			inboxStatus(row({ state: "needs_human", sentCheckEmail: 1 })),
		).toMatchObject({ bucket: "review", label: "Sent — check your email" });
		expect(inboxStatus(row({ state: "approved" }))).toMatchObject({
			bucket: "approved",
			label: "Approved",
		});
		expect(inboxStatus(row({ state: "applying" }))).toMatchObject({
			bucket: "approved",
		});
		expect(inboxStatus(row({ state: "applied" }))).toMatchObject({
			bucket: "closed",
			label: "Applied",
		});
		expect(inboxStatus(row({ state: "dismissed" }))).toMatchObject({
			bucket: "closed",
			label: "Not interested",
		});
	});

	it("puts a closed posting and a fit below the minimum under Closed, as the views do", () => {
		const closedAt = "2026-11-01T00:00:00Z";
		expect(inboxStatus(row({ closedAt }))).toMatchObject({
			bucket: "closed",
			label: "Posting closed",
		});
		expect(
			inboxStatus(row({ state: "ready_for_review", closedAt })),
		).toMatchObject({ bucket: "closed" });
		// Submitted: a posting closed since changes nothing.
		expect(inboxStatus(row({ state: "applying", closedAt }))).toMatchObject({
			bucket: "approved",
		});
		expect(
			inboxStatus(row({ endedReason: "below the minimum fit" })),
		).toMatchObject({ bucket: "closed", label: "Below your minimum" });
	});

	it("never labels a status with trailing dots", () => {
		for (const state of [
			"scored",
			"preparing",
			"needs_answers",
			"ready_for_review",
			"needs_human",
			"approved",
			"applying",
			"applied",
			"rejected",
			"expired",
			"failed",
			"dismissed",
		])
			expect(inboxStatus(row({ state })).label).not.toMatch(/(…|\.\.\.)$/);
	});
});

describe("Inbox status filter", () => {
	it("opens the first row of the filtered list once it is in", () => {
		const items = ["first", "second"];
		expect(rowToOpen({ items, selected: false, settled: true })).toBe("first");
	});

	it("waits while the last filter's rows are still on screen", () => {
		expect(
			rowToOpen({ items: ["old"], selected: false, settled: false }),
		).toBeNull();
	});

	it("never reopens a row that is leaving: the last one gone leaves the detail empty", () => {
		// Not interested on the only match: the selection clears while the row fades out.
		const leaving = new Set(["only"]);
		expect(
			rowToOpen({
				items: ["only"],
				selected: false,
				settled: true,
				leaving: (id) => leaving.has(id),
			}),
		).toBeNull();
		expect(
			rowToOpen({
				items: ["only", "next"],
				selected: false,
				settled: true,
				leaving: (id) => leaving.has(id),
			}),
		).toBe("next");
	});

	it("opens the next row that stays after one leaves, skipping rows already leaving", () => {
		const ids = (id: string) => [id];
		expect(lineAfter(["a", "b", "c"], ["a"], ids)).toBe("b");
		expect(lineAfter(["a", "b", "c"], ["a"], ids, new Set(["b"]))).toBe("c");
		expect(lineAfter(["a", "b", "c"], ["c"], ids, new Set(["b"]))).toBe("a");
		// The last row leaving: nothing to open.
		expect(lineAfter(["a"], ["a"], ids)).toBeNull();
		expect(lineAfter(["a", "b"], ["b"], ids, new Set(["a"]))).toBeNull();
	});

	it("keeps a row the user opened, and opens nothing in an empty list", () => {
		expect(
			rowToOpen({ items: ["a"], selected: true, settled: true }),
		).toBeNull();
		expect(rowToOpen({ items: [], selected: false, settled: true })).toBeNull();
	});
});

describe("Unread dot", () => {
	const NOW = Date.parse("2026-11-05T12:00:00Z");

	it("counts every row from before the upgrade as read, and new ones as unread", () => {
		const storage = memoryStorage();
		const reads = createReadState(storage, () => NOW);
		expect(
			reads.isUnread({ id: "old", createdAt: new Date(NOW - 60_000) }),
		).toBe(false);
		expect(
			reads.isUnread({ id: "new", createdAt: new Date(NOW + 60_000) }),
		).toBe(true);
		// The start is kept: a later launch does not move it.
		const later = createReadState(storage, () => NOW + 86_400_000);
		expect(
			later.isUnread({ id: "new", createdAt: new Date(NOW + 60_000) }),
		).toBe(true);
	});

	it("marks a row read once, and keeps it between launches", () => {
		const storage = memoryStorage();
		const reads = createReadState(storage, () => NOW);
		const job = { id: "a", createdAt: new Date(NOW + 1_000) };
		expect(reads.isUnread(job)).toBe(true);
		expect(reads.markRead(job.id)).toBe(true);
		expect(reads.isUnread(job)).toBe(false);
		// Already read: nothing to re-render.
		expect(reads.markRead(job.id)).toBe(false);
		expect(createReadState(storage, () => NOW).isUnread(job)).toBe(false);
	});

	it("reads the ids the dot stored before", () => {
		const storage = memoryStorage({
			"offerfinch.inbox.seen": JSON.stringify(["seen-before"]),
			"offerfinch.inbox.readSince": String(NOW - 1_000),
		});
		const reads = createReadState(storage, () => NOW);
		expect(reads.isUnread({ id: "seen-before", createdAt: NOW })).toBe(false);
	});
});

const app = (over: Record<string, unknown> = {}) => ({
	state: "ready_for_review",
	prepareRequestedAt: null,
	endedReason: null,
	job: { closedAt: null },
	openFlags: 0,
	approvable: true,
	reviewCurrent: true,
	checkError: null,
	staleProfile: [],
	redraft: null,
	...over,
});

describe("Action bar", () => {
	it("offers Interested and Not interested on a match, Reject and Approve in review", () => {
		expect(barKind(app({ state: "scored" }))).toBe("match");
		expect(
			barKind(app({ state: "scored", prepareRequestedAt: "2026-11-05" })),
		).toBe("other");
		expect(barKind(app({ state: "scored", job: { closedAt: "x" } }))).toBe(
			"other",
		);
		expect(barKind(app())).toBe("review");
		expect(barKind(app({ state: "approved" }))).toBe("other");
		// Before the application loads, the list's state decides.
		expect(barKind(undefined, "ready_for_review")).toBe("review");
	});

	it("keeps Approve off while a flag is open, and says why under the bar", () => {
		expect(approveBlocked(app())).toBeNull();
		expect(approveBlocked(app({ approvable: false, openFlags: 1 }))).toBe(
			"Approve opens once the flagged line is resolved: edit, delete or confirm it.",
		);
		expect(approveBlocked(app({ approvable: false, openFlags: 3 }))).toMatch(
			/3 flagged lines/,
		);
		expect(
			approveBlocked(app({ approvable: false, staleProfile: [{}] })),
		).toMatch(/profile changed/);
		expect(
			approveBlocked(app({ approvable: false, reviewCurrent: false })),
		).toMatch(/check of this version/);
		expect(approveBlocked(undefined)).toMatch(/Loading/);
	});

	it("lists the review's secondary actions in More, with real labels", () => {
		const items = moreItems({
			app: app(),
			hasDocuments: true,
			document: "CV",
			pdf: true,
			docx: false,
		});
		expect(items.map((i) => i.label)).toEqual([
			"Redraft",
			"Open Posting",
			"Copy Posting Link",
			"Save PDF",
			"Open Word Document",
			"Copy Text",
		]);
		expect(items.find((i) => i.id === "redraft")).toMatchObject({
			hint: "CV, letter or answers",
			disabled: null,
		});
		expect(items.find((i) => i.id === "open-docx")).toMatchObject({
			disabled: "The Word file is not exported yet",
		});
		for (const item of items) expect(item.label).not.toMatch(/(…|\.\.\.)$/);
	});

	it("opens no posting from More in try-it mode, and still copies its link", () => {
		const items = moreItems({
			app: app(),
			hasDocuments: true,
			document: "CV",
			pdf: true,
			docx: false,
			demo: true,
		});
		expect(items.map((i) => i.id)).not.toContain("open-posting");
		expect(items.map((i) => i.id)).toContain("copy-link");
	});

	it("leaves the document's exports out of More while an earlier version is on screen", () => {
		expect(exportTarget("Letter", false)).toBe("Letter");
		expect(exportTarget("Letter", true)).toBeNull();
		const earlier = moreItems({
			app: app(),
			hasDocuments: true,
			document: exportTarget("Letter", true),
			pdf: true,
			docx: true,
		});
		// Redraft and the posting stay; nothing that would act on the current version.
		expect(earlier.map((i) => i.id)).toEqual([
			"redraft",
			"open-posting",
			"copy-link",
		]);
	});

	it("turns Redraft off while one runs, and leaves it out before anything is drafted", () => {
		const running = moreItems({
			app: app({ redraft: { problem: null } }),
			hasDocuments: true,
			document: "CV",
			pdf: true,
			docx: true,
		});
		expect(running[0]).toMatchObject({
			id: "redraft",
			disabled: "A redraft is already running",
		});
		const match = moreItems({
			app: app({ state: "scored" }),
			hasDocuments: false,
			document: null,
			pdf: false,
			docx: false,
		});
		expect(match.map((i) => i.id)).toEqual(["open-posting", "copy-link"]);
	});
});
