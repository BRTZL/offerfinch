import { describe, expect, it } from "vitest";

import {
	HELD_FOR_MS,
	MAX_HELD_PER_KIND,
	NoticeBatcher,
	type NoticeItem,
	summarize,
} from "../src/worker/notices";
import {
	DEFAULT_NOTIFICATIONS,
	notificationSettingsSchema,
} from "../src/worker/settings";

/** A batcher on a fake clock with manual timers. */
function setup(
	settings = { ...DEFAULT_NOTIFICATIONS },
	holdUntil?: (now: number) => number | null,
	review?: (items: NoticeItem[]) => Promise<NoticeItem[]>,
) {
	let now = 0;
	const timers: { at: number; fn: () => void }[] = [];
	const sent: ReturnType<typeof summarize>[] = [];
	/** Every list `persist` was given, latest last. */
	const persisted: NoticeItem[][] = [];
	const batcher = new NoticeBatcher({
		emit: (n) => sent.push(n),
		settings: () => settings,
		persist: (items) => persisted.push(items),
		holdUntil: holdUntil ? () => holdUntil(now) : undefined,
		review,
		now: () => now,
		debounceMs: 1_000,
		minGapMs: 60_000,
		setTimer: (fn, ms) => {
			const t = { at: now + ms, fn };
			timers.push(t);
			return t;
		},
		clearTimer: (t) => {
			const i = timers.indexOf(t as never);
			if (i >= 0) timers.splice(i, 1);
		},
	});
	const advance = (ms: number) => {
		now += ms;
		for (const t of [...timers].sort((a, b) => a.at - b.at))
			if (t.at <= now) {
				timers.splice(timers.indexOf(t), 1);
				t.fn();
			}
	};
	return { batcher, sent, advance, settings, timers, persisted };
}

const match = (n: number): NoticeItem => ({
	kind: "match",
	applicationId: `app-${n}`,
	title: `Engineer ${n}`,
	company: "Acme",
	score: 80,
});

describe("notification batching", () => {
	it("sends one notification for a first scan's forty matches, after the scan ends", () => {
		const { batcher, sent, advance } = setup();
		batcher.setScanning(true);
		for (let n = 0; n < 40; n++) batcher.add(match(n));
		advance(10_000);
		expect(sent).toEqual([]);
		batcher.setScanning(false);
		advance(0);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.title).toBe("40 new strong matches");
		expect(sent[0]?.path).toBe("/inbox?view=matches");
	});

	it("opens the application itself when there is only one", () => {
		const { batcher, sent, advance } = setup();
		batcher.add(match(1));
		advance(1_000);
		expect(sent[0]).toMatchObject({
			title: "New strong match",
			body: "Engineer 1 at Acme · fit 80",
			path: "/applications/app-1",
		});
	});

	it("sends each kind at most once per gap; later items join the next one", () => {
		const { batcher, sent, advance } = setup();
		batcher.add({ kind: "review", applicationId: "a", title: "A" });
		advance(1_000);
		batcher.add({ kind: "review", applicationId: "b", title: "B" });
		batcher.add({ kind: "review", applicationId: "c", title: "C" });
		advance(1_000);
		expect(sent).toHaveLength(1);
		advance(60_000);
		expect(sent).toHaveLength(2);
		expect(sent[1]?.title).toBe("2 applications ready for review");
	});

	it("drops kinds the user turned off and duplicates of one application", () => {
		const { batcher, sent, advance } = setup({
			...DEFAULT_NOTIFICATIONS,
			match: false,
		});
		batcher.add(match(1));
		batcher.add({ kind: "question", applicationId: "q", title: "Q" });
		batcher.add({ kind: "question", applicationId: "q", title: "Q" });
		advance(1_000);
		expect(sent.map((n) => n.kind)).toEqual(["question"]);
		expect(sent[0]?.path).toBe("/questions");
	});
});

