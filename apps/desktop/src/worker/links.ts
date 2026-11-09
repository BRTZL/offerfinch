import type { DashboardRepository } from "@offerfinch/db";
import { submissionView } from "./routers/pipeline";

/**
 * The links the app opens in the user's browser, resolved here from stored data for one of the
 * user's applications (docs/decisions.md, 2026-11-09 review fixes). The page names the
 * application (and the attempt it showed), never a URL; main opens what this returns.
 */

/** A stored link, only when it is a web link: anything else never leaves the app. */
function webLink(url: string | null | undefined): string {
	const parsed = URL.canParse(url ?? "") ? new URL(url ?? "") : null;
	if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:")
		throw new Error("Refusing: the stored link is not a web link");
	return url ?? "";
}

/** The posting of one of the user's applications. */
export async function postingLink(
	repo: DashboardRepository,
	userId: string,
	applicationId: string,
): Promise<string> {
	const detail = await repo.getApplication(userId, applicationId);
	if (!detail) throw new Error(`Application ${applicationId} not found`);
	return webLink(detail.job.url);
}

/**
 * The application form for Finish it yourself and the hand-off's link: the attempt the page
 * showed must still be the current one, and a click that may have sent the application must
 * have been recorded as not gone through first (db `formLinkAttempt`). The form is the attempt's
 * stored URL, else the one the hand-off names (`submissionView`).
 */
export async function applicationFormLink(
	repo: DashboardRepository,
	userId: string,
	applicationId: string,
	attemptId: string | null,
): Promise<string> {
	const detail = await repo.getApplication(userId, applicationId);
	if (!detail) throw new Error(`Application ${applicationId} not found`);
	const attempt = await repo.formLinkAttempt(userId, applicationId, attemptId);
	const { postingForm, mode } = await submissionView(
		repo,
		userId,
		applicationId,
		{ job: detail.job, companyKey: detail.company.key },
	);
	const handoff =
		mode.mode === "handoff"
			? postingForm
			: (detail.attempts.find((a) => a.url)?.url ?? postingForm);
	return webLink(attempt?.url || handoff);
}
