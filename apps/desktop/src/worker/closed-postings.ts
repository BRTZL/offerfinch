import {
	ACTION_CHECK_TIMEOUT_MS,
	checkPostingOpen,
	type OpenCheck,
	politePageFetcher,
} from "@offerfinch/core/pipeline/closed";
import { fetchOnce, responseText } from "@offerfinch/core/scrape/public-fetch";
import { USER_AGENT } from "@offerfinch/core/sources/types";
import { DrizzleClosedPostingStore, postingForCheck } from "@offerfinch/db";
import { linkPolicy } from "./add-job";
import type { WorkerApp } from "./app";
import { robotsCheck } from "./pipeline";
import { LOCAL_USER_ID } from "./settings";

/**
 * Closed postings on the user's actions (docs/decisions.md, 2026-11-03): Prepare and the
 * hand-off check the posting first where that is cheap and safe (core `pipeline/closed.ts`).
 * A check that gets no clear answer in ACTION_CHECK_TIMEOUT_MS lets the action go on.
 */

const WHEN = {
	prepare: "checked before Prepare",
	handoff: "checked when the hand-off opened",
} as const;

/** robots.txt for the page check, read as OfferFinch's reader (public addresses only). */
let robots: ((url: string) => Promise<boolean>) | null = null;

/**
 * The page check's fetcher: one plain GET per hop, pinned to a public address (no private
 * network), no browser, no model, so a check never spends money. Under web search's rules: never
 * LinkedIn, Indeed, Glassdoor or a job board's page, and robots.txt asked before the first
 * request and every redirect (core `politePageFetcher`). Prepare and the hand-off follow
 * robots.txt too: the check is automatic, not the user reading the page.
 */
function postingPageFetcher(app: WorkerApp) {
	robots ??= robotsCheck(undefined);
	const fetchPage = politePageFetcher({
		robotsAllow: robots,
		fetchOnce: async (url) => {
			const response = await fetchOnce(url, linkPolicy(app), {
				headers: {
					accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
					"user-agent": USER_AGENT,
				},
				timeoutMs: ACTION_CHECK_TIMEOUT_MS,
				maxBytes: 3_000_000,
			});
			return {
				status: response.status,
				location: response.headers.location,
				html: responseText(response),
			};
		},
	});
	return (url: string, signal: AbortSignal) =>
		Promise.race([
			fetchPage(url, signal),
			new Promise<never>((_, reject) => {
				if (signal.aborted) reject(signal.reason);
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
		]);
}

export type ActionCheck =
	| { closed: false; check?: OpenCheck }
	| { closed: true; reason: string; at: Date };

/**
 * Before Prepare, or as the hand-off opens: is the posting still open? A posting found gone is
 * marked closed (unless the user confirmed it open) and the answer says why; anything unclear
 * leaves it as it was.
 */
export async function checkBeforeAction(
	app: WorkerApp,
	applicationId: string,
	when: keyof typeof WHEN,
): Promise<ActionCheck> {
	const userId = LOCAL_USER_ID;
	const row = await postingForCheck(app.db, userId, applicationId);
	if (!row) return { closed: false };
	if (row.closedAt)
		return {
			closed: true,
			reason: row.closedReason ?? "found closed",
			at: row.closedAt,
		};
	// Only where the action can happen: Prepare on a listed match, the hand-off once approved.
	if (row.state !== (when === "prepare" ? "scored" : "approved"))
		return { closed: false };
	if (row.openConfirmedAt) return { closed: false };
	// Every action checks afresh: an earlier answer (the sweep's, or one discarded because the
	// application moved on) never stands in for the check at Prepare or the hand-off.
	const now = new Date();
	const check = await checkPostingOpen(row, {
		sources: app.deps.sources,
		fetchPage: postingPageFetcher(app),
		timeoutMs: ACTION_CHECK_TIMEOUT_MS,
	});
	if (check.status === "not_checked") return { closed: false, check };
	const reason =
		check.status === "gone" ? `${check.reason} (${WHEN[when]})` : undefined;
	const closed = await new DrizzleClosedPostingStore(app.db).recordCheck(
		userId,
		row.jobId,
		{ at: now, origin: when, ...(reason ? { gone: { reason } } : {}) },
	);
	app.log("info", "posting checked", {
		applicationId,
		when,
		status: check.status,
	});
	return closed && reason
		? { closed: true, reason, at: now }
		: { closed: false, check };
}
