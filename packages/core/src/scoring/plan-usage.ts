/**
 * Plan usage: what each subscription (Claude, ChatGPT for Codex) has used of its windows, as the
 * vendor reports it, and how much of that OfferFinch itself used.
 *
 * The vendors report a window's use as a percentage and when it resets; they do not say which
 * app used it. OfferFinch's share is measured: the plan's use is read around its own calls, and
 * the increase while a call was in flight (or since a call ended that was not read after) is
 * attributed to OfferFinch. Work the user does with the same plan at the same moment counts
 * too; work done while OfferFinch is idle does not. A window's share starts over when the
 * window resets.
 */

export type PlanVendor = "anthropic" | "openai";
export type PlanWindowKind = "session" | "weekly" | "monthly" | "other";

/** One usage window as the vendor reported it just now. */
export interface PlanWindowReading {
	/** Stable per vendor (`five_hour`, `seven_day`, `primary`, `secondary`, …). */
	id: string;
	label: string;
	kind: PlanWindowKind;
	/** 0 to 100. */
	usedPercent: number;
	resetsAt: Date | null;
	durationMins: number | null;
}

/** The account behind the plan: non-secret, for Settings › Models. */
export interface PlanAccount {
	plan: string | null;
	/** Claude: paid extra usage, as the plan reports it. */
	extraUsage: {
		enabled: boolean;
		used: number | null;
		limit: number | null;
		currency: string | null;
	} | null;
	/** Codex: ChatGPT credits (Codex's paid extra usage). */
	credits: { balance: number | null; unlimited: boolean } | null;
}

/** One read of the plan's usage. */
export interface PlanSnapshot {
	at: Date;
	windows: PlanWindowReading[];
	/**
	 * `true`: the vendor's full report (a window missing from it is gone, and it covers every
	 * call that ended before it). `false`: a partial update (one window, mid-call); other
	 * windows keep their state, and calls still count as unread.
	 */
	complete: boolean;
	/** Unset: unchanged. */
	account?: PlanAccount | null;
}

export interface PlanWindowState extends PlanWindowReading {
	/** Of `usedPercent`, the points attributed to OfferFinch's own calls. */
	appPercent: number;
	sampledAt: Date;
}

export interface PlanUsageState {
	vendor: PlanVendor;
	/** The last complete read, or null before the first. */
	checkedAt: Date | null;
	account: PlanAccount | null;
	windows: PlanWindowState[];
}

export function emptyPlanUsage(vendor: PlanVendor): PlanUsageState {
	return { vendor, checkedAt: null, account: null, windows: [] };
}

export function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

/** Two reset times this close apart are the same window (clock skew, rounding). */
const SAME_WINDOW_MS = 5 * 60_000;

/** Whether a new reading is of the window `prev` was last seen in. */
function sameWindow(
	prev: PlanWindowState,
	next: PlanWindowReading,
	at: Date,
): boolean {
	if (prev.resetsAt && next.resetsAt)
		return (
			Math.abs(prev.resetsAt.getTime() - next.resetsAt.getTime()) <=
			SAME_WINDOW_MS
		);
	// Only one side says when it resets: the window is the same while that time is ahead.
	if (prev.resetsAt) return at.getTime() < prev.resetsAt.getTime();
	if (next.resetsAt) return next.usedPercent >= prev.usedPercent;
	// Neither does: use within a window never goes down, so a drop is a new window.
	return next.usedPercent >= prev.usedPercent;
}

/** A complete read older than the last complete read: it says nothing new about the whole. */
function stalePlanSnapshot(
	state: PlanUsageState,
	snapshot: PlanSnapshot,
): boolean {
	return (
		snapshot.complete &&
		state.checkedAt !== null &&
		snapshot.at.getTime() < state.checkedAt.getTime()
	);
}

/** A reading of a window that reset before the one on record: an old read arriving late. */
function earlierWindow(
	prev: PlanWindowState,
	next: PlanWindowReading,
): boolean {
	return (
		prev.resetsAt !== null &&
		next.resetsAt !== null &&
		next.resetsAt.getTime() < prev.resetsAt.getTime() - SAME_WINDOW_MS
	);
}

