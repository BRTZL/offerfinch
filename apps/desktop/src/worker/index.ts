import type { CONTENT_TYPES } from "@offerfinch/core/export/export";
import {
	DashboardRepository,
	exportUserData,
	interviewEvent,
} from "@offerfinch/db";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";

import type {
	MainToWorker,
	SiteCall,
	WorkerMethod,
	WorkerToMain,
} from "../shared/worker-protocol";
import { WorkerApp } from "./app";
import { diagnosticsSummary } from "./diagnostics";
import { dismissFromNotice } from "./dismissals";
import { bindApp, desktopAppRouter } from "./router";
import { LOCAL_USER_EMAIL, LOCAL_USER_ID } from "./settings";

/**
 * The pipeline worker's entry (an Electron utility process). It owns the database and the job
 * queue; windows reach its oRPC API through MessagePorts main hands over, main reaches it for
 * files and tray actions through `request` messages.
 */
const parent = process.parentPort;
const send = (message: WorkerToMain) => parent.postMessage(message);
const log = (
	level: "info" | "warn" | "error",
	message: string,
	data?: unknown,
) => send({ type: "log", level, message, data });

let app: WorkerApp | null = null;
const pendingPorts: Electron.MessagePortMain[] = [];

/** Calls to main's site tabs, waiting for their answer. */
const siteCalls = new Map<
	number,
	{ resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let nextSiteCall = 1;
/** Longer than any one operation main allows (a 60 s page load, a 60 s wait). */
const SITE_CALL_TIMEOUT_MS = 90_000;
function siteCall(call: SiteCall): Promise<unknown> {
	const id = nextSiteCall++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			siteCalls.delete(id);
			reject(new Error(`The ${call.site} tab did not answer (${call.op})`));
		}, SITE_CALL_TIMEOUT_MS);
		siteCalls.set(id, {
			resolve: (v) => {
				clearTimeout(timer);
				resolve(v);
			},
			reject: (e) => {
				clearTimeout(timer);
				reject(e);
			},
		});
		send({ type: "site", id, call });
	});
}

/** The one local user, as the API's session (there is no sign-in on the desktop). */
const session = {
	user: {
		id: LOCAL_USER_ID,
		email: LOCAL_USER_EMAIL,
		name: "You",
		emailVerified: true,
		image: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	},
	session: {
		id: "local",
		userId: LOCAL_USER_ID,
		token: "local",
		expiresAt: new Date(8.64e15),
		createdAt: new Date(0),
		updatedAt: new Date(0),
		ipAddress: null,
		userAgent: null,
	},
};

const handler = new RPCHandler(desktopAppRouter, {
	interceptors: [
		onError((error) => {
			if (error instanceof ORPCError && error.status < 500) return;
			log(
				"error",
				"api error",
				error instanceof Error ? error.stack : String(error),
			);
		}),
	],
});

function connect(port: Electron.MessagePortMain) {
	if (!app) {
		pendingPorts.push(port);
		return;
	}
	const w = app;
	handler.upgrade(port, {
		context: {
			session: session as never,
			db: w.db as never,
			sendEvent: w.sendEvent,
			dryRun: async (userId: string, applicationId: string) => {
				const { dryRunApplication } = await import(
					"@offerfinch/core/apply/submit"
				);
				return dryRunApplication(w.deps, userId, applicationId);
			},
			structureProfile: async (userId: string, text: string) => {
				const { structureProfile } = await import(
					"@offerfinch/core/profile/structure"
				);
				const { meteredFor } = await import("@offerfinch/core/scoring/metered");
				return structureProfile(
					meteredFor(w.deps.llm, w.deps.spend, userId, null),
					text,
				);
			},
			llmStatus: async () => ({
				local: true,
				subscriptionUserId: null,
				removedEnv: [],
				claudeConfigDir: null,
				codexRefusal:
					"Codex subscriptions are not available in this version yet.",
				codexLogin: null,
				roles: w.roles.map((r) => ({
					role: r.role,
					provider: r.provider,
					billing: "api" as const,
					login: null,
				})),
			}),
		},
	});
	port.start();
}

