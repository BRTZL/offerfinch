import { contactValues, type ProfileSnapshot } from "../../profile/types";
import type { LlmProvider } from "../../scoring/llm";
import { roleAliases } from "../employer-names";
import {
	cautionTerms,
	checkDocumentRules,
	checkQuote,
	citableText,
	evidenceProfile,
	normalizeForMatch,
	type RuleIssue,
	type RuleSet,
	ruleSet,
} from "../profile-rules";
import { answerTopic, everyEmployerYes } from "./answers";
import {
	type KnownExpansion,
	namedTerms,
	profileExpansions,
	uncovered,
	withoutExpansions,
} from "./expansions";
import {
	type Employer,
	eachEmployer,
	otherEmployer,
	place,
	unsupportedNumbers,
} from "./numbers-employers";
import { claimsPromptParts, SYSTEM_PROMPT } from "./schema-prompt";
import {
	checkedSegments,
	isStructuralLine,
	type Segment,
	segmentDocuments,
	segmentKey,
} from "./segments";
import { type CandidateSide, candidateSide, skippable } from "./skippable";
import { factTokens, inOwnWords, NEGATED, related } from "./tokens";
import {
	CHECKED_DOCUMENTS,
	type CheckedClaim,
	type ClaimsCheckOutput,
	type ClaimsInput,
	type ClaimsReport,
	claimsCheckSchema,
} from "./types";

/** Per segment: the verified quotes of the claims attached to it, their files and profile lines. */
interface Cited {
	quotes: string[];
	files: Set<string>;
	lines: string[];
	pairs: { file: string; quote: string }[];
	/** The profile line holding each verified quote, with its file. */
	sources: { file: string; line: string }[];
}

interface LineEnv {
	profile: ProfileSnapshot;
	input: ClaimsInput;
	rules: RuleSet;
	expansions: KnownExpansion;
	employers: Employer[];
	side: CandidateSide;
	/**
	 * What the profile's answers state at every employer ("yes in my all companies" to a question
	 * from tailoring): a line's own quotes prove its facts, and these say at which employers.
	 */
	everywhere: Set<string>[];
}

function lineEnv(profile: ProfileSnapshot, input: ClaimsInput): LineEnv {
	const rules = ruleSet(profile);
	const employers = rules.records.map((record) => ({
		record,
		names: roleAliases(profile, record),
	}));
	return {
		profile,
		input,
		rules,
		expansions: profileExpansions(profile),
		employers,
		side: { ...candidateSide(profile), employers },
		everywhere: profile.files.flatMap((file) =>
			file.content
				.split("\n")
				.map((line) => everyEmployerYes(profile, file.path, line))
				.filter((t): t is Set<string> => t !== null),
		),
	};
}

