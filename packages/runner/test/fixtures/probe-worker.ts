// A runner process for the crash tests: runs `probe` flows against the database given as the
// first argument. With PROBE_HANG=1, step B never finishes (the test kills the process there).
import { openSqlite } from "@offerfinch/db";
import { flowRuns } from "@offerfinch/db/schema/jobs";
import { eq } from "drizzle-orm";

import { FlowRunner } from "../../src/runner";

const file = process.argv[2] ?? "";
const db = openSqlite(file);
const log = (run: string, entry: string) =>
	db.$client
		.prepare("insert into probe_log (run, entry, pid) values (?, ?, ?)")
		.run(run, entry, process.pid);

const runner = new FlowRunner({
	db,
	concurrency: 1,
	leaseMs: 60_000,
	backoffMs: () => 10,
	handlers: {
		probe: async (step, _params, run) => {
			log(run.id, "execution");
			await step.do("A", async () => {
				log(run.id, "A");
				return 1;
			});
			await step.do("B", async () => {
				log(run.id, "B");
				if (process.env.PROBE_HANG === "1")
					await new Promise(() => {});
				return 2;
			});
			await step.do("C", async () => {
				log(run.id, "C");
				return 3;
			});
			return "done";
		},
	},
});
await runner.start();
const target = process.argv[3] ?? "";
// Exits once the run it was started for has finished.
setInterval(async () => {
	const [row] = await db
		.select({ status: flowRuns.status })
		.from(flowRuns)
		.where(eq(flowRuns.id, target));
	if (row?.status === "complete" || row?.status === "errored") {
		await runner.stop(100);
		process.exit(0);
	}
}, 50);