describe("quiet hours", () => {
	// Quiet until 10 minutes in, in the batcher's clock.
	const QUIET_END = 600_000;
	const quiet = (now: number) => (now < QUIET_END ? QUIET_END : null);

	it("hold every kind, follow-ups included, then send them together when they end", () => {
		const { batcher, sent, advance } = setup(undefined, quiet);
		batcher.add(match(1));
		batcher.add(match(2));
		batcher.add({ kind: "question", applicationId: "q", title: "Q" });
		batcher.add({
			kind: "followup",
			applicationId: "f",
			stageId: "s",
			title: "F",
			detail: "F at Acme: no news for 7 days.",
		});
		batcher.add({ kind: "stopped", title: "The scan stopped", detail: "D" });
		advance(QUIET_END - 1);
		expect(sent).toEqual([]);
		expect(batcher.pending()).toBe(5);
		// Looked at again at most a minute apart while held, so the end is never missed by long.
		advance(60_000);
		expect(sent.map((n) => n.title).sort()).toEqual([
			"2 new strong matches",
			"Question waiting",
			"Scan stopped",
			"Time to follow up",
		]);
		expect(batcher.pending()).toBe(0);
	});

	it("hold matches past the end of a scan too", () => {
		const { batcher, sent, advance } = setup(undefined, quiet);
		batcher.setScanning(true);
		batcher.add(match(1));
		batcher.setScanning(false);
		advance(0);
		expect(sent).toEqual([]);
		advance(QUIET_END);
		expect(sent).toHaveLength(1);
	});

	it("release at once on recheck when they are turned off", () => {
		let holding = true;
		const { batcher, sent, advance } = setup(undefined, () =>
			holding ? QUIET_END : null,
		);
		batcher.add(match(1));
		advance(1_000);
		expect(sent).toEqual([]);
		holding = false;
		batcher.recheck();
		advance(0);
		expect(sent).toHaveLength(1);
	});

	it("still drop a kind the user turned off while it was held", () => {
		const { batcher, sent, advance, settings } = setup(undefined, quiet);
		batcher.add(match(1));
		settings.match = false;
		advance(QUIET_END);
		expect(sent).toEqual([]);
		expect(batcher.pending()).toBe(0);
	});
});

describe("follow-up reminders after Applied", () => {
	it("one opens the application in Applied; several are one summary opening Applied", () => {
		const { batcher, sent, advance } = setup();
		const item = (n: number): NoticeItem => ({
			kind: "followup",
			applicationId: `app-${n}`,
			title: `Engineer ${n}`,
			company: "Northwind Labs",
			detail: `Engineer ${n} at Northwind Labs: no news for 7 days. A short follow-up may help.`,
		});
		batcher.add(item(1));
		advance(1_000);
		expect(sent).toEqual([
			{
				kind: "followup",
				title: "Time to follow up",
				body: "Engineer 1 at Northwind Labs: no news for 7 days. A short follow-up may help.",
				path: "/applied/app-1",
			},
		]);
		advance(60_000);
		for (const n of [2, 3, 4, 5]) batcher.add(item(n));
		advance(1_000);
		expect(sent[1]).toMatchObject({
			kind: "followup",
			title: "4 applications to follow up on",
			path: "/applied",
		});
	});

	it("is dropped when the user turned follow-up reminders off", () => {
		const { batcher, sent, advance } = setup({
			...DEFAULT_NOTIFICATIONS,
			followup: false,
		});
		batcher.add({ kind: "followup", applicationId: "a", title: "x" });
		advance(5_000);
		expect(sent).toEqual([]);
	});
});

describe("notification settings stored before follow-ups existed", () => {
	it("keep the user's switches and turn follow-ups on", () => {
		const parsed = notificationSettingsSchema.safeParse({
			match: false,
			question: true,
			review: false,
			stopped: true,
		});
		expect(parsed.success && parsed.data).toEqual({
			match: false,
			question: true,
			review: false,
			stopped: true,
			followup: true,
		});
	});
});

describe("a kind turned off while it waited", () => {
	it("is dropped at the flush, not sent", () => {
		const { batcher, sent, advance, settings } = setup();
		batcher.add({ kind: "followup", applicationId: "a", title: "x" });
		settings.followup = false;
		advance(1_000);
		expect(sent).toEqual([]);
		expect(batcher.pending()).toBe(0);
	});
});

describe("notification actions", () => {
	const oneMatch = (id: string): NoticeItem => ({
		kind: "match",
		applicationId: id,
		title: "Engineer",
		company: "Acme",
		score: 82,
	});

	it("one match gets Open and Not interested, on that match", () => {
		const notice = summarize("match", [oneMatch("a1")]);
		expect(notice.actions).toEqual(["open", "dismiss"]);
		expect(notice.applicationId).toBe("a1");
		expect(notice.path).toBe("/applications/a1");
	});

	it("several matches get Open only (the list), never a dismiss of several jobs", () => {
		const notice = summarize("match", [oneMatch("a1"), oneMatch("a2")]);
		expect(notice.actions).toEqual(["open"]);
		expect(notice.applicationId).toBeUndefined();
		expect(notice.path).toBe("/inbox?view=matches");
	});

	it("a stopped scan opens the scan history, where its fix is", () => {
		const stopped: NoticeItem = { kind: "stopped", title: "LinkedIn stopped" };
		expect(summarize("stopped", [stopped]).path).toBe("/scans");
		expect(summarize("stopped", [stopped, stopped]).path).toBe("/scans");
	});

	it("other kinds get no buttons", () => {
		for (const kind of ["question", "review", "stopped", "followup"] as const)
			expect(
				summarize(kind, [{ ...oneMatch("a1"), kind }]).actions,
			).toBeUndefined();
	});
});

