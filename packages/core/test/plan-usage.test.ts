import { describe, expect, it } from "vitest";

import {
	applyPlanSnapshot,
	emptyPlanUsage,
	type PlanSnapshot,
	type PlanUsageState,
	PlanUsageTracker,
	planUsageFromJson,
	planUsageToJson,
	planWindowStart,
	planWindowView,
} from "../src/scoring/plan-usage";

const T0 = new Date("2026-11-04T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const RESET = new Date("2026-11-04T14:00:00Z");

function snapshot(
	used: number,
	options: {
		at?: Date;
		resetsAt?: Date | null;
		complete?: boolean;
		id?: string;
		weekly?: number;
	} = {},
): PlanSnapshot {
	const windows: PlanSnapshot["windows"] = [
		{
			id: options.id ?? "five_hour",
			label: "Session",
			kind: "session",
			usedPercent: used,
			resetsAt: options.resetsAt === undefined ? RESET : options.resetsAt,
			durationMins: 300,
		},
	];
	if (options.weekly !== undefined)
		windows.push({
			id: "seven_day",
			label: "Weekly",
			kind: "weekly",
			usedPercent: options.weekly,
			resetsAt: new Date("2026-11-09T00:00:00Z"),
			durationMins: 7 * 24 * 60,
		});
	return {
		at: options.at ?? T0,
		windows,
		complete: options.complete ?? true,
	};
}

describe("applyPlanSnapshot", () => {
	it("attributes the increase to OfferFinch only while its calls ran", () => {
		let state = applyPlanSnapshot(
			emptyPlanUsage("anthropic"),
			snapshot(10),
			false,
		);
		expect(state.windows[0]).toMatchObject({ usedPercent: 10, appPercent: 0 });
		state = applyPlanSnapshot(state, snapshot(14, { at: at(1) }), true);
		expect(state.windows[0]).toMatchObject({ usedPercent: 14, appPercent: 4 });
		// The user's own work, with OfferFinch idle: not OfferFinch's.
		state = applyPlanSnapshot(state, snapshot(30, { at: at(60) }), false);
		expect(state.windows[0]).toMatchObject({ usedPercent: 30, appPercent: 4 });
		state = applyPlanSnapshot(state, snapshot(33, { at: at(61) }), true);
		expect(state.windows[0]).toMatchObject({ usedPercent: 33, appPercent: 7 });
	});

	it("keeps the higher reading when an older one arrives late, adding nothing", () => {
		let state = applyPlanSnapshot(
			emptyPlanUsage("anthropic"),
			snapshot(10),
			false,
		);
		state = applyPlanSnapshot(state, snapshot(14, { at: at(1) }), true);
		state = applyPlanSnapshot(state, snapshot(12, { at: at(2) }), true);
		expect(state.windows[0]).toMatchObject({ usedPercent: 14, appPercent: 4 });
		state = applyPlanSnapshot(state, snapshot(16, { at: at(3) }), true);
		expect(state.windows[0]).toMatchObject({ usedPercent: 16, appPercent: 6 });
	});

	it("starts a window's share over when it resets", () => {
		let state = applyPlanSnapshot(
			emptyPlanUsage("anthropic"),
			snapshot(90),
			false,
		);
		state = applyPlanSnapshot(state, snapshot(95, { at: at(1) }), true);
		const later = new Date("2026-11-04T19:00:00Z");
		// A new reset time: the old window ended; the reading is what the new one has so far.
		state = applyPlanSnapshot(
			state,
			snapshot(3, { at: at(300), resetsAt: later }),
			true,
		);
		expect(state.windows[0]).toMatchObject({
			usedPercent: 3,
			appPercent: 3,
			resetsAt: later,
		});
		state = applyPlanSnapshot(
			state,
			snapshot(40, { at: at(600), resetsAt: new Date("2026-11-05T01:00:00Z") }),
			false,
		);
		expect(state.windows[0]).toMatchObject({ usedPercent: 40, appPercent: 0 });
	});

	it("treats reset times a few minutes apart as the same window", () => {
		let state = applyPlanSnapshot(
			emptyPlanUsage("anthropic"),
			snapshot(10),
			false,
		);
		state = applyPlanSnapshot(
			state,
			snapshot(12, {
				at: at(1),
				resetsAt: new Date(RESET.getTime() + 90_000),
			}),
			true,
		);
		expect(state.windows[0]).toMatchObject({ usedPercent: 12, appPercent: 2 });
	});

	it("a partial update touches its window only and leaves checkedAt alone", () => {
		let state = applyPlanSnapshot(
			emptyPlanUsage("anthropic"),
			snapshot(10, { weekly: 50 }),
			false,
		);
		expect(state.checkedAt).toEqual(T0);
		state = applyPlanSnapshot(
			state,
			snapshot(15, { at: at(1), complete: false }),
			true,
		);
		expect(state.checkedAt).toEqual(T0);
		expect(state.windows).toHaveLength(2);
		expect(state.windows.find((w) => w.id === "five_hour")).toMatchObject({
			usedPercent: 15,
			appPercent: 5,
		});
		expect(state.windows.find((w) => w.id === "seven_day")).toMatchObject({
			usedPercent: 50,
			appPercent: 0,
		});
		// The next complete read catches the weekly increase those calls made.
		state = applyPlanSnapshot(
			state,
			snapshot(15, { at: at(2), weekly: 51 }),
			true,
		);
		expect(state.windows.find((w) => w.id === "seven_day")).toMatchObject({
			usedPercent: 51,
			appPercent: 1,
		});
		expect(state.checkedAt).toEqual(at(2));
	});

	it("a complete read drops windows the vendor no longer reports", () => {
		let state = applyPlanSnapshot(
			emptyPlanUsage("anthropic"),
			snapshot(10, { weekly: 50 }),
			false,
		);
		state = applyPlanSnapshot(state, snapshot(10, { at: at(1) }), false);
		expect(state.windows.map((w) => w.id)).toEqual(["five_hour"]);
	});

	it("a reading without a reset time stays in the window while its reset is ahead", () => {
		let state = applyPlanSnapshot(
			emptyPlanUsage("anthropic"),
			snapshot(10),
			false,
		);
		state = applyPlanSnapshot(
			state,
			snapshot(12, { at: at(1), resetsAt: null, complete: false }),
			true,
		);
		expect(state.windows[0]).toMatchObject({
			usedPercent: 12,
			appPercent: 2,
			resetsAt: RESET,
		});
		// Past the reset: a drop is the new window.
		state = applyPlanSnapshot(
			state,
			snapshot(1, { at: at(400), resetsAt: null, complete: false }),
			true,
		);
		expect(state.windows[0]).toMatchObject({ usedPercent: 1, appPercent: 1 });
	});
});

describe("planWindowView", () => {
	it("shows what is left, the elapsed share of the window, and ended windows as empty", () => {
		const state = applyPlanSnapshot(
			emptyPlanUsage("anthropic"),
			snapshot(40, { at: at(0) }),
			true,
		);
		const window = state.windows[0];
		if (!window) throw new Error("no window");
		// RESET is 4 hours ahead of T0 in a 5-hour window: 1 hour elapsed.
		expect(planWindowView(window, at(0))).toMatchObject({
			usedPercent: 40,
			appPercent: 40,
			leftPercent: 60,
			elapsedPercent: 20,
			ended: false,
			resetsAt: RESET.toISOString(),
		});
		expect(planWindowView(window, at(300))).toMatchObject({
			usedPercent: 0,
			appPercent: 0,
			leftPercent: 100,
			ended: true,
			resetsAt: null,
		});
		expect(planWindowStart(window)).toEqual(
			new Date(RESET.getTime() - 300 * 60_000),
		);
	});
});

describe("plan usage JSON", () => {
	it("round-trips, and reads a missing or broken row as empty", () => {
		const state = applyPlanSnapshot(
			emptyPlanUsage("openai"),
			{
				...snapshot(25, { id: "primary" }),
				account: {
					plan: "plus",
					extraUsage: null,
					credits: { balance: 12.5, unlimited: false },
				},
			},
			true,
		);
		const back = planUsageFromJson(
			"openai",
			JSON.parse(JSON.stringify(planUsageToJson(state))),
		);
		expect(back).toEqual(state);
		expect(planUsageFromJson("openai", null)).toEqual(emptyPlanUsage("openai"));
		expect(planUsageFromJson("openai", { windows: "no" })).toEqual(
			emptyPlanUsage("openai"),
		);
	});
});

describe("PlanUsageTracker", () => {
	function tracker(options: { onIdle?: (v: string) => void } = {}) {
		const saved: PlanUsageState[] = [];
		const t = new PlanUsageTracker({
			userId: "u1",
			store: {
				load: async () => null,
				save: async (_u, state) => {
					saved.push(state);
				},
			},
			onIdle: options.onIdle,
			idleMs: 5,
		});
		return { t, saved };
	}

	it("attributes a call's own reads, and a status read while calls run", async () => {
		const { t, saved } = tracker();
		const sink = t.sink("anthropic");
		sink.sample(snapshot(10));
		const call = sink.call();
		call.sent();
		call.sample(snapshot(13, { at: at(1), complete: false }));
		// Another caller's status read while this call is still open.
		sink.sample(snapshot(14, { at: at(2) }));
		call.done();
		// The call ended after that read: the idle read right after it is still OfferFinch's.
		sink.sample(snapshot(15, { at: at(3) }));
		// Idle now: the user's own work is not OfferFinch's.
		sink.sample(snapshot(20, { at: at(30) }));
		expect(t.state("anthropic").windows[0]).toMatchObject({
			usedPercent: 20,
			appPercent: 5,
		});
		await t.flush();
		expect(saved).toHaveLength(5);
	});

	it("a call that was never read after it ends marks the next read as OfferFinch's, once", () => {
		const { t } = tracker();
		const sink = t.sink("anthropic");
		sink.sample(snapshot(10));
		const call = sink.call();
		call.sent();
		call.done();
		sink.sample(snapshot(12, { at: at(1) }));
		sink.sample(snapshot(15, { at: at(2) }));
		expect(t.state("anthropic").windows[0]).toMatchObject({
			usedPercent: 15,
			appPercent: 2,
		});
	});

	it("a call read completely after its prompt leaves nothing unread", () => {
		const { t } = tracker();
		const sink = t.sink("openai");
		sink.sample(snapshot(10, { id: "primary" }));
		const call = sink.call();
		call.sent();
		call.sample(snapshot(12, { id: "primary", at: at(1) }));
		call.done();
		sink.sample(snapshot(30, { id: "primary", at: at(60) }));
		expect(t.state("openai").windows[0]).toMatchObject({
			usedPercent: 30,
			appPercent: 2,
		});
	});

	it("a call that sent nothing counts for nothing", () => {
		const { t } = tracker();
		const sink = t.sink("anthropic");
		sink.sample(snapshot(10));
		const call = sink.call();
		call.done();
		sink.sample(snapshot(12, { at: at(1) }));
		expect(t.state("anthropic").windows[0]).toMatchObject({ appPercent: 0 });
	});

	it("asks for a fresh read once a batch of unread calls is over", async () => {
		const idle: string[] = [];
		const { t } = tracker({ onIdle: (v) => idle.push(v) });
		const sink = t.sink("anthropic");
		const a = sink.call();
		const b = sink.call();
		a.sent();
		b.sent();
		a.done();
		await new Promise((r) => setTimeout(r, 15));
		// b is still in flight: not yet.
		expect(idle).toEqual([]);
		b.done();
		await new Promise((r) => setTimeout(r, 15));
		expect(idle).toEqual(["anthropic"]);
		// The fresh read came: nothing unread, no second ask.
		sink.sample(snapshot(12));
		await new Promise((r) => setTimeout(r, 15));
		expect(idle).toEqual(["anthropic"]);
	});

	it("loads stored states on start", async () => {
		const stored = applyPlanSnapshot(
			emptyPlanUsage("openai"),
			snapshot(7, { id: "primary" }),
			true,
		);
		const t = new PlanUsageTracker({
			userId: "u1",
			store: {
				load: async (_u, vendor) => (vendor === "openai" ? stored : null),
				save: async () => {},
			},
		});
		await t.load();
		expect(t.state("openai")).toEqual(stored);
		expect(t.state("anthropic")).toEqual(emptyPlanUsage("anthropic"));
	});
});

describe("reads arriving out of order", () => {
	it("ignores a window that reset before the one on record", () => {
		let state = applyPlanSnapshot(
			emptyPlanUsage("anthropic"),
			snapshot(95),
			true,
		);
		const later = new Date("2026-11-04T19:00:00Z");
		state = applyPlanSnapshot(
			state,
			snapshot(3, { at: at(300), resetsAt: later }),
			true,
		);
		// The old window's last read arrives late: nothing goes back.
		state = applyPlanSnapshot(
			state,
			snapshot(96, { at: at(301), complete: false }),
			true,
		);
		expect(state.windows[0]).toMatchObject({
			usedPercent: 3,
			appPercent: 3,
			resetsAt: later,
		});
	});

	it("treats a complete read older than the last one as partial", () => {
		let state = applyPlanSnapshot(
			emptyPlanUsage("anthropic"),
			snapshot(10, { weekly: 50 }),
			false,
		);
		state = applyPlanSnapshot(
			state,
			{
				...snapshot(12, { at: at(5) }),
				account: {
					plan: "max",
					extraUsage: null,
					credits: null,
				},
			},
			false,
		);
		expect(state.checkedAt).toEqual(at(5));
		expect(state.windows.map((w) => w.id)).toEqual(["five_hour"]);
		// An older complete read with the weekly window and another account: neither returns.
		state = applyPlanSnapshot(
			state,
			{
				...snapshot(11, { at: at(2), weekly: 50 }),
				account: { plan: "pro", extraUsage: null, credits: null },
			},
			false,
		);
		expect(state.checkedAt).toEqual(at(5));
		expect(state.account?.plan).toBe("max");
		expect(state.windows.map((w) => w.id).sort()).toEqual([
			"five_hour",
			"seven_day",
		]);
		expect(state.windows.find((w) => w.id === "five_hour")?.usedPercent).toBe(
			12,
		);
	});
});

describe("baselineNeeded", () => {
	it("asks for a fresh read when the last complete one is old and nothing runs", () => {
		const t = new PlanUsageTracker({ userId: "u1" });
		const sink = t.sink("anthropic");
		expect(sink.baselineNeeded(10_000)).toBe(true);
		sink.sample(snapshot(10, { at: new Date() }));
		expect(sink.baselineNeeded(10_000)).toBe(false);
		sink.sample(snapshot(10, { at: new Date(Date.now() - 20_000) }));
		// Older than the last: still the recent read counts.
		expect(sink.baselineNeeded(10_000)).toBe(false);
		const call = sink.call();
		call.sent();
		expect(sink.baselineNeeded(-1)).toBe(false);
		call.done();
		expect(sink.baselineNeeded(-1)).toBe(true);
	});
});
