import { randomUUID } from "node:crypto";
import { MemoryBlobStore } from "@offerfinch/core/export/export";
import { structureProfile } from "@offerfinch/core/profile/structure";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import { meteredFor } from "@offerfinch/core/scoring/metered";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Context } from "../../../../apps/desktop/src/worker/routers/context";
import { pipelineRouter } from "../../../../apps/desktop/src/worker/routers/pipeline";
import {
	DashboardRepository,
	DrizzleSpendStore,
	ensureUser,
	exportUserData,
	type PendingEvent,
} from "../../src/index";
import { testDb } from "../setup";

/** Real SQLite and dashboard procedures, with synthetic user contexts and no HTTP listener. */
export async function startTestApp(_suite: string) {
	const db = await testDb();
	const blobs = new MemoryBlobStore();
	const events: PendingEvent[] = [];
	const sessions = new Map<string, NonNullable<Context["session"]>>();
	let subscriptionOwner: string | null = null;
	const handler = new RPCHandler(pipelineRouter);
	const fetch = async (request: Request): Promise<Response> => {
		const session = sessions.get(request.headers.get("cookie") ?? "") ?? null;
		const pathname = new URL(request.url).pathname;
		const repo = new DashboardRepository(db);
		if (!pathname.startsWith("/rpc")) {
			if (!session) return new Response("Unauthorized", { status: 401 });
			if (pathname === "/account/export")
				return Response.json(await exportUserData(db, blobs, session.user.id));
			const parts = pathname.split("/");
			const key =
				parts[1] === "files"
					? (await repo.getExport(session.user.id, parts[2] ?? ""))?.storageKey
					: parts[1] === "proof"
						? await repo.getProof(session.user.id, parts[2] ?? "", "before")
						: null;
			const bytes = key ? await blobs.get(key) : null;
			return bytes
				? new Response(bytes)
				: new Response("Not found", { status: 404 });
		}
		const context: Context = {
			db,
			session,
			sendEvent: async (event) => {
				events.push(event);
			},
			structureProfile: (userId, text) =>
				structureProfile(
					meteredFor(
						new FakeLlmProvider(),
						new DrizzleSpendStore(db),
						userId,
						null,
					),
					text,
				),
			llmStatus: async () => ({
				local: true,
				subscriptionUserId: subscriptionOwner,
				removedEnv: ["ANTHROPIC_API_KEY"],
				claudeConfigDir: "/Users/owner/.claude",
				codexRefusal:
					"codex-subscription runs the claims check on your ChatGPT plan",
				codexLogin: null,
				roles: [
					{
						role: "tailoring",
						provider: "claude-subscription:claude-sonnet-5-5",
						billing: "subscription",
						login: {
							state: "logged_in",
							detail: "Claude subscription (plan max)",
						},
					},
				],
			}),
		};
		const result = await handler.handle(request, { prefix: "/rpc", context });
		return result.matched
			? result.response
			: new Response("Not found", { status: 404 });
	};
	return {
		db,
		blobs,
		events,
		fetch,
		setSubscriptionOwner: (userId: string) => {
			subscriptionOwner = userId;
		},
		close: async () => {
			db.$close();
		},
		async user(name: string) {
			const id = randomUUID();
			const email = `${name}@example.test`;
			await ensureUser(db, { id, name, email });
			const cookie = `fixture=${id}`;
			sessions.set(cookie, { user: { id, name, email } });
			const call = (pathname: string, init: RequestInit = {}) =>
				fetch(
					new Request(`http://localhost:3999${pathname}`, {
						...init,
						headers: {
							...Object.fromEntries(new Headers(init.headers)),
							cookie,
						},
					}),
				);
			const rpc: RouterClient<typeof pipelineRouter> = createORPCClient(
				new RPCLink({
					url: "http://localhost:3999/rpc",
					fetch: (request) => {
						const headers = new Headers(request.headers);
						headers.set("cookie", cookie);
						return fetch(new Request(request, { headers }));
					},
				}),
			);
			return { id, email, cookie, rpc, request: call };
		},
	};
}
export type TestApp = Awaited<ReturnType<typeof startTestApp>>;
export type TestUser = Awaited<ReturnType<TestApp["user"]>>;
