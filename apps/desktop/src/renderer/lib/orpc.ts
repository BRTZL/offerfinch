import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { RPC_PORT_MESSAGE } from "../../shared/bridge";
import type { DesktopRouter } from "../../worker/router";

/**
 * The API transport: oRPC over a MessagePort straight to the worker process (no HTTP server,
 * no network). The preload hands a port over at page load, and a new one after the worker
 * restarts (the page asks with `desktop.reconnect()`); calls then go to the newest port.
 */
let resolveFirst: (link: RPCLink<object>) => void = () => {};
let current: Promise<RPCLink<object>> = new Promise((resolve) => {
	resolveFirst = resolve;
});
let connected = false;
let onNextPort: (() => void) | null = null;
window.addEventListener("message", (event) => {
	if (
		event.source !== window ||
		event.data !== RPC_PORT_MESSAGE ||
		!event.ports[0]
	)
		return;
	const port = event.ports[0];
	port.start();
	const next = new RPCLink({ port });
	if (connected) current = Promise.resolve(next);
	else {
		connected = true;
		resolveFirst(next);
	}
	onNextPort?.();
	onNextPort = null;
});

const link = {
	call: async (...args: Parameters<RPCLink<object>["call"]>) =>
		(await current).call(...args),
} as unknown as RPCLink<object>;

/**
 * After the worker restarted: ask for a new port, wait until it is in use, then refetch every
 * query (calls still waiting on the old, dead port are cancelled by the refetch).
 */
export function reconnect(ask: () => void): Promise<void> {
	return new Promise<void>((resolve) => {
		onNextPort = resolve;
		ask();
	}).then(() =>
		queryClient.invalidateQueries(undefined, { cancelRefetch: true }),
	);
}

export const client: RouterClient<DesktopRouter> = createORPCClient(link);

function createQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 1 },
		},
		queryCache: new QueryCache({
			onError: (error, query) => {
				if (query.meta?.quiet) return;
				toast.error(`Error: ${error.message}`, {
					action: { label: "retry", onClick: () => query.invalidate() },
				});
			},
		}),
	});
}

export const queryClient = createQueryClient();

export const orpc = createTanstackQueryUtils(client);
