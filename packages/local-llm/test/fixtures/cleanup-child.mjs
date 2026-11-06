// A second OfferFinch process for opencode-cleanup.test.ts: it runs the real cleanup module (the
// TypeScript source, through Node's type stripping) against the test's database.
//   crash <target-json> <session>    a call: intent, its session written (as OpenCode would),
//                                     its scrub, then the process dies before the marker
//   overlap <target-json> <session>  the same call, alive until it reads a line on stdin, then
//                                     its cleanup finishes normally
//   racer <target-json> <session>    a call starting while this test's sweep runs: writes
//                                     <base>/racer-started, publishes its intent, writes its
//                                     session, writes <base>/racer-inserted, then exits
//   hold <target-json>               a sweep that takes the cleanup lock, prints "held" and
//                                     blocks there until it is killed
import { registerHooks } from "node:module";
import { createInterface } from "node:readline";

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (specifier.startsWith(".") && !specifier.endsWith(".ts"))
				return nextResolve(`${specifier}.ts`, context);
			throw error;
		}
	},
});

const [mode, targetJson, session] = process.argv.slice(2);
const target = JSON.parse(targetJson);
const { attemptCleanup, beginCall, finishCall } = await import(
	"../../src/opencode-cleanup.ts"
);
const { default: Database } = await import("better-sqlite3");

if (mode === "hold") {
	const { writeSync } = await import("node:fs");
	attemptCleanup(target, {
		idle: true,
		now: new Date(),
		beforeSweep: () => {
			writeSync(1, "held\n");
			// Blocks with the lock held, as a sweep in its critical section would.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		},
	});
	process.exit(0);
}

const { writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
if (mode === "racer") writeFileSync(join(target.base, "racer-started"), "");

const intent = beginCall(target, new Date());
const db = new Database(target.dbFile);
const prompt = process.env.PROMPT_CANARY ?? "PROMPT";
db.prepare("INSERT INTO session_v2 (id, project_id) VALUES (?, 'ours')").run(
	session,
);
db.prepare(
	"INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, ?, 'user', 1, ?)",
).run(`msg_${session}`, session, `${prompt} ${"filler ".repeat(800)}`);
db.close();

if (mode === "racer") {
	writeFileSync(join(target.base, "racer-inserted"), "");
	process.exit(0);
}

if (mode === "crash") {
	finishCall(target, intent, session, {
		idle: true,
		now: new Date(),
		afterDelete: () => process.exit(1),
	});
	process.exit(0);
}

process.stdout.write("ready\n");
const lines = createInterface({ input: process.stdin });
for await (const _ of lines) break;
const finished = finishCall(target, intent, session, {
	idle: true,
	now: new Date(),
});
process.stdout.write(`${JSON.stringify(finished)}\n`);
process.exit(0);
