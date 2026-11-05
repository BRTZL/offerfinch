/**
 * The job filter's stored result. No rule rejects a job any more (docs/decisions.md,
 * 2026-11-05): every found job goes to the fit score. Applications checked before that keep
 * their result (`applications.filter_result`), and jobs it set aside stay in
 * `rejected_by_filter`; these types read them for display. Nothing writes a new one.
 */

export type FilterRule =
	| "location"
	| "work_permit"
	| "citizenship"
	| "language"
	| "role";

interface FilterReason {
	rule: FilterRule;
	outcome: "pass" | "reject";
	message: string;
	/** The posting text the decision rests on, quoted. */
	evidence?: string;
}

/**
 * How the job's place fitted the user: in a country they may work in, remote from their
 * country, remote worldwide, abroad with relocation or visa support, no place given, or rejected.
 */
type LocationVerdict =
	| "home"
	| "remote_home"
	| "remote_global"
	| "relocation"
	| "unclear"
	| "rejected";

/** A citizenship or clearance the posting preferred (not required) that the user lacked. */
interface PreferredRequirement {
	country: string;
	what: string;
	evidence: string;
}

export interface FilterResult {
	/** Keep or reject. A rejected job was hidden; a kept one was scored. */
	decision: "keep" | "reject";
	/** Absent on results stored before it existed. */
	locationVerdict?: LocationVerdict;
	preferred?: PreferredRequirement[];
	/** Set when a re-filter on saving Job search set the job aside: that settings revision. */
	refilteredWith?: string;
	/** One-line reason for the decision. */
	summary: string;
	reasons: FilterReason[];
	flags: string[];
}
