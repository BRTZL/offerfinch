import { describe, expect, it } from "vitest";

import {
	type ClaimsCheckOutput,
	type ClaimsInput,
	clearedFlags,
	type StoredFlag,
	segmentDocuments,
	verifyClaims,
} from "../src/tailor/claims";
import {
	ASKED_QUESTION_PREFIX,
	BOARD_QUESTION_PREFIX,
} from "../src/tailor/profile-rules";
import { formAnswersText } from "../src/tailor/tailor";

/**
 * The fifth round of real flags (2026-11-02): letter closers asking for a talk, sentences only
 * about the company, the role or its engineering culture, and a CV line backed by the user's
 * "yes" to a question from tailoring were flagged. The profile is synthetic; the company and
 * posting wording are shaped like the real ones.
 */

const ANSWERS = `# Answers

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Trunk Based Development and Continuous Delivery (for example, merging small changes to main daily)?
- Answer: yes in my all companies basically
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you used Kafka or RabbitMQ in production?
- Answer: yes they ran our queues
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Kubernetes?
- Answer: no, only Docker Compose
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Docker and Kubernetes?
- Answer: yes, with Docker
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Docker and Kubernetes?
- Answer: yes perhaps
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Docker and Kubernetes?
- Answer: yes but only as an observer
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Docker and Kubernetes?
- Answer: yes to the previous question
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Docker and Kubernetes?
- Answer: yes to Docker
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Nomad, Consul and Vault?
- Answer: yes in all my teams
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Helm?
- Answer: yes, in all my companies
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Docker instead of Kubernetes?
- Answer: yes, at every company
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you used Nomad rather than Kubernetes?
- Answer: yes, everywhere
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Kubernetes if needed?
- Answer: yes, across all my employers
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Docker and Kubernetes in production?
- Answer: yes, all of them
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Do you have experience with Docker and Kubernetes?
- Answer: yes, both
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Docker Over Kubernetes?
- Answer: yes, at all my companies
- Source: user, 2026-11-01

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Docker and Kubernetes?
- Answer: yes. No Kubernetes.
- Source: user, 2026-11-01

## Answer to a job board's form question (greenhouse)

${BOARD_QUESTION_PREFIX} Have you worked with Terraform?
- Answer: yes for the infra repo
- Source: user, 2026-11-01
`;

const profile = {
	files: [
		{
			path: "experience/2023-alpha.md",
			content: `# Alpha — Senior Software Engineer

- **Dates:** Jan 2023 – Present
- **Location:** Remote

## What I did

- Built payment services in Go and TypeScript.
- Ran code review for the backend team and mentoring for two juniors.
`,
		},
		{
			path: "skills.md",
			content:
				"# Skills\n\n- Go, TypeScript, PostgreSQL\n- code review, mentoring\n",
		},
		{ path: "answers.md", content: ANSWERS },
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n",
		},
	],
};

const TALABAT_POSTING = `Software Engineer II - Backend

talabat is the leading on-demand food and Q-commerce app for everyday deliveries, operating in eight countries across the Middle East. Our backend systems serve customers, restaurants, local shops and riders.

Our engineering culture: we shorten feedback loops, deliver value in small batches and let quality enable speed. We practise XP: pair programming, TDD, Trunk Based Development and Continuous Delivery.

What you will do:
- Understand customer problems and take end-to-end ownership of an area, keeping hand-overs low
- Build and run backend services in Go
- Review code and mentor other engineers`;

const ERP_POSTING = `Senior Full-Stack Developer

Own features across our TypeScript/React front end and API back end.

- Design and ship product features end-to-end across the web app and API
- Model complex ERP domains into clean, reliable code
- Review code, raise the engineering bar, and mentor mid-level developers

Tessera is a cloud-based ERP for ship suppliers and port agents. Ship agency, procurement, inventory and accounting: seven modules sharing one set of data.`;

function input(docs: {
	cv?: string;
	letter?: string;
	answers?: { question: string; answer: string }[];
	company?: string;
	title?: string;
	posting?: string;
}): ClaimsInput {
	const answers = docs.answers ?? [];
	return {
		documents: {
			cv: docs.cv ?? "# Ada Example",
			cover_letter: docs.letter ?? "",
			form_answers: formAnswersText(answers),
		},
		formAnswers: answers,
		profile,
		context: {
			companyName: docs.company ?? "talabat",
			jobTitle: docs.title ?? "Software Engineer II - Backend",
		},
		postingText: docs.posting ?? TALABAT_POSTING,
	};
}

