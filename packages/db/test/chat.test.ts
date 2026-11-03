import type { NewProposal } from "@offerfinch/core/chat/chat";
import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import { checkClaims } from "@offerfinch/core/tailor/claims";
import {
	formAnswersText,
	parseFormAnswers,
} from "@offerfinch/core/tailor/tailor";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	acceptProposal,
	addRecord,
	CHAT_SOURCE,
	ChatRefusal,
	DashboardRepository,
	type Database,
	DrizzlePipelineRepository,
	dismissProposal,
	ensureUser,
	failTurn,
	findThread,
	finishTurn,
	INTERRUPTED,
	importProfile,
	listMessages,
	listRecords,
	seedCompanies,
	startTurn,
	sweepWorkingMessages,
	turnHistory,
	updateRecord,
} from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DashboardRepository;
let appId = "";

const LETTER = `Ada Example\\
{{email}}

Dear Hiring Team at Acme,

I build backend services in Go.

I would welcome a conversation about the role.

Best regards,\\
Ada Example`;

const job: NormalizedJob = {
	source: "greenhouse",
	externalId: "901",
	url: "https://boards.greenhouse.io/acme/jobs/901",
	title: "Backend Engineer",
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "Build backend services in Go.",
};

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	await ensureUser(db, { id: "u2", name: "Other", email: "u2@example.test" });
	await importProfile(
		db,
		"u1",
		{
			files: [
				{
					path: "personal.md",
					content: "# Ada Example\n\n- **Name:** Ada Example",
				},
				{ path: "skills.md", content: "- Go" },
			],
		},
		"test",
	);
	await seedCompanies(db, "u1", [
		{
			name: "Acme",
			source: "greenhouse",
			sourceKey: "acme",
			discoveredFrom: "t",
		},
	]);
	const [company] = await execute<{ id: string }>(
		db,
		sql`select id from companies where user_id = 'u1'`,
	);
	const { jobId } = await repo.upsertJob("u1", company?.id ?? "", job);
	appId = (await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
	for (const [from, to] of [
		["found", "scored"],
		["scored", "preparing"],
	] as const)
		await repo.transition("u1", appId, {
			from: [from],
			to,
			reason: "t",
			actor: "workflow",
		});
	await repo.saveDraft(
		"u1",
		appId,
		{
			notes: "# Notes",
			cv: "# Ada Example",
			coverLetter: LETTER,
			formAnswers: [
				{
					question: "Why Acme?",
					answer: "I build backend services in Go. More words here.",
				},
				{ question: "Notice period?", answer: "One month." },
			],
		},
		"workflow",
	);
	await repo.transition("u1", appId, {
		from: ["preparing"],
		to: "ready_for_review",
		reason: "prepared",
		actor: "workflow",
	});
});

afterAll(() => db.$close());

/** A finished turn with these proposals; returns the reply's id. */
async function turn(
	scope: "application" | "profile",
	text: string,
	proposals: NewProposal[],
): Promise<{ replyId: string; ids: string[] }> {
	const started = await startTurn(db, {
		userId: "u1",
		scope,
		applicationId: scope === "application" ? appId : null,
		text,
	});
	await finishTurn(db, started.replyId, { reply: "Here you go.", proposals });
	const messages = await listMessages(db, "u1", started.threadId);
	const reply = messages.find((m) => m.id === started.replyId);
	return {
		replyId: started.replyId,
		ids: reply?.proposals.map((p) => p.id) ?? [],
	};
}

async function letterVersion(): Promise<{ version: number; content: string }> {
	const detail = await repo.getApplication("u1", appId);
	const doc = detail?.documents.find((d) => d.kind === "cover_letter");
	return { version: doc?.version ?? 0, content: doc?.content ?? "" };
}

