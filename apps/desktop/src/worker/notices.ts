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
	/** For a stopped board: the company, so a notice about it is checked and kept once. */
	companyId?: string;
	/** When it first waited (ms), kept across a restart: past `HELD_FOR_MS` it is dropped. */
	heldAt?: number;
}

/** At most this many waiting items per kind; the oldest go first. A summary counts up to it. */
export const MAX_HELD_PER_KIND = 50;
/** A waiting item older than this (a week) is dropped, not sent. */
export const HELD_FOR_MS = 7 * 24 * 3_600_000;

/**
 * What an item is about: its application, its company, or (an errored scan, a stop with no
 * company) its text. Two items of a kind with one subject are one notice.
 */
function noticeKey(item: NoticeItem): string {
	const subject =
		item.applicationId ??
		item.companyId ??
		`${item.title}\n${item.detail ?? ""}`;
	return `${item.kind}:${subject}`;
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
	/**
	 * Before anything goes out: the items still worth sending (the same objects), checked against
	 * the database (an application deleted, a question answered while it waited). The others are
	 * dropped. If it fails, everything goes out: a stale notice beats a lost one.
	 */
	review?: (items: NoticeItem[]) => Promise<NoticeItem[]>;
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
 * turned off are dropped. In quiet hours (`holdUntil`) every kind waits for their end. Each kind
 * keeps one item per subject (`noticeKey`), at most `MAX_HELD_PER_KIND`, for at most `HELD_FOR_MS`.
 */
export class NoticeBatcher {
	private readonly queues = new Map<NoticeKind, NoticeItem[]>();
	private readonly lastSent = new Map<NoticeKind, number>();
	private timer: unknown = null;
	private scanning = false;
	private disposed = false;
	private reviewing = false;
	/** Subjects sent since `forgetSent` (`wasSent`). */
	private readonly sentKeys = new Set<string>();
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
		for (const item of items) this.queue(item);
		this.expire();
		// What is kept now: repeats, items past `HELD_FOR_MS` and kinds turned off are gone.
		if (items.length > 0) this.changed();
		if (this.pending() > 0) this.arm(this.debounceMs);
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

	/**
	 * Whether a notice about this subject went out since `forgetSent`. The caller reading the
	 * database skips those, so a watermark that could not move does not send them again.
	 */
	wasSent(item: NoticeItem): boolean {
		return this.sentKeys.has(noticeKey(item));
	}

	/** The watermark moved past what was sent: those subjects are not read again. */
	forgetSent(): void {
		this.sentKeys.clear();
	}

	private queue(item: NoticeItem): boolean {
		if (!this.options.settings()[item.kind]) return false;
		const queue = this.queues.get(item.kind) ?? [];
		const key = noticeKey(item);
		if (queue.some((q) => noticeKey(q) === key)) return false;
		queue.push({ ...item, heldAt: item.heldAt ?? this.now() });
		if (queue.length > MAX_HELD_PER_KIND)
			queue.splice(0, queue.length - MAX_HELD_PER_KIND);
		this.queues.set(item.kind, queue);
		return true;
	}

	/** Drops what waited longer than `HELD_FOR_MS`; returns how many. */
	private expire(): number {
		const oldest = this.now() - HELD_FOR_MS;
		let dropped = 0;
		for (const [kind, items] of this.queues) {
			const kept = items.filter((i) => (i.heldAt ?? oldest) >= oldest);
			dropped += items.length - kept.length;
			this.queues.set(kind, kept);
		}
		return dropped;
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

	/**
	 * Sends what is due; returns how many notifications went out. With `review`, the first look
	 * only starts the check and returns 0; what passes goes out when it answers.
	 */
	flush(): number {
		return this.send(false);
	}

	private send(reviewed: boolean): number {
		if (this.disposed) return 0;
		let dropped = this.expire();
		const holdUntil = this.options.holdUntil?.() ?? null;
		if (holdUntil !== null) {
			if (dropped > 0) this.changed();
			if (this.pending() > 0)
				this.arm(
					Math.max(1_000, Math.min(holdUntil - this.now(), HOLD_RECHECK_MS)),
				);
			return 0;
		}
		const { due, wait, off } = this.dueKinds();
		dropped += off;
		if (due.length > 0 && this.options.review && !reviewed) {
			if (dropped > 0) this.changed();
			this.startReview(this.options.review);
			return 0;
		}
		let sent = 0;
		for (const kind of due) {
			const items = this.queues.get(kind) ?? [];
			this.options.emit(summarize(kind, items), items);
			for (const item of items) this.sentKeys.add(noticeKey(item));
			this.lastSent.set(kind, this.now());
			this.queues.set(kind, []);
			sent++;
		}
		if (sent + dropped > 0) this.changed();
		if (Number.isFinite(wait)) this.arm(wait);
		return sent;
	}

	/**
	 * The kinds that can go out now, how long until the next one may (the gap between
	 * notifications), and how many kinds were dropped because the user turned them off.
	 */
	private dueKinds(): { due: NoticeKind[]; wait: number; off: number } {
		let wait = Number.POSITIVE_INFINITY;
		let off = 0;
		const due: NoticeKind[] = [];
		for (const [kind, items] of this.queues) {
			if (items.length === 0) continue;
			// Turned off while it waited: dropped, never sent (nor marked as sent).
			if (!this.options.settings()[kind]) {
				this.queues.set(kind, []);
				off++;
				continue;
			}
			if (kind === "match" && this.scanning) continue;
			const since =
				this.now() - (this.lastSent.get(kind) ?? Number.NEGATIVE_INFINITY);
			if (since < this.minGapMs) {
				wait = Math.min(wait, this.minGapMs - since);
				continue;
			}
			due.push(kind);
		}
		return { due, wait, off };
	}

	/** Checks every waiting item, drops the stale ones (persisted), then sends what is due. */
	private startReview(review: NonNullable<BatcherOptions["review"]>) {
		if (this.reviewing) return;
		this.reviewing = true;
		const items = [...this.queues.values()].flat();
		review(items)
			.then(
				(kept) => new Set(kept),
				// Unchecked: all of it goes out. A stale notice beats a lost one.
				() => new Set(items),
			)
			.then((kept) => {
				this.reviewing = false;
				if (this.disposed) return;
				const checked = new Set(items);
				let stale = 0;
				for (const [kind, queue] of this.queues) {
					// Added while it ran: just read, so not checked again.
					const left = queue.filter((i) => !checked.has(i) || kept.has(i));
					stale += queue.length - left.length;
					this.queues.set(kind, left);
				}
				if (stale > 0) this.changed();
				this.send(true);
			});
	}

	pending(): number {
		let n = 0;
		for (const items of this.queues.values()) n += items.length;
		return n;
	}
}
