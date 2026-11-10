import {
	missingRequired,
	whatWillBeSent,
} from "@offerfinch/core/apply/field-answers";
import type { FormRead } from "@offerfinch/core/apply/form-schema";
import { sameQuestion } from "@offerfinch/core/apply/forms";
import { submissionModeAfterRead } from "@offerfinch/core/apply/modes";
import { applicantData, modeOf } from "@offerfinch/core/apply/submit";
import {
	type FormAnswer,
	parseFormAnswers,
} from "@offerfinch/core/tailor/tailor";
import { and, desc, eq } from "drizzle-orm";
import { applicationForms, documents } from "../schema/pipeline";
import type { DrizzlePipelineRepositoryContext } from "./context";
import type { Tx } from "./shared";

/** The form read before review (docs/auto-apply-plan.md, step 2) and the answers it adds. */
export const formsMethods = {
	async formRead(
		userId: string,
		applicationId: string,
	): Promise<FormRead | null> {
		const [row] = await this.db
			.select()
			.from(applicationForms)
			.where(
				and(
					eq(applicationForms.applicationId, applicationId),
					eq(applicationForms.userId, userId),
				),
			);
		if (!row) return null;
		const readAt = row.readAt.toISOString();
		if (row.status === "read" && row.schema)
			return { status: "read", schema: row.schema, readAt };
		return {
			status: row.status === "skipped" ? "skipped" : "failed",
			board: row.board ?? "",
			url: row.url ?? "",
			note: row.note ?? "The form could not be read before review.",
			readAt,
		};
	},

	/**
	 * Required fields of "What will be sent" that would go out empty, from the profile, the saved
	 * form read and the form answers as they are inside the caller's transaction (plan step 7).
	 * The approval is recorded only when this is empty, so a value removed after the review page
	 * checked it still holds the approval. Empty where the form is not filled automatically.
	 */
	async missingRequiredFields(
		t: Tx,
		userId: string,
		applicationId: string,
	): Promise<string[]> {
		const context = await this.submissionContext(userId, applicationId);
		const read = await this.formRead(userId, applicationId);
		const profile = await this.getProfile(userId, t);
		if (!context || !read || !profile) return [];
		const mode = submissionModeAfterRead(modeOf(context), context.board, read);
		// Approval needs a finished review, which exports the letter: a drafted letter is attached.
		const data = applicantData(
			profile,
			context,
			context.coverLetterMarkdown !== null,
		);
		return missingRequired(
			whatWillBeSent(read, data, await this.savedAnswers(userId)),
			mode,
		);
	},

	/** Only while preparing: an approval never covers a list that changed after it. */
	async saveFormRead(
		userId: string,
		applicationId: string,
		read: FormRead,
	): Promise<boolean> {
		return this.db.transaction(async (tx) => {
			const row = await this.lockOwned(tx, userId, applicationId);
			if (row.state !== "preparing") return false;
			await this.writeFormRead(tx, userId, applicationId, read);
			return true;
		});
	},

	/** Stores a read, replacing the application's earlier one. The caller holds the lock. */
	async writeFormRead(
		tx: Tx,
		userId: string,
		applicationId: string,
		read: FormRead,
	): Promise<void> {
		const values =
			read.status === "read"
				? {
						status: read.status,
						board: read.schema.board,
						url: read.schema.url,
						schema: read.schema,
						note: null,
						readAt: new Date(read.readAt),
					}
				: {
						status: read.status,
						board: read.board || null,
						url: read.url || null,
						schema: null,
						note: read.note.slice(0, 2000),
						readAt: new Date(read.readAt),
					};
		await tx
			.insert(applicationForms)
			.values({ userId, applicationId, ...values })
			.onConflictDoUpdate({
				target: applicationForms.applicationId,
				set: values,
			});
	},

	async addFormAnswers(
		userId: string,
		applicationId: string,
		answers: FormAnswer[],
	): Promise<number> {
		return this.db.transaction(async (tx) => {
			const row = await this.lockOwned(tx, userId, applicationId);
			if (row.state !== "preparing") return 0;
			return this.mergeFormAnswers(tx, userId, applicationId, answers);
		});
	},

	/**
	 * Adds answers to the form answers as a new version (same question: replaced). The caller
	 * holds the lock and decides the state. Returns how many changed.
	 */
	async mergeFormAnswers(
		tx: Tx,
		userId: string,
		applicationId: string,
		answers: FormAnswer[],
	): Promise<number> {
		const [latest] = await tx
			.select({ content: documents.content })
			.from(documents)
			.where(
				and(
					eq(documents.applicationId, applicationId),
					eq(documents.userId, userId),
					eq(documents.kind, "form_answers"),
					eq(documents.format, "json"),
				),
			)
			.orderBy(desc(documents.version))
			.limit(1);
		const current = parseFormAnswers(latest?.content ?? "[]");
		let changed = 0;
		for (const answer of answers) {
			const existing = current.find((a) =>
				sameQuestion(a.question, answer.question),
			);
			if (existing?.answer === answer.answer) continue;
			if (existing) existing.answer = answer.answer;
			else current.push({ ...answer });
			changed++;
		}
		if (changed === 0) return 0;
		await this.insertVersion(
			tx,
			userId,
			applicationId,
			"form_answers",
			"json",
			JSON.stringify(current, null, 2),
			"workflow",
		);
		return changed;
	},
} satisfies Record<string, unknown> &
	ThisType<DrizzlePipelineRepositoryContext>;
