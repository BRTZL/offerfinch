import { isSiteTabId } from "../shared/bridge";
import type {
	MainToWorker,
	SiteCall,
	WorkerToMain,
} from "../shared/worker-protocol";

/** The parts of WorkerHost the site tabs use. */
export interface SiteWorkerHost {
	on(listener: (message: WorkerToMain, generation: number) => void): unknown;
	postTo(generation: number, message: MainToWorker): void;
	onExit: ((generation: number) => void) | null;
}

/** The parts of SiteBrowser the worker reaches. */
export interface SiteCalls {
	handle(call: SiteCall, generation: number): Promise<unknown>;
	workerGone(generation: number): void;
}

/**
 * Connects the worker's site calls to main's site tabs. Every call and its answer belong to the
 * worker process (generation) that sent it: the answer goes back to that process only, and when
 * it exits its claims are let go, so a restarted worker (whose call ids start at 1 again) never
 * gets a stale answer or finds a tab still held by the dead one.
 */
export function connectSiteTabs(host: SiteWorkerHost, sites: SiteCalls) {
	host.on((message, generation) => {
		if (message.type !== "site") return;
		const { id, call } = message;
		const reply = isSiteTabId(call?.site)
			? sites.handle(call, generation)
			: Promise.reject(new Error("Unknown site"));
		reply.then(
			(value) =>
				host.postTo(generation, { type: "site-result", id, ok: true, value }),
			(error) =>
				host.postTo(generation, {
					type: "site-result",
					id,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}),
		);
	});
	const before = host.onExit;
	host.onExit = (generation) => {
		before?.(generation);
		sites.workerGone(generation);
	};
}
