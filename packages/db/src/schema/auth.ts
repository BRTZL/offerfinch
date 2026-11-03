import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The one local user. The desktop app has no sign-in: every row keeps its `user_id` (PLAN rule
 * 6), all pointing at this row. Better-Auth's session, account and verification tables are gone.
 */
export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" })
		.default(false)
		.notNull(),
	image: text("image"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.$defaultFn(() => new Date())
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.$defaultFn(() => new Date())
		.$onUpdate(() => new Date())
		.notNull(),
});
