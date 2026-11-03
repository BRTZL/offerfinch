import { describe, expect, it } from "vitest";
import { ruleSet } from "../src/tailor/profile-rules";
import { selectQuestions } from "../src/tailor/questions";
import { buildTailorPrompt } from "../src/tailor/tailor";

/** The first real run (Tessera): the second draft asked three new questions the user had settled. */
const profile = {
	files: [
		{
			path: "projects.md",
			content:
				"# Projects\n\n- Orders and inventory: built in e-commerce/client work (user, 2026-10-27; which project isn't recorded, likely trendmall-api). No invoicing, accounting or multi-currency work.\n",
		},
		{
			path: "experience/2021-keystone.md",
			content:
				"# Keystone — Software Engineer\n\n- **Dates:** Jan 2021 – Dec 2021\n\n- Mentored two junior engineers.\n",
		},
	],
};

const ROUND_ONE = [
	{
		question:
			"What is your English level (e.g. professional working proficiency, C1)?",
		answer: "professional working proficiency",
		status: "answered" as const,
	},
	{
		question:
			"Have you worked directly with customers or support teams to turn their feedback into product changes? If so, where and how?",
		answer: "not really",
		status: "answered" as const,
	},
	{
		question:
			"Have you mentored mid-level developers (not only juniors), and at which company?",
		answer:
			"yes at brightloom and rivermode I worked with engineers below me and mentored them and teached them stuff. onboarded etc.",
		status: "answered" as const,
	},
];

const ROUND_TWO = [
	{
		question:
			"Have you built any invoicing, accounting, ledger or multi-currency features, even in client or side projects?",
		why: "The posting asks for accounting, invoicing and multi-currency domains.",
		requirement: "must_have" as const,
	},
	{
		question:
			"Which project had the orders and inventory work (was it trendmall-api), and what did it cover (stock levels, warehouses, reservations)?",
		why: "Inventory is a core module.",
		requirement: "must_have" as const,
	},
	{
		question:
			"Have you ever talked to customers or support staff directly (calls, tickets, demos), even if not to drive product changes?",
		why: "The posting asks for working directly with customers and support.",
		requirement: "must_have" as const,
	},
];

describe("questions are never asked twice", () => {
	it("drops each of the Tessera second-round questions for its own reason, with rounds to spare", () => {
		const selection = selectQuestions(ROUND_TWO, {
			profile,
			asked: ROUND_ONE,
			budget: { rounds: 0, maxRounds: 3, maxQuestions: 3 },
		});
		expect(selection.ask).toEqual([]);
		expect(selection.dropped.map((d) => d.reason)).toEqual([
			"the profile already settles it",
			"the profile already settles it",
			"already asked for this application",
		]);
	});

	it("keeps distinct topics apart: English level, customers and mentoring are three questions", () => {
		const selection = selectQuestions(
			ROUND_ONE.map((q) => ({
				question: q.question,
				why: "required",
				requirement: "must_have" as const,
			})),
			{
				profile,
				asked: [],
				budget: { rounds: 0, maxRounds: 1, maxQuestions: 3 },
			},
		);
		expect(selection.ask).toHaveLength(3);
	});
});

describe("the question budget", () => {
	const fresh = (question: string, requirement = "must_have" as const) => ({
		question,
		why: "required",
		requirement,
	});

	it("asks nothing once the application's round is spent", () => {
		const selection = selectQuestions(
			[fresh("Do you hold a valid work permit for Spain?")],
			{
				profile,
				asked: [],
				budget: { rounds: 1, maxRounds: 1, maxQuestions: 3 },
			},
		);
		expect(selection.ask).toEqual([]);
		expect(selection.dropped[0]?.reason).toMatch(/no question round left/);
	});

	it("never asks about a nice-to-have, and asks at most three per round", () => {
		const selection = selectQuestions(
			[
				{
					...fresh("Have you used Elixir in production?"),
					requirement: "nice_to_have",
				},
				fresh("Do you hold a valid work permit for Spain?"),
				fresh("What is your notice period?"),
				fresh("Can you travel to Lisbon twice a year?"),
				fresh("Which salary range do you expect in euros?"),
			],
			{
				profile,
				asked: [],
				budget: { rounds: 0, maxRounds: 1, maxQuestions: 3 },
			},
		);
		expect(selection.ask.map((q) => q.question)).toEqual([
			"Do you hold a valid work permit for Spain?",
			"What is your notice period?",
			"Can you travel to Lisbon twice a year?",
		]);
		expect(selection.dropped.map((d) => d.reason)).toEqual([
			"a nice-to-have; left out and named as a gap",
			"more than 3 questions in one round",
		]);
	});

	it("tells the model what was asked and that it may ask nothing", () => {
		const prompt = buildTailorPrompt(
			{
				job: {
					companyName: "Tessera",
					title: "Senior Full-Stack Developer",
					url: "https://example.test/jobs/1",
					locations: [],
					workplaceType: "remote",
					descriptionText: "Accounting and invoicing domain.",
				},
				profile,
				today: "2026-10-31",
				askedQuestions: ROUND_ONE,
				questionsAllowed: 0,
			},
			ruleSet(profile),
		);
		expect(prompt).toContain("<questions_allowed>0</questions_allowed>");
		expect(prompt).toContain(
			"Have you worked directly with customers or support teams to turn their feedback into product changes? If so, where and how? — answered: not really",
		);
	});
});
