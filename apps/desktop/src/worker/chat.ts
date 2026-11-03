import {
	CHAT_DOCUMENTS,
	type ChatDocument,
	type ChatProposal,
	type ChatScope,
	lineDiff,
	recordFieldDiff,
	runApplicationChat,
	runProfileChat,
} from "@offerfinch/core/chat/chat";
import { markdownToPreviewHtml } from "@offerfinch/core/export/render";
import { LlmPausedError } from "@offerfinch/core/scoring/llm";
import { meteredFor } from "@offerfinch/core/scoring/metered";
import {
	acceptProposal,
	ChatRefusal,
	DashboardRepository,
	DrizzlePipelineRepository,
	dismissProposal,
	failTurn,
	findThread,
	finishTurn,
	listMessages,
	listRecords,
	startTurn,
	turnHistory,
} from "@offerfinch/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { WorkerApp } from "./app";
import { protectedProcedure } from "./routers/procedure";

/**
 * The chat beside an application and beside the profile (one panel, one backend). A send stores
 * the message and a `working` reply, returns at once, and runs the model here in the worker; the
 * panel polls the thread while a reply is working, so leaving the screen loses nothing. Accept
 * and Dismiss take ids only: the stored proposal is what gets applied.
 */

const scopeInput = z.discriminatedUnion("scope", [
	z.object({
		scope: z.literal("application"),
		applicationId: z.string().uuid(),
	}),
	z.object({ scope: z.literal("profile") }),
]);
type ScopeInput = z.infer<typeof scopeInput>;
const appIdOf = (input: ScopeInput) =>
	input.scope === "application" ? input.applicationId : null;

const PAUSED_HINT =
	"Connect a model for drafting in Settings › Models, then send your message again.";

async function refuse<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (
			error instanceof ChatRefusal ||
			(error instanceof Error &&
				/^Refusing|can be edited|not found/i.test(error.message))
		)
			throw new ORPCError("CONFLICT", { message: error.message });
		throw error;
	}
}

const today = () => new Date().toISOString().slice(0, 10);

/** One model turn, in the background. Never throws: every outcome lands on the reply row. */
export async function runChatTurn(
	w: WorkerApp,
	turn: {
		userId: string;
		scope: ChatScope;
		applicationId: string | null;
		threadId: string;
		replyId: string;
	},
): Promise<void> {
	try {
		const profile = await new DrizzlePipelineRepository(w.db).getProfile(
			turn.userId,
		);
		if (!profile)
			return failTurn(
				w.db,
				turn.replyId,
				"error",
				"Your profile is empty. Import your resume or add a record first.",
			);
		const history = await turnHistory(w.db, turn.userId, turn.threadId);
		// Drafting's model: the claims check stays on the other vendor, independent of chat.
		const base = w.deps.tailorLlm ?? w.deps.llm;
		const llm = meteredFor(base, w.deps.spend, turn.userId, turn.applicationId);
		if (turn.scope === "application" && turn.applicationId) {
			const app = await new DashboardRepository(w.db).getApplication(
				turn.userId,
				turn.applicationId,
			);
			if (!app)
				return failTurn(
					w.db,
					turn.replyId,
					"error",
					"This application is gone.",
				);
			const result = await runApplicationChat(llm, {
				profile,
				job: {
					companyName: app.company.name,
					title: app.job.title,
					url: app.job.url,
					locations: app.job.locations,
					workplaceType: app.job.workplaceType,
					descriptionText: app.job.descriptionText,
				},
				state: app.state,
				documents: app.documents
					.filter((d) => (CHAT_DOCUMENTS as readonly string[]).includes(d.kind))
					.map((d) => ({
						kind: d.kind as ChatDocument,
						version: d.version,
						content: d.content ?? "",
					})),
				history,
				today: today(),
			});
			return finishTurn(w.db, turn.replyId, result);
		}
		const records = await listRecords(w.db, turn.userId);
		const result = await runProfileChat(llm, {
			profile,
			records,
			history,
			today: today(),
		});
		return finishTurn(w.db, turn.replyId, result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			if (error instanceof LlmPausedError)
				await failTurn(
					w.db,
					turn.replyId,
					"paused",
					/not-connected|Add an|Choose the|not available/i.test(message)
						? `${message} ${PAUSED_HINT}`
						: message,
				);
			else {
				w.deps.log?.("chat turn failed", { error: message });
				await failTurn(
					w.db,
					turn.replyId,
					"error",
					`The model could not answer: ${message}`,
				);
			}
		} catch {
			// The database is gone (the worker is stopping); the startup sweep marks it.
		}
	}
}

