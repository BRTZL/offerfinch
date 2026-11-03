import {
	answerIndex,
	CHAT_HISTORY,
	type ChatProposal,
	type ChatScope,
	type ChatTurnMessage,
	type DocumentProposal,
	type NewProposal,
} from "@offerfinch/core/chat/chat";
import { parseFormAnswers } from "@offerfinch/core/tailor/tailor";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database, Tx } from "./client";
import {
	DashboardRepository,
	EditConflictError,
	type PendingEvent,
} from "./dashboard";
import { addRecord, listRecords, updateRecord } from "./profile-records";
import {
	applications,
	chatMessages,
	chatThreads,
	documents,
} from "./schema/pipeline";

/**
 * The chat beside an application and beside the profile: threads, messages and the status of
 * each proposal. Accepting a proposal goes through the same paths a manual edit does:
 * `editDocument` (a new version, checked again; an edit after approval revokes it), `addFact`
 * (a dated answer in answers.md, evidence from then on) and `addRecord` / `updateRecord`.
 */

export const CHAT_SOURCE = "you, in chat";

export type ChatMessageRow = typeof chatMessages.$inferSelect;

/** Thrown when a send or an accept cannot go ahead; the API shows the message as-is. */
export class ChatRefusal extends Error {
	constructor(message: string) {
		super(`Refusing: ${message}`);
		this.name = "ChatRefusal";
	}
}

function threadKey(scope: ChatScope, applicationId: string | null): string {
	if (scope === "application") {
		if (!applicationId)
			throw new ChatRefusal("an application chat needs its application");
		return `application:${applicationId}`;
	}
	return "profile";
}

async function ownsApplication(
	db: Database,
	userId: string,
	applicationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: applications.id })
		.from(applications)
		.where(
			and(eq(applications.id, applicationId), eq(applications.userId, userId)),
		);
	return Boolean(row);
}

/** The thread for a scope, or null before its first message. */
export async function findThread(
	db: Database,
	userId: string,
	scope: ChatScope,
	applicationId: string | null,
) {
	const [row] = await db
		.select()
		.from(chatThreads)
		.where(
			and(
				eq(chatThreads.userId, userId),
				eq(chatThreads.key, threadKey(scope, applicationId)),
			),
		);
	return row ?? null;
}

/** Every message of a thread, oldest first. */
export async function listMessages(
	db: Database,
	userId: string,
	threadId: string,
): Promise<ChatMessageRow[]> {
	return db
		.select()
		.from(chatMessages)
		.where(
			and(eq(chatMessages.threadId, threadId), eq(chatMessages.userId, userId)),
		)
		.orderBy(asc(chatMessages.createdAt), asc(sql`${chatMessages}.rowid`));
}

/**
 * The user's message and the assistant's `working` reply, in one transaction. Refused while the
 * thread already waits on the model, so one turn runs at a time.
 */
export async function startTurn(
	db: Database,
	input: {
		userId: string;
		scope: ChatScope;
		applicationId: string | null;
		text: string;
	},
): Promise<{ threadId: string; userMessageId: string; replyId: string }> {
	const text = input.text.trim();
	if (!text) throw new ChatRefusal("a message cannot be empty");
	const applicationId =
		input.scope === "application" ? input.applicationId : null;
	if (
		applicationId &&
		!(await ownsApplication(db, input.userId, applicationId))
	)
		throw new ChatRefusal("that application is not yours");
	const key = threadKey(input.scope, applicationId);
	return db.transaction(async (tx) => {
		await tx
			.insert(chatThreads)
			.values({
				userId: input.userId,
				scope: input.scope,
				applicationId,
				key,
			})
			.onConflictDoNothing();
		const [thread] = await tx
			.select({ id: chatThreads.id })
			.from(chatThreads)
			.where(
				and(eq(chatThreads.userId, input.userId), eq(chatThreads.key, key)),
			);
		if (!thread) throw new Error("Chat thread could not be created");
		const [busy] = await tx
			.select({ id: chatMessages.id })
			.from(chatMessages)
			.where(
				and(
					eq(chatMessages.threadId, thread.id),
					eq(chatMessages.status, "working"),
				),
			)
			.limit(1);
		if (busy) throw new ChatRefusal("the last message is still being answered");
		const now = Date.now();
		const [user] = await tx
			.insert(chatMessages)
			.values({
				userId: input.userId,
				threadId: thread.id,
				role: "user",
				content: text,
				status: "done",
				createdAt: new Date(now),
			})
			.returning({ id: chatMessages.id });
		const [reply] = await tx
			.insert(chatMessages)
			.values({
				userId: input.userId,
				threadId: thread.id,
				role: "assistant",
				content: "",
				status: "working",
				createdAt: new Date(now + 1),
			})
			.returning({ id: chatMessages.id });
		await tx
			.update(chatThreads)
			.set({ updatedAt: new Date(now) })
			.where(eq(chatThreads.id, thread.id));
		if (!user || !reply) throw new Error("Chat message could not be saved");
		return { threadId: thread.id, userMessageId: user.id, replyId: reply.id };
	});
}

