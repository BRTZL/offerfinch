import { applyUrl, BOARDS, type Board } from "@offerfinch/core/apply/forms";
import {
	BOARD_SUBMISSION_MODES,
	submissionModeForSource,
} from "@offerfinch/core/apply/modes";
import { compareApproval } from "@offerfinch/core/domain/approval";
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
				const approvable =
					detail.state === "ready_for_review" &&
					reviewCurrent &&
					review.passed &&
					review.atsChecked &&
					staleProfile.length === 0;
				const formAnswers = detail.documents.find(
					(d) => d.kind === "form_answers",
				);
				const contact = profile ? parseContact(evidenceProfile(profile)) : null;
				const board = (BOARDS as readonly string[]).includes(detail.job.source)
					? (detail.job.source as Board)
					: null;
				// The posting's own apply form on the real board (the board, not a fixture, decides).
				// LinkedIn: the employer's own apply link when the listing showed one, else the posting.
				const postingForm = board
					? applyUrl(board, {
							url: detail.job.url,
							externalId: detail.job.externalId,
							companyKey: detail.company.key,
						})
					: (detail.job.applyUrl ?? detail.job.url);
				const mode = submissionModeForSource(
					detail.job.source,
					board,
					postingForm,
				);
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
					/** "handoff": after approval the user submits it; nothing is filled automatically. */
					submission: mode,
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
						input.text,
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