describe("chat threads and messages", () => {
	it("keeps one thread per scope, one working reply at a time, and sweeps interrupted replies", async () => {
		const first = await startTurn(db, {
			userId: "u1",
			scope: "profile",
			applicationId: null,
			text: "  hello  ",
		});
		await expect(
			startTurn(db, {
				userId: "u1",
				scope: "profile",
				applicationId: null,
				text: "again",
			}),
		).rejects.toBeInstanceOf(ChatRefusal);
		const messages = await listMessages(db, "u1", first.threadId);
		expect(messages.map((m) => [m.role, m.status, m.content])).toEqual([
			["user", "done", "hello"],
			["assistant", "working", ""],
		]);
		// A worker that stopped mid-turn leaves it working; the next start says so.
		expect(await sweepWorkingMessages(db)).toBe(1);
		const swept = await listMessages(db, "u1", first.threadId);
		expect(swept[1]).toMatchObject({ status: "error", content: INTERRUPTED });
		// A finished turn after a sweep is not overwritten.
		await finishTurn(db, first.replyId, { reply: "late", proposals: [] });
		expect((await listMessages(db, "u1", first.threadId))[1]?.content).toBe(
			INTERRUPTED,
		);

		const second = await startTurn(db, {
			userId: "u1",
			scope: "profile",
			applicationId: null,
			text: "next",
		});
		expect(second.threadId).toBe(first.threadId);
		await failTurn(
			db,
			second.replyId,
			"paused",
			"Subscription paused (usage_limit)",
		);
		// The model sees answered turns only: the interrupted and paused replies are left out.
		expect(await turnHistory(db, "u1", first.threadId)).toEqual([
			{ role: "user", content: "hello" },
			{ role: "user", content: "next" },
		]);
		const [count] = await execute<{ n: number }>(
			db,
			sql`select count(*) n from chat_threads where user_id = 'u1' and key = 'profile'`,
		);
		expect(Number(count?.n)).toBe(1);
	});

	it("refuses another user's application and an empty message", async () => {
		await expect(
			startTurn(db, {
				userId: "u2",
				scope: "application",
				applicationId: appId,
				text: "hi",
			}),
		).rejects.toThrow(/not yours/);
		await expect(
			startTurn(db, {
				userId: "u1",
				scope: "application",
				applicationId: appId,
				text: "  ",
			}),
		).rejects.toThrow(/empty/);
		expect(await findThread(db, "u2", "application", appId)).toBeNull();
	});
});

