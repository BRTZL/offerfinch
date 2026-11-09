import { openFormQuestions, planFormFields } from "../apply/field-answers";
import type { FormRead } from "../apply/form-schema";
import { readApplicationForm } from "../apply/read-form";
import { applicantData } from "../apply/submit";
import { parseFormAnswers } from "../tailor/tailor";
import type { PipelineDeps } from "./ports";

/**
 * The form steps of preparation (docs/auto-apply-plan.md, steps 2 and 3): the application's form
 * is read before drafting, and after each draft every field gets an approved value, a blank, or
 * a question. Both are no-ops where submission is not configured or the board is a hand-off.
 */

/** The saved read of this application's form, or null. */
async function savedRead(
	deps: PipelineDeps,
	userId: string,
	applicationId: string,
): Promise<FormRead | null> {
	return (await deps.apply?.store.formRead?.(userId, applicationId)) ?? null;
}

/**
 * Reads the form once per application (a failed or skipped read is tried again on the next
 * preparation). Never throws: a read that fails is saved with its reason, and review goes ahead.
 */
export async function readFormStep(
	deps: PipelineDeps,
	userId: string,
	applicationId: string,
): Promise<{ status: FormRead["status"] | "none" }> {
	const apply = deps.apply;
	if (!apply?.store.saveFormRead) return { status: "none" };
	try {
		if ((await deps.repo.getState(userId, applicationId)) !== "preparing")
			return { status: "none" };
		const earlier = await savedRead(deps, userId, applicationId);
		if (earlier?.status === "read") return { status: "read" };
		const context = await apply.store.submissionContext(userId, applicationId);
		if (!context) return { status: "none" };
		const read = await readApplicationForm(
			apply,
			context,
			deps.now?.() ?? new Date(),
		);
		await apply.store.saveFormRead(userId, applicationId, read);
		deps.log?.("form read", {
			applicationId,
			status: read.status,
			...(read.status === "read"
				? { fields: read.schema.fields.length }
				: { note: read.note }),
		});
		return { status: read.status };
	} catch (error) {
		// Recording the read failed: preparation goes on without the field list.
		deps.log?.("form read failed", {
			applicationId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: "none" };
	}
}

/** The form's questions the drafting model should answer (nothing on file covers them yet). */
export async function formQuestionsForDraft(
	deps: PipelineDeps,
	userId: string,
	applicationId: string,
): Promise<{ label: string; required: boolean; options: string[] }[]> {
	const read = await savedRead(deps, userId, applicationId);
	if (read?.status !== "read" || !deps.apply) return [];
	const saved = await deps.apply.store.savedAnswers(userId);
	return openFormQuestions(read.schema, [], saved);
}

export type FieldAnswersOutcome =
	| { outcome: "none" }
	| { outcome: "answered"; added: number }
	| { outcome: "questions"; open: number };

/**
 * After a draft: maps every field of the read form. Saved answers the form needs join the form
 * answers (a new version, so the claims check and the approval cover them); a required field
 * nothing answers becomes a question, and the application waits in needs_answers.
 */
export async function fieldAnswersStep(
	deps: PipelineDeps,
	userId: string,
	applicationId: string,
): Promise<FieldAnswersOutcome> {
	const apply = deps.apply;
	if (!apply) return { outcome: "none" };
	if ((await deps.repo.getState(userId, applicationId)) !== "preparing")
		return { outcome: "none" };
	const read = await savedRead(deps, userId, applicationId);
	if (read?.status !== "read") return { outcome: "none" };
	const profile = await deps.repo.getProfile(userId);
	if (!profile) return { outcome: "none" };
	const docs = await deps.repo.latestDocuments(userId, applicationId);
	const byKind = Object.fromEntries(docs.map((d) => [d.kind, d]));
	const data = applicantData(
		profile,
		{
			formAnswers: parseFormAnswers(byKind.form_answers?.content ?? "[]"),
			coverLetterMarkdown: byKind.cover_letter?.content ?? null,
		},
		// Every draft has a letter; its PDF is exported once the review passes.
		byKind.cover_letter !== undefined,
	);
	const plan = planFormFields(
		read.schema,
		data,
		await apply.store.savedAnswers(userId),
	);
	const added =
		plan.add.length > 0 && apply.store.addFormAnswers
			? await apply.store.addFormAnswers(
					userId,
					applicationId,
					plan.add.map(({ question, answer }) => ({ question, answer })),
				)
			: 0;
	if (plan.ask.length === 0) return { outcome: "answered", added };
	const { open } = await deps.repo.askQuestions(
		userId,
		applicationId,
		plan.ask.map((q) => ({
			question: q.label,
			why: `Asked by the ${read.schema.board} application form (required)${q.answered ? `; the drafted answer "${q.answered}" is not one of its options` : ""}. Nothing on file answers it.`,
			formField: {
				label: q.label,
				options: q.options,
				kind: q.kind,
				board: read.schema.board,
			},
		})),
		"{open} question(s) on the application form need your answer before review",
	);
	return open > 0
		? { outcome: "questions", open }
		: { outcome: "answered", added };
}
