import { z } from "zod";
import type { ProfileSnapshot } from "../../profile/types";
import type { DocumentContext, RuleIssue } from "../profile-rules";
import type { FormAnswer } from "../tailor";

/**
 * The independent claims check (PLAN rule 2). A second model, never the one that wrote the
 * drafts, lists every factual claim about the candidate and cites a profile file and verbatim
 * quote for each. Code then verifies every citation, and deterministic rules run regardless of
 * what the model says. Any unsupported claim or rule issue fails the check, which blocks review.
 */

export const CHECKED_DOCUMENTS = [
	"cv",
	"cover_letter",
	"form_answers",
] as const;

export type CheckedDocument = (typeof CHECKED_DOCUMENTS)[number];

/** Why a segment holds no claim about the candidate. Only these reasons are accepted. */
export const SKIP_CATEGORIES = [
	"about_company_or_role",
	"greeting_or_signoff",
	"motivation_only",
] as const;

export const claimsCheckSchema = z.object({
	claims: z
		.array(
			z.object({
				segments: z
					.array(z.string())
					.describe('Ids of the segments this claim comes from, e.g. ["cv-4"]'),
				document: z.enum(CHECKED_DOCUMENTS),
				text: z
					.string()
					.describe(
						"The claim, copied from the segment (a bullet, line or sentence)",
					),
				supported: z
					.boolean()
					.describe("True only if the cited quotes state this claim"),
				evidence: z
					.array(
						z.object({
							file: z.string().describe("Profile file path exactly as given"),
							quote: z.string().describe("Verbatim text copied from that file"),
						}),
					)
					.describe("Empty when the profile does not support the claim"),
				note: z
					.string()
					.describe("One sentence: why it is or is not supported"),
			}),
		)
		.describe("Every factual claim about the candidate, in document order"),
	skipped: z
		.array(
			z.object({
				segment: z.string().describe("Segment id"),
				category: z.enum(SKIP_CATEGORIES),
				note: z
					.string()
					.describe("One sentence: why it states no fact about the candidate"),
			}),
		)
		.describe("Segments with no claim about the candidate. Never a CV segment"),
});

export type ClaimsCheckOutput = z.infer<typeof claimsCheckSchema>;

export interface CheckedClaim {
	document: CheckedDocument;
	text: string;
	supported: boolean;
	evidence: { file: string; quote: string }[];
	note: string;
	/** Citations that failed verification, with the reason. */
	rejected: { file: string; quote: string; reason: string }[];
	/** The segments the claim comes from, as checked. */
	segments?: string[];
	/** The same segments' keys (`segmentKey`): where they are, not only what they say. */
	segmentKeys?: string[];
}

export interface ClaimsReport {
	passed: boolean;
	provider: string;
	claims: CheckedClaim[];
	issues: RuleIssue[];
}

export interface ClaimsInput {
	/** Document text as checked by the rules and shown to the model; form answers via `formAnswersText`. */
	documents: Record<CheckedDocument, string>;
	/** The form answers as stored; segmented answer by answer, questions excluded. */
	formAnswers: FormAnswer[];
	profile: ProfileSnapshot;
	context: DocumentContext;
	/** The posting text; numbers the letter quotes from it are not claims about the candidate. */
	postingText: string;
	/**
	 * Keys (`segmentKey`) of the only segments to check: an edit in review. The documents are still
	 * sent whole, so the checker reads each line under its employer and next to its sentences.
	 */
	checkOnly?: string[];
}
