/** Messages between the main process and the pipeline worker (a utility process). */
import type { SiteTabId } from "./bridge";

/**
 * The worker's exit code when it ends itself because a step stalled (src/worker/stalls.ts).
 * Main restarts it without counting a crash; the step limit bounds how often this can happen.
 */
export const WORKER_STALL_EXIT = 75;

export interface WorkerInit {
	type: "init";
	userData: string;
	dbFile: string;
	version: string;
	/** The bundled Claude Agent SDK host script, forked as Node for each Claude call. */
	claudeHost: string;
	/**
	 * Try-it mode (worker/demo.ts): `userData` is the demo folder, the test models run every
	 * role, the sample source is the only one, and no CLI, login shell or network is used. Its
	 * own switch, not a test hook: it works in a shipped build, and wins over `test`.
	 */
	demo?: boolean;
	/** Test runs: fake models, fixture boards, a fixed clock offset. */
	test?: {
		fakeModels?: boolean;
		boardBases?: Record<string, string>;
		/** Skips the hourly timer (e2e drives scans by hand). */
		noSchedule?: boolean;
		/** Slows every fake model call (kill tests need a step that is still running). */
		fakeDelayMs?: number;
		/** The LinkedIn runner goes to this local fixture instead (headless, no gaps). */
		linkedinOrigin?: string;
		/** Job board API hosts answered by a local fixture server: host -> base URL. */
		fetchRewrite?: Record<string, string>;
		/** How long a run waits for the user to solve a site's check (default 10 minutes). */
		checkTimeoutMs?: number;
		/** A flow whose step stalls (ignores its stop) until a file says otherwise. */
		stallProbe?: boolean;
		/**
		 * Claude Code and Codex from `fake-clis.json` instead of this Mac's (worker/fake-clis.ts).
		 * Unpackaged builds only.
		 */
		fakeClis?: boolean;
	};
}

/**
 * One operation on a site's hidden tab (main's SiteBrowser), asked by the worker's site readers.
 * A fixed set: the worker never sends script. Navigation, waiting and reading only.
 */
export type SiteCall =
	/** A run takes the site's tab; refused while a sign-in sheet shows it. */
	| { op: "claim"; site: SiteTabId }
	/** The run ended: the tab closes unless a sheet shows it. */
	| { op: "release"; site: SiteTabId }
	/** Loads a page; resolves with where it ended and the HTTP status. */
	| { op: "navigate"; site: SiteTabId; url: string }
	/** Waits until the selector matches (true) or the time runs out (false). */
	| { op: "waitFor"; site: SiteTabId; selector: string; timeoutMs: number }
	/**
	 * The page as it is now: URL, status, title, HTML and the text it shows (rendered elements
	 * only, leaving out those matching `exclude`: the posting's own words).
	 */
	| { op: "snapshot"; site: SiteTabId; exclude?: string }
	/** Closes the tab if no run and no sheet holds it. */
	| { op: "closeIdle"; site: SiteTabId }
	/** Signs out: clears the site's whole session partition (cookies, storage, cache). */
	| { op: "signOut"; site: SiteTabId };

export interface SiteSnapshot {
	url: string;
	status: number | null;
	title: string;
	html: string;
	/**
	 * What the page shows: the rendered elements' text, without the excluded ones. Main always
	 * gives it; a test driver may leave it out (the readers then derive it from the HTML).
	 */
	text?: string;
	/** The load was refused (web tab: a private address): no content. */
	refused?: string;
	/** Web tab: the page headed here (a redirect), not followed; no content. */
	redirect?: string;
}

export type MainToWorker =
	| WorkerInit
	| { type: "wake"; reason: string }
	/** Carries a MessagePort for one window's oRPC connection. */
	| { type: "connect" }
	| { type: "shutdown" }
	| { type: "noticeResult"; id: string; outcome: NoticeOutcome }
	| { type: "request"; id: number; method: WorkerMethod; args: unknown[] }
	| { type: "site-result"; id: number; ok: true; value: unknown }
	| { type: "site-result"; id: number; ok: false; error: string };

export type WorkerMethod =
	| "fileBytes"
	| "proofBytes"
	| "postingLink"
	| "formLink"
	| "dataExport"
	| "interviewEvent"
	| "status"
	| "scanNow"
	| "setPaused"
	| "diagnostics"
	| "dismissMatch";

export interface TrayStatus {
	state: "idle" | "scanning" | "paused" | "starting" | "error";
	lastScanAt: string | null;
	lastScanSummary: string | null;
	counts: { review: number; questions: number; applied: number; new: number };
	paused: boolean;
	/** The scan running now (its progress is `desktop.scan`), or null. */
	scanId?: string | null;
	error?: string;
}

export interface NativeNotice {
	title: string;
	body: string;
	/** Renderer path to open on click. */
	path: string;
	kind:
		| "match"
		| "question"
		| "review"
		| "stopped"
		| "followup"
		| "added"
		| "check";
	/** Shown only when the app's window is not in front (the user would see it there). */
	onlyIfUnfocused?: boolean;
	/** Set when the worker needs to know what macOS did with it: main answers `noticeResult`. */
	id?: string;
	/**
	 * Buttons in Notification Center, in order. Only these two exist: nothing a notification
	 * offers approves, prepares or sends (that is always done in the app).
	 */
	actions?: NoticeActionId[];
	/** The one match a "dismiss" button is about. */
	applicationId?: string;
}

/** Open: what a click does. Dismiss: Not interested on one match, as in the app. */
export type NoticeActionId = "open" | "dismiss";

/** What became of a notification: shown, refused by macOS, no answer, or not shown at all. */
export type NoticeOutcome = "delivered" | "blocked" | "unknown" | "skipped";

export type WorkerToMain =
	| { type: "ready" }
	| { type: "fatal"; error: string }
	| { type: "response"; id: number; ok: true; value: unknown }
	| { type: "response"; id: number; ok: false; error: string }
	| { type: "status"; status: TrayStatus }
	| { type: "notify"; notice: NativeNotice }
	| { type: "site"; id: number; call: SiteCall }
	/** Google's sign-in page for Gemini (Antigravity): main opens it in the browser. */
	| { type: "openSignIn"; url: string }
	| {
			type: "log";
			level: "info" | "warn" | "error";
			message: string;
			data?: unknown;
	  };
