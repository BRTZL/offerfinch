import type { ProfileSnapshot } from "../profile/types";
import type { GenerateObjectRequest } from "../scoring/llm";
import {
	type ClaimsCheckOutput,
	type ClaimsInput,
	candidateSide,
	checkedSegments,
	overlap,
	skippable,
} from "./claims";
import {
	checkDocumentRules,
	checkQuote,
	evidenceProfile,
	experienceRecords,
	LETTER_MIN_WORDS as MIN,
	normalizeForMatch,
	ruleSet,
	wordCount,
} from "./profile-rules";
import type { TailorInput, TailorOutput } from "./tailor";

/**
 * Deterministic stand-ins for the tailoring and claims-check models, for tests and local runs
 * without API keys. The tailoring fake only copies verbatim profile lines, so its drafts are
 * supportable; the claims fake supports a claim only when a profile line covers its words.
 */

const USED_IN = /\s*\*\(used in:[^)]*\)\*\s*$/;

function clean(line: string): string {
	return line
		.replace(/^\s*[-*]\s+/, "")
		.replace(USED_IN, "")
		.trim();
}

function section(content: string, heading: RegExp): string[] {
	const lines: string[] = [];
	let inside = false;
	for (const line of content.split("\n")) {
		if (/^#{1,6}\s/.test(line)) {
			inside = heading.test(line);
			continue;
		}
		if (inside && /^\s*-\s+\S/.test(line) && !/^\s*-\s+\*\*/.test(line))
			lines.push(clean(line));
	}
	return lines;
}

function file(profile: ProfileSnapshot, path: string): string {
	return profile.files.find((f) => f.path === path)?.content ?? "";
}

function relevance(line: string, posting: string): number {
	return overlap(line, posting);
}

function passesRules(line: string, profile: ProfileSnapshot): boolean {
	const rules = ruleSet(profile);
	return (
		checkDocumentRules("form_answers", line, rules, {
			companyName: "",
			jobTitle: "",
		}).length === 0
	);
}

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

function letterDate(iso: string): string {
	const [y, m, d] = iso.split("-").map(Number);
	return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}

/**
 * Answers saved from the question inbox live in `answers.md`: a marked question line and an
 * `- Answer:` line per block (older files: `## question` and the answer as a paragraph).
 */
