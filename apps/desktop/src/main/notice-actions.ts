import type { NoticeActionId } from "../shared/worker-protocol";

/** The button labels, as the app names the same actions. */
const LABELS: Record<NoticeActionId, string> = {
	open: "Open",
	dismiss: "Not interested",
};

/** Electron's buttons for a notification's actions, in order (macOS reports the index). */
export function noticeButtons(
	actions: readonly NoticeActionId[] | undefined,
): { type: "button"; text: string }[] {
	return (actions ?? []).map((id) => ({ type: "button", text: LABELS[id] }));
}

/** What a notification is, for its actions: where it opens, and the match a dismiss is about. */
export interface ActionableNotice {
	path: string;
	actions?: NoticeActionId[];
	applicationId?: string;
}

export interface NoticeActionDeps {
	open: (path: string) => void;
	/** Not interested on one match, in the worker: "stale" when it was already decided or gone. */
	dismiss: (applicationId: string) => Promise<"dismissed" | "stale">;
	log: (message: string, data?: unknown) => void;
}

/**
 * Carries out the button at `index` of a notification. Open does what a click does; Not
 * interested dismisses its one match through the app's own path and shows nothing more.
 * Anything else (an index the notification never offered) only logs.
 */
export async function runNoticeAction(
	notice: ActionableNotice,
	index: number,
	deps: NoticeActionDeps,
): Promise<void> {
	const id = notice.actions?.[index];
	if (id === "open") {
		deps.open(notice.path);
		return;
	}
	if (id === "dismiss" && notice.applicationId) {
		try {
			const outcome = await deps.dismiss(notice.applicationId);
			deps.log(
				outcome === "dismissed"
					? "notification action: match dismissed"
					: "notification action: match already decided or gone, nothing changed",
				{ applicationId: notice.applicationId },
			);
		} catch (error) {
			deps.log("notification action failed", {
				applicationId: notice.applicationId,
				error: String(error),
			});
		}
		return;
	}
	deps.log("notification action not offered, ignored", {
		index,
		actions: notice.actions ?? [],
	});
}