describe("waiting notifications across a restart", () => {
	it("are persisted as they change: added, then empty once sent", () => {
		const { batcher, advance, persisted } = setup();
		batcher.add(match(1));
		expect(persisted.at(-1)).toEqual([{ ...match(1), heldAt: 0 }]);
		advance(1_000);
		expect(persisted.at(-1)).toEqual([]);
	});

	it("wait again once restored, and are held by quiet hours like any other", () => {
		let quietEnd: number | null = 100_000;
		const { batcher, sent, advance } = setup(undefined, () => quietEnd);
		batcher.restore([match(1), match(2), match(1)]);
		expect(batcher.pending()).toBe(2);
		advance(60_000);
		expect(sent).toEqual([]);
		quietEnd = null;
		advance(60_000);
		expect(sent.map((n) => n.title)).toEqual(["2 new strong matches"]);
	});

	it("are forgotten by clear, and the empty list persisted", () => {
		const { batcher, sent, advance, timers, persisted } = setup();
		batcher.add(match(1));
		batcher.clear();
		expect(timers).toHaveLength(0);
		expect(persisted.at(-1)).toEqual([]);
		advance(10_000);
		expect(sent).toEqual([]);
	});
});

describe("dispose", () => {
	it("clears a held notice's timer, and nothing arms it again", () => {
		const { batcher, sent, advance, timers, persisted } = setup(
			undefined,
			() => 10_000_000,
		);
		batcher.add(match(1));
		advance(1_000);
		// Held: it re-checks on a timer.
		expect(timers).toHaveLength(1);
		const writes = persisted.length;
		batcher.dispose();
		expect(timers).toHaveLength(0);
		expect(batcher.flush()).toBe(0);
		batcher.recheck();
		batcher.setScanning(true);
		batcher.setScanning(false);
		batcher.add(match(2));
		batcher.restore([match(3)]);
		expect(timers).toHaveLength(0);
		advance(10_000_000);
		expect(sent).toEqual([]);
		// What waited stays as last persisted: a restart sends it.
		expect(persisted).toHaveLength(writes);
		expect(persisted.at(-1)).toEqual([{ ...match(1), heldAt: 0 }]);
	});
});