/**
 * The issue on one segment, if any: its claims (`said`, with the verified quotes they cite) leave
 * a fact word out, name something the cited files do not, cite a caution or another employer; or
 * nothing covers it and its skip is not one the segment allows.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Evidence verification keeps ordered rejection checks together so earlier failures retain precedence.
function lineIssue(
	segment: Segment,
	said: string[],
	evidence: Cited | undefined,
	skip: { category: string } | undefined,
	env: LineEnv,
): RuleIssue | null {
	const { profile, input, rules, expansions, employers } = env;
	// Every fact word of the segment must be in its claims, or in the verified quotes they
	// cite (a checker may paraphrase "query rewrites" as "rewritten queries").
	const covered = new Set(
		[...said, ...(evidence?.quotes ?? [])].flatMap((t) => [...factTokens(t)]),
	);
	const quoted = new Set(
		(evidence?.quotes ?? []).flatMap((q) => [...factTokens(q)]),
	);
	const missing =
		said.length > 0
			? uncovered(segment, covered, said, quoted, expansions)
			: null;
	if (missing && missing.length === 0) {
		// A name stated next to a negation is not stated: "yes. No Kubernetes." sources no
		// Kubernetes. Read per sentence of the cited files' citable text.
		const inSources = new Set<string>();
		for (const file of evidence?.files ?? [])
			for (const sentence of citableText(profile, file).split(
				/\n|(?<=[.!?;])\s+/,
			)) {
				const said = factTokens(sentence);
				if (!said.has(NEGATED)) for (const t of said) inSources.add(t);
			}
		for (const source of evidence?.sources ?? [])
			for (const t of answerTopic(
				profile,
				source.file,
				source.line,
				segment.text,
				input.context,
			))
				inSources.add(t);
		const unsourced = evidence
			? [...namedTerms(segment.text, input.context, expansions)].filter(
					(t) => !inSources.has(t),
				)
			: [];
		const loose = (t: string) =>
			` ${normalizeForMatch(t)
				.replace(/[^\p{L}\d]+/gu, " ")
				.trim()} `;
		const banned = [
			...new Set((evidence?.lines ?? []).flatMap(cautionTerms)),
		].filter((term) => loose(segment.text).includes(loose(term)));
		const elsewhere = evidence
			? (otherEmployer(segment, evidence, rules) ??
				eachEmployer(
					segment,
					evidence.pairs,
					employers,
					expansions,
					env.everywhere,
				))
			: null;
		if (unsourced.length === 0 && banned.length === 0 && !elsewhere)
			return null;
		return {
			rule: "unchecked_line",
			document: segment.document,
			message:
				unsourced.length > 0
					? `Not in the profile files its claims cite: ${inOwnWords(segment.text, unsourced).join(", ")}.`
					: banned.length > 0
						? `The profile line it cites says not to claim ${banned.map((t) => `"${t}"`).join(", ")}.`
						: (elsewhere ?? ""),
			excerpt: segment.text,
			lines: [segment.text],
			at: [place(segment)],
		};
	}
	if (
		skip &&
		said.length === 0 &&
		skippable(segment, input.context, input.postingText, env.side)
	)
		return null;
	return {
		rule: "unchecked_line",
		document: segment.document,
		message: skip
			? `The claims check skipped this as ${skip.category.replace(/_/g, " ")}, but it states a fact about the candidate.`
			: said.length > 0
				? `The claims check covered only part of this; left out: ${leftOut(segment.text, missing ?? [], expansions).join(", ")}.`
				: "The claims check did not cover this.",
		excerpt: segment.text,
		lines: [segment.text],
		at: [place(segment)],
	};
}

/**
 * What `uncovered` returns, in the segment's own words: plain tokens as the segment writes them,
 * a scope word with its note, a negation as the answer's polarity.
 */
function leftOut(
	text: string,
	missing: string[],
	known: KnownExpansion,
): string[] {
	const plain = missing.filter((t) => t !== NEGATED && !t.includes(" ("));
	return [
		...inOwnWords(withoutExpansions(text, known), plain),
		...missing
			.filter((t) => t.includes(" ("))
			.map((t) => {
				const [scope = t, note = ""] = t.split(" (");
				const [word] = inOwnWords(text, [scope]);
				return `${word ?? scope} (${note}`;
			}),
		...(missing.includes(NEGATED) ? ["the answer's polarity (yes/no)"] : []),
	];
}

