import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import {
	ensureUser,
	importProfile,
	listMessages,
	openSqlite,
	startTurn,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { describe, expect, it } from "vitest";

import type { WorkerApp } from "../src/worker/app";
import { runChatTurn } from "../src/worker/chat";
import { NotConnectedProvider } from "../src/worker/pipeline";

/** A migrated database with one user and a small profile. */
async function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-chat-"));
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
	return db;
}

async function turnWith(llm: WorkerApp["deps"]["llm"]) {
	const db = await setup();
	const started = await startTurn(db, {
		userId: "u1",
		scope: "profile",
		applicationId: null,
		text: "I built Ledgerline at Bluefin Labs in 2024 with Go, it cut latency 40%",
	});
	const w = { db, deps: { llm, tailorLlm: llm, log: () => {} } } as never;
	await runChatTurn(w, {
		userId: "u1",
		scope: "profile",
		applicationId: null,
		...started,
	});
	const messages = await listMessages(db, "u1", started.threadId);
	db.$close();
	return messages.find((m) => m.id === started.replyId);
}

describe("a chat turn in the worker", () => {
	it("stores the reply and its proposals, pending", async () => {
		const reply = await turnWith(new FakeLlmProvider());
		expect(reply?.status).toBe("done");
		expect(reply?.proposals).toEqual([
			expect.objectContaining({
				type: "record",
				action: "create",
				status: "pending",
			}),
		]);
	});

	it("a model that cannot answer now leaves an inline pause with what to do", async () => {
		const reply = await turnWith(
			new NotConnectedProvider(
				"not-connected:tailoring",
				"Add an Anthropic API key in Settings > Models.",
			),
		);
		expect(reply).toMatchObject({ status: "paused", proposals: [] });
		expect(reply?.content).toContain("Add an Anthropic API key");
		expect(reply?.content).toContain(
			"Settings › Models, then send your message again",
		);
	});

	it("any other failure is an error on the reply, never an unhandled rejection", async () => {
		const reply = await turnWith({
			name: "broken",
			generateObject: async () => {
				throw new Error("socket hang up");
			},
		});
		expect(reply).toMatchObject({
			status: "error",
			content: "The model could not answer: socket hang up",
		});
	});
});
