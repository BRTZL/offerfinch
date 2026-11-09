import type { NativeNotice } from "../shared/worker-protocol";
import type { NotificationSettings } from "./settings";

export type NoticeKind = Exclude<NativeNotice["kind"], "added" | "check">;

export interface NoticeItem {
	kind: NoticeKind;
	/** Application id, for a click that opens it. */
	applicationId?: string;
	title: string;
	company?: string;
	score?: number;
	/** For "stopped": what stopped (a company's board, the scan). */
	detail?: string;
	/** For "followup": the stage entry it is about, marked reminded once it went out. */
	stageId?: string;
}

export interface BatcherOptions {
	/** Sends one notification, with the items it carries (a follow-up waits for main's answer). */
	emit: (notice: NativeNotice, items: NoticeItem[]) => void;
	settings: () => NotificationSettings;
	/**
	 * While this returns a time (quiet hours: when they end, in ms), nothing goes out: items wait
	 * and go out together, one notification per kind, once it returns null.
	 */
	holdUntil?: () => number | null;
	/**
	 * Called with every item still waiting whenever that changes (added, sent, dropped), so the
	 * caller can keep them across a restart (`restore`).
	 */
	persist?: (items: NoticeItem[]) => void;
	now?: () => number;
	/** Quiet time after the last item before a batch goes out. */
	debounceMs?: number;
	/** At most one notification per kind in this window; later items join the next batch. */
	minGapMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

/**
 * The longest wait between looks while held: timers stall while the Mac sleeps, so a wake after
 * the quiet hours' end is seen within this, not hours later.
 */
const HOLD_RECHECK_MS = 60_000;

const PLURAL: Record<NoticeKind, [string, string]> = {
	match: ["new strong match", "new strong matches"],
	question: ["question waiting", "questions waiting"],
	review: ["application ready for review", "applications ready for review"],
	stopped: ["scan stopped", "scans stopped"],
	followup: ["time to follow up", "applications to follow up on"],
};

const LIST_PATH: Record<NoticeKind, string> = {
	match: "/inbox?view=matches",
	question: "/questions",
	review: "/inbox?view=review",
	stopped: "/scans",
	followup: "/applied",
};

/** Where a click on one item's notification opens it: an application sent opens in Applied. */
function itemPath(kind: NoticeKind, applicationId: string): string {
	if (kind === "question") return "/questions";
	if (kind === "followup") return `/applied/${applicationId}`;
	return `/applications/${applicationId}`;
}

/** One notification for one item, or one summary for several of a kind. */
export function summarize(kind: NoticeKind, items: NoticeItem[]): NativeNotice {
	const [one, many] = PLURAL[kind];
	if (items.length === 1) {
		const item = items[0] as NoticeItem;
		const where = item.company ? ` at ${item.company}` : "";
		const body =
			kind === "match"
				? `${item.title}${where}${item.score === undefined ? "" : ` · fit ${item.score}`}`
				: kind === "stopped" || kind === "followup"
					? (item.detail ?? item.title)
					: `${item.title}${where}`;
		const notice: NativeNotice = {
			kind,
			title: one[0]?.toUpperCase() + one.slice(1),
			body,
			path: item.applicationId
				? itemPath(kind, item.applicationId)
				: LIST_PATH[kind],
		};
		// One match: Open, and Not interested on that match.
		if (kind === "match" && item.applicationId)
			return {
				...notice,
				actions: ["open", "dismiss"],
				applicationId: item.applicationId,
			};
		return kind === "match" ? { ...notice, actions: ["open"] } : notice;
	}
	const names = items
		.slice(0, 3)
		.map((i) => (i.company ? `${i.title} (${i.company})` : i.title))
		.join(", ");
	const rest = items.length > 3 ? ` and ${items.length - 3} more` : "";
	const notice: NativeNotice = {
		kind,
		title: `${items.length} ${many}`,
		body: `${names}${rest}`,
		path: LIST_PATH[kind],
	};
	// Several matches: Open (the list) only; one button never dismisses several jobs.
	return kind === "match" ? { ...notice, actions: ["open"] } : notice;
}

/**
 * Groups notifications so a busy moment (the first scan finding forty matches) is one
 * notification per kind, not forty. Items wait for a quiet `debounceMs`, and while a scan runs
 * matches are held until it ends. Each kind is sent at most once per `minGapMs`. Kinds the user
 * turned off are dropped. In quiet hours (`holdUntil`) every kind waits for their end.
 */
export class NoticeBatcher {
	private readonly queues = new Map<NoticeKind, NoticeItem[]>();
	private readonly lastSent = new Map<NoticeKind, number>();
	private timer: unknown = null;
	private scanning = false;
	private disposed = false;
	private readonly now: () => number;
	private readonly debounceMs: number;
	private readonly minGapMs: number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	constructor(private readonly options: BatcherOptions) {
		this.now = options.now ?? Date.now;
		this.debounceMs = options.debounceMs ?? 15_000;
		this.minGapMs = options.minGapMs ?? 120_000;
		this.setTimer =
			options.setTimer ??
			((fn, ms) => {
				const t = setTimeout(fn, ms);
				t.unref?.();
				return t;
			});
		this.clearTimer =
			options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
	}