function savedAnswer(profile: ProfileSnapshot, topic: RegExp): string | null {
	const answers = file(profile, "answers.md");
	const blocks = answers.split(/^## /m).slice(1);
	for (const block of blocks) {
		const lines = block.split("\n").map((l) => l.trim());
		const asked = lines.find((l) => /^-\s+Question asked \(/.test(l));
		const question = asked ?? lines[0] ?? "";
		if (!topic.test(question)) continue;
		const answer =
			lines
				.find((l) => l.startsWith("- Answer:"))
				?.slice(9)
				.trim() ??
			lines.slice(1).find((l) => l && !l.startsWith("-") && !l.startsWith("*"));
		if (answer) return answer;
	}
	return null;
}

/** The fake's fit notes: the match map from the fit assessment. */
function fakeNotes(input: TailorInput): string {
	return [
		`# Notes — ${input.job.companyName} ${input.job.title}`,
		"",
		"## Role summary",
		"",
		`${input.job.title} at ${input.job.companyName}.`,
		"",
		"## Match map",
		"",
		...(input.fit?.requirements ?? []).map(
			(r) =>
				`- **${r.requirement}:** ${r.status}${r.evidence[0] ? ` (${r.evidence[0].file})` : ""}`,
		),
		"",
		"## Fit verdict",
		"",
		`Score ${input.fit?.score ?? "n/a"}.`,
		"",
		"## Status",
		"",
		`Drafted ${input.today}`,
	].join("\n");
}

export function fakeTailorResponder(
	request: GenerateObjectRequest<unknown>,
): TailorOutput {
	const input = request.context as TailorInput & { redraft?: unknown };
	// A redraft writes another arrangement of the same verbatim lines, so its version differs.
	const variant = input.redraft !== undefined;
	const profile = evidenceProfile(input.profile);
	const posting = input.job.descriptionText;
	const company = input.job.companyName;
	const title = input.job.title;
	const personal = file(profile, "personal.md");
	const field = (label: string) =>
		personal
			.match(
				new RegExp(`^-[ \\t]+\\*\\*${label}:\\*\\*[ \\t]+(.+)$`, "mi"),
			)?.[1]
			?.trim() ?? "";
	const name = field("Name");
	const location = field("Location").replace(/\s*\(.*\)\s*$/, "");

	const summaries = section(
		file(profile, "summary.md"),
		/summaries used in cvs/i,
	);
	const summary = summaries.at(-1) ?? "";

	const roles = experienceRecords(profile)
		.sort((a, b) => b.file.localeCompare(a.file))
		.map((record) => {
			const content = file(profile, record.file);
			const variants = [
				...section(content, /bullet variants/i),
				...section(content, /what i did/i),
			].filter(
				(line, i, all) =>
					line.length > 30 &&
					all.indexOf(line) === i &&
					passesRules(line, profile),
			);
			const bullets = variants
				.map((line) => ({ line, score: relevance(line, posting) }))
				.sort((a, b) => b.score - a.score)
				.slice(0, 2)
				.map((b) => b.line);
			if (variant) bullets.reverse();
			const meta = [
				...record.locationParts.filter((p) => !/^(?:full|part)-time$/i.test(p)),
				record.dates,
			].join(" · ");
			return { record, bullets, meta, variants };
		});

	const skills = section(file(profile, "skills.md"), /skill lines used in cvs/i)
		.slice(0, 4)
		.filter((line) => passesRules(line, profile));
	const education = file(profile, "education.md")
		.split("\n")
		.filter((l) => /^-\s+\*\*[^*]+\*\*,\s/.test(l))
		.map((l) => l.replace(/^-\s+/, ""));

	const cv = [
		`# ${name}`,
		"",
		[
			location,
			"{{email}}",
			"{{phone}}",
			field("LinkedIn"),
			field("Website"),
			field("GitHub"),
		]
			.filter(Boolean)
			.join(" · "),
		"",
		"## Summary",
		"",
		summary,
		"",
		"## Experience",
		"",
		...roles.flatMap(({ record, bullets, meta }) => [
			`### ${record.title} — ${record.company}`,
			`*${meta}*`,
			"",
			...bullets.map((b) => `- ${b}`),
			"",
		]),
		"## Skills",
		"",
		...skills.map((s) => `- ${s}`),
		"",
		"## Education",
		"",
		...education,
	].join("\n");

	const proof = roles
		.flatMap((r) => r.variants)
		.sort((a, b) => relevance(b, posting) - relevance(a, posting));
	if (variant) proof.reverse();
	const opening = `I am applying for the ${title} role at ${company}. What draws me to ${company} is the work the posting describes.`;
	const close = `I would welcome a conversation about the ${title} role at ${company}.`;
	const paragraphs: string[] = [];
	const body: string[] = [];
	const letterText = () =>
		[opening, ...paragraphs, body.join(" "), close].join("\n\n");
	for (const line of proof) {
		if (wordCount(letterText()) + wordCount(line) > 330) break;
		body.push(line.endsWith(".") ? line : `${line}.`);
		if (body.length === 3) {
			paragraphs.push(body.join(" "));
			body.length = 0;
		}
	}
	if (summary && wordCount(letterText()) < MIN) paragraphs.unshift(summary);
	const coverLetter = [
		`${name}\\`,
		`{{email}} · {{phone}} · ${field("LinkedIn")}`,
		"",
		letterDate(input.today),
		"",
		`Dear Hiring Team at ${company},`,
		"",
		opening,
		"",
		...[...paragraphs, body.join(" ")].filter(Boolean).flatMap((p) => [p, ""]),
		close,
		"",
		"Best regards,\\",
		name,
	].join("\n");

	const missingFacts: TailorOutput["missingFacts"] = [];
	const formAnswers: TailorOutput["formAnswers"] = [
		{
			question: `Why do you want to work at ${company}?`,
			answer: `The ${title} role at ${company} is the work I want to do next. ${proof[0] ?? summary}`,
		},
	];
	if (/notice period/i.test(posting)) {
		const answer = savedAnswer(profile, /notice period/i);
		if (answer)
			formAnswers.push({ question: "What is your notice period?", answer });
		else if ((input.questionsAllowed ?? 3) > 0)
			missingFacts.push({
				question: "What is your notice period?",
				why: "The posting asks for a notice period and the profile does not record one.",
				requirement: "application_question",
			});
	}

	const notes = fakeNotes(input);

	return { notes, cv, coverLetter, formAnswers, missingFacts };
}

/**
 * The claims fake: skips a segment only where a careful checker would (company or role, greeting,
 * too short to state anything) and the code allows it; claims everything else, supported only
 * when one profile line covers most of its words.
 */
export function fakeClaimsResponder(
	request: GenerateObjectRequest<unknown>,
): ClaimsCheckOutput {
	const input = request.context as ClaimsInput;
	const profile = evidenceProfile(input.profile);
	const lines = profile.files.flatMap((f) =>
		f.content
			.split("\n")
			.map((line) => ({ file: f.path, line, text: clean(line) }))
			.filter((l) => l.text.length > 2),
	);
	// An experience file's header block (title, dates, location) supports a CV role heading.
	for (const f of profile.files) {
		if (!f.path.startsWith("experience/")) continue;
		const header = f.content.split("\n").slice(0, 5).join("\n").trim();
		lines.push({ file: f.path, line: header, text: header });
	}
	const output: ClaimsCheckOutput = { claims: [], skipped: [] };
	const side = candidateSide(input.profile);
	for (const segment of checkedSegments(input)) {
		const unit = segment.text;
		if (
			skippable(segment, input.context, input.postingText, side) &&
			(unit.includes(input.context.companyName) ||
				unit.includes(input.context.jobTitle) ||
				normalizeForMatch(unit).split(" ").length < 3)
		) {
			output.skipped.push({
				segment: segment.id,
				category: "about_company_or_role",
				note: "About the company or the role.",
			});
			continue;
		}
		let best: { file: string; quote: string; score: number } | null = null;
		for (const l of lines) {
			const score = overlap(unit, l.line);
			if (score > (best?.score ?? 0) && checkQuote(profile, l.file, l.text).ok)
				best = { file: l.file, quote: l.text, score };
		}
		const supported = (best?.score ?? 0) >= 0.6;
		output.claims.push({
			segments: [segment.id],
			document: segment.document,
			text: unit,
			supported,
			evidence:
				supported && best ? [{ file: best.file, quote: best.quote }] : [],
			note: supported
				? `Matches ${best?.file}.`
				: "No profile line states this.",
		});
	}
	return output;
}