/**
 * Verifies the model's claims and runs every deterministic rule. Fails closed: a segment no claim
 * covers, a skip the segment does not allow, an empty claim or one tied to no segment is an issue.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Evidence verification keeps ordered rejection checks together so earlier failures retain precedence.
export function verifyClaims(
	output: ClaimsCheckOutput,
	input: ClaimsInput,
	provider: string,
): ClaimsReport {
	const profile = evidenceProfile(input.profile);
	const all = segmentDocuments(input);
	const segments = checkedSegments(input);
	const byId = new Map(segments.map((s) => [s.id, s]));
	const known = new Set(all.map((s) => s.id));
	const issues: RuleIssue[] = [];
	const attached = new Map<string, string[]>();
	/**
	 * Per segment: verified quotes, the files they come from and the profile lines holding them, of
	 * the claims attached to it.
	 */
	const cited = new Map<string, Cited>();
	const claims: CheckedClaim[] = [];
	for (const claim of output.claims) {
		const text = claim.text.trim();
		const ids = claim.segments.map((id) => id.trim());
		const own = ids
			.map((id) => byId.get(id))
			.filter((s): s is Segment => s !== undefined);
		// An edit in review checks only its listed segments: a claim about the others is context.
		if (
			input.checkOnly &&
			own.length === 0 &&
			ids.length > 0 &&
			ids.every((id) => known.has(id))
		)
			continue;
		const document = own[0]?.document ?? claim.document;
		if (!text) {
			issues.push({
				rule: "empty_claim",
				document,
				message: "The claims check returned a claim with no text.",
				excerpt:
					own
						.map((s) => s.text)
						.join(" ")
						.slice(0, 200) || undefined,
				lines: own.map((s) => s.text),
				at: own.map(place),
			});
			continue;
		}
		if (own.length === 0)
			issues.push({
				rule: "unanchored_claim",
				document,
				message: "The claim names no segment of the documents.",
				excerpt: text,
			});
		const evidence: CheckedClaim["evidence"] = [];
		const rejected: CheckedClaim["rejected"] = [];
		const sourceLines: { file: string; line: string }[] = [];
		for (const cite of claim.evidence) {
			const result = checkQuote(profile, cite.file, cite.quote);
			if (result.ok) {
				evidence.push({ file: result.file, quote: result.quote });
				sourceLines.push({ file: result.file, line: result.line });
			} else rejected.push({ ...cite, reason: result.reason });
		}
		const supported = claim.supported && evidence.length > 0;
		for (const segment of own)
			if (related(text, segment.text)) {
				attached.set(segment.id, [...(attached.get(segment.id) ?? []), text]);
				if (supported) {
					const entry = cited.get(segment.id) ?? {
						quotes: [],
						files: new Set<string>(),
						lines: [],
						pairs: [],
						sources: [],
					};
					for (const e of evidence) {
						entry.quotes.push(e.quote);
						entry.files.add(e.file);
						entry.pairs.push(e);
					}
					entry.lines.push(...sourceLines.map((s) => s.line));
					entry.sources.push(...sourceLines);
					cited.set(segment.id, entry);
				}
			}
		claims.push({
			document,
			text,
			supported,
			evidence,
			note:
				claim.supported && !supported
					? `No verifiable profile quote (${rejected.map((r) => r.reason).join("; ") || "none given"}). ${claim.note}`
					: claim.note,
			rejected,
			segments: own.map((s) => s.text),
			segmentKeys: own.map(segmentKey),
		});
	}

	const env = lineEnv(profile, input);
	const { rules } = env;
	const skips = new Map(output.skipped.map((s) => [s.segment.trim(), s]));
	for (const segment of segments) {
		const issue = lineIssue(
			segment,
			attached.get(segment.id) ?? [],
			cited.get(segment.id),
			skips.get(segment.id),
			env,
		);
		if (issue) issues.push(issue);
	}

	for (const kind of CHECKED_DOCUMENTS)
		issues.push(
			...checkDocumentRules(kind, input.documents[kind], rules, input.context),
		);
	const placeOf = new Map(segments.map((s) => [segmentKey(s), place(s)]));
	for (const claim of claims)
		if (!claim.supported)
			issues.push({
				rule: "unsupported_claim",
				document: claim.document,
				message: `Unsupported claim: ${claim.note}`,
				excerpt: claim.text,
				...(claim.segments?.length
					? {
							lines: claim.segments,
							at: (claim.segmentKeys ?? []).map(
								(key) => placeOf.get(key) ?? { context: "", occurrence: 0 },
							),
						}
					: {}),
			});
	const profileText = profile.files.map((f) => f.content).join("\n");
	for (const kind of CHECKED_DOCUMENTS)
		issues.push(
			...unsupportedNumbers(
				kind,
				input.documents[kind],
				profileText,
				kind === "cv" ? "" : input.postingText,
			),
		);
	return { passed: issues.length === 0, provider, claims, issues };
}

/** A stored review's flag, as `ReviewFlag` keeps it (see flags.ts). */
export interface StoredFlag {
	document: string;
	text: string | null;
	context?: string;
	occurrence?: number;
	reasons: { rule: RuleIssue["rule"]; message: string }[];
	state: "open" | "confirmed";
}

const SKIP_MESSAGE =
	/^The claims check skipped this as (.+), but it states a fact about the candidate\.$/;

