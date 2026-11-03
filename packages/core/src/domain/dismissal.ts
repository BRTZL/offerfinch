/**
 * "Not interested" on a match. The contract other parts read (ranking reads `dismissals`):
 *
 * - `dismissals` (id, user_id, application_id, company_id, reasons, note, created_at): one row per
 *   match the user dismissed. `reasons` is a JSON array of {@link DISMISS_REASONS}, possibly
 *   empty; `note` is the optional free text. Rows are written only for the user's own dismissals,
 *   never for the automatic ones below, and are deleted again when the user undoes it.
 * - `hidden_companies` (user_id, company_id, created_at): companies the user hid. A company is
 *   matched by its normalized name (`companies.name_key`), so the same employer found through
 *   another source is hidden too.
 * - The application moves to state `dismissed` with `ended_reason` set to
 *   {@link ENDED_NOT_INTERESTED} (the user's call) or {@link ENDED_COMPANY_HIDDEN} (a job from a
 *   hidden company, dismissed by the app; only `found` jobs and open matches, never later).
 */
export const DISMISS_REASONS = [
	"location",
	"seniority",
	"company",
	"stack",
	"salary",
	"other",
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

export const DISMISS_REASON_LABEL: Record<DismissReason, string> = {
	location: "Location",
	seniority: "Seniority",
	company: "Company",
	stack: "Tech stack",
	salary: "Salary",
	other: "Other",
};

/** `applications.ended_reason` of a match the user marked Not interested. */
export const ENDED_NOT_INTERESTED = "not_interested";
/** `applications.ended_reason` of a job dismissed because its company is hidden. */
export const ENDED_COMPANY_HIDDEN = "company_hidden";