/**
 * The conversation the model sees: the last messages that were answered, oldest first, ending
 * with the user's newest message. Failed replies are left out; proposals are named in words so
 * the model knows what it suggested and what the user did with it.
 */
export async function turnHistory(
	db: Database,
	userId: string,
	threadId: string,
): Promise<ChatTurnMessage[]> {
	const rows = await listMessages(db, userId, threadId);
	return rows
		.filter((m) => m.status === "done" && (m.role === "user" || m.content))
		.slice(-CHAT_HISTORY)
		.map((m) => ({
			role: m.role,
			content:
				m.role === "assistant" && m.proposals.length > 0
					? `${m.content}\n\n(Proposals: ${m.proposals.map(describeProposal).join("; ")})`
					: m.content,
		}));
}

function describeProposal(p: ChatProposal): string {
	const what =
		p.type === "document"
			? `edit to ${p.document.replace("_", " ")}${p.question ? ` (${p.question})` : ""}`
			: p.type === "fact"
				? `fact "${p.answer}"`
				: `${p.action} ${p.kind} record`;
	return `${what}, ${p.status}`;
}

/** The model answered: its reply and proposals, each pending. */
export async function finishTurn(
	db: Database,
	replyId: string,
	turn: { reply: string; proposals: NewProposal[] },
): Promise<void> {
	const proposals = turn.proposals.map(
		(p) =>
			({ ...p, id: crypto.randomUUID(), status: "pending" }) as ChatProposal,
	);
	await db
		.update(chatMessages)
		.set({ content: turn.reply, proposals, status: "done" })
		.where(
			and(eq(chatMessages.id, replyId), eq(chatMessages.status, "working")),
		);
}

/** The model could not answer: an error, or a pause (no model connected, a usage limit). */
export async function failTurn(
	db: Database,
	replyId: string,
	status: "error" | "paused",
	message: string,
): Promise<void> {
	await db
		.update(chatMessages)
		.set({ content: message, status })
		.where(
			and(eq(chatMessages.id, replyId), eq(chatMessages.status, "working")),
		);
}

export const INTERRUPTED =
	"The app stopped before this was answered. Send your message again.";

/**
 * At start: replies left `working` by a worker that stopped are marked as interrupted, and
 * suggestions left mid-accept are settled. Returns the number of replies marked.
 */
export async function sweepWorkingMessages(db: Database): Promise<number> {
	const rows = await db
		.update(chatMessages)
		.set({ status: "error", content: INTERRUPTED })
		.where(eq(chatMessages.status, "working"))
		.returning({ id: chatMessages.id });
	// And suggestions an accept was interrupted in (see `reconcileProposals`).
	await reconcileProposals(db);
	return rows.length;
}

/* -------------------------------------------------------------- proposals */