/**
 * The open flags of a stored review that its stored claims now clear, with no model call: each
 * line check runs again with the current code and profile on the claims the review kept. Only
 * clears, never adds: a flag with a reason other than a line check, on a segment no longer in the
 * documents, or whose claims cite a quote the profile no longer holds is not returned. The model's
 * skips are not stored; a skip is known from the flag's own message, so only flagged lines can
 * be read again this way, never a whole review.
 */
export function clearedFlags<F extends StoredFlag>(
	flags: F[],
	claims: CheckedClaim[],
	input: ClaimsInput,
): F[] {
	const profile = evidenceProfile(input.profile);
	const env = lineEnv(profile, input);
	const segments = new Map(
		segmentDocuments(input).map((s) => [segmentKey(s), s]),
	);
	const cleared: F[] = [];
	for (const flag of flags) {
		if (
			flag.state !== "open" ||
			flag.text === null ||
			flag.reasons.length === 0 ||
			!flag.reasons.every((r) => r.rule === "unchecked_line")
		)
			continue;
		const key = segmentKey({
			document: flag.document,
			text: flag.text,
			context: flag.context,
			occurrence: flag.occurrence,
		});
		const segment = segments.get(key);
		if (!segment) {
			// A line the check no longer reads as a claim at all (a contact line, a heading)
			// carries no claim: its old flag clears, if the line is still in the document.
			const kind = CHECKED_DOCUMENTS.find((k) => k === flag.document);
			const text = flag.text;
			if (
				kind &&
				input.documents[kind]
					.split("\n")
					.some((line: string) => line.includes(text)) &&
				isStructuralLine(kind, text, input.profile)
			)
				cleared.push(flag);
			continue;
		}
		const category = flag.reasons
			.map((r) => r.message.match(SKIP_MESSAGE)?.[1])
			.find(Boolean);
		const mine = claims.filter(
			(c) => c.segmentKeys?.includes(key) && related(c.text, segment.text),
		);
		let evidence: Cited | undefined;
		let verified = true;
		for (const claim of mine.filter((c) => c.supported))
			for (const e of claim.evidence) {
				const result = checkQuote(profile, e.file, e.quote);
				if (!result.ok) {
					verified = false;
					continue;
				}
				evidence ??= {
					quotes: [],
					files: new Set(),
					lines: [],
					pairs: [],
					sources: [],
				};
				evidence.quotes.push(result.quote);
				evidence.files.add(result.file);
				evidence.pairs.push({ file: result.file, quote: result.quote });
				evidence.lines.push(result.line);
				evidence.sources.push({ file: result.file, line: result.line });
			}
		if (!verified) continue;
		const issue = lineIssue(
			segment,
			mine.map((c) => c.text),
			evidence,
			category ? { category } : undefined,
			env,
		);
		if (issue === null) cleared.push(flag);
	}
	return cleared;
}

export async function checkClaims(
	llm: LlmProvider,
	input: ClaimsInput,
): Promise<ClaimsReport> {
	const output = await llm.generateObject({
		task: "claims-check",
		system: SYSTEM_PROMPT,
		redact: contactValues(input.profile),
		...claimsPromptParts(input),
		schema: claimsCheckSchema,
		maxTokens: 32000,
		context: input,
	});
	return verifyClaims(output, input, llm.name);
}

/** Deterministic rules only: what an edit gets immediately, before the model re-checks it. */
export function checkRulesOnly(input: ClaimsInput): RuleIssue[] {
	const profile = evidenceProfile(input.profile);
	const rules = ruleSet(profile);
	const profileText = profile.files.map((f) => f.content).join("\n");
	return [
		...CHECKED_DOCUMENTS.flatMap((kind) => [
			...checkDocumentRules(kind, input.documents[kind], rules, input.context),
			...unsupportedNumbers(
				kind,
				input.documents[kind],
				profileText,
				kind === "cv" ? "" : input.postingText,
			),
		]),
	];
}

/**
 * The claims input for an edit in review: the whole documents, so each line is read in its
 * section and paragraph, with only the changed segments to check. The profile prefix is the
 * same, so the provider's cache still applies, and the answer covers only those segments.
 */
export function focusedInput(
	input: ClaimsInput,
	changed: Segment[],
): ClaimsInput {
	return { ...input, checkOnly: changed.map(segmentKey) };
}
