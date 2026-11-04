import type {
	Actor,
	Draft,
	ExportRecord,
	StoredDocument,
	StoredDocumentKind,
} from "@offerfinch/core/pipeline/ports";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../client";
import { documents } from "../schema/pipeline";
import type { DrizzlePipelineRepositoryContext } from "./context";
import { firstPer, type Tx } from "./shared";
export const documentsMethods = {
	/* ------------------------------------------------ preparation and review */

	async saveDraft(
		userId: string,
		applicationId: string,
		draft: Draft,
		actor: Actor,
	): Promise<void> {
		await this.db.transaction(async (tx) => {
			await this.lockOwned(tx, userId, applicationId);
			for (const [kind, format, content] of [
				["notes", "markdown", draft.notes],
				["cv", "markdown", draft.cv],
				["cover_letter", "markdown", draft.coverLetter],
				["form_answers", "json", JSON.stringify(draft.formAnswers, null, 2)],
			] as const)
				await this.insertVersion(
					tx,
					userId,
					applicationId,
					kind,
					format,
					content,
					actor,
					draft.provider ?? null,
				);
		});
	},

	/**
	 * A new version of one document. `author` is the model that wrote it; unset (a user's edit,
	 * added answers) the previous version's author carries over: an edit does not change who
	 * wrote the draft.
	 */
	// biome-ignore lint/complexity/useMaxParams: Keep document-version and state-transition transaction contracts intact.
	async insertVersion(
		t: Tx,
		userId: string,
		applicationId: string,
		kind: StoredDocumentKind,
		format: "markdown" | "json",
		content: string,
		actor: Actor,
		author?: string | null,
	): Promise<number> {
		const [last] = await t
			.select({
				version: documents.version,
				authorProvider: documents.authorProvider,
			})
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
		const version = (last?.version ?? 0) + 1;
		await t.insert(documents).values({
			userId,
			applicationId,
			kind,
			format,
			version,
			content,
			createdBy: actor,
			authorProvider:
				author === undefined ? (last?.authorProvider ?? null) : author,
		});
		return version;
	},

	async latestDocuments(
		this: DrizzlePipelineRepositoryContext,
		userId: string,
		applicationId: string,
		t: Tx | Database = this.db,
	): Promise<StoredDocument[]> {
		const all = await t
			.select({
				kind: documents.kind,
				version: documents.version,
				content: documents.content,
				createdBy: documents.createdBy,
				authorProvider: documents.authorProvider,
			})
			.from(documents)
			.where(
				and(
					eq(documents.applicationId, applicationId),
					eq(documents.userId, userId),
					inArray(documents.format, ["markdown", "json"]),
				),
			)
			.orderBy(documents.kind, desc(documents.version));
		return firstPer(all, (r) => r.kind).map((r) => ({
			...r,
			content: r.content ?? "",
		}));
	},

	async saveExport(
		userId: string,
		applicationId: string,
		record: ExportRecord,
	): Promise<void> {
		await this.db.transaction(async (tx) => {
			await this.lockOwned(tx, userId, applicationId);
			const [last] = await tx
				.select({ version: documents.version })
				.from(documents)
				.where(
					and(
						eq(documents.applicationId, applicationId),
						eq(documents.kind, record.kind),
						eq(documents.format, record.format),
					),
				)
				.orderBy(desc(documents.version))
				.limit(1);
			await tx.insert(documents).values({
				userId,
				applicationId,
				kind: record.kind,
				format: record.format,
				version: (last?.version ?? 0) + 1,
				storageKey: record.storageKey,
				sourceVersion: record.sourceVersion,
				meta: record.meta,
			});
		});
	},
} satisfies Record<string, unknown> &
	ThisType<DrizzlePipelineRepositoryContext>;