/**
 * Folds one read into the state. `attributable`: OfferFinch's calls were in flight, or ended
 * unread, since the last read, so the increase is OfferFinch's. Within a window the vendor's
 * percentage never goes down, so a lower reading (an older one arriving late) keeps the higher
 * value and adds nothing. A new window starts its share over: at the reading when
 * attributable (the window's use so far is OfferFinch's calls), else at zero. A read of a
 * window that reset before the one on record is ignored, and a complete read older than the
 * last one counts as partial: neither can take the state backwards.
 */
export function applyPlanSnapshot(
	state: PlanUsageState,
	snapshot: PlanSnapshot,
	attributable: boolean,
): PlanUsageState {
	const complete = snapshot.complete && !stalePlanSnapshot(state, snapshot);
	const windows = new Map(state.windows.map((w) => [w.id, w]));
	for (const reading of snapshot.windows) {
		const used = clampPercent(reading.usedPercent);
		const prev = windows.get(reading.id);
		if (prev && earlierWindow(prev, reading)) continue;
		if (prev && sameWindow(prev, reading, snapshot.at)) {
			const delta = Math.max(0, used - prev.usedPercent);
			windows.set(reading.id, {
				...prev,
				label: reading.label,
				kind: reading.kind,
				usedPercent: Math.max(prev.usedPercent, used),
				resetsAt: reading.resetsAt ?? prev.resetsAt,
				durationMins: reading.durationMins ?? prev.durationMins,
				appPercent: clampPercent(prev.appPercent + (attributable ? delta : 0)),
				sampledAt: snapshot.at,
			});
		} else {
			windows.set(reading.id, {
				...reading,
				usedPercent: used,
				appPercent: attributable ? used : 0,
				sampledAt: snapshot.at,
			});
		}
	}
	const kept = complete
		? [...windows.values()].filter((w) =>
				snapshot.windows.some((r) => r.id === w.id),
			)
		: [...windows.values()];
	return {
		vendor: state.vendor,
		checkedAt: complete ? snapshot.at : state.checkedAt,
		account:
			snapshot.account === undefined || !complete
				? state.account
				: snapshot.account,
		windows: kept,
	};
}

/** What a window looks like now: ended windows read as empty until the next read. */
export interface PlanWindowView {
	id: string;
	label: string;
	kind: PlanWindowKind;
	usedPercent: number;
	appPercent: number;
	leftPercent: number;
	resetsAt: string | null;
	durationMins: number | null;
	/** How much of the window's time has passed, 0 to 100, when its length is known. */
	elapsedPercent: number | null;
	/** The reset time has passed: the vendor has not been asked since. */
	ended: boolean;
}

export function planWindowView(
	window: PlanWindowState,
	now: Date,
): PlanWindowView {
	const ended =
		window.resetsAt !== null && window.resetsAt.getTime() <= now.getTime();
	const used = ended ? 0 : Math.round(window.usedPercent);
	const app = ended ? 0 : Math.min(used, Math.round(window.appPercent));
	let elapsed: number | null = null;
	if (!ended && window.resetsAt && window.durationMins) {
		const length = window.durationMins * 60_000;
		const start = window.resetsAt.getTime() - length;
		elapsed = clampPercent(((now.getTime() - start) / length) * 100);
	}
	return {
		id: window.id,
		label: window.label,
		kind: window.kind,
		usedPercent: used,
		appPercent: app,
		leftPercent: 100 - used,
		resetsAt: ended ? null : (window.resetsAt?.toISOString() ?? null),
		durationMins: window.durationMins,
		elapsedPercent: elapsed === null ? null : Math.round(elapsed),
		ended,
	};
}

/** The window's start, when its length and reset are known: the calls since then are in it. */
export function planWindowStart(window: {
	resetsAt: Date | null;
	durationMins: number | null;
}): Date | null {
	if (!window.resetsAt || !window.durationMins) return null;
	return new Date(window.resetsAt.getTime() - window.durationMins * 60_000);
}

