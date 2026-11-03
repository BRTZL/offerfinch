import type { DismissReason } from "@offerfinch/core/domain/dismissal";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

import { user } from "./auth";
import { applications, companies } from "./pipeline";

/**
 * "Not interested" on a match: why the user passed on it (see `core/domain/dismissal.ts` for the
 * contract). One row per match the user dismissed; none for the app's own dismissals of a hidden
 * company's jobs; deleted when the user undoes it. Ranking reads it.
 */
export const dismissals = sqliteTable(
	"dismissals",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "cascade" }),
		companyId: text("company_id")
			.notNull()
			.references(() => companies.id, { onDelete: "cascade" }),
		/** JSON array of 'location' | 'seniority' | 'company' | 'stack' | 'salary' | 'other'; may be empty. */
		reasons: text("reasons", { mode: "json" })
			.$type<DismissReason[]>()
			.notNull()
			.$defaultFn(() => []),
		note: text("note"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [
		index("dismissals_user_created_idx").on(t.userId, t.createdAt),
		index("dismissals_app_idx").on(t.applicationId),
	],
);

/**
 * Companies the user hid ("Hide every job from <Company>"): their jobs are dismissed as they are
 * found. Matched by the company's normalized name, so another source's row for it is hidden too.
 */
export const hiddenCompanies = sqliteTable(
	"hidden_companies",
	{
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		companyId: text("company_id")
			.notNull()
			.references(() => companies.id, { onDelete: "cascade" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.companyId] })],
);