function idOf(i: ClaimsInput, text: string): string {
	const found = segmentDocuments(i).find((s) => s.text === text);
	if (!found) throw new Error(`no segment "${text}"`);
	return found.id;
}

function flagsOn(i: ClaimsInput, output: ClaimsCheckOutput, text: string) {
	return verifyClaims(output, i, "test").issues.filter(
		(x) => x.excerpt === text,
	);
}

function allSkipped(
	i: ClaimsInput,
	category: ClaimsCheckOutput["skipped"][number]["category"],
): ClaimsCheckOutput {
	return {
		claims: [],
		skipped: segmentDocuments(i).map((s) => ({
			segment: s.id,
			category,
			note: "No fact about the candidate.",
		})),
	};
}

/** One supported claim restating the line word for word, citing the given quotes. */
function claimFor(
	i: ClaimsInput,
	text: string,
	evidence: [string, string][],
	document: "cv" | "cover_letter" | "form_answers" = "cover_letter",
): ClaimsCheckOutput {
	return {
		claims: [
			{
				segments: [idOf(i, text)],
				document,
				text,
				supported: true,
				evidence: evidence.map(([file, quote]) => ({ file, quote })),
				note: "Stated in the cited profile text.",
			},
		],
		skipped: [],
	};
}

const letter = (...paragraphs: string[]) =>
	`Dear Hiring Team,\n\n${paragraphs.join("\n\n")}\n\nBest regards,\\\nAda Example`;

describe("a closing line asking the reader for a talk", () => {
	for (const line of [
		"Please let me know a convenient time to talk about the role.",
		"I would be glad to talk through how I could contribute to your team.",
		// The two closers the writer prompt gives as examples.
		"I'd welcome a conversation about the role.",
		"Please let me know a convenient time to talk.",
		"I look forward to hearing from you.",
	])
		it(`accepts "${line}"`, () => {
			const i = input({ letter: letter(line) });
			for (const category of [
				"about_company_or_role",
				"motivation_only",
				"greeting_or_signoff",
			] as const)
				expect(flagsOn(i, allSkipped(i, category), line)).toEqual([]);
		});

	for (const line of [
		"I'd love to talk about my 8 years leading teams.",
		"I would be glad to talk through how my Rust work could help your team.",
		"Please let me know a convenient time to talk about the payments platform I built.",
		"I would be glad to discuss how I could lead your team.",
		"Thank you for considering my Rust expertise.",
	])
		it(`still flags "${line}"`, () => {
			const i = input({ letter: letter(line) });
			expect(
				flagsOn(i, allSkipped(i, "about_company_or_role"), line),
			).not.toEqual([]);
		});
});

