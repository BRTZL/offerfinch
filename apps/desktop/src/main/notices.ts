import type { NativeNotice, NoticeOutcome } from "../shared/worker-protocol";
import { log, mainState, TEST_MODE } from "./state";
import { testHooks } from "./test-hooks";
import { windowInFront } from "./window";

/** Tells the worker what became of a notice it asked about (a follow-up reminder). */
function report(notice: NativeNotice, outcome: NoticeOutcome) {
	if (notice.id)
		mainState.worker?.post({ type: "noticeResult", id: notice.id, outcome });
}

export async function showNotice(notice: NativeNotice) {
	if (notice.onlyIfUnfocused && windowInFront()) {
		log("notification skipped: the window is in front", { kind: notice.kind });
		report(notice, "skipped");
		return;
	}
	if (TEST_MODE) testHooks.notices.push(notice);
	log("notification", { kind: notice.kind });
	// What macOS did with it, not that it was asked: a blocked or failed one is tried again.
	report(notice, await mainState.notifier.show(notice));
}