	add(item: NoticeItem): void {
		if (this.disposed || !this.queue(item)) return;
		this.changed();
		this.arm(this.debounceMs);
	}

	/** Items that were waiting when the app last stopped: they wait again, as if just added. */
	restore(items: NoticeItem[]): void {
		if (this.disposed) return;
		let added = 0;
		for (const item of items) if (this.queue(item)) added++;
		if (added === 0) return;
		this.changed();
		this.arm(this.debounceMs);
	}

	/** Forgets every waiting item (the user's data was erased). */
	clear(): void {
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
		this.queues.clear();
		this.changed();
	}

	/** Stops for good: the timer is cleared and nothing arms it again. What waits stays persisted. */
	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
	}

	private queue(item: NoticeItem): boolean {
		if (!this.options.settings()[item.kind]) return false;
		const queue = this.queues.get(item.kind) ?? [];
		if (
			item.applicationId &&
			queue.some((q) => q.applicationId === item.applicationId)
		)
			return false;
		queue.push(item);
		this.queues.set(item.kind, queue);
		return true;
	}

	private changed() {
		if (this.disposed) return;
		this.options.persist?.([...this.queues.values()].flat());
	}

	/** While true, matches wait; when the scan ends they go out together. */
	setScanning(scanning: boolean): void {
		const ended = this.scanning && !scanning;
		this.scanning = scanning;
		if (ended) this.arm(0);
	}

	/** Looks again at once (quiet hours turned off or moved: what they held goes out). */
	recheck(): void {
		if (this.pending() > 0) this.arm(0);
	}

	private arm(ms: number) {
		if (this.disposed) return;
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = this.setTimer(() => {
			this.timer = null;
			this.flush();
		}, ms);
	}

	/** Sends what is due; returns how many notifications went out. */
	flush(): number {
		if (this.disposed) return 0;
		const holdUntil = this.options.holdUntil?.() ?? null;
		if (holdUntil !== null) {
			if (this.pending() > 0)
				this.arm(
					Math.max(1_000, Math.min(holdUntil - this.now(), HOLD_RECHECK_MS)),
				);
			return 0;
		}
		let sent = 0;
		let dropped = 0;
		let wait = Number.POSITIVE_INFINITY;
		for (const [kind, items] of this.queues) {
			if (items.length === 0) continue;
			// Turned off while it waited: dropped, never sent (nor marked as sent).
			if (!this.options.settings()[kind]) {
				this.queues.set(kind, []);
				dropped++;
				continue;
			}
			if (kind === "match" && this.scanning) continue;
			const since =
				this.now() - (this.lastSent.get(kind) ?? Number.NEGATIVE_INFINITY);
			if (since < this.minGapMs) {
				wait = Math.min(wait, this.minGapMs - since);
				continue;
			}
			this.options.emit(summarize(kind, items), items);
			this.lastSent.set(kind, this.now());
			this.queues.set(kind, []);
			sent++;
		}
		if (sent + dropped > 0) this.changed();
		if (Number.isFinite(wait)) this.arm(wait);
		return sent;
	}

	pending(): number {
		let n = 0;
		for (const items of this.queues.values()) n += items.length;
		return n;
	}
}