describe("company and role sentences need no evidence (per-document checker, 2026-11-03)", () => {
	// These were flagged again in the fifth round. The user's decision: a letter or an answer
	// talking about the company, the role or its culture states nothing about the candidate, so
	// a skip is accepted unless the sentence has the candidate in it (see the lists below).
	for (const [company, line] of [
		[
			"talabat",
			"The engineering culture is stated clearly: shorten feedback loops, deliver value in small batches, and let quality enable speed through XP, pair programming and TDD.",
		],
		[
			"talabat",
			"The role asks engineers to understand customer problems and take end-to-end ownership of an area, which keeps hand-overs low.",
		],
		[
			"Talabat",
			"talabat runs an on-demand food and Q-commerce app in eight countries, so its backend systems serve customers, restaurants, local shops and riders.",
		],
	] as const)
		it(`accepts (company stored as "${company}") "${line.slice(0, 50)}…"`, () => {
			const i = input({ letter: letter(line), company });
			expect(
				flagsOn(i, allSkipped(i, "about_company_or_role"), line).filter(
					(x) => x.rule === "unchecked_line",
				),
			).toEqual([]);
		});

	it("accepts the role's requirement, in a name only an earlier posting's question used", () => {
		// "Kafka" is in the profile only in a question line ("Have you used Kafka or RabbitMQ …?"),
		// which is a posting's wording, not the candidate's.
		const line = "The role asks engineers to bring Kafka experience.";
		const i = input({ letter: letter(line) });
		expect(flagsOn(i, allSkipped(i, "about_company_or_role"), line)).toEqual(
			[],
		);
	});

	it("accepts a sentence about the product that makes the role's work interesting", () => {
		const line =
			"A single ERP that keeps procurement, inventory and accounting on one connected set of data makes the back-end modelling work in this role interesting.";
		const i = input({
			letter: letter(line),
			company: "Tessera",
			title: "Senior Full-Stack Developer",
			posting: ERP_POSTING,
		});
		expect(flagsOn(i, allSkipped(i, "about_company_or_role"), line)).toEqual(
			[],
		);
	});

	it("flags a duty sentence with a trailing claim, even in the posting's own words", () => {
		const line =
			"The role asks engineers to understand customer problems, something the jobseeker practises.";
		const i = input({
			letter: letter(line),
			posting:
				"Understand customer problems. Our jobseeker platform practises careful work.",
		});
		expect(
			flagsOn(i, allSkipped(i, "about_company_or_role"), line),
		).not.toEqual([]);
		const segment = segmentDocuments(i).find((s) => s.text === line);
		const flag: StoredFlag = {
			document: "cover_letter",
			text: line,
			context: segment?.context,
			occurrence: segment?.occurrence,
			reasons: [
				{
					rule: "unchecked_line",
					message:
						"The claims check skipped this as about company or role, but it states a fact about the candidate.",
				},
			],
			state: "open",
		};
		expect(clearedFlags([flag], [], i)).toEqual([]);
	});

	for (const line of [
		"talabat needs Go experts, and I have built Go services for 5 years.",
		"talabat needs engineers to build Go services, which I have done at Alpha.",
		"The engineering culture fits a background in Rust services.",
		"Talabat gains an engineer with extensive Go experience.",
		"The backend team would gain a Go developer who shipped payment services.",
	])
		it(`still flags "${line}"`, () => {
			const i = input({ letter: letter(line) });
			expect(
				flagsOn(i, allSkipped(i, "about_company_or_role"), line),
			).not.toEqual([]);
		});
});

describe("a proportion or frequency word is scope the quotes must state", () => {
	it("flags 'mainly' that the cited quote does not state, even restated in the claim", () => {
		const line = "I work mainly in Go and TypeScript.";
		const i = input({ letter: letter(line) });
		expect(
			flagsOn(i, claimFor(i, line, [["skills.md", "Go, TypeScript"]]), line),
		).not.toEqual([]);
	});

	it("flags 'daily' the profile does not state", () => {
		const line = "I review Go code daily.";
		const i = input({ letter: letter(line) });
		expect(
			flagsOn(i, claimFor(i, line, [["skills.md", "code review"]]), line),
		).not.toEqual([]);
	});

	it("still accepts the same line without the proportion word", () => {
		const line = "I work in Go and TypeScript.";
		const i = input({ letter: letter(line) });
		expect(
			flagsOn(i, claimFor(i, line, [["skills.md", "Go, TypeScript"]]), line),
		).toEqual([]);
	});

	it("does not take 'main' (a branch) for 'mainly'", () => {
		const line = "I merged small changes to main in Go.";
		const i = input({ letter: letter(line) });
		const issues = flagsOn(
			i,
			claimFor(i, line, [["skills.md", "Go, TypeScript"]]),
			line,
		);
		expect(issues.map((x) => x.message).join(" ")).not.toMatch(
			/not in the cited quotes/,
		);
	});
});

describe("a fact needs evidence however the letter frames it", () => {
	it("flags relocation and on-site work the profile does not state", () => {
		const line = "I am willing to relocate and work on-site.";
		const i = input({ letter: letter(line) });
		for (const category of [
			"motivation_only",
			"about_company_or_role",
		] as const)
			expect(flagsOn(i, allSkipped(i, category), line)).not.toEqual([]);
	});
});

