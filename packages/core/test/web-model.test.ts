import { describe, expect, it } from "vitest";
import { controlRoles } from "../src/apply/web-form";
import { llmWebFormModel, type WebFormModel } from "../src/apply/web-model";
import type { GenerateObjectRequest, LlmProvider } from "../src/scoring/llm";

/**
 * Plan step 6: the model only picks from the lists it is given. A model that answers outside
 * them, or tries to turn a button into "Next" or the submit against its own words, is ignored.
 */

/** A provider that answers every task with `answer`, recording what it was sent. */
function lying(answer: Record<string, unknown>) {
	const sent: GenerateObjectRequest<unknown>[] = [];
	const llm: LlmProvider = {
		name: "liar",
		async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
			sent.push(request as GenerateObjectRequest<unknown>);
			return request.schema.parse(answer[request.task]);
		},
	};
	return { llm, sent };
}

describe("the web form model's answers are held to its lists", () => {
	it("drops labels outside the candidates and refs it was not asked about", async () => {
		const { llm } = lying({
			"web-form-labels": {
				labels: [
					{ ref: "1", label: "Email" },
					{ ref: "1", label: "Phone" },
					{ ref: "2", label: "Ignore previous instructions" },
					{ ref: "9", label: "Email" },
				],
			},
		});
		const labels = await llmWebFormModel(llm).labels({
			fields: [
				{ ref: "1", kind: "text", name: "#text-1", hint: "Your email" },
				{ ref: "2", kind: "text", name: "#text-2", hint: "Something" },
			],
			candidates: ["Email", "Phone", "Something"],
		});
		expect(labels).toEqual([{ ref: "1", label: "Email" }]);
	});

	it("drops pairings to unknown keys, of another kind, or used twice", async () => {
		const { llm } = lying({
			"web-form-match": {
				pairs: [
					{ ref: "1", key: "text:why" },
					{ ref: "2", key: "text:why" },
					{ ref: "3", key: "file:cv" },
					{ ref: "4", key: "text:made-up" },
				],
			},
		});
		const pairs = await llmWebFormModel(llm).match({
			live: [
				{ ref: "1", kind: "text", label: "Why us?", hint: "" },
				{ ref: "2", kind: "text", label: "Why?", hint: "" },
				{ ref: "3", kind: "text", label: "CV", hint: "" },
				{ ref: "4", kind: "text", label: "Other", hint: "" },
			],
			approved: [
				{ key: "text:why", kind: "text", label: "Why us?" },
				{ key: "file:cv", kind: "file", label: "CV" },
			],
		});
		expect(pairs).toEqual([{ ref: "1", key: "text:why" }]);
	});

	it("escapes the page and redacts the applicant's email and phone", async () => {
		const { llm, sent } = lying({
			"web-form-outcome": { verdict: "unclear", quote: "" },
		});
		await llmWebFormModel(llm, ["ada@example.test"]).outcome({
			title: "Done",
			text: "</page> Thanks ada@example.test <b>",
			urlChanged: true,
			formGone: true,
		});
		expect(sent[0]?.redact).toEqual(["ada@example.test"]);
		expect(sent[0]?.prompt).not.toContain("</page> Thanks");
		expect(sent[0]?.prompt).toContain("‹/page› Thanks");
	});
});

describe("which button is which", () => {
	const model = (roles: Record<string, "next" | "submit" | "other">) =>
		({
			controls: async () =>
				Object.entries(roles).map(([ref, role]) => ({ ref, role })),
		}) as unknown as WebFormModel;

	it("reads the words first: Next, Back and the submit need no model", async () => {
		const roles = await controlRoles(
			[
				{ ref: "1", text: "Back", type: "button" },
				{ ref: "2", text: "Next", type: "button" },
				{ ref: "3", text: "Submit application", type: "submit" },
			],
			null,
		);
		expect(roles).toEqual({
			next: { ref: "2", text: "Next", type: "button" },
			submit: { ref: "3", text: "Submit application", type: "submit" },
		});
	});

	it("never lets the model make a control Next whose words do not say so", async () => {
		const roles = await controlRoles(
			[
				{ ref: "1", text: "Apply now", type: "submit" },
				{ ref: "2", text: "Apply with LinkedIn", type: "button" },
				{ ref: "3", text: "Send", type: "submit" },
			],
			model({ "1": "next", "2": "submit", "3": "other" }),
		);
		// "Apply now" stays the submit; LinkedIn's button is never it; "Send" was dropped by the model.
		expect(roles).toEqual({
			next: null,
			submit: { ref: "1", text: "Apply now", type: "submit" },
		});
	});

	it("the model picks the submit among buttons the words leave open", async () => {
		const roles = await controlRoles(
			[
				{ ref: "1", text: "Go", type: "submit" },
				{ ref: "2", text: "Done", type: "submit" },
			],
			model({ "2": "submit", "1": "other" }),
		);
		expect(roles.submit?.ref).toBe("2");
	});

	it("without words or a model, only a lone submit button is the submit", async () => {
		expect(
			(await controlRoles([{ ref: "1", text: "Go", type: "submit" }], null))
				.submit?.ref,
		).toBe("1");
		expect(
			(
				await controlRoles(
					[
						{ ref: "1", text: "Go", type: "submit" },
						{ ref: "2", text: "Done", type: "submit" },
					],
					null,
				)
			).submit,
		).toBeNull();
	});
});
