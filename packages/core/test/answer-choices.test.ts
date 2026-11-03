import { describe, expect, it } from "vitest";

import { FakeLlmProvider } from "../src/scoring/fake";
import type { GenerateObjectRequest, LlmProvider } from "../src/scoring/llm";
import { runAnswerChoices } from "../src/tailor/answer-choices";
import {
	type ChoiceGroup,
	composeChoices,
	NONE,
	NOT_SURE,
	togglePick,
} from "../src/tailor/answer-compose";
import type { AnswerHelperInput } from "../src/tailor/answer-helper";

const EMAIL = "ada@example.test";

const profile = {
	files: [
		{
			path: "personal.md",
			content: `# Ada Example\n\n- **Email:** ${EMAIL}`,
		},
		{
			path: "skills.md",
			content:
				"# Skills\n\n- React, TypeScript\n- Profiled renders with React Profiler at Bluefin Labs\n\n## Don't claim\n\n- Webpack: never configured it",
		},
	],
};

const QUESTION =
	"Which profiling tools have you used to diagnose frontend performance (for example Lighthouse, Chrome DevTools, React Profiler, bundle analyzers), and have you worked to a JS bundle-size budget?";

const input: AnswerHelperInput = {
	question: QUESTION,
	why: "The profile records no tools or figures.",
	posting: {
		companyName: "Harbor Mills",
		title: "Frontend Engineer",
		text: "We use Vite and Datadog.",
	},
	profile,
	draft: "",
};

function fixedModel(groups: unknown) {
	const requests: GenerateObjectRequest<unknown>[] = [];
	const llm: LlmProvider = {
		name: "fixed",
		async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
			requests.push(request as GenerateObjectRequest<unknown>);
			return request.schema.parse({ groups });
		},
	};
	return { llm, requests };
}

describe("answer choices", () => {
	it("keeps memory-jog options, marks only what the profile names, and drops built-in labels", async () => {
		const { llm, requests } = fixedModel([
			{
				ask: "Which of these profiling tools have you used?",
				multi: true,
				options: [
					"React Profiler",
					"Lighthouse",
					"Webpack Bundle Analyzer",
					"lighthouse",
					"None of these",
					"Not sure",
				],
			},
		]);
		const result = await runAnswerChoices(llm, input);
		expect(result).toEqual({
			status: "ok",
			groups: [
				{
					ask: "Which of these profiling tools have you used?",
					multi: true,
					options: [
						{ label: "React Profiler", inProfile: true },
						{ label: "Lighthouse", inProfile: false },
						// Don't claim is not evidence: never marked as the user's.
						{ label: "Webpack Bundle Analyzer", inProfile: false },
					],
				},
			],
		});
		const request = requests[0];
		expect(request?.task).toBe("answer-choices");
		expect(`${request?.promptPrefix}\n${request?.prompt}`).not.toContain(EMAIL);
	});

	it("drops an ask that names something nobody said: its words go into the draft", async () => {
		const { llm } = fixedModel([
			{
				ask: "Which tools did you use at Harbor Mills to cut load time by 40%?",
				multi: true,
				options: ["Lighthouse", "Chrome DevTools"],
			},
			{
				ask: "Have you worked to a JS bundle-size budget?",
				multi: false,
				options: ["Yes", "No"],
			},
		]);
		const result = await runAnswerChoices(llm, input);
		expect(result.status).toBe("ok");
		expect(
			result.status === "ok" ? result.groups.map((g) => g.ask) : [],
		).toEqual(["Have you worked to a JS bundle-size budget?"]);
	});

	it("is empty when nothing survives", async () => {
		const { llm } = fixedModel([
			{ ask: "Anything?", multi: false, options: ["Not sure"] },
		]);
		expect(await runAnswerChoices(llm, input)).toEqual({ status: "empty" });
	});

	it("the fake splits the question into its parts", async () => {
		const result = await runAnswerChoices(new FakeLlmProvider(), input);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.groups).toHaveLength(2);
		expect(result.groups[0]?.options.map((o) => o.label)).toContain(
			"Chrome DevTools",
		);
		expect(result.groups[1]?.options.map((o) => o.label)).toEqual([
			"Yes",
			"No",
		]);
	});
});

describe("composing picks", () => {
	const groups: ChoiceGroup[] = [
		{
			ask: "Which of these have you used",
			multi: true,
			options: [
				{ label: "Lighthouse", inProfile: false },
				{ label: "React Profiler", inProfile: true },
			],
		},
		{
			ask: "Worked to a bundle-size budget?",
			multi: false,
			options: [
				{ label: "Yes", inProfile: false },
				{ label: "No", inProfile: false },
			],
		},
	];

	it("writes only the asks and what the user ticked or typed", () => {
		expect(
			composeChoices(groups, [
				{ picked: ["Lighthouse", "React Profiler"], other: "Perfetto" },
				{ picked: ["Yes"], other: "" },
			]),
		).toBe(
			"Which of these have you used? Lighthouse, React Profiler and Perfetto.\nWorked to a bundle-size budget? Yes.",
		);
	});

	it("leaves out Not sure and untouched groups, so the part stays missing", () => {
		expect(
			composeChoices(groups, [
				{ picked: [NOT_SURE], other: "" },
				{ picked: ["No"], other: "" },
			]),
		).toBe("Worked to a bundle-size budget? No.");
		expect(composeChoices(groups, [])).toBe("");
	});

	it("says None of these plainly", () => {
		expect(composeChoices(groups, [{ picked: [NONE], other: "" }])).toBe(
			"Which of these have you used? None of these.",
		);
	});

	it("keeps None of these and Not sure exclusive, and one pick in a single-choice group", () => {
		const multi = { multi: true };
		expect(togglePick(multi, ["Lighthouse"], NONE)).toEqual([NONE]);
		expect(togglePick(multi, [NONE], "Lighthouse")).toEqual(["Lighthouse"]);
		expect(togglePick(multi, ["Lighthouse"], "React Profiler")).toEqual([
			"Lighthouse",
			"React Profiler",
		]);
		expect(togglePick(multi, ["Lighthouse"], "Lighthouse")).toEqual([]);
		expect(togglePick({ multi: false }, ["Yes"], "No")).toEqual(["No"]);
	});
});
