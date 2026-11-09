import {
	type WhatWillBeSent,
	whatWillBeSent,
} from "@offerfinch/core/apply/field-answers";
import { formTargetFor } from "@offerfinch/core/apply/form-target";
import { applyUrl } from "@offerfinch/core/apply/forms";
import {
	BOARD_SUBMISSION_MODES,
	submissionModeAfterRead,
	submissionModeForSource,
} from "@offerfinch/core/apply/modes";
import { applicantData } from "@offerfinch/core/apply/submit";
import { compareApproval } from "@offerfinch/core/domain/approval";
import { normalizeLineEndings } from "@offerfinch/core/domain/line-endings";
import { sourceMismatch } from "@offerfinch/core/domain/source";
import { APPLICATION_STATES } from "@offerfinch/core/domain/states";
import { markdownToPreviewHtml } from "@offerfinch/core/export/render";
import { filterSettingsSchema } from "@offerfinch/core/filter/settings";
import { postingAge } from "@offerfinch/core/pipeline/closed";
import { pdfText } from "@offerfinch/core/profile/pdf-text";
import { recordsFromStructured } from "@offerfinch/core/profile/records";
import { LlmPausedError } from "@offerfinch/core/scoring/llm";
import { MAX_SUBSCRIPTION_DAILY_CALLS } from "@offerfinch/core/scoring/metered";
import { BLOCKING_RULES, locateFlag } from "@offerfinch/core/tailor/flags";
import { evidenceProfile } from "@offerfinch/core/tailor/profile-rules";
import {
	ownAnswerQuestions,
	REDRAFT_INSTRUCTION_MAX,
	REDRAFT_SCOPES,
} from "@offerfinch/core/tailor/redraft";
import {
	ruleExplanation,
	ruleLabel,
} from "@offerfinch/core/tailor/rule-labels";
import { staleCitations } from "@offerfinch/core/tailor/stale";
import { parseContact, parseFormAnswers } from "@offerfinch/core/tailor/tailor";
import {
	DashboardRepository,
	DrizzleLinkedInStore,
	DrizzleSpendStore,
	EditConflictError,
	saveFilterSettings,
} from "@offerfinch/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { protectedProcedure } from "./procedure";

/** "What will be sent" for one application, from its saved form read; null when never read. */
async function whatWillBeSentFor(
	repo: ReturnType<typeof repoOf>,
	userId: string,
	applicationId: string,
	profile: Awaited<ReturnType<ReturnType<typeof repoOf>["getProfile"]>>,
): Promise<WhatWillBeSent | null> {
	const read = await repo.formRead(userId, applicationId);
	if (!read || !profile) return null;
	const context = await repo.submissionContext(userId, applicationId);
	if (!context) return null;
	return whatWillBeSent(
		read,
		// Approval needs a finished review, which exports the letter: a drafted letter is attached.
		applicantData(profile, context, context.coverLetterMarkdown !== null),
		await repo.savedAnswers(userId),
	);
}

/**
 * Required fields of the approved list that would go out empty (plan step 7, follow-up from step
 * 2): Approve waits until each has a value. Only where the form is filled automatically.
 */
function missingRequiredOf(
	form: WhatWillBeSent | null,
	mode: { mode: string },
): string[] {
	if (mode.mode !== "auto" || form?.status !== "read") return [];
	return form.fields
		.filter((f) => f.required && f.value === null)
		.map((f) => f.label);
}

/**
 * How the application is submitted and the form the hand-off opens, decided as the submission
 * decides it (core apply/form-target.ts): the source's board, else the board or employer form its
 * apply link names; an employer's own form is a hand-off unless its field list was read.
 */
export async function submissionView(
	repo: ReturnType<typeof repoOf>,
	userId: string,
	applicationId: string,
	posting: {
		job: {
			source: string;
			url: string;
			applyUrl: string | null;
			externalId: string;
		};
		companyKey: string;
	},
) {
	const { job } = posting;
	const target = formTargetFor({ ...job, companyKey: posting.companyKey });
	// The posting's own apply form on the real board (the board, not a fixture, decides);
	// otherwise the employer's own apply link when the listing showed one, else the posting.
	const postingForm =
		target.board === "web"
			? target.url
			: target.board
				? applyUrl(target.board, target)
				: (job.applyUrl ?? job.url);
	const mode = submissionModeAfterRead(
		submissionModeForSource(
			job.source,
			target.board,
			target.from,
			target.reason,
		),
		target.board,
		target.board === "web" ? await repo.formRead(userId, applicationId) : null,
	);
	return { postingForm, mode };
}

