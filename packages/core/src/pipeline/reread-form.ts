import { type FieldPlan, planFormFields } from "../apply/field-answers";
import type { FormRead } from "../apply/form-schema";
import { readApplicationForm } from "../apply/read-form";
import { applicantData } from "../apply/submit";
import { webFormModelFor } from "../apply/web-model";
import type { PipelineDeps } from "./ports";

/**
 * "Read the form again" (docs/auto-apply-plan.md, step 7): a run stopped because the live form
 * no longer matched the field list approved in review (`form_changed`). Retrying would compare
 * against the same old list and stop again, so the form is read afresh, read-only as before
 * review, and every field gets its value, a blank or a question from the same plan review uses.
 * Nothing is saved here: the caller stores the read and sends the application back to review in
 * one transaction, and only when no attempt reached the click.
 */
export type FormReadAgain =
	| {
			ok: true;
			read: Extract<FormRead, { status: "read" }>;
			add: FieldPlan["add"];
			ask: FieldPlan["ask"];
	  }
	| { ok: false; reason: string };

export async function readFormAgain(
	deps: PipelineDeps,
	userId: string,
	applicationId: string,
): Promise<FormReadAgain> {
	const apply = deps.apply;
	if (!apply)
		return { ok: false, reason: "Submission is not configured here." };
	const context = await apply.store.submissionContext(userId, applicationId);
	if (!context)
		return { ok: false, reason: "The application's job could not be read." };
	const read = await readApplicationForm(
		apply,
		context,
		deps.now?.() ?? new Date(),
		context.board === "web"
			? webFormModelFor(deps, userId, applicationId)
			: null,
	);
	if (read.status !== "read")
		return {
			ok: false,
			reason: read.note.replace(
				"The form could not be read before review",
				"The form could not be read again",
			),
		};
	const profile = await deps.repo.getProfile(userId);
	if (!profile)
		return { ok: false, reason: "No profile to fill the form from." };
	const plan = planFormFields(
		read.schema,
		applicantData(
			profile,
			context,
			// Approval needed a finished review, which exported the letter.
			context.coverLetterMarkdown !== null,
		),
		await apply.store.savedAnswers(userId),
	);
	return { ok: true, read, add: plan.add, ask: plan.ask };
}
