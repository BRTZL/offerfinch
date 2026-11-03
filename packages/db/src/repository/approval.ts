import {
	type ApprovalVerdict,
	compareApproval,
	type DocumentHashes,
	hashDocuments,
	SUBMITTED_DOCUMENT_KINDS,
} from "@offerfinch/core/domain/approval";
import type { StoredReview } from "@offerfinch/core/pipeline/ports";
import type { ReviewFlag, ReviewStatus } from "@offerfinch/core/tailor/flags";
import type { RuleIssue } from "@offerfinch/core/tailor/profile-rules";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
	applications,
	approvals,
	companies,
	documents,
	jobs,
	reviewChecks,
} from "../schema/pipeline";
import type { DrizzlePipelineRepositoryContext } from "./context";
import { firstPer, type Tx } from "./shared";
export const approvalMethods = {
	/** Hashes of the latest markdown version of each submitted document. */
	async currentHashes(
		t: Tx | Database,
		userId: string,
		applicationId: string,
	): Promise<DocumentHashes> {
		const all = await t
			.select({
				kind: documents.kind,
				content: documents.content,
			})
			.from(documents)
			.where(
				and(
					eq(documents.applicationId, applicationId),
					eq(documents.userId, userId),
					inArray(documents.format, ["markdown", "json"]),
					inArray(documents.kind, [...SUBMITTED_DOCUMENT_KINDS]),
				),
			)
			.orderBy(documents.kind, desc(documents.version));
		const rows = firstPer(all, (r) => r.kind);
		const [posting] = await t
			.select({
				title: jobs.title,
				description: jobs.descriptionText,
				company: companies.name,
			})
			.from(applications)
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.innerJoin(companies, eq(companies.id, jobs.companyId))
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
				),
			);
		return hashDocuments(
			rows.map((r) => ({ kind: r.kind, content: r.content ?? "" })),
			posting,
		);
	},

	async approvalVerdict(
		t: Tx | Database,
		userId: string,
		applicationId: string,
	): Promise<ApprovalVerdict> {
		const [approval] = await t
			.select({ hashes: approvals.documentHashes })
			.from(approvals)
			.where(
				and(
					eq(approvals.applicationId, applicationId),
					eq(approvals.userId, userId),
					isNull(approvals.revokedAt),
				),
			);
		return compareApproval(
			approval?.hashes ?? null,
			await this.currentHashes(t, userId, applicationId),
		);
	},

	async recordReview(
		userId: string,
		applicationId: string,
		review: Omit<StoredReview, "id" | "atsChecked" | "createdAt">,
	): Promise<string> {
		const [row] = await this.db
			.insert(reviewChecks)
			.values({
				userId,
				applicationId,
				documentHashes: review.documentHashes,
				provider: review.provider,
				passed: review.passed,
				issues: review.issues,
				claims: review.claims,
				status: review.status ?? (review.passed ? "passed" : "failed"),
				flags: review.flags ?? [],
				segments: review.segments ?? [],
				cited: review.cited ?? [],
			})
			.returning({ id: reviewChecks.id });
		if (!row) throw new Error("review insert returned nothing");
		return row.id;
	},

	async completeReview(
		userId: string,
		reviewId: string,
		atsIssues: RuleIssue[],
		options: { flags?: ReviewFlag[]; failedStatus?: ReviewStatus } = {},
	): Promise<boolean> {
		return this.db.transaction(async (tx) => {
			const [row] = await tx
				.select({ issues: reviewChecks.issues, passed: reviewChecks.passed })
				.from(reviewChecks)
				.where(
					and(eq(reviewChecks.id, reviewId), eq(reviewChecks.userId, userId)),
				);
			if (!row) return false;
			const passed = row.passed && atsIssues.length === 0;
			await tx
				.update(reviewChecks)
				.set({
					issues: [...row.issues, ...atsIssues],
					passed,
					atsCheckedAt: new Date(),
					status: passed ? "passed" : (options.failedStatus ?? "failed"),
					...(options.flags ? { flags: options.flags } : {}),
				})
				.where(eq(reviewChecks.id, reviewId));
			return passed;
		});
	},

	async flagReview(
		userId: string,
		reviewId: string,
		flags: ReviewFlag[],
	): Promise<void> {
		await this.db
			.update(reviewChecks)
			.set({ status: "claims_flagged", flags })
			.where(
				and(eq(reviewChecks.id, reviewId), eq(reviewChecks.userId, userId)),
			);
	},

	async latestReview(
		this: DrizzlePipelineRepositoryContext,
		userId: string,
		applicationId: string,
		t: Tx | Database = this.db,
	): Promise<StoredReview | null> {
		const [row] = await t
			.select()
			.from(reviewChecks)
			.where(
				and(
					eq(reviewChecks.applicationId, applicationId),
					eq(reviewChecks.userId, userId),
				),
			)
			.orderBy(desc(reviewChecks.createdAt), desc(sql`${reviewChecks}.rowid`))
			.limit(1);
		return row
			? {
					id: row.id,
					documentHashes: row.documentHashes,
					provider: row.provider,
					passed: row.passed,
					issues: row.issues,
					claims: row.claims,
					atsChecked: row.atsCheckedAt !== null,
					createdAt: row.createdAt,
					status: row.status ?? undefined,
					flags: row.flags,
					segments: row.segments,
					cited: row.cited,
				}
			: null;
	},

	/** Whether the application's unrevoked approval still matches its documents. */
	checkApproval(
		userId: string,
		applicationId: string,
	): Promise<ApprovalVerdict> {
		return this.approvalVerdict(this.db, userId, applicationId);
	},

	async revokeApproval(
		t: Tx,
		userId: string,
		applicationId: string,
		reason: string,
	): Promise<void> {
		await t
			.update(approvals)
			.set({ revokedAt: new Date(), revokedReason: reason.slice(0, 500) })
			.where(
				and(
					eq(approvals.applicationId, applicationId),
					eq(approvals.userId, userId),
					isNull(approvals.revokedAt),
				),
			);
	},
} satisfies Record<string, unknown> &
	ThisType<DrizzlePipelineRepositoryContext>;