const repoOf = (context: {
	db: ConstructorParameters<typeof DashboardRepository>[0];
}) => new DashboardRepository(context.db);

const stateSchema = z.enum(APPLICATION_STATES);
const documentKind = z.enum(["notes", "cv", "cover_letter", "form_answers"]);
const hashesSchema = z.object({
	cv: z.string().optional(),
	cover_letter: z.string().optional(),
	form_answers: z.string().optional(),
	// Approvals are bound to the posting too; without it every approval is refused.
	posting: z.string().optional(),
});

/** Turns a domain refusal into a 409 the dashboard shows as-is, instead of a 500. */
async function refusal<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof EditConflictError)
			throw new ORPCError("CONFLICT", { message: error.message });
		if (
			error instanceof Error &&
			/Refusing|not in|cannot|can be edited|can be resolved|not found|must be|is empty/i.test(
				error.message,
			)
		)
			throw new ORPCError("CONFLICT", { message: error.message });
		throw error;
	}
}

/**
 * Every saved version of each document, for the version picker, and the questions whose
 * current answer the user wrote (a redraft keeps those by default).
 */
async function versionsOf(
	repo: DashboardRepository,
	userId: string,
	applicationId: string,
) {
	return {
		ownAnswers: ownAnswerQuestions(
			await repo.documentVersions(userId, applicationId, "form_answers"),
		),
		versions: await repo.documentHistory(userId, applicationId),
	};
}