async function loadProposal(
	db: Database,
	userId: string,
	messageId: string,
	proposalId: string,
) {
	const [message] = await db
		.select()
		.from(chatMessages)
		.where(
			and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId)),
		);
	if (!message) throw new ChatRefusal("that message is not in your chats");
	const proposal = message.proposals.find((p) => p.id === proposalId);
	if (!proposal)
		throw new ChatRefusal("that suggestion is not in this message");
	const [thread] = await db
		.select()
		.from(chatThreads)
		.where(eq(chatThreads.id, message.threadId));
	if (!thread) throw new ChatRefusal("that chat is gone");
	return { message, proposal, thread };
}

/** A proposal's message, under the transaction's write lock. */
async function proposalIn(tx: Tx, messageId: string, proposalId: string) {
	const [message] = await tx
		.select({ proposals: chatMessages.proposals })
		.from(chatMessages)
		.where(eq(chatMessages.id, messageId));
	const current = message?.proposals.find((p) => p.id === proposalId);
	return message && current ? { proposals: message.proposals, current } : null;
}

async function writeProposal(
	tx: Tx,
	messageId: string,
	proposals: ChatProposal[],
	next: ChatProposal,
): Promise<ChatProposal> {
	await tx
		.update(chatMessages)
		.set({ proposals: proposals.map((p) => (p.id === next.id ? next : p)) })
		.where(eq(chatMessages.id, messageId));
	return next;
}

/**
 * Sets one proposal's fields, only while its status is one of `from` (under the write lock, so
 * two clicks cannot both claim it). Returns the updated proposal, or null when it had moved on.
 */
async function patchProposal(
	db: Database,
	messageId: string,
	proposalId: string,
	from: ChatProposal["status"][],
	patch: Partial<ChatProposal>,
): Promise<ChatProposal | null> {
	return db.transaction(async (tx) => {
		const found = await proposalIn(tx, messageId, proposalId);
		if (!found || !from.includes(found.current.status)) return null;
		return writeProposal(tx, messageId, found.proposals, {
			...found.current,
			...patch,
		} as ChatProposal);
	});
}

export async function dismissProposal(
	db: Database,
	input: { userId: string; messageId: string; proposalId: string },
): Promise<ChatProposal> {
	await loadProposal(db, input.userId, input.messageId, input.proposalId);
	const next = await patchProposal(
		db,
		input.messageId,
		input.proposalId,
		["pending", "conflict"],
		{ status: "dismissed" },
	);
	if (!next) throw new ChatRefusal("that suggestion was already settled");
	return next;
}

/** The newest editable text of one document kind: its version and content. */
async function latestDocument(
	db: Database | Tx,
	applicationId: string,
	kind: string,
): Promise<{ version: number; content: string } | null> {
	const [row] = await db
		.select({ version: documents.version, content: documents.content })
		.from(documents)
		.where(
			and(
				eq(documents.applicationId, applicationId),
				eq(documents.kind, kind as never),
				inArray(documents.format, ["markdown", "json"]),
			),
		)
		.orderBy(desc(documents.version))
		.limit(1);
	return row ? { version: row.version, content: row.content ?? "" } : null;
}

/**
 * Accepts one proposal by applying what was stored with it (the renderer sends ids only, never
 * text).
 *
 * A fact or a record is claimed, written and marked accepted in one transaction: a crash leaves
 * either all of it or none, and of two suggestions changing the same record the second finds it
 * changed and becomes a conflict. A document edit goes through `editDocument`, which runs its own
 * transaction (a new version and the event that checks it again): the proposal is marked
 * `applying` first and `accepted` after, and a start after a crash in between settles it from
 * the versions stored (`reconcileProposals`). If the document changed since the suggestion, it
 * becomes a conflict and nothing is overwritten.
 */