/** Test runs only: job board API hosts go to the local fixture server instead. */
function rewriteFetch(map: Record<string, string>) {
	const real = globalThis.fetch;
	globalThis.fetch = (input, init) => {
		const url = new URL(
			typeof input === "string" || input instanceof URL ? input : input.url,
		);
		const base = map[url.host];
		if (!base) return real(input, init);
		return real(`${base}/${url.host}${url.pathname}${url.search}`, init);
	};
}

async function answer(method: WorkerMethod, args: unknown[]): Promise<unknown> {
	if (!app) throw new Error("Starting");
	const repo = new DashboardRepository(app.db);
	switch (method) {
		case "fileBytes": {
			const file = await repo.getExport(LOCAL_USER_ID, String(args[0]));
			if (!file?.storageKey) throw new Error("Not found");
			const bytes = await app.blobs.get(file.storageKey);
			if (!bytes) throw new Error("Not found");
			const format = file.format as keyof typeof CONTENT_TYPES;
			return { name: `${file.kind}-v${file.version}.${format}`, bytes };
		}
		case "proofBytes": {
			const which = args[1] === "after" ? "after" : "before";
			const key = await repo.getProof(LOCAL_USER_ID, String(args[0]), which);
			const bytes = key ? await app.blobs.get(key) : null;
			if (!bytes) throw new Error("Not found");
			return { name: `proof-${which}.png`, bytes };
		}
		case "interviewEvent":
			return interviewEvent(app.db, LOCAL_USER_ID, String(args[0]));
		case "dataExport":
			return JSON.stringify(
				await exportUserData(app.db, app.blobs, LOCAL_USER_ID),
				null,
				2,
			);
		case "status":
			return app.status();
		case "scanNow":
			return app.scanNow();
		case "setPaused":
			return app.setPaused(Boolean(args[0]));
		case "diagnostics":
			return diagnosticsSummary(app);
		case "dismissMatch":
			return dismissFromNotice(app.db, app.sendEvent, {
				userId: LOCAL_USER_ID,
				applicationId: String(args[0]),
			});
	}
}

parent.on("message", async (event) => {
	const message = event.data as MainToWorker;
	try {
		switch (message.type) {
			case "init": {
				const started = Date.now();
				if (message.test?.fetchRewrite) rewriteFetch(message.test.fetchRewrite);
				app = await WorkerApp.open(message, {
					status: (status) => send({ type: "status", status }),
					notify: (notice) => send({ type: "notify", notice }),
					site: siteCall,
					openSignIn: (url) => send({ type: "openSignIn", url }),
					// A moment for the last log messages to reach main, then the end.
					exit: (code) => {
						setTimeout(() => process.exit(code), 250);
					},
					log,
				});
				bindApp(app);
				for (const port of pendingPorts.splice(0)) connect(port);
				await app.start();
				send({ type: "ready" });
				log("info", "worker ready", { ms: Date.now() - started });
				break;
			}
			case "connect": {
				const port = event.ports[0];
				if (port) connect(port);
				break;
			}
			case "wake":
				await app?.scheduleTick(message.reason);
				app?.runner.poke();
				break;
			case "noticeResult":
				await app?.noticeResult(message.id, message.outcome);
				break;
			case "shutdown":
				await app?.stop();
				process.exit(0);
				break;
			case "site-result": {
				// An answer to a call from before a restart has no waiter: ignored.
				const call = siteCalls.get(message.id);
				siteCalls.delete(message.id);
				if (message.ok) call?.resolve(message.value);
				else call?.reject(new Error(message.error));
				break;
			}
			case "request":
				try {
					send({
						type: "response",
						id: message.id,
						ok: true,
						value: await answer(message.method, message.args),
					});
				} catch (error) {
					send({
						type: "response",
						id: message.id,
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				break;
		}
	} catch (error) {
		const text =
			error instanceof Error ? (error.stack ?? error.message) : String(error);
		log("error", `worker ${message.type} failed`, text);
		if (message.type === "init")
			send({ type: "fatal", error: text.split("\n")[0] ?? text });
	}
});
