import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import type { LlmProvider } from "@offerfinch/core/scoring/llm";
import {
	addNote,
	DashboardRepository,
	ensureUser,
	importProfile,
	moveStage,
	openSqlite,
	seedCompanies,
	startTurn,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { describe, expect, it } from "vitest";

import { runChatTurn } from "../src/worker/chat";

/**
 * Private notes and stage notes (#41) are never sent to a model. Proved two ways: a chat turn
 * about an application with notes sends none of their text, and no code that builds a model's
 * input reads the notes or stages at all.
 */
const CANARY = "CANARY-PRIVATE-NOTE-7f3a";
const ROOT = path.resolve(import.meta.dirname, "../../..");

async function applicationWithNotes() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-notes-"));
	const db = openSqlite(path.join(dir, "test.sqlite"));
	await migrate(db);
	await ensureUser(db, { id: "u1", name: "Test", email: "u1@example.test" });
	await importProfile(
		db,
		"u1",
		{
			files: [
				{ path: "personal.md", content: "# Ada\n\n- **Name:** Ada Example" },
				{ path: "skills.md", content: "- Go" },
			],
		},
		"test",
	);
	await seedCompanies(db, "u1", [
		{
			name: "Northwind Labs",
			source: "greenhouse",
			sourceKey: "northwind",
			discoveredFrom: "t",
		},
	]);
	const companyId = (
		db.$client.prepare("select id from companies").get() as { id: string }
	).id;
	const repo = new DashboardRepository(db);
	const { jobId } = await repo.upsertJob("u1", companyId, {
		source: "greenhouse",
		externalId: "n1",
		url: "https://jobs.example.com/n1",
		title: "Backend Engineer",
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "Go services.",
	});
	const app = await repo.getApplicationByJob("u1", jobId);
	if (!app) throw new Error("no application");
	const id = app.applicationId;
	db.$client
		.prepare(
			"update applications set state = 'applied', applied_at = ?, applied_via = 'manual' where id = ?",
		)
		.run(Date.now(), id);
	await addNote(db, { userId: "u1", applicationId: id, body: CANARY });
	await moveStage(db, {
		userId: "u1",
		applicationId: id,
		stage: "interviewing",
		interviewAt: "2026-11-10T14:30:00.000Z",
		note: `${CANARY} stage`,
	});
	return { db, id };
}

describe("private notes never reach a model", () => {
	it("a chat turn about the application sends none of its notes", async () => {
		const { db, id } = await applicationWithNotes();
		const fake = new FakeLlmProvider();
		const requests: unknown[] = [];
		const recording: LlmProvider = {
			name: fake.name,
			generateObject: (request) => {
				requests.push(request);
				return fake.generateObject(request);
			},
		};
		const started = await startTurn(db, {
			userId: "u1",
			scope: "application",
			applicationId: id,
			text: "Make the letter warmer",
		});
		const w = {
			db,
			deps: { llm: recording, tailorLlm: recording, log: () => {} },
		} as never;
		await runChatTurn(w, {
			userId: "u1",
			scope: "application",
			applicationId: id,
			...started,
		});
		expect(requests.length).toBeGreaterThan(0);
		const sent = JSON.stringify(requests);
		expect(sent).toContain("Backend Engineer");
		expect(sent).not.toContain(CANARY);
		// The application detail the chat (and the window) reads carries no notes either.
		const detail = await new DashboardRepository(db).getApplication("u1", id);
		expect(JSON.stringify(detail)).not.toContain(CANARY);
		db.$close();
	});

	it("no code that builds a model's input reads notes or stages", () => {
		// The only readers: the stage rules, the db module, the export, the tracking router, the sweep and
		// the .ics builder (which leaves notes out; its test checks that).
		const allowed = new Set(
			[
				"packages/core/src/domain/tracking.ts",
				"packages/db/src/tracking.ts",
				"packages/db/src/schema/tracking.ts",
				"packages/db/src/schema/index.ts",
				"packages/db/src/index.ts",
				"packages/db/src/account.ts",
				"packages/db/src/migrations/index.ts",
				"apps/desktop/src/worker/routers/tracking.ts",
				"apps/desktop/src/worker/follow-ups.ts",
				"apps/desktop/src/worker/index.ts",
			].map((p) => path.join(ROOT, p)),
		);
		const pattern =
			/\b(jobNotes|job_notes|applicationStages|application_stages|trackingFor|addNote|schema\/tracking|from "\.\/tracking")\b/;
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const file = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name !== "node_modules") walk(file);
				} else if (
					/\.tsx?$/.test(entry.name) &&
					!allowed.has(file) &&
					pattern.test(fs.readFileSync(file, "utf8"))
				)
					offenders.push(path.relative(ROOT, file));
			}
		};
		for (const dir of [
			"packages/core/src",
			"packages/db/src",
			"packages/local-llm/src",
			"apps/desktop/src/worker",
			"apps/desktop/src/main",
		])
			if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir));
		expect(offenders).toEqual([]);
	});
});