export async function acceptProposal(
	db: Database,
	input: { userId: string; messageId: string; proposalId: string },
): Promise<{ proposal: ChatProposal; event: PendingEvent | null }> {
	const { proposal, thread } = await loadProposal(
		db,
		input.userId,
		input.messageId,
		input.proposalId,
	);
	if (proposal.status !== "pending")
		throw new ChatRefusal(
			proposal.status === "conflict"
				? "that suggestion was written for an earlier version; ask for it again"
				: "that suggestion was already settled",
		);
	if (proposal.type !== "document")
		return {
			proposal: await acceptInOneTransaction(db, input, thread.applicationId),
			event: null,
		};
	return acceptDocument(db, input, proposal, thread.applicationId);
}

async function acceptInOneTransaction(
	db: Database,
	input: { userId: string; messageId: string; proposalId: string },
	applicationId: string | null,
): Promise<ChatProposal> {
	return db.transaction(async (tx) => {
		const found = await proposalIn(tx, input.messageId, input.proposalId);
		if (found?.current.status !== "pending")
			throw new ChatRefusal("that suggestion was already settled");
		const p = found.current;
		const settle = (patch: Partial<ChatProposal>) =>
			writeProposal(tx, input.messageId, found.proposals, {
				...p,
				...patch,
			} as ChatProposal);
		// The record and fact functions take the transaction handle: nested, they are savepoints.
		const inTx = tx as unknown as Database;
		if (p.type === "fact") {
			const fact = await new DashboardRepository(inTx).addFact(
				input.userId,
				{ question: p.question, answer: p.answer },
				{ source: CHAT_SOURCE, applicationId },
			);
			return settle({ status: "accepted", factId: fact?.id });
		}
		if (p.type !== "record") throw new Error("not a fact or record proposal");
		if (p.action === "create") {
			const saved = await addRecord(inTx, input.userId, p.after, CHAT_SOURCE);
			return settle({ status: "accepted", savedId: saved.id });
		}
		const current = (await listRecords(tx, input.userId)).find(
			(r) => r.id === p.recordId,
		);
		if (!current)
			return settle({
				status: "conflict",
				note: "That record was removed since this suggestion.",
			});
		if (JSON.stringify(current.data) !== JSON.stringify(p.before))
			return settle({
				status: "conflict",
				note: "That record changed since this suggestion.",
			});
		const saved = await updateRecord(inTx, input.userId, current.id, p.after, {
			source: CHAT_SOURCE,
		});
		if (!saved)
			return settle({
				status: "conflict",
				note: "That record was removed since this suggestion.",
			});
		return settle({ status: "accepted", savedId: saved.id });
	});
}

/** The document text a proposal saves, from the latest version; null when that changed. */
async function proposedContent(
	db: Database | Tx,
	applicationId: string,
	proposal: DocumentProposal,
): Promise<{ content: string } | { conflict: string }> {
	if (proposal.document !== "form_answers") return { content: proposal.after };
	const latest = await latestDocument(db, applicationId, "form_answers");
	if (!latest || latest.version !== proposal.baseVersion)
		return { conflict: "The answers changed since this suggestion." };
	const answers = parseFormAnswers(latest.content);
	const index = answerIndex(answers, proposal.question ?? "");
	if (index < 0)
		return { conflict: "That answer is no longer in the form answers." };
	return {
		content: JSON.stringify(
			answers.map((a, i) =>
				i === index ? { ...a, answer: proposal.after } : a,
			),
			null,
			2,
		),
	};
}

