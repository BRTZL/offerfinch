import type {
	Actor,
	StoredDocumentKind,
} from "@offerfinch/core/pipeline/ports";
import type {
	RedraftDocument,
	RedraftRequest,
} from "@offerfinch/core/tailor/redraft";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../client";
import { applications, documents } from "../schema/pipeline";
import type { DrizzlePipelineRepositoryContext } from "./context";
import type { Tx } from "./shared";

/** The newest source version of one document (0 when there is none). */
export async function latestVersionOf(
	t: Tx,
	applicationId: string,
	kind: StoredDocumentKind,
): Promise<number> {
	const [last] = await t
		.select({ version: documents.version })
		.from(documents)
		.where(
			and(
				eq(documents.applicationId, applicationId),
				eq(documents.kind, kind),
				inArray(documents.format, ["markdown", "json"]),
			),
		)
		.orderBy(desc(documents.version))
		.limit(1);
	return last?.version ?? 0;
}

async function requestOf(
	t: Tx | Database,
	userId: string,
	applicationId: string,
): Promise<RedraftRequest | null> {
	const [row] = await t
		.select({ redraft: applications.redraft })
		.from(applications)
		.where(
			and(eq(applications.id, applicationId), eq(applications.userId, userId)),
		);
	return row?.redraft ?? null;
}

/** The workflow's side of Redraft (core `pipeline/redraft.ts`). */
export const redraftMethods = {
	async pendingRedraft(
		userId: string,
		applicationId: string,
	): Promise<RedraftRequest | null> {
		return requestOf(this.db, userId, applicationId);
	},

	async documentVersions(
		userId: string,
		applicationId: string,
		kind: StoredDocumentKind,
	): Promise<{ version: number; content: string | null; createdBy: Actor }[]> {
		return this.db
			.select({
				version: documents.version,
				content: documents.content,
				createdBy: documents.createdBy,
			})
			.from(documents)
			.where(
				and(
					eq(documents.applicationId, applicationId),
					eq(documents.userId, userId),
					eq(documents.kind, kind),
					inArray(documents.format, ["markdown", "json"]),
				),
			)
			.orderBy(asc(documents.version));
	},

	/**
	 * The redraft's versions and its cleared request, in one transaction. Written as the workflow's
	 * (the model wrote them), with the request in `meta` so the version says it was a redraft.
	 */
	async saveRedraft(
		userId: string,
		applicationId: string,
		requestId: string,
		versions: { kind: RedraftDocument; content: string }[],
	): Promise<"saved" | "gone" | "conflict"> {
		return this.db.transaction(async (tx) => {
			const app = await this.lockOwned(tx, userId, applicationId);
			const request = await requestOf(tx, userId, applicationId);
			if (
				app.state !== "ready_for_review" ||
				!request ||
				request.id !== requestId ||
				request.problem
			)
				return "gone";
			for (const v of versions) {
				const latest = await latestVersionOf(tx, applicationId, v.kind);
				if (latest !== (request.baseVersions[v.kind] ?? 0)) {
					await tx
						.update(applications)
						.set({
							redraft: {
								...request,
								problem: {
									kind: "conflict",
									message: `The ${v.kind === "cv" ? "CV" : v.kind === "cover_letter" ? "letter" : "answers"} changed since you asked for the redraft (now version ${latest}); nothing was replaced.`,
									at: new Date().toISOString(),
								},
							},
						})
						.where(eq(applications.id, applicationId));
					return "conflict";
				}
			}
			for (const v of versions) {
				const version = (await latestVersionOf(tx, applicationId, v.kind)) + 1;
				await tx.insert(documents).values({
					userId,
					applicationId,
					kind: v.kind,
					format: v.kind === "form_answers" ? "json" : "markdown",
					version,
					content: v.content,
					createdBy: "workflow",
					meta: {
						redraft: {
							requestId: request.id,
							scope: request.scope,
							instruction: request.instruction,
						},
					},
				});
			}
			await tx
				.update(applications)
				.set({ redraft: null })
				.where(eq(applications.id, applicationId));
			return "saved";
		});
	},

	async setRedraftProblem(
		userId: string,
		applicationId: string,
		requestId: string,
		problem: NonNullable<RedraftRequest["problem"]>,
	): Promise<void> {
		await this.db.transaction(async (tx) => {
			await this.lockOwned(tx, userId, applicationId);
			const request = await requestOf(tx, userId, applicationId);
			if (request?.id !== requestId) return;
			await tx
				.update(applications)
				.set({ redraft: { ...request, problem } })
				.where(eq(applications.id, applicationId));
		});
	},
} satisfies Record<string, unknown> &
	ThisType<DrizzlePipelineRepositoryContext>;
