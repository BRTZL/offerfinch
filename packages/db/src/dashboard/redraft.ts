import { compareApproval } from "@offerfinch/core/domain/approval";
import type { StoredDocumentKind } from "@offerfinch/core/pipeline/ports";
import {
	cleanInstruction,
	type RedraftRequest,
	type RedraftScope,
	redraftDocumentsOf,
} from "@offerfinch/core/tailor/redraft";
import { and, asc, eq, inArray } from "drizzle-orm";
import { latestVersionOf } from "../repository/redraft";
import { applications, documents, jobs } from "../schema/pipeline";
import type { DashboardRepositoryContext } from "./context";
import type { PendingEvent } from "./shared";

const SCOPE_NOUN: Record<RedraftScope, string> = {
	cv: "CV",
	cover_letter: "letter",
	form_answers: "answers",
	all: "CV, letter and answers",
};

/** Why a redraft cannot start in this state, in words; null when it can. */
function refusalFor(state: string): string | null {
	if (state === "ready_for_review" || state === "approved") return null;
	if (state === "preparing" || state === "needs_answers")
		return "Refusing: drafting is still running; redraft once the documents are in review";
	if (state === "applied")
		return "Refusing: you marked this application submitted, so its documents stay as sent";
	if (state === "applying" || state === "needs_human")
		return "Refusing: this application is being submitted, so its documents stay as approved";
	return `Refusing: only a prepared application in review or approved can be redrafted (it is ${state.replaceAll("_", " ")})`;
}

/**
 * Redraft on a prepared application (core `tailor/redraft.ts`): the user's request, its retry and
 * its cancel. Each commits with its workflow event; the workflow writes the new version in review.
 */