async function acceptDocument(
	db: Database,
	input: { userId: string; messageId: string; proposalId: string },
	proposal: DocumentProposal,
	applicationId: string | null,
): Promise<{ proposal: ChatProposal; event: PendingEvent | null }> {
	if (!applicationId) throw new ChatRefusal("this chat has no application");
	// Claimed first, so a second click finds it taken; `applying` until the version is saved.
	const claimed = await patchProposal(
		db,
		input.messageId,
		input.proposalId,
		["pending"],
		{ status: "applying" },
	);
	if (!claimed) throw new ChatRefusal("that suggestion was already settled");
	const settle = async (patch: Partial<ChatProposal>) =>
		(await patchProposal(
			db,
			input.messageId,
			input.proposalId,
			["applying"],
			patch,
		)) ?? proposal;
	const conflict = async (note: string) => ({
		proposal: await settle({ status: "conflict", note }),
		event: null,
	});
	try {
		const target = await proposedContent(db, applicationId, proposal);
		if ("conflict" in target) return conflict(target.conflict);
		try {
			const result = await new DashboardRepository(db).editDocument({
				userId: input.userId,
				applicationId,
				kind: proposal.document,
				content: target.content,
				baseVersion: proposal.baseVersion,
			});
			return {
				proposal: await settle({
					status: "accepted",
					appliedVersion: result.version,
					revoked: result.revoked,
				}),
				event: result.event,
			};
		} catch (error) {
			if (error instanceof EditConflictError)
				return conflict(
					`${DOCUMENT_NOUN[proposal.document]} changed since this suggestion (now version ${error.currentVersion}).`,
				);
			throw error;
		}
	} catch (error) {
		// Nothing was applied: the suggestion stays open, and the reason is shown.
		await patchProposal(db, input.messageId, input.proposalId, ["applying"], {
			status: "pending",
		});
		throw error;
	}
}

/** Whether an accepted proposal carries what accepting it produced. */
function applied(p: ChatProposal): boolean {
	if (p.type === "document") return p.appliedVersion !== undefined;
	if (p.type === "fact") return p.factId !== undefined;
	return p.savedId !== undefined;
}

/**
 * At start: a document edit left `applying` by a worker that stopped mid-accept is settled from
 * the versions stored. A version after the base that holds the proposed text means it was saved
 * (accepted); otherwise nothing was, and it is open again. An accepted proposal without its
 * result (written by an earlier version before the write) is open again too.
 */
async function reconcileProposals(db: Database): Promise<number> {
	const rows = await db
		.select({
			id: chatMessages.id,
			threadId: chatMessages.threadId,
			proposals: chatMessages.proposals,
		})
		.from(chatMessages)
		.where(
			sql`${chatMessages.proposals} like '%"status":"applying"%' or ${chatMessages.proposals} like '%"status":"accepted"%'`,
		);
	let settled = 0;
	for (const row of rows) {
		const stuck = row.proposals.filter(
			(p) =>
				p.status === "applying" || (p.status === "accepted" && !applied(p)),
		);
		if (stuck.length === 0) continue;
		const [thread] = await db
			.select({ applicationId: chatThreads.applicationId })
			.from(chatThreads)
			.where(eq(chatThreads.id, row.threadId));
		for (const p of stuck) {
			const version =
				p.type === "document" && thread?.applicationId
					? await savedVersion(db, thread.applicationId, p)
					: null;
			await patchProposal(
				db,
				row.id,
				p.id,
				["applying", "accepted"],
				version !== null
					? { status: "accepted", appliedVersion: version }
					: { status: "pending" },
			);
			settled += 1;
		}
	}
	return settled;
}

/** The version after the proposal's base that holds its text, or null. */
async function savedVersion(
	db: Database,
	applicationId: string,
	p: DocumentProposal,
): Promise<number | null> {
	const rows = await db
		.select({ version: documents.version, content: documents.content })
		.from(documents)
		.where(
			and(
				eq(documents.applicationId, applicationId),
				eq(documents.kind, p.document),
				inArray(documents.format, ["markdown", "json"]),
			),
		)
		.orderBy(asc(documents.version));
	for (const row of rows) {
		if (row.version <= p.baseVersion) continue;
		const content = row.content ?? "";
		if (p.document !== "form_answers") {
			if (content === p.after) return row.version;
			continue;
		}
		try {
			const answers = parseFormAnswers(content);
			const at = answerIndex(answers, p.question ?? "");
			if (at >= 0 && answers[at]?.answer === p.after) return row.version;
		} catch {
			// Not a list of answers: not this proposal's version.
		}
	}
	return null;
}

const DOCUMENT_NOUN: Record<string, string> = {
	cv: "The CV",
	cover_letter: "The letter",
	form_answers: "The answers",
	notes: "The fit notes",
};
