import { z } from "zod";

import { promptAttr, promptText } from "../domain/prompt";

import type { NormalizedJob } from "../domain/types";
import type { LocationVerdict } from "../filter/rules";
import {
	contactValues,
	findDocument,
	type ProfileSnapshot,
	redactContact,
} from "../profile/types";
import { fullPrompt, type LlmProvider } from "./llm";

const requirementStatus = z.enum(["met", "partial", "not_met", "unknown"]);

export const fitAssessmentSchema = z.object({
	requirements: z
		.array(
			z.object({
				requirement: z
					.string()
					.describe("The requirement as the posting states it"),
				importance: z.enum(["must", "nice"]),
				// May be omitted: shown as "unknown" with no credit (`statusOmitted`), so one missing
				// field does not waste the call.
				status: requirementStatus.optional(),
				evidence: z
					.array(
						z.object({
							file: z
								.string()
								.describe(
									"Profile file path exactly as given, e.g. experience/2023-brightloom.md",
								),
							quote: z.string().describe("Verbatim text copied from that file"),
						}),
					)
					.describe("Empty when the profile has no evidence"),
				note: z
					.string()
					.describe(
						"One sentence on how the evidence meets or misses the requirement",
					),
			}),
		)
		.describe("Every requirement in the posting, one entry each"),
	summary: z.string().describe("Two sentences on overall fit"),
});

export type FitAssessment = z.infer<typeof fitAssessmentSchema>;

interface VerifiedEvidence {
	file: string;
	quote: string;
}

export interface FitRequirement {
	requirement: string;
	importance: "must" | "nice";
	status: z.infer<typeof requirementStatus>;
	/** The model gave no status: shown as "unknown", and earns no credit (not unknown's). */
	statusOmitted?: true;
	evidence: VerifiedEvidence[];
	note: string;
}

export interface FitResult {
	score: number;
	requirements: FitRequirement[];
	summary: string;
	provider: string;
	/** Citations the model gave that were not found in the profile. They never count as evidence. */
	droppedEvidence: {
		requirement: string;
		file: string;
		quote: string;
		reason: string;
	}[];
}

interface FitJob
	extends Pick<
		NormalizedJob,
		"title" | "locations" | "workplaceType" | "descriptionText"
	> {
	companyName: string;
}

/** Where the candidate lives and may work, from Settings › Job search, and the filter's reading. */
interface FitWorkRights {
	livesIn: string;
	citizenship: string[];
	rightToWork: string[];
	/** How the job's place fits the user, as the location filter read it. */
	locationVerdict?: LocationVerdict;
	/** The filter's one-line reason for the place ("Remote in Turkey."). */
	locationNote?: string;
}

export interface FitContext {
	job: FitJob;
	profile: ProfileSnapshot;
	work?: FitWorkRights;
}

const VERDICT_TEXT: Record<LocationVerdict, string> = {
	home: "in a country the candidate may work in",
	remote_home: "remote, open to the candidate's country",
	remote_global: "remote worldwide",
	relocation:
		"abroad; the posting offers relocation or visa support, so the candidate would have to move",
	unclear:
		"unclear: the posting may not hire from the candidate's country, which makes it a weaker fit",
	rejected: "outside where the candidate may work",
};

const SYSTEM_PROMPT = `You assess how well a candidate's profile fits a job posting, requirement by requirement.

Rules:
- The profile files are the only source of facts about the candidate. Never assume or invent experience, skills, employers, dates, degrees, languages or work rights.
- For each requirement, cite evidence as {file, quote}: the file path exactly as given and a quote copied verbatim from that file (a phrase or one line, not a paraphrase).
- If the profile says nothing about a requirement, set status "unknown" with no evidence. Do not mark it met.
- Use "not_met" only when the profile shows the candidate lacks it (for example, a constraint in the profile rules it out).
- Mark requirements the posting calls a plus, bonus or nice to have as importance "nice"; everything else is "must".
- Keep notes to one plain sentence.
- <work_rights>, when given, states where the candidate lives, their citizenship and where they have the right to work; it is a fact about the candidate, like the profile. Use it for location, citizenship, security clearance and work authorization requirements: "met" when it covers them (cite no evidence), "not_met" when it rules them out.
- The job's "Location check" is the app's reading of where the job hires; mention in the summary when it is unclear or needs relocation, since that lowers the real chance.`;

