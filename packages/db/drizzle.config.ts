import { defineConfig } from "drizzle-kit";

/** Generates SQLite migrations from the schema; no database needed (`pnpm db:generate`). */
export default defineConfig({
	schema: "./src/schema/index.ts",
	out: "./src/migrations",
	dialect: "sqlite",
});
