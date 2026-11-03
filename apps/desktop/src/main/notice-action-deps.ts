import type { NoticeActionDeps } from "./notice-actions";
import { log, mainState } from "./state";
import { showWindow } from "./window";

/** What a notification's buttons do: open in the window, or Not interested in the worker. */
export const noticeActionDeps: NoticeActionDeps = {
	open: (path) => showWindow(path),
	dismiss: (applicationId) =>
		mainState.worker.request<"dismissed" | "stale">(
			"dismissMatch",
			applicationId,
		),
	log,
};