const board = (companyId: string): NoticeItem => ({
	kind: "stopped",
	companyId,
	title: `${companyId}: stopped`,
	detail: `${companyId}'s board asked for a person.`,
});
/** Lets a review's promise answer, and the send after it run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("one waiting notice per subject, at most fifty a kind, for a week", () => {
	it("keeps a stopped board once, by company, and a stop with no company once, by its text", () => {
		const { batcher } = setup();
		batcher.add(board("c1"));
		batcher.add(board("c1"));
		batcher.add({ ...board("c1"), title: "Acme renamed: stopped" });
		batcher.add(board("c2"));
		const scan = {
			kind: "stopped",
			title: "The scan stopped",
			detail: "x",
		} as const;
		batcher.add(scan);
		batcher.add({ ...scan });
		batcher.add({ ...scan, detail: "y" });
		expect(batcher.pending()).toBe(4);
	});

	it("keeps the newest fifty of a kind", () => {
		const { batcher, sent, advance, persisted } = setup();
		for (let n = 1; n <= MAX_HELD_PER_KIND + 5; n++) batcher.add(match(n));
		batcher.add(board("c1"));
		expect(batcher.pending()).toBe(MAX_HELD_PER_KIND + 1);
		const kept = persisted.at(-1)?.filter((i) => i.kind === "match") ?? [];
		expect(kept).toHaveLength(MAX_HELD_PER_KIND);
		expect(kept[0]?.applicationId).toBe("app-6");
		advance(1_000);
		expect(sent.map((n) => n.title)).toEqual([
			`${MAX_HELD_PER_KIND} new strong matches`,
			"Scan stopped",
		]);
	});

	it("drops what waited longer than a week, restored or held", () => {
		const end = HELD_FOR_MS + 3_600_000;
		const { batcher, sent, advance, persisted } = setup(undefined, (now) =>
			now < end ? end : null,
		);
		advance(HELD_FOR_MS);
		// Written before heldAt existed: it waits from now.
		batcher.restore([
			{ ...match(1), heldAt: -1 },
			match(2),
			{ ...match(3), heldAt: 10 },
		]);
		expect(batcher.pending()).toBe(2);
		expect(persisted.at(-1)?.map((i) => i.applicationId)).toEqual([
			"app-2",
			"app-3",
		]);
		// Held by quiet hours: a week old by now, so dropped at the next look.
		advance(1_000);
		expect(persisted.at(-1)?.map((i) => i.applicationId)).toEqual(["app-2"]);
		expect(sent).toEqual([]);
		advance(3_600_000);
		expect(sent.map((n) => n.body)).toEqual(["Engineer 2 at Acme · fit 80"]);
	});
});

describe("a waiting notice checked before it goes out", () => {
	it("is dropped, and the removal persisted, when quiet hours end and it is no longer true", async () => {
		let quietEnd: number | null = 100_000;
		const reviewed: NoticeItem[][] = [];
		const { batcher, sent, advance, persisted } = setup(
			undefined,
			() => quietEnd,
			async (items) => {
				reviewed.push(items);
				return items.filter((i) => i.applicationId !== "app-1");
			},
		);
		batcher.add(match(1));
		batcher.add(match(2));
		advance(60_000);
		// Held: nothing is checked yet.
		expect(reviewed).toEqual([]);
		quietEnd = null;
		advance(60_000);
		expect(sent).toEqual([]);
		await settle();
		expect(reviewed).toHaveLength(1);
		expect(sent.map((n) => n.body)).toEqual(["Engineer 2 at Acme · fit 80"]);
		expect(persisted).toContainEqual([{ ...match(2), heldAt: 0 }]);
		expect(persisted.at(-1)).toEqual([]);
	});

	it("goes out unchecked when the check fails: stale beats lost", async () => {
		const { batcher, sent, advance } = setup(undefined, undefined, () =>
			Promise.reject(new Error("database closed")),
		);
		batcher.add(match(1));
		advance(1_000);
		await settle();
		expect(sent.map((n) => n.title)).toEqual(["New strong match"]);
	});

	it("is not sent when the batcher was disposed while the check ran", async () => {
		let answer: (items: NoticeItem[]) => void = () => {};
		const { batcher, sent, advance, persisted } = setup(
			undefined,
			undefined,
			(items) =>
				new Promise((resolve) => {
					answer = () => resolve(items);
				}),
		);
		batcher.add(match(1));
		advance(1_000);
		const writes = persisted.length;
		batcher.dispose();
		answer([]);
		await settle();
		expect(sent).toEqual([]);
		expect(persisted).toHaveLength(writes);
	});
});

describe("subjects already sent", () => {
	it("are known until forgotten (the watermark moved)", () => {
		const { batcher, advance } = setup();
		batcher.add(match(1));
		expect(batcher.wasSent(match(1))).toBe(false);
		advance(1_000);
		expect(batcher.wasSent(match(1))).toBe(true);
		expect(batcher.wasSent(match(2))).toBe(false);
		batcher.forgetSent();
		expect(batcher.wasSent(match(1))).toBe(false);
	});
});

describe("a newer event about a subject already waiting", () => {
	const question = (eventId: string): NoticeItem => ({
		kind: "question",
		applicationId: "app-1",
		title: "Engineer",
		company: "Acme",
		eventId,
	});

	it("replaces the waiting one, so a check of the old one still running cannot drop it", async () => {
		let answer: (items: NoticeItem[]) => void = () => {};
		const { batcher, sent, advance, persisted } = setup(
			undefined,
			undefined,
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		batcher.add(question("round-1"));
		advance(1_000);
		// Round 1 is being checked; round 2 arrives meanwhile.
		batcher.add(question("round-2"));
		expect(persisted.at(-1)).toMatchObject([{ eventId: "round-2" }]);
		// The check finds round 1 stale (its questions were answered); round 2 still goes out.
		answer([]);
		await settle();
		expect(sent.map((n) => n.title)).toEqual(["Question waiting"]);
		expect(batcher.pending()).toBe(0);
		expect(persisted.at(-1)).toEqual([]);
	});

	it("waits from when it arrived, not from when the old one did", () => {
		const { batcher, advance } = setup(undefined, () => Number.MAX_VALUE);
		batcher.add(question("round-1"));
		advance(HELD_FOR_MS - 1_000);
		batcher.add(question("round-2"));
		// Past round 1's week: a few looks while held.
		for (let i = 0; i < 4; i++) advance(60_000);
		expect(batcher.pending()).toBe(1);
	});

	it("the same event again changes nothing", () => {
		const { batcher, persisted } = setup();
		batcher.add(question("round-1"));
		const writes = persisted.length;
		batcher.add(question("round-1"));
		expect(persisted).toHaveLength(writes);
	});
});
