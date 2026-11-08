import { sameQuestion } from "@offerfinch/core/apply/forms";
import type { AttemptInput, FormQuestion } from "@offerfinch/core/apply/submit";
import type { Actor } from "@offerfinch/core/pipeline/ports";
import type { AskedQuestion } from "@offerfinch/core/tailor/questions";
import {
	type FormAnswer,
	parseFormAnswers,
} from "@offerfinch/core/tailor/tailor";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
	applicationTransitions,
	documents,
	profileFacts,
	questions,
} from "../schema/pipeline";
import type { DrizzlePipelineRepositoryContext } from "./context";
import { ANSWERS_PATH, formQuestionText, questionKey, type Tx } from "./shared";
export const questionsMethods = {
	/**
	 * Adds questions and, with `waitReason`, moves preparing -> needs_answers, in one transaction
	 * under the application lock that answering takes too: an answer never sees the questions
	 * without the state, or the state without the questions.
	 */
	async askQuestions(
		userId: string,
		applicationId: string,
		asked: { question: string; why: string }[],
		waitReason?: string,
	): Promise<{ open: number }> {
		return this.db.transaction(async (tx) => {
			await this.lockOwned(tx, userId, applicationId);
			for (const q of asked)
				await tx
					.insert(questions)
					.values({
						userId,
						applicationId,
						key: questionKey(q.question),
						question: q.question,
						context: q.why,
					})
					.onConflictDoNothing();
			const [row] = await tx
				.select({ n: sql<number>`count(*)` })
				.from(questions)
				.where(
					and(
						eq(questions.userId, userId),
						eq(questions.applicationId, applicationId),
						eq(questions.status, "open"),
					),
				);
			const open = row?.n ?? 0;
			if (waitReason && open > 0)
				await this.move(
					userId,
					applicationId,
					["preparing"],
					"needs_answers",
					waitReason.replace("{open}", String(open)),
					"workflow",
					{},
					tx,
				);
			return { open };
		});
	},

	async questionHistory(
		userId: string,
		applicationId: string,
	): Promise<{ rounds: number; asked: AskedQuestion[] }> {
		const [row] = await this.db
			.select({ n: sql<number>`count(*)` })
			.from(applicationTransitions)
			.where(
				and(
					eq(applicationTransitions.userId, userId),
					eq(applicationTransitions.applicationId, applicationId),
					eq(applicationTransitions.fromState, "preparing"),
					eq(applicationTransitions.toState, "needs_answers"),
				),
			);
		const asked = await this.db
			.select({
				question: questions.question,
				answer: questions.answer,
				status: questions.status,
			})
			.from(questions)
			.where(
				and(
					eq(questions.userId, userId),
					eq(questions.applicationId, applicationId),
					isNull(questions.formField),
				),
			)
			.orderBy(asc(questions.createdAt), asc(sql`${questions}.rowid`));
		return { rounds: row?.n ?? 0, asked };
	},

	/**
	 * Adds the answered form questions of an application to its form answers as a new version and
	 * revokes the approval: new content goes to the employer only after review and approval.
	 */
	async appendFormAnswers(
		t: Tx,
		userId: string,
		applicationId: string,
		actor: Actor,
	): Promise<number> {
		const answered = await t
			.select({ answer: questions.answer, formField: questions.formField })
			.from(questions)
			.where(
				and(
					eq(questions.applicationId, applicationId),
					eq(questions.userId, userId),
					eq(questions.status, "answered"),
					sql`${questions.formField} is not null`,
				),
			)
			.orderBy(asc(questions.createdAt), asc(sql`${questions}.rowid`));
		const [latest] = await t
			.select({ content: documents.content })
			.from(documents)
			.where(
				and(
					eq(documents.applicationId, applicationId),
					eq(documents.kind, "form_answers"),
					eq(documents.format, "json"),
				),
			)
			.orderBy(desc(documents.version))
			.limit(1);
		const current: FormAnswer[] = parseFormAnswers(latest?.content ?? "[]");
		let added = 0;
		for (const q of answered) {
			const label = q.formField?.label;
			if (!label || !q.answer) continue;
			const existing = current.find((a) => sameQuestion(a.question, label));
			if (existing?.answer === q.answer) continue;
			if (existing) existing.answer = q.answer;
			else current.push({ question: label, answer: q.answer });
			added++;
		}
		if (added === 0) return 0;
		await this.insertVersion(
			t,
			userId,
			applicationId,
			"form_answers",
			"json",
			JSON.stringify(current, null, 2),
			actor,
		);
		await this.revokeApproval(
			t,
			userId,
			applicationId,
			"Answers to the application form's questions were added",
		);
		return added;
	},

	/** needs_human/applying -> ready_for_review once every form question has an answer. */
	async resumeWithFormAnswers(
		t: Tx,
		userId: string,
		applicationId: string,
		from: "applying" | "needs_human",
		actor: Actor,
	): Promise<boolean> {
		// Only when nothing reached the click; otherwise the user resolves that attempt first.
		if (await this.blockingAttempt(t, applicationId)) return false;
		const added = await this.appendFormAnswers(t, userId, applicationId, actor);
		if (added === 0) return false;
		return this.move(
			userId,
			applicationId,
			[from],
			"ready_for_review",
			`${added} answer(s) to the application form's questions added to the form answers; review and approve again`,
			actor,
			{ approvedAt: null },
			t,
		);
	},

	async stopForQuestions(
		userId: string,
		applicationId: string,
		input: AttemptInput & { questions: FormQuestion[] },
	): Promise<{ asked: number; reused: number }> {
		return this.db.transaction(async (tx) => {
			await this.lockOwned(tx, userId, applicationId);
			await this.insertStop(tx, userId, applicationId, input, "not_sent");
			let reused = 0;
			for (const q of input.questions) {
				const text = formQuestionText(q.label, q.options);
				const key = questionKey(text);
				const formField = {
					label: q.label,
					options: q.options,
					kind: q.kind,
					board: q.board,
				};
				const context = `Asked by the ${q.board} application form${q.required ? " (required)" : ""}.${q.answered ? ` The approved answer "${q.answered}" is not one of its options.` : ""}`;
				const [existing] = await tx
					.select({ id: questions.id })
					.from(questions)
					.where(
						and(
							eq(questions.applicationId, applicationId),
							eq(questions.key, key),
						),
					);
				const values = q.reuse
					? {
							status: "answered" as const,
							answer: q.reuse,
							answeredAt: new Date(),
							profilePath: ANSWERS_PATH,
						}
					: {
							status: "open" as const,
							answer: null,
							answeredAt: null,
							// Made for the old wording or context: the next sweep suggests afresh.
							suggestion: null,
						};
				if (q.reuse) reused++;
				if (existing)
					await tx
						.update(questions)
						.set({ ...values, context, formField })
						.where(eq(questions.id, existing.id));
				else
					await tx.insert(questions).values({
						userId,
						applicationId,
						key,
						question: text,
						context,
						formField,
						...values,
					});
			}
			const [open] = await tx
				.select({ n: sql<number>`count(*)` })
				.from(questions)
				.where(
					and(
						eq(questions.applicationId, applicationId),
						eq(questions.status, "open"),
					),
				);
			const asked = open?.n ?? 0;
			if (
				asked === 0 &&
				(await this.resumeWithFormAnswers(
					tx,
					userId,
					applicationId,
					"applying",
					"workflow",
				))
			)
				return { asked: 0, reused };
			await this.move(
				userId,
				applicationId,
				["applying"],
				"needs_human",
				asked > 0
					? `${asked} question(s) on the application form need your answer. Nothing was submitted.`
					: input.reason,
				"workflow",
				{},
				tx,
			);
			return { asked, reused };
		});
	},

	async savedAnswers(userId: string): Promise<FormAnswer[]> {
		return this.db
			.select({ question: profileFacts.question, answer: profileFacts.answer })
			.from(profileFacts)
			.where(eq(profileFacts.userId, userId))
			.orderBy(desc(profileFacts.answeredAt), desc(sql`${profileFacts}.rowid`));
	},
} satisfies Record<string, unknown> &
	ThisType<DrizzlePipelineRepositoryContext>;