describe("a 'yes' to a question from tailoring states the question's names", () => {
	const CV = (line: string) =>
		`# Ada Example\n\n## Skills\n\n- Languages: Go, TypeScript\n- ${line}`;

	it("sources Trunk Based Development and Continuous Delivery from the answer line", () => {
		const line =
			"Practices: Trunk Based Development, Continuous Delivery, code review, mentoring";
		const i = input({ cv: CV(line) });
		expect(
			flagsOn(
				i,
				claimFor(
					i,
					line,
					[
						["answers.md", "yes in my all companies basically"],
						["skills.md", "code review, mentoring"],
					],
					"cv",
				),
				line,
			),
		).toEqual([]);
	});

	it("still flags a name the question does not ask about", () => {
		const line = "Practices: Trunk Based Development, Kanban, code review";
		const i = input({ cv: CV(line) });
		const issues = flagsOn(
			i,
			claimFor(
				i,
				line,
				[
					["answers.md", "yes in my all companies basically"],
					["skills.md", "code review, mentoring"],
				],
				"cv",
			),
			line,
		);
		expect(issues.map((x) => x.message).join(" ")).toMatch(/Kanban/);
	});

	it("gives nothing for a question with 'or': 'yes' affirms neither", () => {
		const line = "Messaging: Kafka";
		const i = input({ cv: CV(line) });
		expect(
			flagsOn(
				i,
				claimFor(i, line, [["answers.md", "yes they ran our queues"]], "cv"),
				line,
			),
		).not.toEqual([]);
	});

	it("gives nothing for a negative answer", () => {
		const line = "Infrastructure: Kubernetes";
		const i = input({ cv: CV(line) });
		expect(
			flagsOn(
				i,
				claimFor(i, line, [["answers.md", "no, only Docker Compose"]], "cv"),
				line,
			),
		).not.toEqual([]);
	});

	it("gives nothing for a board's question", () => {
		const line = "Infrastructure: Terraform";
		const i = input({ cv: CV(line) });
		const output = claimFor(
			i,
			line,
			[["answers.md", "yes for the infra repo"]],
			"cv",
		);
		expect(flagsOn(i, output, line)).not.toEqual([]);
	});
});

describe("stored flags the current check clears, with no model call", () => {
	const SKIPPED =
		"The claims check skipped this as about company or role, but it states a fact about the candidate.";
	/** A flag as an older version stored it on this line. */
	function staleFlag(
		i: ClaimsInput,
		text: string,
		message: string,
	): StoredFlag {
		const segment = segmentDocuments(i).find((s) => s.text === text);
		if (!segment) throw new Error(`no segment "${text}"`);
		return {
			document: segment.document,
			text,
			context: segment.context,
			occurrence: segment.occurrence,
			reasons: [{ rule: "unchecked_line", message }],
			state: "open",
		};
	}

	it("clears a skipped closer and a company sentence, keeps a skipped fact", () => {
		const closer =
			"Please let me know a convenient time to talk about the role.";
		const company =
			"The role asks engineers to understand customer problems and take end-to-end ownership of an area, which keeps hand-overs low.";
		const fact =
			"talabat needs Go experts, and I have built Go services for 5 years.";
		// A sentence starting with "talabat" is not split from the one before it: fact first.
		const i = input({ letter: letter(`${fact} ${company}`, closer) });
		const flags = [closer, company, fact].map((t) => staleFlag(i, t, SKIPPED));
		expect(clearedFlags(flags, [], i).map((f) => f.text)).toEqual([
			closer,
			company,
		]);
	});

	it("clears the Trunk Based Development line on its stored claim citing the 'yes'", () => {
		const line =
			"Practices: Trunk Based Development, Continuous Delivery, code review, mentoring";
		const i = input({
			cv: `# Ada Example\n\n## Skills\n\n- ${line}`,
		});
		const { claims } = verifyClaims(
			claimFor(
				i,
				line,
				[
					["answers.md", "yes in my all companies basically"],
					["skills.md", "code review, mentoring"],
				],
				"cv",
			),
			i,
			"test",
		);
		const flag = staleFlag(
			i,
			line,
			"Not in the profile files its claims cite: trunk, bas, continuou.",
		);
		expect(clearedFlags([flag], claims, i)).toEqual([flag]);
		// The answer gone from the profile: its quote no longer verifies, the flag stays.
		const without = {
			...i,
			profile: {
				files: i.profile.files.filter((f) => f.path !== "answers.md"),
			},
		};
		expect(clearedFlags([flag], claims, without)).toEqual([]);
	});

	it("keeps a flag with any other reason, a confirmed flag, or a line no longer there", () => {
		const closer =
			"Please let me know a convenient time to talk about the role.";
		const i = input({ letter: letter(closer) });
		const base = staleFlag(i, closer, SKIPPED);
		const flags: StoredFlag[] = [
			{
				...base,
				reasons: [
					...base.reasons,
					{ rule: "unsupported_number", message: '"8" does not appear.' },
				],
			},
			{ ...base, state: "confirmed" },
			{ ...base, context: "another paragraph" },
		];
		expect(clearedFlags(flags, [], i)).toEqual([]);
	});

	it("keeps a stale 'did not cover' flag: nothing was skipped or claimed", () => {
		const closer =
			"Please let me know a convenient time to talk about the role.";
		const i = input({ letter: letter(closer) });
		const flag = staleFlag(i, closer, "The claims check did not cover this.");
		expect(clearedFlags([flag], [], i)).toEqual([]);
	});
});

