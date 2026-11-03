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
	now?: () => number;
	/** Quiet time after the last item before a batch goes out. */
	debounceMs?: number;
	/** At most one notification per kind in this window; later items join the next batch. */
	minGapMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

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
	stopped: "/settings/watchlist",
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
		return {
			kind,
			title: one[0]?.toUpperCase() + one.slice(1),
			body,
			path: item.applicationId
				? itemPath(kind, item.applicationId)
				: LIST_PATH[kind],
		};
	}
	const names = items
		.slice(0, 3)
		.map((i) => (i.company ? `${i.title} (${i.company})` : i.title))
		.join(", ");
	const rest = items.length > 3 ? ` and ${items.length - 3} more` : "";
	return {
		kind,
		title: `${items.length} ${many}`,
		body: `${names}${rest}`,
		path: LIST_PATH[kind],
	};
}

/**
 * Groups notifications so a busy moment (the first scan finding forty matches) is one
 * notification per kind, not forty. Items wait for a quiet `debounceMs`, and while a scan runs
 * matches are held until it ends. Each kind is sent at most once per `minGapMs`. Kinds the user
 * turned off are dropped.
 */
export class NoticeBatcher {
	private readonly queues = new Map<NoticeKind, NoticeItem[]>();
	private readonly lastSent = new Map<NoticeKind, number>();
	private timer: unknown = null;
	private scanning = false;
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
		if (!this.options.settings()[item.kind]) return;
		const queue = this.queues.get(item.kind) ?? [];
		if (
			item.applicationId &&
			queue.some((q) => q.applicationId === item.applicationId)
		)
			return;
		queue.push(item);
		this.queues.set(item.kind, queue);
		this.arm(this.debounceMs);
	}

	/** While true, matches wait; when the scan ends they go out together. */
	setScanning(scanning: boolean): void {
		const ended = this.scanning && !scanning;
		this.scanning = scanning;
		if (ended) this.arm(0);
	}

	private arm(ms: number) {
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = this.setTimer(() => {
			this.timer = null;
			this.flush();
		}, ms);
	}

	/** Sends what is due; returns how many notifications went out. */
	flush(): number {
		let sent = 0;
		let wait = Number.POSITIVE_INFINITY;
		for (const [kind, items] of this.queues) {
			if (items.length === 0) continue;
			// Turned off while it waited: dropped, never sent (nor marked as sent).
			if (!this.options.settings()[kind]) {
				this.queues.set(kind, []);
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
		if (Number.isFinite(wait)) this.arm(wait);
		return sent;
	}

	pending(): number {
		let n = 0;
		for (const items of this.queues.values()) n += items.length;
		return n;
	}
}