function normalizeForMatch(text: string): string {
	return text
		.replace(/\*\*|__|`/g, "")
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** Keeps only citations whose file exists and whose quote appears verbatim in it. */
export function verifyAssessment(
	assessment: FitAssessment,
	profile: ProfileSnapshot,
) {
	const dropped: FitResult["droppedEvidence"] = [];
	const requirements: FitRequirement[] = assessment.requirements.map((req) => {
		const evidence: VerifiedEvidence[] = [];
		for (const cite of req.evidence) {
			const doc = findDocument(profile, cite.file);
			if (!doc) {
				dropped.push({
					requirement: req.requirement,
					...cite,
					reason: "file not in profile",
				});
				continue;
			}
			const quote = normalizeForMatch(cite.quote);
			if (quote.length < 3 || !normalizeForMatch(doc.content).includes(quote)) {
				dropped.push({
					requirement: req.requirement,
					...cite,
					reason: "quote not found in file",
				});
				continue;
			}
			evidence.push({ file: doc.path, quote: cite.quote.trim() });
		}
		const unsupported =
			(req.status === "met" || req.status === "partial") &&
			evidence.length === 0;
		if (req.status === undefined)
			return {
				requirement: req.requirement,
				importance: req.importance,
				status: "unknown" as const,
				statusOmitted: true as const,
				evidence,
				note: `No status given by the model; counted as no credit. ${req.note}`,
			};
		return {
			requirement: req.requirement,
			importance: req.importance,
			status: unsupported ? "unknown" : req.status,
			evidence,
			note: unsupported
				? `No verifiable profile evidence (model said ${req.status}). ${req.note}`
				: req.note,
		};
	});
	return { requirements, dropped };
}

const STATUS_VALUE = {
	met: 1,
	partial: 0.5,
	unknown: 0.2,
	not_met: 0,
} as const;
const IMPORTANCE_WEIGHT = { must: 2, nice: 1 } as const;

/** Score 0-100 computed in code from verified statuses, so it never rests on an unverified claim. */
export function computeScore(requirements: FitRequirement[]): number {
	if (requirements.length === 0) return 0;
	let total = 0;
	let earned = 0;
	for (const req of requirements) {
		const weight = IMPORTANCE_WEIGHT[req.importance];
		total += weight;
		// No status (omitted, or a caller that skipped verification): no credit.
		earned += req.statusOmitted ? 0 : weight * (STATUS_VALUE[req.status] ?? 0);
	}
	return Math.round((100 * earned) / total);
}

export function buildFitPrompt(context: FitContext): string {
	return fullPrompt(fitPromptParts(context));
}

/** The profile first, the same for every job a scan scores (cached by the provider), then the job. */
function fitPromptParts({ job, profile, work }: FitContext): {
	promptPrefix: string;
	prompt: string;
} {
	const known = contactValues(profile);
	const files = profile.files
		.map(
			(file) =>
				`<file path="${promptAttr(file.path)}">\n${promptText(redactContact(file.content, known))}\n</file>`,
		)
		.join("\n\n");
	return {
		promptPrefix: `<profile>
${files}
</profile>${
			work
				? `

<work_rights>
Lives in: ${promptText(work.livesIn) || "not set"}
Citizenship: ${promptText(work.citizenship.join(", ")) || "not set"}
Right to work in: ${promptText(work.rightToWork.join(", ")) || "not set"}
</work_rights>`
				: ""
		}`,
		prompt: `<job>
Company: ${promptText(job.companyName)}
Title: ${promptText(job.title)}
Locations: ${promptText(job.locations.join("; ")) || "not given"}
Workplace: ${promptText(job.workplaceType)}${
			work?.locationVerdict
				? `
Location check: ${VERDICT_TEXT[work.locationVerdict]}${work.locationNote ? ` (${promptText(work.locationNote)})` : ""}`
				: ""
		}

${promptText(job.descriptionText)}
</job>

List every requirement in the job and assess it against the profile.`,
	};
}

export async function scoreFit(
	llm: LlmProvider,
	context: FitContext,
): Promise<FitResult> {
	const assessment = await llm.generateObject({
		task: "fit-score",
		system: SYSTEM_PROMPT,
		redact: contactValues(context.profile),
		...fitPromptParts(context),
		schema: fitAssessmentSchema,
		context,
	});
	const { requirements, dropped } = verifyAssessment(
		assessment,
		context.profile,
	);
	return {
		score: computeScore(requirements),
		requirements,
		summary: assessment.summary,
		provider: llm.name,
		droppedEvidence: dropped,
	};
}