describe("a first-person contraction mid-sentence is not a name", () => {
	it("accepts a closer with 'I'd' after a comma", () => {
		const line =
			"Thank you for your time, and I'd welcome a conversation about the role.";
		const i = input({ letter: letter(line) });
		expect(flagsOn(i, allSkipped(i, "greeting_or_signoff"), line)).toEqual([]);
	});

	it('does not ask the profile to state "I\'ve"', () => {
		const line = "At Alpha, I've built payment services in Go.";
		const i = input({ letter: letter(line) });
		const issues = flagsOn(
			i,
			claimFor(i, line, [
				[
					"experience/2023-alpha.md",
					"Built payment services in Go and TypeScript.",
				],
			]),
			line,
		);
		expect(issues.map((x) => x.message).join(" ")).not.toMatch(/i've/i);
	});
});

describe("a qualified or partial yes sources none of the question's names", () => {
	const CV = (line: string) => `# Ada Example\n\n## Skills\n\n- ${line}`;
	const cite = (i: ClaimsInput, line: string, answer: string) =>
		claimFor(i, line, [["answers.md", answer]], "cv");

	for (const answer of [
		"yes, with Docker",
		"yes perhaps",
		"yes but only as an observer",
		"yes to the previous question",
		"yes to Docker",
	])
		it(`flags Kubernetes on "${answer}" to "Docker and Kubernetes?"`, () => {
			const line = "Infrastructure: Kubernetes";
			const i = input({ cv: CV(line) });
			expect(
				flagsOn(i, cite(i, line, answer), line)
					.map((x) => x.message)
					.join(" "),
			).toMatch(/Kubernetes/);
		});

	it("flags an item of a listed question ('X, Y and Z?') on a bare yes", () => {
		const line = "Infrastructure: Vault";
		const i = input({ cv: CV(line) });
		expect(
			flagsOn(i, cite(i, line, "yes in all my teams"), line)
				.map((x) => x.message)
				.join(" "),
		).toMatch(/Vault/);
	});

	it("still sources a one-item question on an unqualified yes", () => {
		const line = "Infrastructure: Helm";
		const i = input({ cv: CV(line) });
		expect(flagsOn(i, cite(i, line, "yes, in all my companies"), line)).toEqual(
			[],
		);
	});
});

describe("the candidate in the third person, or after the posting's words", () => {
	const AUTHOR = "The author uses Go for backend services in this role.";
	const AS_AUTHOR =
		"The role asks engineers to understand customer problems, as the author does.";
	for (const line of [
		AUTHOR,
		AS_AUTHOR,
		"The backend services in this role suit this engineer, who uses Go.",
		"The role asks engineers to take end-to-end ownership of an area, which the candidate has.",
		"The role asks engineers to review code, like someone who did it daily.",
		"The author would love to join the team.",
	])
		it(`flags "${line}"`, () => {
			const i = input({ letter: letter(line) });
			for (const category of [
				"about_company_or_role",
				"motivation_only",
			] as const)
				expect(flagsOn(i, allSkipped(i, category), line)).not.toEqual([]);
		});

	it("never clears such a flag from a stored review", () => {
		const i = input({ letter: letter(AUTHOR, AS_AUTHOR) });
		const flags = [AUTHOR, AS_AUTHOR].map((text) => {
			const segment = segmentDocuments(i).find((s) => s.text === text);
			if (!segment) throw new Error(`no segment "${text}"`);
			return {
				document: segment.document,
				text,
				context: segment.context,
				occurrence: segment.occurrence,
				reasons: [
					{
						rule: "unchecked_line" as const,
						message:
							"The claims check skipped this as about company or role, but it states a fact about the candidate.",
					},
				],
				state: "open" as const,
			};
		});
		expect(clearedFlags(flags, [], i)).toEqual([]);
	});

	it("never clears a Kubernetes flag backed by a qualified yes", () => {
		const line = "Infrastructure: Kubernetes";
		const i = input({ cv: `# Ada Example\n\n## Skills\n\n- ${line}` });
		const { claims } = verifyClaims(
			claimFor(i, line, [["answers.md", "yes, with Docker"]], "cv"),
			i,
			"test",
		);
		const segment = segmentDocuments(i).find((s) => s.text === line);
		const flag: StoredFlag = {
			document: "cv",
			text: line,
			context: segment?.context,
			occurrence: segment?.occurrence,
			reasons: [
				{
					rule: "unchecked_line",
					message: "Not in the profile files its claims cite: kubernetes.",
				},
			],
			state: "open",
		};
		expect(clearedFlags([flag], claims, i)).toEqual([]);
	});
});

describe("only a question asserting experience with its items sources them", () => {
	const CV = (line: string) => `# Ada Example\n\n## Skills\n\n- ${line}`;
	const line = "Infrastructure: Kubernetes";
	const cite = (i: ClaimsInput, answer: string) =>
		claimFor(i, line, [["answers.md", answer]], "cv");
	const staleOn = (i: ClaimsInput): StoredFlag => {
		const segment = segmentDocuments(i).find((s) => s.text === line);
		return {
			document: "cv",
			text: line,
			context: segment?.context,
			occurrence: segment?.occurrence,
			reasons: [
				{
					rule: "unchecked_line",
					message: "Not in the profile files its claims cite: kubernete.",
				},
			],
			state: "open",
		};
	};

	// Each answer is its own line in answers.md, so each quote finds its own question.
	for (const [question, answer] of [
		["Docker instead of Kubernetes?", "yes, at every company"],
		["Nomad rather than Kubernetes?", "yes, everywhere"],
		["Kubernetes if needed?", "yes, across all my employers"],
		["Docker Over Kubernetes?", "yes, at all my companies"],
		// The answer names Kubernetes, but only to deny it.
		["Docker and Kubernetes?", "yes. No Kubernetes."],
	] as const)
		it(`flags Kubernetes on "${answer}" to "…${question}", and never clears it`, () => {
			const i = input({ cv: CV(line) });
			const output = cite(i, answer);
			expect(
				flagsOn(i, output, line)
					.map((x) => x.message)
					.join(" "),
			).toMatch(/Kubernetes/);
			const { claims } = verifyClaims(output, i, "test");
			expect(clearedFlags([staleOn(i)], claims, i)).toEqual([]);
		});

	for (const answer of ["yes, all of them", "yes, both"])
		it(`counts "${answer}" as a yes to both items`, () => {
			const i = input({ cv: CV(line) });
			const output = cite(i, answer);
			expect(flagsOn(i, output, line)).toEqual([]);
			const { claims } = verifyClaims(output, i, "test");
			expect(clearedFlags([staleOn(i)], claims, i)).toHaveLength(1);
		});
});

describe("a company or role sentence adds no word of its own to the posting's", () => {
	const SKIPPED =
		"The claims check skipped this as about company or role, but it states a fact about the candidate.";
	for (const line of [
		"The role asks engineers to understand customer problems, something the jobseeker practises.",
		"The role asks engineers to understand customer problems, a habit of the interviewee.",
	])
		it(`flags "${line}", and never clears it`, () => {
			const i = input({ letter: letter(line) });
			expect(
				flagsOn(i, allSkipped(i, "about_company_or_role"), line),
			).not.toEqual([]);
			const segment = segmentDocuments(i).find((s) => s.text === line);
			const flag: StoredFlag = {
				document: "cover_letter",
				text: line,
				context: segment?.context,
				occurrence: segment?.occurrence,
				reasons: [{ rule: "unchecked_line", message: SKIPPED }],
				state: "open",
			};
			expect(clearedFlags([flag], [], i)).toEqual([]);
		});
});
