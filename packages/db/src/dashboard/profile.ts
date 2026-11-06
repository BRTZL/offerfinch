import { normalizeLineEndings } from "@offerfinch/core/domain/line-endings";
import type { FilterSettings } from "@offerfinch/core/filter/settings";
import { renderRecords } from "@offerfinch/core/profile/records";
import { and, desc, eq, sql } from "drizzle-orm";
import { listRecords } from "../profile-records";
import { profileFacts, profiles } from "../schema/pipeline";
import type { DashboardRepositoryContext } from "./context";
export const profileMethods = {
	/** The user's profile as files (rendered from records once there are any), or null before onboarding. */
	async profileFiles(userId: string) {
		const records = await listRecords(this.database, userId);
		if (records.length > 0)
			return {
				files: renderRecords(records),
				sourcePath: null as string | null,
				importedAt: new Date(
					Math.max(...records.map((r) => r.sourceDate.getTime())),
				),
			};
		const [row] = await this.database
			.select({
				files: profiles.files,
				sourcePath: profiles.sourcePath,
				importedAt: profiles.importedAt,
			})
			.from(profiles)
			.where(eq(profiles.userId, userId));
		return row
			? {
					...row,
					files: row.files.map((file) => ({
						...file,
						content: normalizeLineEndings(file.content),
					})),
				}
			: null;
	},

	/**
	 * A fact the user wrote in the profile editor (or saved from a chat), dated now. Rendered into
	 * answers.md, where tailoring and the claims check cite it.
	 */
	async addFact(
		userId: string,
		input: { question: string; answer: string },
		from: { source?: string; applicationId?: string | null } = {},
	) {
		const [row] = await this.database
			.insert(profileFacts)
			.values({
				userId,
				question: input.question,
				answer: input.answer,
				source: from.source ?? "dashboard profile editor",
				applicationId: from.applicationId ?? null,
			})
			.returning();
		return row;
	},

	/** Edits one of the user's facts; its date becomes today and its source the editor. Null when not theirs. */
	async updateFact(
		userId: string,
		input: { id: string; question: string; answer: string },
	) {
		const [row] = await this.database
			.update(profileFacts)
			.set({
				question: input.question,
				answer: input.answer,
				source: "dashboard profile editor",
				answeredAt: new Date(),
			})
			.where(
				and(eq(profileFacts.id, input.id), eq(profileFacts.userId, userId)),
			)
			.returning();
		return row ?? null;
	},

	async removeFact(userId: string, id: string): Promise<boolean> {
		const rows = await this.database
			.delete(profileFacts)
			.where(and(eq(profileFacts.id, id), eq(profileFacts.userId, userId)))
			.returning({ id: profileFacts.id });
		return rows.length > 0;
	},

	async listFacts(userId: string) {
		return this.database
			.select()
			.from(profileFacts)
			.where(eq(profileFacts.userId, userId))
			.orderBy(desc(profileFacts.answeredAt), desc(sql`${profileFacts}.rowid`));
	},

	async getFilterSettingsRaw(userId: string): Promise<FilterSettings> {
		return this.getFilterSettings(userId);
	},
} satisfies Record<string, unknown> & ThisType<DashboardRepositoryContext>;