// ---------------------------------------------------------------------------------------------
// Serialization: the state as JSON (dates as ISO strings), for a database row.

export interface PlanUsageJson {
	vendor: PlanVendor;
	checkedAt: string | null;
	account: PlanAccount | null;
	windows: (Omit<PlanWindowState, "resetsAt" | "sampledAt"> & {
		resetsAt: string | null;
		sampledAt: string;
	})[];
}

export function planUsageToJson(state: PlanUsageState): PlanUsageJson {
	return {
		vendor: state.vendor,
		checkedAt: state.checkedAt?.toISOString() ?? null,
		account: state.account,
		windows: state.windows.map((w) => ({
			...w,
			resetsAt: w.resetsAt?.toISOString() ?? null,
			sampledAt: w.sampledAt.toISOString(),
		})),
	};
}

function dateOf(value: unknown): Date | null {
	if (typeof value !== "string") return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** A stored state, or the empty one when the row is missing or unreadable. */
export function planUsageFromJson(
	vendor: PlanVendor,
	raw: unknown,
): PlanUsageState {
	const json = raw as Partial<PlanUsageJson> | null;
	if (!json || typeof json !== "object" || !Array.isArray(json.windows))
		return emptyPlanUsage(vendor);
	const windows: PlanWindowState[] = [];
	for (const w of json.windows) {
		if (!w || typeof w.id !== "string") continue;
		windows.push({
			id: w.id,
			label: typeof w.label === "string" ? w.label : w.id,
			kind: w.kind ?? "other",
			usedPercent: clampPercent(Number(w.usedPercent)),
			appPercent: clampPercent(Number(w.appPercent)),
			resetsAt: dateOf(w.resetsAt),
			durationMins:
				typeof w.durationMins === "number" && w.durationMins > 0
					? w.durationMins
					: null,
			sampledAt: dateOf(w.sampledAt) ?? new Date(0),
		});
	}
	return {
		vendor,
		checkedAt: dateOf(json.checkedAt),
		account: json.account ?? null,
		windows,
	};
}

// ---------------------------------------------------------------------------------------------
// The tracker: one per user, fed by the subscription providers and the status checks.

export interface PlanUsageStore {
	load(userId: string, vendor: PlanVendor): Promise<PlanUsageState | null>;
	save(userId: string, state: PlanUsageState): Promise<void>;
}

/** One subscription call's reads, so its increase is attributed to OfferFinch. */
export interface PlanUsageCall {
	/** The prompt was handed to the vendor. */
	sent(): void;
	/** A read made by this call (after the prompt was sent, or around it). */
	sample(snapshot: PlanSnapshot): void;
	/** The call is over, however it ended. */
	done(): void;
}

/** What a provider gets: reads outside a call, and a handle per call. */
export interface PlanUsageSink {
	sample(snapshot: PlanSnapshot): void;
	call(): PlanUsageCall;
	/**
	 * True when a call about to start needs a fresh complete read first: the last one is older
	 * than `maxAgeMs` and no call is in flight, so what the plan did meanwhile (the user's own
	 * work) would otherwise be read as the call's.
	 */
	baselineNeeded(maxAgeMs: number): boolean;
}

export interface PlanUsageTrackerOptions {
	userId: string;
	store?: PlanUsageStore;
	/**
	 * Called once a vendor has no call in flight and some call ended without a complete read
	 * after it (Claude: a call reports one window as it answers; the full report needs a probe).
	 * The worker answers with a fresh status read, which lands here as a complete sample.
	 */
	onIdle?: (vendor: PlanVendor) => void;
	/** How long after the last call ends `onIdle` fires (coalesces a batch). Default 20 s. */
	idleMs?: number;
	log?: (message: string, data?: Record<string, unknown>) => void;
}

export class PlanUsageTracker {
	private readonly states = new Map<PlanVendor, PlanUsageState>();
	private readonly inFlight = new Map<PlanVendor, number>();
	/** Calls that were sent and ended without a complete read after them. */
	private readonly unread = new Map<PlanVendor, number>();
	private readonly idleTimers = new Map<
		PlanVendor,
		ReturnType<typeof setTimeout>
	>();
	private writes: Promise<void> = Promise.resolve();

	constructor(private readonly options: PlanUsageTrackerOptions) {}

	/** Reads the stored states (a worker start). */
	async load(): Promise<void> {
		for (const vendor of ["anthropic", "openai"] as const) {
			const stored = await this.options.store?.load(
				this.options.userId,
				vendor,
			);
			if (stored) this.states.set(vendor, stored);
		}
	}

	state(vendor: PlanVendor): PlanUsageState {
		return this.states.get(vendor) ?? emptyPlanUsage(vendor);
	}

	/** Pending writes done (tests, shutdown). */
	flush(): Promise<void> {
		return this.writes;
	}

	private attributable(vendor: PlanVendor): boolean {
		return (
			(this.inFlight.get(vendor) ?? 0) > 0 || (this.unread.get(vendor) ?? 0) > 0
		);
	}

	private apply(
		vendor: PlanVendor,
		snapshot: PlanSnapshot,
		attributable: boolean,
	): void {
		const state = this.state(vendor);
		const complete = snapshot.complete && !stalePlanSnapshot(state, snapshot);
		const next = applyPlanSnapshot(state, snapshot, attributable);
		this.states.set(vendor, next);
		if (complete) {
			this.unread.set(vendor, 0);
			this.clearIdle(vendor);
		}
		const store = this.options.store;
		if (store)
			this.writes = this.writes
				.then(() => store.save(this.options.userId, next))
				.catch((error) =>
					this.options.log?.("plan usage not saved", {
						vendor,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
	}

	/** A read outside any call (a status check): OfferFinch's only when its calls were running. */
	sample(vendor: PlanVendor, snapshot: PlanSnapshot): void {
		this.apply(vendor, snapshot, this.attributable(vendor));
	}

	private clearIdle(vendor: PlanVendor): void {
		const timer = this.idleTimers.get(vendor);
		if (timer) clearTimeout(timer);
		this.idleTimers.delete(vendor);
	}

	private scheduleIdle(vendor: PlanVendor): void {
		if (!this.options.onIdle || this.idleTimers.has(vendor)) return;
		const timer = setTimeout(() => {
			this.idleTimers.delete(vendor);
			if ((this.inFlight.get(vendor) ?? 0) > 0) return;
			if ((this.unread.get(vendor) ?? 0) === 0) return;
			this.options.onIdle?.(vendor);
		}, this.options.idleMs ?? 20_000);
		timer.unref?.();
		this.idleTimers.set(vendor, timer);
	}

	sink(vendor: PlanVendor): PlanUsageSink {
		return {
			sample: (snapshot) => this.sample(vendor, snapshot),
			baselineNeeded: (maxAgeMs) => {
				if ((this.inFlight.get(vendor) ?? 0) > 0) return false;
				const last = this.state(vendor).checkedAt;
				return !last || Date.now() - last.getTime() > maxAgeMs;
			},
			call: () => {
				let sent = false;
				let readAfter = false;
				let over = false;
				return {
					sent: () => {
						if (sent || over) return;
						sent = true;
						this.inFlight.set(vendor, (this.inFlight.get(vendor) ?? 0) + 1);
						this.clearIdle(vendor);
					},
					sample: (snapshot) => {
						if (over) return;
						// A call's own read after its prompt: the increase is this call's.
						this.apply(vendor, snapshot, sent || this.attributable(vendor));
						if (sent && snapshot.complete) readAfter = true;
					},
					done: () => {
						if (over) return;
						over = true;
						if (!sent) return;
						this.inFlight.set(
							vendor,
							Math.max(0, (this.inFlight.get(vendor) ?? 0) - 1),
						);
						if (!readAfter) {
							this.unread.set(vendor, (this.unread.get(vendor) ?? 0) + 1);
						}
						if (
							(this.inFlight.get(vendor) ?? 0) === 0 &&
							this.attributable(vendor)
						)
							this.scheduleIdle(vendor);
					},
				};
			},
		};
	}
}