describe("accepting a document proposal", () => {
	it("saves a new version against the version it was written from, raising the re-check", async () => {
		const base = await letterVersion();
		const after = base.content.replace(
			"I would welcome a conversation about the role.",
			"I'd welcome a conversation about the role.",
		);
		const { replyId, ids } = await turn(
			"application",
			"make the letter warmer",
			[
				{
					type: "document",
					document: "cover_letter",
					baseVersion: base.version,
					before: base.content,
					after,
					summary: "Warmer close.",
					issues: [],
				},
			],
		);
		const result = await acceptProposal(db, {
			userId: "u1",
			messageId: replyId,
			proposalId: ids[0] ?? "",
		});
		expect(result.proposal).toMatchObject({
			status: "accepted",
			appliedVersion: base.version + 1,
			revoked: false,
		});
		expect(result.event).toMatchObject({ userId: "u1" });
		expect(await letterVersion()).toEqual({
			version: base.version + 1,
			content: after,
		});
		// A second click finds it settled; nothing is saved twice.
		await expect(
			acceptProposal(db, {
				userId: "u1",
				messageId: replyId,
				proposalId: ids[0] ?? "",
			}),
		).rejects.toThrow(/already settled/);
		expect((await letterVersion()).version).toBe(base.version + 1);
	});

	it("marks a proposal for an older version as a conflict and overwrites nothing", async () => {
		const base = await letterVersion();
		const { replyId, ids } = await turn("application", "shorter letter", [
			{
				type: "document",
				document: "cover_letter",
				baseVersion: base.version,
				before: base.content,
				after: `${base.content}\n\nP.S. Thanks.`,
				summary: "Adds a line.",
				issues: [],
			},
		]);
		// The user edits the letter by hand meanwhile.
		await repo.editDocument({
			userId: "u1",
			applicationId: appId,
			kind: "cover_letter",
			content: `${base.content}\n`,
			baseVersion: base.version,
		});
		const result = await acceptProposal(db, {
			userId: "u1",
			messageId: replyId,
			proposalId: ids[0] ?? "",
		});
		expect(result.proposal.status).toBe("conflict");
		expect(result.proposal.note).toMatch(
			/The letter changed since this suggestion/,
		);
		expect(result.event).toBeNull();
		expect(await letterVersion()).toEqual({
			version: base.version + 1,
			content: `${base.content}\n`,
		});
		await expect(
			acceptProposal(db, {
				userId: "u1",
				messageId: replyId,
				proposalId: ids[0] ?? "",
			}),
		).rejects.toThrow(/earlier version/);
		expect(
			(
				await dismissProposal(db, {
					userId: "u1",
					messageId: replyId,
					proposalId: ids[0] ?? "",
				})
			).status,
		).toBe("dismissed");
	});

	it("changes one form answer and keeps the others", async () => {
		const detail = await repo.getApplication("u1", appId);
		const doc = detail?.documents.find((d) => d.kind === "form_answers");
		const { replyId, ids } = await turn("application", "shorten answer 1", [
			{
				type: "document",
				document: "form_answers",
				question: "Why Acme?",
				baseVersion: doc?.version ?? 0,
				before: "I build backend services in Go. More words here.",
				after: "I build backend services in Go.",
				summary: "Shorter.",
				issues: [],
			},
		]);
		await acceptProposal(db, {
			userId: "u1",
			messageId: replyId,
			proposalId: ids[0] ?? "",
		});
		const now = await repo.getApplication("u1", appId);
		const stored = now?.documents.find((d) => d.kind === "form_answers");
		expect(stored?.version).toBe((doc?.version ?? 0) + 1);
		expect(parseFormAnswers(stored?.content ?? "")).toEqual([
			{ question: "Why Acme?", answer: "I build backend services in Go." },
			{ question: "Notice period?", answer: "One month." },
		]);
	});

	it("an accepted edit after approval revokes the approval, and says so", async () => {
		const detail = await repo.getApplication("u1", appId);
		const hashes = detail?.currentHashes ?? {};
		const review = await repo.recordReview("u1", appId, {
			documentHashes: hashes,
			provider: "test",
			passed: true,
			issues: [],
			claims: [],
		});
		await repo.completeReview("u1", review, []);
		await repo.approve({
			userId: "u1",
			applicationId: appId,
			approvedHashes: hashes,
			idempotencyKey: "chat-approve",
		});
		expect(await repo.getState("u1", appId)).toBe("approved");
		const base = await letterVersion();
		const { replyId, ids } = await turn("application", "tweak", [
			{
				type: "document",
				document: "cover_letter",
				baseVersion: base.version,
				before: base.content,
				after: base.content.replace("Best regards", "Kind regards"),
				summary: "Sign-off.",
				issues: [],
			},
		]);
		const result = await acceptProposal(db, {
			userId: "u1",
			messageId: replyId,
			proposalId: ids[0] ?? "",
		});
		expect(result.proposal).toMatchObject({
			status: "accepted",
			revoked: true,
		});
		expect(await repo.getState("u1", appId)).toBe("ready_for_review");
	});
});

describe("accepting a fact", () => {
	it("saves it as a dated answer that the claims check accepts as evidence", async () => {
		const line = "I led the Postgres migration at Acme in 2023.";
		const check = async () => {
			const profile = await new DrizzlePipelineRepository(db).getProfile("u1");
			if (!profile) throw new Error("no profile");
			const formAnswers = [
				{ question: "Tell us about a migration.", answer: line },
			];
			const report = await checkClaims(new FakeLlmProvider(), {
				documents: {
					cv: "",
					cover_letter: "",
					form_answers: formAnswersText(formAnswers),
				},
				formAnswers,
				profile,
				context: { companyName: "Acme", jobTitle: "Backend Engineer" },
				postingText: job.descriptionText,
			});
			return report.claims.find((c) => c.text.includes("Postgres migration"));
		};
		expect((await check())?.supported).toBe(false);

		const { replyId, ids } = await turn("application", line, [
			{
				type: "fact",
				question: "Did you lead the Postgres migration?",
				answer: line,
			},
		]);
		const result = await acceptProposal(db, {
			userId: "u1",
			messageId: replyId,
			proposalId: ids[0] ?? "",
		});
		expect(result.proposal.status).toBe("accepted");
		const facts = await repo.listFacts("u1");
		expect(facts[0]).toMatchObject({
			answer: line,
			source: CHAT_SOURCE,
			applicationId: appId,
		});
		const profile = await new DrizzlePipelineRepository(db).getProfile("u1");
		expect(
			profile?.files.find((f) => f.path === "answers.md")?.content,
		).toContain(`- Answer: ${line}`);
		const after = await check();
		expect(after?.supported).toBe(true);
		expect(after?.evidence.some((e) => e.file === "answers.md")).toBe(true);
	});
});

