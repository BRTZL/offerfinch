import { parseFilterSettings } from "@offerfinch/core/filter/settings";
import { renderRecords } from "@offerfinch/core/profile/records";
import type { ProfileSnapshot } from "@offerfinch/core/profile/types";
import { evidenceProfile } from "@offerfinch/core/tailor/profile-rules";
import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { listRecords } from "../profile-records";
import { filterSettings, profileFacts, profiles } from "../schema/pipeline";
import type { DrizzlePipelineRepositoryContext } from "./context";
import { ANSWERS_PATH, answersMarkdown, type Tx } from "./shared";
export const profileMethods = {
	async getFilterSettings(userId: string) {
		const [row] = await this.db
			.select()
			.from(filterSettings)
			.where(eq(filterSettings.userId, userId));
		return parseFilterSettings(row?.settings ?? {});
	},

	async getProfile(
		this: DrizzlePipelineRepositoryContext,
		userId: string,
		t: Tx | Database = this.db,
	): Promise<ProfileSnapshot | null> {
		// Records are the profile; the files row is read only until it is converted.
		const records = await listRecords(t, userId);
		const [row] =
			records.length > 0
				? [{ files: renderRecords(records) }]
				: await t
						.select({ files: profiles.files })
						.from(profiles)
						.where(eq(profiles.userId, userId));
		if (!row) return null;
		const facts = await t
			.select()
			.from(profileFacts)
			.where(eq(profileFacts.userId, userId))
			.orderBy(asc(profileFacts.answeredAt), asc(sql`${profileFacts}.rowid`));
		// Imports made before sources/ was excluded may still hold it; it is never evidence.
		const files = evidenceProfile({ files: row.files }).files.filter(
			(f) => f.path !== ANSWERS_PATH,
		);
		if (facts.length > 0)
			files.push({ path: ANSWERS_PATH, content: answersMarkdown(facts) });
		return { files };
	},
} satisfies Record<string, unknown> &
	ThisType<DrizzlePipelineRepositoryContext>;