export const redraftMethods = {
	/**
	 * Records a redraft of the chosen documents with the user's optional instruction. Refused
	 * while drafting or the check runs, once submitted, for a closed posting, and while another
	 * redraft runs. An approved application goes back to review in the same transaction and its
	 * approval is revoked: approval binds to exact documents.
	 */
	async requestRedraft(input: {
		userId: string;
		applicationId: string;
		scope: RedraftScope;
		instruction?: string | null;
		rewriteOwnAnswers?: boolean;
	}): Promise<{ event: PendingEvent; revoked: boolean; requestId: string }> {
		return this.database.transaction(async (tx) => {
			const app = await this.lockOwned(tx, input.userId, input.applicationId);
			const refused = refusalFor(app.state);
			if (refused) throw new Error(refused);
			const [row] = await tx
				.select({
					redraft: applications.redraft,
					checkError: applications.checkError,
					closedAt: jobs.closedAt,
					closedReason: jobs.closedReason,
				})
				.from(applications)
				.innerJoin(jobs, eq(jobs.id, applications.jobId))
				.where(eq(applications.id, input.applicationId));
			if (row?.closedAt)
				throw new Error(
					`Refusing: this posting looks closed (${row.closedReason ?? "found closed"}), so Redraft is off. If it is still open, choose It's still open.`,
				);
			if (row?.redraft && !row.redraft.problem)
				throw new Error(
					"Refusing: a redraft is already running; wait for its new version or cancel it",
				);
			if (app.state === "ready_for_review") {
				const current = await this.currentHashes(
					tx,
					input.userId,
					input.applicationId,
				);
				const review = await this.latestReview(
					input.userId,
					input.applicationId,
					tx,
				);
				const checked =
					review !== null &&
					compareApproval(review.documentHashes, current).ok &&
					(review.atsChecked || !review.passed);
				const stopped =
					row?.checkError && compareApproval(row.checkError.hashes, current).ok;
				if (!checked && !stopped)
					throw new Error(
						"Refusing: the check of the current version is still running; redraft when it finishes",
					);
			}
			const baseVersions: RedraftRequest["baseVersions"] = {};
			for (const kind of redraftDocumentsOf(input.scope))
				baseVersions[kind] = await latestVersionOf(
					tx,
					input.applicationId,
					kind,
				);
			if (
				!baseVersions.cv &&
				!baseVersions.cover_letter &&
				input.scope !== "form_answers"
			)
				throw new Error("Refusing: nothing drafted to redraft yet");
			const request: RedraftRequest = {
				id: crypto.randomUUID(),
				scope: input.scope,
				instruction: cleanInstruction(input.instruction),
				rewriteOwnAnswers: input.rewriteOwnAnswers === true,
				baseVersions,
				requestedAt: new Date().toISOString(),
			};
			let revoked = false;
			if (app.state === "approved")
				revoked = await this.move(
					input.userId,
					input.applicationId,
					["approved"],
					"ready_for_review",
					`Redraft of the ${SCOPE_NOUN[input.scope]} requested; approval withdrawn`,
					"user",
					{},
					tx,
				);
			await tx
				.update(applications)
				.set({ redraft: request })
				.where(eq(applications.id, input.applicationId));
			const event = await this.addEvent(
				tx,
				input.userId,
				input.applicationId,
				`redraft-${request.id}`,
				{ action: "redraft", scope: input.scope },
			);
			return { event, revoked, requestId: request.id };
		});
	},

	/** Runs a paused or failed redraft again; keyed by its problem, so a double click runs it once. */
	async retryRedraft(input: {
		userId: string;
		applicationId: string;
	}): Promise<PendingEvent> {
		return this.database.transaction(async (tx) => {
			const app = await this.lockOwned(tx, input.userId, input.applicationId);
			const [row] = await tx
				.select({ redraft: applications.redraft })
				.from(applications)
				.where(eq(applications.id, input.applicationId));
			const request = row?.redraft;
			if (!request?.problem || app.state !== "ready_for_review")
				throw new Error("Refusing: no stopped redraft to try again");
			if (request.problem.kind === "conflict")
				throw new Error(
					"Refusing: the documents changed since this redraft was asked for; cancel it and redraft again",
				);
			const { problem, ...rest } = request;
			await tx
				.update(applications)
				.set({ redraft: rest })
				.where(eq(applications.id, input.applicationId));
			return this.addEvent(
				tx,
				input.userId,
				input.applicationId,
				`redraft-retry-${request.id}-${problem.at}`,
				{ action: "redraft_retry" },
			);
		});
	},

	/** Drops the pending redraft; the documents stay as they are. A no-op when none is pending. */
	async cancelRedraft(input: {
		userId: string;
		applicationId: string;
	}): Promise<{ cancelled: boolean }> {
		return this.database.transaction(async (tx) => {
			await this.lockOwned(tx, input.userId, input.applicationId);
			const [row] = await tx
				.select({ redraft: applications.redraft })
				.from(applications)
				.where(eq(applications.id, input.applicationId));
			if (!row?.redraft) return { cancelled: false };
			await tx
				.update(applications)
				.set({ redraft: null })
				.where(eq(applications.id, input.applicationId));
			return { cancelled: true };
		});
	},

	/** Every saved version of the application's documents, oldest first, without their text. */
	async documentHistory(userId: string, applicationId: string) {
		const rows = await this.database
			.select({
				kind: documents.kind,
				version: documents.version,
				createdBy: documents.createdBy,
				createdAt: documents.createdAt,
				meta: documents.meta,
			})
			.from(documents)
			.where(
				and(
					eq(documents.applicationId, applicationId),
					eq(documents.userId, userId),
					inArray(documents.format, ["markdown", "json"]),
				),
			)
			.orderBy(asc(documents.kind), asc(documents.version));
		return rows.map(({ meta, ...r }) => ({ ...r, redraft: redraftOf(meta) }));
	},

	/** One saved version of one document, for the version picker; null when not the user's. */
	async documentVersion(
		userId: string,
		applicationId: string,
		kind: StoredDocumentKind,
		version: number,
	) {
		const [row] = await this.database
			.select({
				kind: documents.kind,
				version: documents.version,
				content: documents.content,
				createdBy: documents.createdBy,
				createdAt: documents.createdAt,
				meta: documents.meta,
			})
			.from(documents)
			.where(
				and(
					eq(documents.applicationId, applicationId),
					eq(documents.userId, userId),
					eq(documents.kind, kind),
					eq(documents.version, version),
					inArray(documents.format, ["markdown", "json"]),
				),
			);
		if (!row) return null;
		const { meta, ...rest } = row;
		return { ...rest, content: rest.content ?? "", redraft: redraftOf(meta) };
	},
} satisfies Record<string, unknown> & ThisType<DashboardRepositoryContext>;

/** What a version's `meta` says about the redraft that wrote it. */
function redraftOf(
	meta: Record<string, unknown> | null,
): { scope: RedraftScope; instruction: string | null } | null {
	const r = meta?.redraft as
		| { scope?: RedraftScope; instruction?: string | null }
		| undefined;
	return r?.scope
		? { scope: r.scope, instruction: r.instruction ?? null }
		: null;
}