describe("accepting a profile record proposal", () => {
	it("adds a new record through the record path, validated, with chat as its source", async () => {
		const { replyId, ids } = await turn("profile", "I built Ledgerline", [
			{
				type: "record",
				action: "create",
				recordId: null,
				kind: "project",
				before: null,
				after: {
					kind: "project",
					data: {
						name: "Ledgerline",
						description: "Built with Go.",
						bullets: ["Cut latency 40%"],
					},
				},
				summary: "New project.",
			},
		]);
		const result = await acceptProposal(db, {
			userId: "u1",
			messageId: replyId,
			proposalId: ids[0] ?? "",
		});
		expect(result.proposal.status).toBe("accepted");
		const saved = (await listRecords(db, "u1")).find(
			(r) => r.kind === "project",
		);
		expect(saved).toMatchObject({
			source: CHAT_SOURCE,
			data: { name: "Ledgerline", bullets: ["Cut latency 40%"] },
		});
	});

	it("an edit to a record changed since is a conflict; an unchanged one is saved", async () => {
		const record = await addRecord(
			db,
			"u1",
			{ kind: "skill", data: { name: "Postgre" } },
			"test",
		);
		const proposal = (name: string): NewProposal => ({
			type: "record",
			action: "update",
			recordId: record.id,
			kind: "skill",
			before: { ...record.data },
			after: { kind: "skill", data: { name } },
			summary: "Spelling.",
		});
		const stale = await turn("profile", "fix spelling", [
			proposal("PostgreSQL"),
		]);
		const fresh = await turn("profile", "fix spelling", [
			proposal("PostgreSQL"),
		]);
		const ok = await acceptProposal(db, {
			userId: "u1",
			messageId: fresh.replyId,
			proposalId: fresh.ids[0] ?? "",
		});
		expect(ok.proposal.status).toBe("accepted");
		const conflict = await acceptProposal(db, {
			userId: "u1",
			messageId: stale.replyId,
			proposalId: stale.ids[0] ?? "",
		});
		expect(conflict.proposal).toMatchObject({
			status: "conflict",
			note: "That record changed since this suggestion.",
		});
		await updateRecord(
			db,
			"u1",
			record.id,
			{ kind: "skill", data: { name: "Go" } },
			{ source: "test" },
		);
		expect(
			(await listRecords(db, "u1")).find((r) => r.id === record.id)?.data,
		).toEqual({
			name: "Go",
		});
	});

	it("never applies another user's proposal", async () => {
		const { replyId, ids } = await turn("profile", "x", [
			{ type: "fact", question: "What else?", answer: "Nothing." },
		]);
		await expect(
			acceptProposal(db, {
				userId: "u2",
				messageId: replyId,
				proposalId: ids[0] ?? "",
			}),
		).rejects.toThrow(/not in your chats/);
	});
});

/** Rewrites a stored proposal as a crash would have left it. */
async function storeProposal(
	replyId: string,
	patch: Record<string, unknown>,
): Promise<void> {
	const [row] = await execute<{ proposals: string }>(
		db,
		sql`select proposals from chat_messages where id = ${replyId}`,
	);
	const proposals = JSON.parse(String(row?.proposals)).map(
		(p: Record<string, unknown>) => ({ ...p, ...patch }),
	);
	db.$client
		.prepare("update chat_messages set proposals = ? where id = ?")
		.run(JSON.stringify(proposals), replyId);
}

async function storedProposal(replyId: string) {
	const [row] = await execute<{ proposals: string }>(
		db,
		sql`select proposals from chat_messages where id = ${replyId}`,
	);
	return JSON.parse(String(row?.proposals))[0];
}

