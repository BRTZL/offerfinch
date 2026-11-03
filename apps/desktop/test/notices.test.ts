import { describe, expect, it } from "vitest";

import {
	NoticeBatcher,
	type NoticeItem,
	summarize,
} from "../src/worker/notices";
import {
	DEFAULT_NOTIFICATIONS,
	notificationSettingsSchema,
} from "../src/worker/settings";

/** A batcher on a fake clock with manual timers. */
function setup(settings = { ...DEFAULT_NOTIFICATIONS }) {
	let now = 0;
	const timers: { at: number; fn: () => void }[] = [];
	const sent: ReturnType<typeof summarize>[] = [];
	const batcher = new NoticeBatcher({
		emit: (n) => sent.push(n),
		settings: () => settings,
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
	return { batcher, sent, advance, settings };
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
