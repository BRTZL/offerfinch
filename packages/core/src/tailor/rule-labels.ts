/**
 * The claims check's rules and their plain names, with no other imports so the renderer can
 * read them without pulling the checker in. Every place that shows a rule uses `ruleLabel`, never
 * the rule id (issue #21: ids like `unsupported_claim` mean nothing to the user).
 */

/** Every rule a generated document is checked against: fixed rules and the claims model's. */
export const CLAIM_RULES = [
	"banned_term",
	"cv_wording",
	"experience_record",
	"placeholder",
	"length",
	"name_spelling",
	"unsupported_number",
	"unsupported_claim",
	"unchecked_line",
	"empty_claim",
	"unanchored_claim",
	"ats",
] as const;

export type ClaimRule = (typeof CLAIM_RULES)[number];

/** Plain words for the dashboard: what the rule means, before the checker's own note. */
export const RULE_LABEL: Record<ClaimRule, string> = {
	unsupported_claim: "The profile does not state this",
	unchecked_line: "Not tied to the profile",
	unsupported_number: "A number the profile does not have",
	empty_claim: "The checker returned an empty claim",
	unanchored_claim: "A claim not tied to a line",
	banned_term: "Never claimed (fixed rule)",
	cv_wording: "Your CV wording rule (fixed rule)",
	experience_record: "Must match the experience file (fixed rule)",
	placeholder: "Leftover placeholder (fixed rule)",
	length: "Length (fixed rule)",
	name_spelling: "Company or role name (fixed rule)",
	ats: "PDF text check (fixed rule)",
};

/** One line per rule on why it fired and what clears it, shown beside the label. */
export const RULE_EXPLANATION: Record<ClaimRule, string> = {
	unsupported_claim:
		"The checker found nothing in your profile that says this. Edit it, delete it, or confirm it is true.",
	unchecked_line:
		"The checker did not tie this line to any part of your profile. Edit it, delete it, or confirm it is true.",
	unsupported_number:
		"This number does not appear in your profile. Edit it, delete it, or confirm it is true.",
	empty_claim:
		"The checker returned a claim with no text, so the line could not be checked. Confirm it, or check again.",
	unanchored_claim:
		"The checker named a claim it could not place on a line of the document. Confirm it, or check again.",
	banned_term:
		"Your profile says never to claim this. Edit or delete the line; it cannot be confirmed.",
	cv_wording:
		"A wording rule from your profile is broken. Edit the line so it follows the rule.",
	experience_record:
		"A role's dates, title or employer differ from your experience record. Edit it to match.",
	placeholder:
		"A placeholder like [Company] was left in. Replace it with the real text.",
	length:
		"The letter or CV is outside its allowed length. Shorten or extend it.",
	name_spelling:
		"The company or role name is spelled differently from the posting. Use the posting's spelling.",
	ats: "Applicant systems could not read the PDF's text as written. Check the document again after editing.",
};

/**
 * The plain name of a rule. A rule no longer checked (an old review, a removed rule) still reads
 * as words, never as its id.
 */
export function ruleLabel(rule: string): string {
	return (RULE_LABEL as Record<string, string>)[rule] ?? "Another check";
}

/** The one-line explanation of a rule, or null for one no longer checked. */
export function ruleExplanation(rule: string): string | null {
	return (RULE_EXPLANATION as Record<string, string>)[rule] ?? null;
}
