import type { FilterRule } from "./rules";

/** The job filter's rules in plain words, for the renderer (no other imports at runtime). */
const FILTER_RULE_LABEL: Record<FilterRule, string> = {
	location: "Location",
	work_permit: "Right to work",
	citizenship: "Citizenship",
	language: "Language",
	role: "Role",
};

/** A filter rule's name; one no longer checked reads as words, never as its id. */
export function filterRuleLabel(rule: string): string {
	return (FILTER_RULE_LABEL as Record<string, string>)[rule] ?? "Job search";
}