describe("accepting is atomic (Codex review)", () => {
	it("of two concurrent edits to the same record, one is saved and the other is a conflict", async () => {
		const record = await addRecord(
			db,
			"u1",
			{ kind: "skill", data: { name: "Original" } },
			"test",
		);
		const { replyId, ids } = await turn(
			"profile",
			"two ways",
			["First", "Second"].map(
				(name): NewProposal => ({
					type: "record",
					action: "update",
					recordId: record.id,
					kind: "skill",
					before: { ...record.data },
					after: { kind: "skill", data: { name } },
					summary: name,
				}),
			),
		);
		const results = await Promise.all(
			ids.map((proposalId) =>
				acceptProposal(db, { userId: "u1", messageId: replyId, proposalId }),
			),
		);
		const statuses = results.map((r) => r.proposal.status).sort();
		expect(statuses).toEqual(["accepted", "conflict"]);
		const winner = results.find((r) => r.proposal.status === "accepted");
		const saved = (await listRecords(db, "u1")).find((r) => r.id === record.id);
		expect(saved?.data).toEqual(
			winner?.proposal.type === "record" ? winner.proposal.after.data : null,
		);
		expect(
			results.find((r) => r.proposal.status === "conflict")?.proposal.note,
		).toBe("That record changed since this suggestion.");
	});

	it("a write that fails rolls the claim back: the suggestion stays open", async () => {
		const [about] = (await listRecords(db, "u1")).filter(
			(r) => r.kind === "about",
		);
		if (!about)
			await addRecord(
				db,
				"u1",
				{ kind: "about", data: { name: "Ada" } } as never,
				"test",
			);
		const { replyId, ids } = await turn("profile", "about", [
			{
				type: "record",
				action: "create",
				recordId: null,
				kind: "about",
				before: null,
				after: { kind: "about", data: { name: "Second About" } } as never,
				summary: "x",
			},
		]);
		await expect(
			acceptProposal(db, {
				userId: "u1",
				messageId: replyId,
				proposalId: ids[0] ?? "",
			}),
		).rejects.toThrow(/one About record/);
		expect((await storedProposal(replyId)).status).toBe("pending");
		expect(
			(await listRecords(db, "u1")).filter((r) => r.kind === "about"),
		).toHaveLength(1);
	});

	it("a start after a crash mid-accept reopens a suggestion whose write never happened", async () => {
		const { replyId, ids } = await turn("profile", "add skill", [
			{
				type: "record",
				action: "create",
				recordId: null,
				kind: "skill",
				before: null,
				after: { kind: "skill", data: { name: "Lost" } },
				summary: "add",
			},
		]);
		// What an earlier version could leave: marked accepted, nothing written.
		await storeProposal(replyId, { status: "accepted" });
		await sweepWorkingMessages(db);
		expect((await storedProposal(replyId)).status).toBe("pending");
		const result = await acceptProposal(db, {
			userId: "u1",
			messageId: replyId,
			proposalId: ids[0] ?? "",
		});
		expect(result.proposal).toMatchObject({ status: "accepted" });
		expect(
			(await listRecords(db, "u1")).filter(
				(r) => (r.data as Record<string, unknown>).name === "Lost",
			),
		).toHaveLength(1);
	});

	it("a document edit left applying is settled from the stored versions at start", async () => {
		expect(await repo.getState("u1", appId)).toBe("ready_for_review");
		const base = await letterVersion();
		const after = `${base.content}\n\nSaved before the crash.`;
		const lost = `${base.content}\n\nNever saved.`;
		const proposal = (text: string): NewProposal => ({
			type: "document",
			document: "cover_letter",
			baseVersion: base.version,
			before: base.content,
			after: text,
			summary: "x",
			issues: [],
		});
		const saved = await turn("application", "a", [proposal(after)]);
		const notSaved = await turn("application", "b", [proposal(lost)]);
		// The first crashed after editDocument committed, the second before it ran.
		await repo.editDocument({
			userId: "u1",
			applicationId: appId,
			kind: "cover_letter",
			content: after,
			baseVersion: base.version,
		});
		await storeProposal(saved.replyId, { status: "applying" });
		await storeProposal(notSaved.replyId, { status: "applying" });
		await sweepWorkingMessages(db);
		expect(await storedProposal(saved.replyId)).toMatchObject({
			status: "accepted",
			appliedVersion: base.version + 1,
		});
		expect((await storedProposal(notSaved.replyId)).status).toBe("pending");
		// Reopened, it is now out of date and overwrites nothing.
		const retry = await acceptProposal(db, {
			userId: "u1",
			messageId: notSaved.replyId,
			proposalId: notSaved.ids[0] ?? "",
		});
		expect(retry.proposal.status).toBe("conflict");
		expect((await letterVersion()).content).toBe(after);
	});
});
