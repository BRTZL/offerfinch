import { FOLLOW_UP_AFTER_DAYS } from "@offerfinch/core/domain/tracking";
import {
	type Database,
	markReminded,
	remindedStages,
	sweepTracking,
} from "@offerfinch/db";

import type { NativeNotice, NoticeOutcome } from "../shared/worker-protocol";
import { type NoticeItem, summarize } from "./notices";

/** How often applied applications are looked at: Ghosted and reminders are a matter of days. */
export const FOLLOW_UP_EVERY_MS = 30 * 60_000;

/**
 * After Applied: sets Ghosted after 21 quiet days and queues one follow-up reminder per stage
 * entry after 7 (`core/domain/tracking.ts`). Reminders go through the notice batcher, so many at
 * once (the first start after this update, with older applications) are one notification.
 * Runs at start and every half hour, also when scans are paused: it reads no site and calls no
 * model.
 */
export async function runFollowUps(input: {
	db: Database;
	userId: string;
	add: (item: NoticeItem) => void;
	log: (message: string, data?: unknown) => void;
	now?: Date;
	/** A reminder already on its way out (`FollowUpDelivery.inFlight`): not queued again. */
	inFlight?: (stageId: string) => boolean;
}): Promise<void> {
	const result = await sweepTracking(input.db, input.userId, input.now);
	if (result.ghosted.length > 0)
		input.log("applications marked ghosted", { n: result.ghosted.length });
	for (const r of result.reminders)
		if (!input.inFlight?.(r.stageId))
			input.add({
				kind: "followup",
				applicationId: r.applicationId,
				stageId: r.stageId,
				title: r.title,
				company: r.company,
				detail: `${r.title} at ${r.company}: no news for ${FOLLOW_UP_AFTER_DAYS} days. A short follow-up may help.`,
			});
}

/** How long a reminder counts as on its way out (main answers within 6 s): not queued again. */
const IN_FLIGHT_MS = 60_000;
/** How long a late answer is still taken (it marks the reminder shown), and how many are kept. */
const ANSWER_KEPT_MS = 24 * 3_600_000;
const ANSWERS_KEPT = 500;

/**
 * Follow-up reminders on their way out. Each notification gets an id; main answers with what
 * macOS did with it (`noticeResult`). Shown, or no answer from macOS within its 6 s (almost
 * always a slow show), its stage entries are marked and not reminded again: a missed reminder
 * beats repeats. A definite refusal (blocked) is tried again after a day. Unanswered for a
 * minute (a quit, a crash), it is no longer in flight and a later sweep may queue it again, but
 * a late answer still counts for a day; a queued reminder whose stage was marked meanwhile is
 * dropped before it goes out, so a duplicate never does.
 */
export class FollowUpDelivery {
	private readonly pending = new Map<
		string,
		{ items: NoticeItem[]; at: number }
	>();

	constructor(
		private readonly options: {
			db: Database;
			userId: string;
			send: (notice: NativeNotice) => void;
			log: (message: string, data?: unknown) => void;
			now?: () => Date;
		},
	) {}

	private time(): number {
		return (this.options.now?.() ?? new Date()).getTime();
	}

	/** Forgets answers older than a day, and the oldest beyond the cap (a Map keeps order). */
	private prune(): void {
		const now = this.time();
		for (const [id, entry] of this.pending)
			if (now - entry.at > ANSWER_KEPT_MS || this.pending.size > ANSWERS_KEPT)
				this.pending.delete(id);
	}

	/** Whether this stage entry's reminder went out under a minute ago and is unanswered. */
	inFlight(stageId: string): boolean {
		this.prune();
		const now = this.time();
		for (const entry of this.pending.values())
			if (
				now - entry.at <= IN_FLIGHT_MS &&
				entry.items.some((i) => i.stageId === stageId)
			)
				return true;
		return false;
	}

	/** Notices in flight: sent under a minute ago, unanswered (for tests and logs). */
	get waiting(): number {
		this.prune();
		const now = this.time();
		let n = 0;
		for (const entry of this.pending.values())
			if (now - entry.at <= IN_FLIGHT_MS) n++;
		return n;
	}

	/** Sends the batch, without the reminders whose stage was marked shown since they queued. */
	async emit(notice: NativeNotice, items: NoticeItem[]): Promise<void> {
		this.prune();
		const ids = items.flatMap((i) => (i.stageId ? [i.stageId] : []));
		const done = await remindedStages(
			this.options.db,
			this.options.userId,
			ids,
		).catch(() => new Set<string>());
		const left = items.filter((i) => !(i.stageId && done.has(i.stageId)));
		if (left.length === 0) return;
		const id = crypto.randomUUID();
		this.pending.set(id, { items: left, at: this.time() });
		this.options.send({
			...(left.length === items.length ? notice : summarize("followup", left)),
			id,
		});
	}

	async result(id: string, outcome: NoticeOutcome): Promise<void> {
		this.prune();
		const entry = this.pending.get(id);
		// An answer for a notice from before a restart, or over a day old: nothing waits on it.
		if (!entry) return;
		this.pending.delete(id);
		const ids = entry.items.flatMap((i) => (i.stageId ? [i.stageId] : []));
		const shown = outcome === "delivered" || outcome === "unknown";
		try {
			await markReminded(
				this.options.db,
				this.options.userId,
				ids,
				shown ? "shown" : "not_shown",
				this.options.now?.(),
			);
		} catch (error) {
			// Unmarked, it is due again on the next sweep: a repeat, never a loss.
			this.options.log("follow-ups not marked", { error: String(error) });
		}
		if (!shown)
			this.options.log("follow-up reminder not shown; tried again tomorrow", {
				outcome,
			});
	}
}
