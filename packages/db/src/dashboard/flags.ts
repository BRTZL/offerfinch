import type { DocumentHashes } from "@offerfinch/core/domain/approval";
import { compareApproval } from "@offerfinch/core/domain/approval";
import {
	type CheckedClaim,
	type ClaimsInput,
	clearedFlags,
} from "@offerfinch/core/tailor/claims";
import {
	BLOCKING_RULES,
	changeFlaggedLine,
} from "@offerfinch/core/tailor/flags";
import {
	CONFIRMATION_SOURCE,
	checkDocumentRules,
	confirmationQuestion,
	confirmedRole,
	evidenceProfile,
	ruleSet,
} from "@offerfinch/core/tailor/profile-rules";
import { staleCitations } from "@offerfinch/core/tailor/stale";
import {
	formAnswersText,
	parseFormAnswers,
} from "@offerfinch/core/tailor/tailor";
import { and, eq } from "drizzle-orm";
import type { Tx } from "../repository";
import {
	applications,
	companies,
	jobs,
	profileFacts,
	reviewChecks,
} from "../schema/pipeline";
import type { DashboardRepositoryContext } from "./context";
import type { PendingEvent } from "./shared";
export const flagsMethods = {
	/**
	 * The open flag `flagId` of the review of the current documents, under the application lock.
	 * Refused unless the application is in review and the review is of these exact documents.
	 */
	async lockFlag(
		tx: Tx,
		userId: string,
		applicationId: string,
		flagId: string,
	) {
		const app = await this.lockOwned(tx, userId, applicationId);
		if (app.state !== "ready_for_review")
			throw new Error(
				`Flags can be resolved in review, not while ${app.state}`,
			);
		const review = await this.latestReview(userId, applicationId, tx);
		const current = await this.currentHashes(tx, userId, applicationId);
		if (!review || !compareApproval(review.documentHashes, current).ok)
			throw new Error(
				"Refusing: the documents changed since this check; wait for the check of the new version",
			);
		const flag = (review.flags ?? []).find((f) => f.id === flagId);
		if (!flag) throw new Error(`Flag ${flagId} not found on the current check`);
		if (flag.state !== "open")
			throw new Error("Refusing: this flag is already confirmed");
		return { review, flag };
	},

	/**
	 * Replaces (text) or deletes (null) one flagged line, saved as a new version by the user. The
	 * workflow then runs the fixed rules on the whole documents and the claims check on the changed
	 * line only; nothing is re-tailored.
	 */
	async resolveFlagByEdit(input: {
		userId: string;
		applicationId: string;
		flagId: string;
		text: string | null;
	}): Promise<{ kind: string; version: number; event: PendingEvent }> {
		return this.database.transaction(async (tx) => {
			const { flag } = await this.lockFlag(
				tx,
				input.userId,
				input.applicationId,
				input.flagId,
			);
			const docs = Object.fromEntries(
				(await this.latestDocuments(input.userId, input.applicationId, tx)).map(
					(d) => [d.kind, d.content],
				),
			);
			const changed = changeFlaggedLine(
				{
					cv: docs.cv ?? "",
					cover_letter: docs.cover_letter ?? "",
					form_answers: parseFormAnswers(docs.form_answers ?? "[]"),
				},
				flag,
				input.text,
			);
			const version = await this.insertVersion(
				tx,
				input.userId,
				input.applicationId,
				changed.kind,
				changed.kind === "form_answers" ? "json" : "markdown",
				changed.content,
				"user",
			);
			const event = await this.addEvent(
				tx,
				input.userId,
				input.applicationId,
				`edit-${input.applicationId}-${changed.kind}-${version}`,
				{ kind: changed.kind, version, flag: input.flagId },
			);
			return { kind: changed.kind, version, event };
		});
	},

	/**
	 * Retries the check of the current version after it kept failing (or met the cap): the error
	 * is cleared and the workflow checks the same version again. No redraft; approval still needs
	 * a passed review. Keyed by the error, so a double click retries once.
	 */
	async retryCheck(input: {
		userId: string;
		applicationId: string;
	}): Promise<PendingEvent> {
		return this.database.transaction(async (tx) => {
			const app = await this.lockOwned(tx, input.userId, input.applicationId);
			if (app.state !== "ready_for_review")
				throw new Error(
					`Refusing: a check can be retried in review, not while ${app.state}`,
				);
			const [row] = await tx
				.select({ checkError: applications.checkError })
				.from(applications)
				.where(
					and(
						eq(applications.id, input.applicationId),
						eq(applications.userId, input.userId),
					),
				);
			const error = row?.checkError ?? null;
			const current = await this.currentHashes(
				tx,
				input.userId,
				input.applicationId,
			);
			if (!error || !compareApproval(error.hashes, current).ok) {
				// A passed check whose citations the profile no longer holds is checked again too.
				const review = await this.latestReview(
					input.userId,
					input.applicationId,
					tx,
				);
				const stale =
					review?.passed === true &&
					compareApproval(review.documentHashes, current).ok &&
					staleCitations(
						review.claims,
						await this.getProfile(input.userId, tx),
						review.flags ?? [],
						review.cited ?? [],
					).length > 0;
				if (!review || !stale)
					throw new Error(
						"Refusing: no check error for the current version; the check is running or done",
					);
				return this.addEvent(
					tx,
					input.userId,
					input.applicationId,
					`recheck-profile-${input.applicationId}-${review.id}`,
					{ action: "retry_check" },
				);
			}
			await tx
				.update(applications)
				.set({ checkError: null })
				.where(
					and(
						eq(applications.id, input.applicationId),
						eq(applications.userId, input.userId),
					),
				);
			return this.addEvent(
				tx,
				input.userId,
				input.applicationId,
				`retry-check-${input.applicationId}-${error.at}`,
				{ action: "retry_check" },
			);
		});
	},

	/**
	 * Flags an older check raised that the current claims check clears on the same stored claims,
	 * with no model call (`clearedFlags`). Run at startup, so a fix to the check reaches the
	 * applications already in review. Only the latest review of an unchanged version in review,
	 * only flags whose every reason is a line check, and flags are only removed, never added. When
	 * none is left open the review passes its claims part, as when the user confirms the last flag,
	 * and the workflow exports and runs the ATS check.
	 */
	async clearStaleFlags(
		userId: string,
	): Promise<{ cleared: number; events: PendingEvent[] }> {
		const profile = await this.getProfile(userId);
		if (!profile) return { cleared: 0, events: [] };
		const rows = await this.database
			.select({
				id: applications.id,
				title: jobs.title,
				company: companies.name,
				posting: jobs.descriptionText,
			})
			.from(applications)
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.innerJoin(companies, eq(companies.id, jobs.companyId))
			.where(
				and(
					eq(applications.userId, userId),
					eq(applications.state, "ready_for_review"),
				),
			);
		let cleared = 0;
		const events: PendingEvent[] = [];
		for (const row of rows) {
			const event = await this.database.transaction(async (tx) => {
				const app = await this.lockOwned(tx, userId, row.id);
				if (app.state !== "ready_for_review") return null;
				const review = await this.latestReview(userId, row.id, tx);
				if (review?.status !== "claims_flagged") return null;
				const current = await this.currentHashes(tx, userId, row.id);
				if (!compareApproval(review.documentHashes, current).ok) return null;
				const docs = Object.fromEntries(
					(await this.latestDocuments(userId, row.id, tx)).map((d) => [
						d.kind,
						d.content,
					]),
				);
				const formAnswers = parseFormAnswers(docs.form_answers ?? "[]");
				const input: ClaimsInput = {
					documents: {
						cv: docs.cv ?? "",
						cover_letter: docs.cover_letter ?? "",
						form_answers: formAnswersText(formAnswers),
					},
					formAnswers,
					profile,
					context: { companyName: row.company, jobTitle: row.title },
					postingText: row.posting,
				};
				const all = review.flags ?? [];
				const gone = clearedFlags(all, review.claims as CheckedClaim[], input);
				if (gone.length === 0) return null;
				cleared += gone.length;
				const flags = all.filter((f) => !gone.includes(f));
				// The issue each cleared flag came from goes with it.
				const issues = review.issues.filter(
					(i) =>
						i.rule !== "unchecked_line" ||
						!gone.some(
							(f) =>
								f.document === i.document &&
								i.lines?.[0] === f.text &&
								(i.at?.[0]?.context ?? undefined) === f.context &&
								(i.at?.[0]?.occurrence ?? undefined) === f.occurrence,
						),
				);
				const open = flags.filter((f) => f.state === "open").length;
				// Passes only when nothing else blocks: a fixed-rule issue (length, placeholder, ...)
				// with no flag of its own keeps the review where it is.
				const passes =
					open === 0 && !issues.some((i) => BLOCKING_RULES.includes(i.rule));
				await tx
					.update(reviewChecks)
					.set({
						flags,
						issues,
						...(passes ? { passed: true, status: "passed" as const } : {}),
					})
					.where(
						and(
							eq(reviewChecks.id, review.id),
							eq(reviewChecks.userId, userId),
						),
					);
				return passes
					? this.addEvent(tx, userId, row.id, `flags-cleared-${review.id}`, {
							action: "flags_cleared",
						})
					: null;
			});
			if (event) events.push(event);
		}
		return { cleared, events };
	},

	/**
	 * The user confirms a flagged line is true. The exact text is saved to their profile store with
	 * the date and source "user confirmation" (read back as answers.md, evidence from then on), and
	 * the flag is closed. A line that breaks a fixed rule cannot be confirmed. When no flag is left
	 * open the review passes its claims part and the workflow exports and runs the ATS check.
	 */
	async confirmFlag(input: {
		userId: string;
		applicationId: string;
		flagId: string;
	}): Promise<{ open: number; factId: string; event: PendingEvent | null }> {
		return this.database.transaction(async (tx) => {
			const { review, flag } = await this.lockFlag(
				tx,
				input.userId,
				input.applicationId,
				input.flagId,
			);
			// The fixed rules run again on the line itself, whatever the flag says.
			const profile = await this.getProfile(input.userId, tx);
			const [names] = await tx
				.select({ title: jobs.title, company: companies.name })
				.from(applications)
				.innerJoin(jobs, eq(jobs.id, applications.jobId))
				.innerJoin(companies, eq(companies.id, jobs.companyId))
				.where(
					and(
						eq(applications.id, input.applicationId),
						eq(applications.userId, input.userId),
					),
				);
			const broken = flag.text
				? checkDocumentRules(
						"cv",
						flag.text,
						ruleSet(evidenceProfile(profile ?? { files: [] })),
						{
							companyName: names?.company ?? "",
							jobTitle: names?.title ?? "",
						},
					).filter(
						(i) => BLOCKING_RULES.includes(i.rule) && i.rule !== "length",
					)
				: [];
			if (!flag.confirmable || !flag.text || broken.length > 0) {
				const fixed = [
					...flag.reasons
						.filter((r) => BLOCKING_RULES.includes(r.rule))
						.map((r) => r.message),
					...broken.map((i) => i.message),
				].filter((m, i, all) => all.indexOf(m) === i);
				throw new Error(
					`Refusing to confirm: ${fixed.length > 0 ? `this line breaks a fixed rule (${fixed.join(" ")})` : "this flag is about the whole document"}. Edit or delete it instead.`,
				);
			}
			const now = new Date();
			const [fact] = await tx
				.insert(profileFacts)
				.values({
					userId: input.userId,
					applicationId: input.applicationId,
					// For the Profile page; answers.md shows only the text, source and date.
					question: confirmationQuestion({
						document: flag.document,
						role: confirmedRole(flag),
						company: names?.company ?? "?",
						title: names?.title ?? "?",
					}),
					answer: flag.text,
					source: CONFIRMATION_SOURCE,
					questionSource: "confirmation",
					answeredAt: now,
				})
				.returning({ id: profileFacts.id });
			if (!fact) throw new Error("confirmation insert returned nothing");
			const flags = (review.flags ?? []).map((f) =>
				f.id === flag.id
					? {
							...f,
							state: "confirmed" as const,
							confirmedAt: now.toISOString().slice(0, 10),
						}
					: f,
			);
			const open = flags.filter((f) => f.state === "open").length;
			await tx
				.update(reviewChecks)
				.set({
					flags,
					...(open === 0 ? { passed: true, status: "passed" as const } : {}),
				})
				.where(
					and(
						eq(reviewChecks.id, review.id),
						eq(reviewChecks.userId, input.userId),
					),
				);
			const event =
				open === 0
					? await this.addEvent(
							tx,
							input.userId,
							input.applicationId,
							`flags-cleared-${review.id}`,
							{ action: "flags_cleared" },
						)
					: null;
			return { open, factId: fact.id, event };
		});
	},

	async approve(input: {
		userId: string;
		applicationId: string;
		approvedHashes: DocumentHashes;
		idempotencyKey: string;
	}): Promise<PendingEvent> {
		const result = await this.recordUserAction({
			userId: input.userId,
			applicationId: input.applicationId,
			idempotencyKey: input.idempotencyKey,
			transition: {
				from: ["ready_for_review"],
				to: "approved",
				reason: "Approved in the dashboard",
			},
			approvedHashes: input.approvedHashes,
			payload: { action: "approve" },
		});
		return {
			userId: input.userId,
			eventId: result.eventId,
			instanceId: result.instanceId,
		};
	},

	async reject(input: {
		userId: string;
		applicationId: string;
		reason: string;
		idempotencyKey: string;
	}): Promise<PendingEvent> {
		const result = await this.recordUserAction({
			userId: input.userId,
			applicationId: input.applicationId,
			idempotencyKey: input.idempotencyKey,
			transition: {
				from: ["ready_for_review"],
				to: "rejected",
				reason: input.reason.trim() || "Rejected in the dashboard",
			},
			payload: { action: "reject" },
		});
		return {
			userId: input.userId,
			eventId: result.eventId,
			instanceId: result.instanceId,
		};
	},
} satisfies Record<string, unknown> & ThisType<DashboardRepositoryContext>;