const DOC_TITLE: Record<ChatDocument, string> = {
	cv: "CV",
	cover_letter: "Letter",
	form_answers: "Answer",
	notes: "Fit notes",
};

/** A proposal as the panel shows it: its diff worked out here, where core lives. */
function proposalView(p: ChatProposal) {
	if (p.type === "document")
		return {
			...p,
			title:
				p.document === "form_answers" && p.question
					? `${DOC_TITLE[p.document]}: ${p.question}`
					: DOC_TITLE[p.document],
			diff: lineDiff(p.before, p.after),
		};
	if (p.type === "record")
		return { ...p, fields: recordFieldDiff(p.before, p.after) };
	return p;
}

export function chatRouter(worker: () => WorkerApp) {
	return {
		/** The thread for an application or the profile: its messages, and whether one is working. */
		thread: protectedProcedure
			.input(scopeInput)
			.handler(async ({ context, input }) => {
				const w = worker();
				const userId = context.session.user.id;
				const thread = await findThread(
					w.db,
					userId,
					input.scope,
					appIdOf(input),
				);
				if (!thread) return { threadId: null, working: false, messages: [] };
				const messages = await listMessages(w.db, userId, thread.id);
				return {
					threadId: thread.id,
					working: messages.some((m) => m.status === "working"),
					messages: messages.map((m) => ({
						id: m.id,
						role: m.role,
						status: m.status,
						content: m.content,
						// Model-written Markdown, rendered by the export's sanitizing renderer.
						html:
							m.role === "assistant" && m.status === "done"
								? markdownToPreviewHtml(m.content)
								: null,
						createdAt: m.createdAt,
						proposals: m.proposals.map(proposalView),
					})),
				};
			}),
		/** Sends a message; the reply is written in the background. */
		send: protectedProcedure
			.input(
				z.intersection(
					scopeInput,
					z.object({ text: z.string().trim().min(1).max(8_000) }),
				),
			)
			.handler(({ context, input }) =>
				refuse(async () => {
					const w = worker();
					const userId = context.session.user.id;
					const applicationId = appIdOf(input);
					const started = await startTurn(w.db, {
						userId,
						scope: input.scope,
						applicationId,
						text: input.text,
					});
					void runChatTurn(w, {
						userId,
						scope: input.scope,
						applicationId,
						threadId: started.threadId,
						replyId: started.replyId,
					});
					return { threadId: started.threadId, replyId: started.replyId };
				}),
			),
		/** Applies a stored proposal through the app's own edit paths. */
		accept: protectedProcedure
			.input(
				z.object({
					messageId: z.string().uuid(),
					proposalId: z.string().uuid(),
				}),
			)
			.handler(({ context, input }) =>
				refuse(async () => {
					const result = await acceptProposal(worker().db, {
						userId: context.session.user.id,
						...input,
					});
					// A new document version: the workflow checks it again, as after any edit.
					if (result.event) await context.sendEvent(result.event);
					return proposalView(result.proposal);
				}),
			),
		dismiss: protectedProcedure
			.input(
				z.object({
					messageId: z.string().uuid(),
					proposalId: z.string().uuid(),
				}),
			)
			.handler(({ context, input }) =>
				refuse(async () =>
					proposalView(
						await dismissProposal(worker().db, {
							userId: context.session.user.id,
							...input,
						}),
					),
				),
			),
	};
}