export const pipelineRouter = {
	inbox: {
		counts: protectedProcedure.handler(({ context }) =>
			repoOf(context).countsByState(context.session.user.id),
		),
		list: protectedProcedure
			.input(
				z.object({
					states: z.array(stateSchema).optional(),
					search: z.string().max(200).optional(),
					minScore: z.number().min(0).max(100).optional(),
					companyId: z.string().uuid().optional(),
				}),
			)
			.handler(({ context, input }) =>
				repoOf(context).listApplications(context.session.user.id, input),
			),
	},

	application: {
		get: protectedProcedure
			.input(z.object({ id: z.string().uuid() }))
			.handler(async ({ context, input }) => {
				const detail = await repoOf(context).getApplication(
					context.session.user.id,
					input.id,
				);
				if (!detail) throw new ORPCError("NOT_FOUND");
				const review = detail.review;
				const reviewCurrent =
					review !== null &&
					compareApproval(review.documentHashes, detail.currentHashes).ok;
				const profile = await repoOf(context).getProfile(
					context.session.user.id,
				);
				// Citations the profile no longer holds (a record edited or removed since the check).
				const staleProfile =
					detail.state === "ready_for_review" && reviewCurrent && review.passed
						? staleCitations(
								review.claims,
								profile,
								review.flags ?? [],
								("cited" in review ? review.cited : undefined) ?? [],
							)
						: [];
				const formAnswers = detail.documents.find(
					(d) => d.kind === "form_answers",
				);
				const contact = profile ? parseContact(evidenceProfile(profile)) : null;
				const { postingForm, mode } = await submissionView(
					repoOf(context),
					context.session.user.id,
					input.id,
					{ job: detail.job, companyKey: detail.company.key },
				);
				const form = await whatWillBeSentFor(
					repoOf(context),
					context.session.user.id,
					input.id,
					profile,
				);
				const missingRequired = missingRequiredOf(form, mode);
				const approvable =
					detail.state === "ready_for_review" &&
					!detail.redraft &&
					reviewCurrent &&
					review.passed &&
					review.atsChecked &&
					staleProfile.length === 0 &&
					missingRequired.length === 0;
				const docOf = (kind: string) =>
					detail.documents.find((d) => d.kind === kind)?.content ?? "";
				const flagDocs = {
					cv: docOf("cv"),
					cover_letter: docOf("cover_letter"),
					form_answers: formAnswers
						? parseFormAnswers(formAnswers.content)
						: [],
				};
				// Each flag with where it is in the current text (to mark it) and its reasons in words.
				const flags = (reviewCurrent ? (review.flags ?? []) : []).map((f) => ({
					...f,
					at: locateFlag(flagDocs, f),
					reasons: f.reasons.map((r) => ({
						...r,
						label: ruleLabel(r.rule),
						explanation: ruleExplanation(r.rule),
						fixed: BLOCKING_RULES.includes(r.rule),
					})),
				}));
				// Each Markdown document rendered as the export renders it, flagged lines marked.
				const previewOf = (kind: "cv" | "cover_letter" | "notes") => {
					const text = docOf(kind);
					if (!text) return null;
					return markdownToPreviewHtml(
						text,
						flags.flatMap((f, index) =>
							f.document === kind && f.at && f.at.index === 0
								? [
										{
											id: f.id,
											n: index + 1,
											start: f.at.start,
											end: f.at.end,
											open: f.state === "open",
											title: f.reasons.map((r) => r.label).join(" · "),
										},
									]
								: [],
						),
					);
				};
				const preview = {
					cv: previewOf("cv"),
					cover_letter: previewOf("cover_letter"),
					notes: previewOf("notes"),
				};
				return {
					...detail,
					/** Every saved version of each document, for the version picker. */
					...(await versionsOf(
						repoOf(context),
						context.session.user.id,
						input.id,
					)),
					/** Rendered, sanitized HTML of each Markdown document, for the review pane. */
					preview,
					formAnswers: formAnswers ? parseFormAnswers(formAnswers.content) : [],
					reviewCurrent,
					/** A board label the posting URL contradicts (a seeded job labelled Greenhouse). */
					sourceMismatch: sourceMismatch(detail.job.source, detail.job.url),
					/** The check of the current version stopped on an error: shown with a retry. */
					checkError:
						!reviewCurrent &&
						detail.checkError &&
						compareApproval(detail.checkError.hashes, detail.currentHashes).ok
							? {
									message: detail.checkError.message,
									at: detail.checkError.at,
								}
							: null,
					approvable,
					/** Required fields of "What will be sent" with no value: Approve waits for them. */
					missingRequired,
					/** Cited facts edited or removed since the check: approval waits for Check again. */
					staleProfile,
					/** claims_flagged: the user resolves each flag before approving. */
					draftStatus: reviewCurrent ? (review.status ?? null) : null,
					/**
					 * `marked`: the rendered view shows this flag's mark. False for a CV or letter
					 * line that could not be placed, or whose mark overlaps another flag's.
					 */
					flags: flags.map((f) => ({
						...f,
						marked:
							f.document === "cv" || f.document === "cover_letter"
								? (preview[f.document]?.includes(`href="#flag-${f.id}"`) ??
									false)
								: null,
					})),
					openFlags: flags.filter((f) => f.state === "open").length,
					/** Everything the user needs to submit by hand, ready to copy. */
					handoff: {
						formUrl:
							mode.mode === "handoff"
								? postingForm
								: (detail.attempts.find((a) => a.url)?.url ?? detail.job.url),
						contact,
					},
					/**
					 * "auto": approval fills the form and submits once (unless submissions are paused).
					 * "handoff": after approval the user submits it; nothing is filled automatically.
					 */
					submission: mode,
					/**
					 * The application form as read before review, with each field's exact value
					 * ("What will be sent"), or why it could not be read. Null: never read.
					 */
					form,
					/**
					 * How old the posting is; `mayBeClosed` for LinkedIn, Indeed and Glassdoor
					 * postings past 14 days, which are never re-read to check.
					 */
					postingAge: postingAge(
						{
							source: detail.job.source,
							url: detail.job.url,
							externalId: detail.job.externalId,
							companyKey: detail.company.key,
							publishedAt: detail.job.publishedAt,
							firstSeenAt: detail.job.firstSeenAt,
						},
						new Date(),
					),
				};
			}),
		editDocument: protectedProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					kind: documentKind,
					content: z.string().max(100_000),
					baseVersion: z.number().int().min(0),
				}),
			)
			.handler(({ context, input }) =>
				refusal(async () => {
					const result = await repoOf(context).editDocument({
						userId: context.session.user.id,
						applicationId: input.id,
						kind: input.kind,
						content: input.content,
						baseVersion: input.baseVersion,
					});
					await context.sendEvent(result.event);
					return { version: result.version, revoked: result.revoked };
				}),
			),
		/** Edit or delete one flagged line: a new version, re-checked on that line only. */
		resolveFlag: protectedProcedure
			.input(
				z.discriminatedUnion("action", [
					z.object({
						id: z.string().uuid(),
						flagId: z.string().min(1).max(100),
						action: z.literal("edit"),
						text: z.string().min(1).max(5_000),
					}),
					z.object({
						id: z.string().uuid(),
						flagId: z.string().min(1).max(100),
						action: z.literal("delete"),
					}),
				]),
			)
			.handler(({ context, input }) =>
				refusal(async () => {
					const result = await repoOf(context).resolveFlagByEdit({
						userId: context.session.user.id,
						applicationId: input.id,
						flagId: input.flagId,
						text: input.action === "edit" ? input.text : null,
					});
					await context.sendEvent(result.event);
					return { kind: result.kind, version: result.version };
				}),
			),
		/**
		 * Redraft: a new version of the chosen documents from the current profile and the posting,
		 * with the user's optional instruction as a preference; then the check, back in review.
		 */
		redraft: protectedProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					scope: z.enum(REDRAFT_SCOPES),
					instruction: z.string().max(REDRAFT_INSTRUCTION_MAX).optional(),
					rewriteOwnAnswers: z.boolean().optional(),
				}),
			)
			.handler(({ context, input }) =>
				refusal(async () => {
					const result = await repoOf(context).requestRedraft({
						userId: context.session.user.id,
						applicationId: input.id,
						scope: input.scope,
						instruction: input.instruction,
						rewriteOwnAnswers: input.rewriteOwnAnswers,
					});
					await context.sendEvent(result.event);
					return { revoked: result.revoked };
				}),
			),
		retryRedraft: protectedProcedure
			.input(z.object({ id: z.string().uuid() }))
			.handler(({ context, input }) =>
				refusal(async () => {
					const event = await repoOf(context).retryRedraft({
						userId: context.session.user.id,
						applicationId: input.id,
					});
					await context.sendEvent(event);
					return { ok: true };
				}),
			),
		cancelRedraft: protectedProcedure
			.input(z.object({ id: z.string().uuid() }))
			.handler(({ context, input }) =>
				refusal(() =>
					repoOf(context).cancelRedraft({
						userId: context.session.user.id,
						applicationId: input.id,
					}),
				),
			),
		/** One earlier (or the current) version of a document, read only. */
		documentVersion: protectedProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					kind: documentKind,
					version: z.number().int().min(1),
				}),
			)
			.handler(async ({ context, input }) => {
				const found = await repoOf(context).documentVersion(
					context.session.user.id,
					input.id,
					input.kind,
					input.version,
				);
				if (!found) throw new ORPCError("NOT_FOUND");
				return {
					...found,
					html:
						found.kind === "form_answers"
							? null
							: markdownToPreviewHtml(found.content),
					formAnswers:
						found.kind === "form_answers"
							? parseFormAnswers(found.content || "[]")
							: [],
				};
			}),
		/** The check of the current version kept failing: check the same version again, no redraft. */
		retryCheck: protectedProcedure
			.input(z.object({ id: z.string().uuid() }))
			.handler(({ context, input }) =>
				refusal(async () => {
					const event = await repoOf(context).retryCheck({
						userId: context.session.user.id,
						applicationId: input.id,
					});
					await context.sendEvent(event);
					return { ok: true };
				}),
			),
		/** "This is true": saved to the user's profile with date and source, and the flag closes. */
		confirmFlag: protectedProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					flagId: z.string().min(1).max(100),
				}),
			)
			.handler(({ context, input }) =>
				refusal(async () => {
					const result = await repoOf(context).confirmFlag({
						userId: context.session.user.id,
						applicationId: input.id,
						flagId: input.flagId,
					});
					if (result.event) await context.sendEvent(result.event);
					return { open: result.open };
				}),
			),
		approve: protectedProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					hashes: hashesSchema,
					idempotencyKey: z.string().min(8).max(100),
				}),
			)
			.handler(({ context, input }) =>
				refusal(async () => {
					const userId = context.session.user.id;
					const repo = repoOf(context);
					const detail = await repo.getApplication(userId, input.id);
					if (detail) {
						const { mode } = await submissionView(repo, userId, input.id, {
							job: detail.job,
							companyKey: detail.company.key,
						});
						const missing = missingRequiredOf(
							await whatWillBeSentFor(
								repo,
								userId,
								input.id,
								await repo.getProfile(userId),
							),
							mode,
						);
						if (missing.length > 0)
							throw new ORPCError("CONFLICT", {
								message: `Refusing: required fields would be sent empty: ${missing.map((m) => `"${m}"`).join(", ")}`,
							});
					}
					const event = await repoOf(context).approve({
						userId: context.session.user.id,
						applicationId: input.id,
						approvedHashes: input.hashes,
						idempotencyKey: `approve-${input.idempotencyKey}`,
					});
					await context.sendEvent(event);
					return { ok: true };
				}),
			),
		reject: protectedProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					reason: z.string().max(500),
					idempotencyKey: z.string().min(8).max(100),
				}),
			)
			.handler(({ context, input }) =>
				refusal(async () => {
					const event = await repoOf(context).reject({
						userId: context.session.user.id,
						applicationId: input.id,
						reason: input.reason,
						idempotencyKey: `reject-${input.idempotencyKey}`,
					});
					await context.sendEvent(event);
					return { ok: true };
				}),
			),
	},

	submission: {
		retry: protectedProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					confirmedNotSent: z.boolean(),
					idempotencyKey: z.string().min(8).max(100),
				}),
			)
			.handler(({ context, input }) =>
				refusal(async () => {
					const event = await repoOf(context).retrySubmission({
						userId: context.session.user.id,
						applicationId: input.id,
						confirmedNotSent: input.confirmedNotSent,
						idempotencyKey: `retry-${input.idempotencyKey}`,
					});
					await context.sendEvent(event);
					return { ok: true };
				}),
			),
		markSubmitted: protectedProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					idempotencyKey: z.string().min(8).max(100),
					/** The day it was submitted, YYYY-MM-DD; default today. */
					appliedOn: z
						.string()
						.regex(/^\d{4}-\d{2}-\d{2}$/)
						.optional(),
				}),
			)
			.handler(({ context, input }) =>
				refusal(async () => {
					const event = await repoOf(context).markSubmittedManually({
						userId: context.session.user.id,
						applicationId: input.id,
						idempotencyKey: `manual-${input.idempotencyKey}`,
						appliedOn: input.appliedOn,
					});
					await context.sendEvent(event);
					return { ok: true };
				}),
			),
		readFormAgain: protectedProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					idempotencyKey: z.string().min(8).max(100),
				}),
			)
			.handler(({ context, input }) =>
				refusal(async () => {
					const userId = context.session.user.id;
					const repo = repoOf(context);
					if (!context.readFormAgain)
						throw new ORPCError("NOT_IMPLEMENTED", {
							message:
								"Reading the form needs a browser; none is configured here",
						});
					// Nothing opens while an attempt may have gone through; checked again on save.
					const refused = await repo.readFormAgainRefusal(userId, input.id);
					if (refused) throw new ORPCError("CONFLICT", { message: refused });
					const read = await context.readFormAgain(userId, input.id);
					if (!read.ok)
						throw new ORPCError("CONFLICT", { message: read.reason });
					const result = await repo.readFormAgain({
						userId,
						applicationId: input.id,
						read: read.read,
						add: read.add,
						ask: read.ask,
						idempotencyKey: `form-again-${input.idempotencyKey}`,
					});
					if (result.event) await context.sendEvent(result.event);
					return {
						asked: result.asked,
						fields: read.read.schema.fields.length,
					};
				}),
			),
		dryRun: protectedProcedure
			.input(z.object({ id: z.string().uuid() }))
			.handler(({ context, input }) =>
				refusal(async () => {
					if (!context.dryRun)
						throw new ORPCError("NOT_IMPLEMENTED", {
							message: "Dry runs need a browser; none is configured here",
						});
					return context.dryRun(context.session.user.id, input.id);
				}),
			),
		settings: protectedProcedure.handler(async ({ context }) => ({
			paused: await repoOf(context).submissionsPaused(context.session.user.id),
			/** Per board, fixed in code (apply/modes.ts). */
			modes: Object.entries(BOARD_SUBMISSION_MODES).map(([board, m]) => ({
				board,
				mode: m.mode,
				why: m.why,
			})),
		})),
		setPaused: protectedProcedure
			.input(z.object({ paused: z.boolean() }))
			.handler(async ({ context, input }) => {
				const result = await repoOf(context).setSubmissionsPaused(
					context.session.user.id,
					input.paused,
				);
				for (const event of result.events) await context.sendEvent(event);
				return { paused: result.paused, woken: result.events.length };
			}),
		applied: protectedProcedure.handler(({ context }) =>
			repoOf(context).listApplied(context.session.user.id),
		),
	},

	questions: {
		list: protectedProcedure
			.input(z.object({ status: z.enum(["open", "answered"]).optional() }))
			.handler(({ context, input }) =>
				repoOf(context).listQuestions(context.session.user.id, input.status),
			),
		answer: protectedProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					answer: z.string().min(1).max(5_000),
				}),
			)
			.handler(({ context, input }) =>
				refusal(async () => {
					const result = await repoOf(context).answerQuestion({
						userId: context.session.user.id,
						questionId: input.id,
						answer: input.answer,
					});
					if (result.event) await context.sendEvent(result.event);
					return {
						applicationId: result.applicationId,
						resumed: Boolean(result.event),
						next: result.next ?? null,
					};
				}),
			),
		facts: protectedProcedure.handler(({ context }) =>
			repoOf(context).listFacts(context.session.user.id),
		),
	},

	rejected: {
		list: protectedProcedure.handler(({ context }) =>
			repoOf(context).listRejected(context.session.user.id),
		),
	},

	settings: {
		get: protectedProcedure.handler(({ context }) =>
			repoOf(context).getFilterSettings(context.session.user.id),
		),
		update: protectedProcedure
			.input(filterSettingsSchema.partial())
			.handler(async ({ context, input }) => {
				const repo = repoOf(context);
				const current = await repo.getFilterSettings(context.session.user.id);
				const next = filterSettingsSchema.parse({ ...current, ...input });
				await saveFilterSettings(context.db, context.session.user.id, next);
				return next;
			}),
	},

	models: {
		/**
		 * Each role's provider and how it is paid for. Subscription logins are the owner's own:
		 * only the configured local owner account sees their state.
		 */
		status: protectedProcedure.handler(async ({ context }) => {
			if (!context.llmStatus) return null;
			const status = await context.llmStatus();
			const owner = status.subscriptionUserId === context.session.user.id;
			const store = new DrizzleSpendStore(context.db);
			return {
				...status,
				owner,
				/** This account's confirmation that extra usage is off on its Claude account. */
				extraUsageOffConfirmedAt: await store.extraUsageOffConfirmedAt(
					context.session.user.id,
				),
				/** This account's subscription model calls over the last 24 hours, and its budget. */
				callBudget: await store.subscriptionBudget(context.session.user.id),
				ownerConfigured: status.subscriptionUserId !== null,
				subscriptionUserId: owner ? status.subscriptionUserId : null,
				claudeConfigDir: owner ? status.claudeConfigDir : null,
				removedEnv: owner ? status.removedEnv : [],
				roles: status.roles.map((role) => ({
					...role,
					login:
						role.login && !owner
							? {
									state: "refused" as const,
									detail:
										"This subscription belongs to another account; it never answers for yours.",
								}
							: role.login,
				})),
			};
		}),
		/**
		 * Confirms (or withdraws) that paid extra usage is off on this account's Claude plan.
		 * Subscription calls are refused without it; a call that draws on extra usage clears it.
		 */
		confirmExtraUsageOff: protectedProcedure
			.input(z.object({ confirmed: z.boolean() }))
			.handler(async ({ context, input }) => {
				const store = new DrizzleSpendStore(context.db);
				await store.confirmExtraUsageOff(
					context.session.user.id,
					input.confirmed,
				);
				return {
					extraUsageOffConfirmedAt: await store.extraUsageOffConfirmedAt(
						context.session.user.id,
					),
				};
			}),
		/**
		 * The plan's protection: model calls the subscription may make in any rolling 24 hours
		 * (null: the default). New scoring and preparation wait while it is used up.
		 */
		setCallBudget: protectedProcedure
			.input(
				z.object({
					dailyCalls: z
						.number()
						.int()
						.min(0)
						.max(MAX_SUBSCRIPTION_DAILY_CALLS)
						.nullable(),
				}),
			)
			.handler(async ({ context, input }) => {
				const store = new DrizzleSpendStore(context.db);
				await store.setSubscriptionDailyCalls(
					context.session.user.id,
					input.dailyCalls,
				);
				return store.subscriptionBudget(context.session.user.id);
			}),
	},

	spending: {
		/** The monthly cap and this month's estimated spend. */
		get: protectedProcedure.handler(({ context }) =>
			repoOf(context).spending(context.session.user.id),
		),
		set: protectedProcedure
			.input(
				z.object({
					enabled: z.boolean(),
					// monthly_cap_micros is a 32-bit integer: at most about $2,147.
					monthlyUsd: z.number().min(0).max(2_000),
				}),
			)
			.handler(({ context, input }) =>
				refusal(async () => {
					const { events } = await repoOf(context).setSpendingCap(
						context.session.user.id,
						{
							enabled: input.enabled,
							monthlyCapMicros: Math.round(input.monthlyUsd * 1_000_000),
						},
					);
					for (const event of events) await context.sendEvent(event);
					return { woken: events.length };
				}),
			),
	},

	profile: {
		/** The saved profile files, or null before onboarding. */
		get: protectedProcedure.handler(({ context }) =>
			repoOf(context).profileFiles(context.session.user.id),
		),
		/** Text of an uploaded PDF resume (base64, at most 5 MB). */
		pdfText: protectedProcedure
			.input(z.object({ base64: z.string().max(7_000_000) }))
			.handler(async ({ input }) => {
				const bytes = Uint8Array.from(Buffer.from(input.base64, "base64"));
				if (bytes.byteLength > 5_000_000)
					throw new ORPCError("BAD_REQUEST", { message: "PDF over 5 MB" });
				try {
					return { text: await pdfText(bytes) };
				} catch {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Could not read text from that PDF; paste the text instead.",
					});
				}
			}),
		/**
		 * Draft records from pasted resume or notes text. Nothing is saved: the user reviews the
		 * draft, then saves it.
		 */
		structure: protectedProcedure
			.input(z.object({ text: z.string().trim().min(20).max(100_000) }))
			.handler(async ({ context, input }) => {
				if (!context.structureProfile)
					throw new ORPCError("NOT_IMPLEMENTED", {
						message: "No model is configured here to structure a resume",
					});
				try {
					const structured = await context.structureProfile(
						context.session.user.id,
						normalizeLineEndings(input.text),
					);
					return { records: recordsFromStructured(structured, "your resume") };
				} catch (error) {
					if (error instanceof LlmPausedError)
						throw new ORPCError("CONFLICT", { message: error.message });
					throw error;
				}
			}),
		facts: {
			add: protectedProcedure
				.input(
					z.object({
						question: z.string().trim().min(3).max(500),
						answer: z.string().trim().min(1).max(5_000),
					}),
				)
				.handler(({ context, input }) =>
					repoOf(context).addFact(context.session.user.id, input),
				),
			update: protectedProcedure
				.input(
					z.object({
						id: z.string().uuid(),
						question: z.string().trim().min(3).max(500),
						answer: z.string().trim().min(1).max(5_000),
					}),
				)
				.handler(async ({ context, input }) => {
					const row = await repoOf(context).updateFact(
						context.session.user.id,
						input,
					);
					if (!row) throw new ORPCError("NOT_FOUND");
					return row;
				}),
			remove: protectedProcedure
				.input(z.object({ id: z.string().uuid() }))
				.handler(async ({ context, input }) => {
					if (
						!(await repoOf(context).removeFact(
							context.session.user.id,
							input.id,
						))
					)
						throw new ORPCError("NOT_FOUND");
					return { removed: true };
				}),
		},
	},

	linkedin: {
		/** LinkedIn's stop, pages used in the last 24 hours and recent reads. */
		status: protectedProcedure.handler(({ context }) =>
			new DrizzleLinkedInStore(context.db).status(context.session.user.id),
		),
	},
};
