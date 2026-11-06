import { mainState } from "./state";

let shutdown: Promise<void> | null = null;

/** Restart to Update and will-quit share one shutdown, including while it is running. */
export function shutdownForQuit(): Promise<void> {
	if (shutdown !== null) return shutdown;
	mainState.sites.closeAll();
	shutdown = mainState.worker.stop().catch((error: unknown) => {
		shutdown = null;
		throw error;
	});
	return shutdown;
}
