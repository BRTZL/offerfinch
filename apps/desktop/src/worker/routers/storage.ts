import fs from "node:fs";
import path from "node:path";
import { protectedProcedure } from "./procedure";
import { worker } from "./shared";

export const storageRouter = {
	/** What is stored on this Mac, counted, and how much room it takes. */
	summary: protectedProcedure.handler(({ context }) => {
		const w = worker();
		const userId = context.session.user.id;
		const count = (sql: string) =>
			(w.db.$client.prepare(sql).get(userId) as { n: number }).n;
		const size = (target: string): number => {
			try {
				const stat = fs.statSync(target);
				if (!stat.isDirectory()) return stat.size;
				return fs
					.readdirSync(target)
					.reduce((sum, name) => sum + size(path.join(target, name)), 0);
			} catch {
				return 0;
			}
		};
		const dbBytes = ["", "-wal", "-shm"].reduce(
			(sum, s) => sum + size(`${w.init.dbFile}${s}`),
			0,
		);
		return {
			jobs: count("select count(*) n from jobs where user_id = ?"),
			applications: count(
				"select count(*) n from applications where user_id = ?",
			),
			openQuestions: count(
				"select count(*) n from questions where user_id = ? and status = 'open'",
			),
			answers: count("select count(*) n from profile_facts where user_id = ?"),
			profileFiles: (() => {
				const row = w.db.$client
					.prepare("select files from profiles where user_id = ?")
					.get(userId) as { files: string } | undefined;
				try {
					return row ? (JSON.parse(row.files) as unknown[]).length : 0;
				} catch {
					return 0;
				}
			})(),
			searchPreferences: count(
				"select count(*) n from filter_settings where user_id = ?",
			),
			documents: count("select count(*) n from documents where user_id = ?"),
			databaseBytes: dbBytes,
			fileBytes: size(path.join(w.init.userData, "files")),
			backupBytes: size(path.join(w.init.userData, "backups")),
		};
	}),
};
