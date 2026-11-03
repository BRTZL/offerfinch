import { deleteUserData, exportUserData } from "@offerfinch/db";
import { z } from "zod";
import { protectedProcedure } from "./procedure";
import { worker } from "./shared";

export const dataRouter = {
	/** Erases every row and file of the local user; the app starts at onboarding again. */
	erase: protectedProcedure
		.input(z.object({ confirm: z.literal("erase") }))
		.handler(async ({ context }) => {
			const w = worker();
			await w.runner.stop(2_000);
			// Runs, their steps and events and the app's settings, then every stored file, then
			// the user row: every per-user table goes with it (foreign keys cascade).
			w.db.$client.exec(
				"delete from flow_events; delete from flow_steps; delete from flow_runs; delete from app_settings;",
			);
			await deleteUserData(w.db, w.blobs, {
				id: context.session.user.id,
				email: context.session.user.email,
			});
			w.db.$client
				.prepare("delete from user where id = ?")
				.run(context.session.user.id);
			await w.reopen();
			await w.runner.start();
			return { erased: true };
		}),
	exportJson: protectedProcedure.handler(async ({ context }) =>
		JSON.stringify(
			await exportUserData(
				worker().db,
				worker().blobs,
				context.session.user.id,
			),
		),
	),
};
