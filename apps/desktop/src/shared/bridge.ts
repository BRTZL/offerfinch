/**
 * The only API the renderer gets from the preload (`window.desktop`), besides the oRPC port.
 * Every call is a fixed IPC channel with checked arguments; nothing generic is exposed.
 */
export interface AppInfo {
	name: string;
	version: string;
	electron: string;
	chrome: string;
	node: string;
	arch: string;
	userData: string;
}

export interface LoginItemState {
	/** What the app asked for. */
	openAtLogin: boolean;
	/** What macOS reports (unsigned apps can be refused or need approval in Settings). */
	status:
		| "enabled"
		| "requires-approval"
		| "not-registered"
		| "not-found"
		| "unknown";
}

/** Every key the app keeps in the Keychain; main, the bridge and the store all check against it. */
export const SECRET_NAMES = ["anthropic", "openai"] as const;
/** Keys earlier versions stored and nothing reads any more (Brave Search): removed at start. */
export const RETIRED_SECRETS = ["brave"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export const isSecretName = (name: unknown): name is SecretName =>
	typeof name === "string" &&
	(SECRET_NAMES as readonly string[]).includes(name);

/**
 * Items a right-click menu may show (a fixed set, checked in main). There is no approve item:
 * an accidental click must not approve.
 */
export const CONTEXT_ITEMS = [
	"open",
	"open-posting",
	"copy-link",
	"answer",
	"reject",
	"open-pdf",
	"open-docx",
	"save-pdf",
	"edit",
	"show-source",
	"show-rendered",
	"copy-text",
	// A listed match: draft it, or set it aside (with optional reasons, in a popover).
	"prepare",
	"dismiss",
	// A job the job filter set aside: back to Matches, chosen anyway.
	"show-in-matches",
] as const;
export type ContextItemId = (typeof CONTEXT_ITEMS)[number];
export interface ContextItem {
	id: ContextItemId | "separator";
	label?: string;
	enabled?: boolean;
}

/**
 * The sites read in hidden tabs inside the app (main's SiteBrowser), each in its own session
 * partition `persist:site-<id>`. A fixed list: main checks every IPC argument against it.
 */
export const SITE_TABS = [
	"linkedin",
	"indeed",
	"glassdoor",
	// Job-board search's results pages: no sign-in, a tab only for its runs (and their checks).
	"duckduckgo",
	// Web search's result pages on any site: no sign-in, never waits on a check.
	"web",
] as const;
export type SiteTabId = (typeof SITE_TABS)[number];
export const isSiteTabId = (site: unknown): site is SiteTabId =>
	typeof site === "string" && (SITE_TABS as readonly string[]).includes(site);

/** The rectangle inside the window where the renderer's sheet leaves room for the site's view. */
export interface SiteBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Sign-in: the site's login page in its own session. Live: the tab a run is using right now. */
export type SiteSheetMode = "sign-in" | "live";

/** What the sheet's chrome shows about the attached page. */
export interface SitePageInfo {
	site: SiteTabId;
	url: string;
	title: string;
	loading: boolean;
}

export type SiteShowResult =
	| { ok: true; page: SitePageInfo }
	| { ok: false; reason: string };

/** Commands the menu bar sends to the window. */
export type AppCommand =
	| "command-menu"
	| "toggle-inspector"
	| "toggle-sidebar"
	| "add-job"
	| "shortcuts"
	| "export-diagnostics"
	| "whats-new";
export const APP_COMMANDS: readonly AppCommand[] = [
	"command-menu",
	"toggle-inspector",
	"toggle-sidebar",
	"add-job",
	"shortcuts",
	"export-diagnostics",
	"whats-new",
];

/**
 * Export Diagnostics' review sheet: the files main built and redacted, each with the start of
 * its text. `id` names the prepared bundle; Save writes exactly those files, nothing rebuilt.
 */
export interface DiagnosticsPreview {
	id: string;
	files: { name: string; bytes: number; preview: string; cut: boolean }[];
	/** Something could not be read (the worker); the bundle is still made without it. */
	warnings: string[];
}

/** The app's version and its bundled release notes (CHANGELOG.md in the app's resources). */
export interface ReleaseNotesSource {
	version: string;
	changelog: string;
}

/**
 * What notification delivery last showed. `unknown`: none sent yet; `delivered`: macOS showed
 * one; `blocked`: macOS refused (not allowed); `failed`: another error; `unsupported`: no
 * notifications here. `missed` counts notices that could not be shown.
 */
/** What a notification sounds like: OfferFinch's chirp, macOS's default sound, or silent. */
export const NOTIFICATION_SOUNDS = ["chirp", "default", "none"] as const;
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];

export interface NotificationState {
	status: "unknown" | "delivered" | "blocked" | "failed" | "unsupported";
	missed: number;
	lastError: string | null;
	at: string | null;
	sound: NotificationSound;
}

/**
 * Where an over-the-air update stands. `disabled`: this build does not update itself (a
 * development or test build); `downloading` and `ready` carry the new version.
 */
export type UpdateState =
	| { status: "disabled"; currentVersion: string; reason: string }
	| { status: "idle"; currentVersion: string }
	| { status: "checking"; currentVersion: string }
	| { status: "up-to-date"; currentVersion: string; checkedAt: string }
	| {
			status: "downloading";
			currentVersion: string;
			version: string;
			percent: number;
	  }
	| { status: "ready"; currentVersion: string; version: string }
	| {
			status: "error";
			currentVersion: string;
			error: string;
			checkedAt: string;
	  };

/** What a backup holds, as the restore confirmation shows it (counted from its database). */
export interface BackupSummary {
	createdAt: string;
	appVersion: string;
	jobs: number;
	applications: number;
	documents: number;
	answers: number;
	files: number;
	bytes: number;
}

export type BackupSaveResult =
	| { status: "saved"; name: string }
	| { status: "canceled" }
	| { status: "failed"; error: string };

/** A chosen backup, checked and unpacked, waiting for the user's confirmation. */
export type RestoreCheck =
	| { status: "ready"; id: string; summary: BackupSummary }
	| { status: "canceled" }
	| { status: "refused"; error: string };

export type RestoreResult =
	| { status: "restored"; safetyBackup: string }
	| { status: "failed"; error: string };

/** Entering or leaving try-it mode: done (the window reloads on its own), or why not. */
export type DemoResult = { ok: true } | { ok: false; error: string };

/** Whether the app shows the sample data, and why a leave did not finish (Leave tries again). */
export interface DemoStatus {
	demo: boolean;
	leaveFailed: string | null;
}

export interface DesktopBridge {
	info(): Promise<AppInfo>;
	/**
	 * Opens an http(s) link in the default browser. Anything else is refused. In try-it mode no
	 * link opens (`onLinkRefused` is called instead).
	 */
	openExternal(url: string): Promise<void>;
	/** Writes an exported file (PDF, DOCX) to a temp file and opens it in its default app. */
	openDocument(documentId: string): Promise<void>;
	/** Saves an exported file or proof screenshot where the user picks. */
	saveDocument(documentId: string): Promise<boolean>;
	/** Saves "Download everything" JSON where the user picks. */
	saveDataExport(): Promise<boolean>;
	/**
	 * Backup and restore of the whole data folder's database and files (main/backup.ts). The
	 * renderer passes no paths: main asks with its own dialogs.
	 */
	/**
	 * Try-it mode (sample data in a folder of its own, docs/decisions.md 2026-11-05). Entering
	 * and leaving restart the worker and reload every window at Home.
	 */
	demo: {
		/** Whether the app runs on the sample data now (or a leave is unfinished). */
		state(): Promise<DemoStatus>;
		enter(): Promise<DemoResult>;
		/** Deletes the sample data and goes back to the real data (or the first-run welcome). */
		leave(): Promise<DemoResult>;
	};
	backup: {
		/** Saves a backup zip where the user picks. */
		save(): Promise<BackupSaveResult>;
		/** Asks for a backup zip and checks it; nothing is replaced yet. */
		check(): Promise<RestoreCheck>;
		/** The user said no: the unpacked backup is removed. */
		discard(id: string): Promise<void>;
		/** Replaces the data with the checked backup, after a safety backup of the current one. */
		restore(id: string): Promise<RestoreResult>;
	};
	/**
	 * Saves an interview stage as an .ics file where the user picks, then opens it in Calendar
	 * (which asks where to add it). No calendar access, no network. The saved file's name, or
	 * null when the user cancelled.
	 */
	saveInterviewEvent(stageId: string): Promise<string | null>;
	/** Opens a submission screenshot in the default viewer. */
	openProof(attemptId: string, which: "before" | "after"): Promise<void>;
	/** Help › Export Diagnostics: builds and redacts the bundle, then saves it where the user picks. */
	diagnostics: {
		prepare(): Promise<DiagnosticsPreview>;
		/** Resolves false when the user cancelled the save panel. */
		save(id: string): Promise<boolean>;
		discard(id: string): Promise<void>;
	};
	/** The version running and the release notes bundled with it (What's new). */
	releaseNotes(): Promise<ReleaseNotesSource>;
	secrets: {
		/** Encrypted with macOS Keychain (safeStorage) and given to the worker in memory only. */
		set(name: SecretName, value: string): Promise<void>;
		remove(name: SecretName): Promise<void>;
		/** Which keys are stored; never the values. */
		status(): Promise<Record<SecretName, boolean>>;
		/** False when Keychain encryption is unavailable (keys are then refused, never stored plain). */
		available(): Promise<boolean>;
		/**
		 * Keys stored but no longer readable: encrypted under another Keychain item (a
		 * differently signed build's). They must be entered again.
		 */
		unreadable(): Promise<SecretName[]>;
	};
	/** Opens System Settings › General › Login Items. */
	openLoginItems(): Promise<void>;
	loginItem: {
		get(): Promise<LoginItemState>;
		set(openAtLogin: boolean): Promise<LoginItemState>;
	};
	notifications: {
		/** Sends a real test notification; resolves with what macOS did with it. */
		test(): Promise<NotificationState>;
		/** The state delivery last showed. */
		state(): Promise<NotificationState>;
		/** Opens System Settings › Notifications. */
		openSettings(): Promise<void>;
		/** The in-app notice about missed notifications was seen. */
		clearMissed(): Promise<NotificationState>;
		/** Chooses the notification sound. */
		setSound(sound: NotificationSound): Promise<NotificationState>;
		/**
		 * Plays the chirp for a moment worth one (setup: AI connected, the first matches), when
		 * the chirp is the chosen sound. Resolves with whether it played.
		 */
		chirp(): Promise<boolean>;
	};
	updates: {
		state(): Promise<UpdateState>;
		/** Checks GitHub Releases now; a found update downloads in the background. */
		check(): Promise<UpdateState>;
		/** Restarts into the downloaded update. */
		install(): Promise<boolean>;
		/** Called whenever the update state changes. Returns an unsubscribe. */
		onChange(callback: (state: UpdateState) => void): () => void;
	};
	/** Called when a notification or the tray asks to show a page. Returns an unsubscribe. */
	onNavigate(callback: (path: string) => void): () => void;
	/** Puts text on the clipboard (the page itself has no clipboard permission). */
	copyText(text: string): Promise<void>;
	/** The clipboard's text if it is one http(s) link; null otherwise (nothing else is read out). */
	clipboardLink(): Promise<string | null>;
	/** Shows a native right-click menu at the pointer; resolves with the chosen item or null. */
	contextMenu(items: ContextItem[]): Promise<ContextItemId | null>;
	/** Called when a menu bar item asks the window to do something. */
	onCommand(callback: (command: AppCommand) => void): () => void;
	/**
	 * Site sheets: main attaches the site's own view (sign-in page, or the tab a run is using)
	 * inside the window at the bounds the sheet reports, and detaches it on hide.
	 */
	sites: {
		show(
			site: SiteTabId,
			mode: SiteSheetMode,
			bounds: SiteBounds,
		): Promise<SiteShowResult>;
		/** The sheet moved or resized: the view follows. */
		setBounds(site: SiteTabId, bounds: SiteBounds): void;
		hide(site: SiteTabId): Promise<void>;
		/** The attached page navigated or changed title. Returns an unsubscribe. */
		onPage(callback: (page: SitePageInfo) => void): () => void;
	};
	/** Asks main for a new port to the worker (after it restarted). */
	reconnect(): void;
	/** Called when the worker restarted; the renderer reconnects. */
	onWorkerRestart(callback: () => void): () => void;
	/** A link was not opened (try-it mode): why, for a toast. */
	onLinkRefused(callback: (message: string) => void): () => void;
	/** Whether the window is focused, shown and not minimised: motion runs only then. */
	onWindowActive(callback: (active: boolean) => void): () => void;
}

/** IPC channel names, shared by main and preload. */
export const IPC = {
	info: "app:info",
	/** The one theme source: main answers light or dark and tells the page when it changes. */
	themeGet: "theme:get",
	themeChanged: "theme:changed",
	windowActive: "window:active",
	openExternal: "app:open-external",
	openDocument: "files:open",
	saveDocument: "files:save",
	saveDataExport: "files:save-export",
	backupSave: "backup:save",
	backupCheck: "backup:check",
	backupDiscard: "backup:discard",
	backupRestore: "backup:restore",
	demoState: "demo:state",
	demoEnter: "demo:enter",
	demoLeave: "demo:leave",
	saveInterviewEvent: "files:save-interview",
	openProof: "files:proof",
	diagnosticsPrepare: "diagnostics:prepare",
	diagnosticsSave: "diagnostics:save",
	diagnosticsDiscard: "diagnostics:discard",
	releaseNotes: "app:release-notes",
	secretSet: "secrets:set",
	secretRemove: "secrets:remove",
	secretStatus: "secrets:status",
	secretAvailable: "secrets:available",
	secretUnreadable: "secrets:unreadable",
	openLoginItems: "app:open-login-items",
	loginGet: "login:get",
	loginSet: "login:set",
	notifyTest: "notify:test",
	notifyState: "notify:state",
	notifyOpenSettings: "notify:open-settings",
	notifyClearMissed: "notify:clear-missed",
	notifySetSound: "notify:set-sound",
	notifyChirp: "notify:chirp",
	rpcConnect: "rpc:connect",
	rpcPort: "rpc:port",
	navigate: "app:navigate",
	command: "app:command",
	contextMenu: "app:context-menu",
	copyText: "app:copy-text",
	clipboardLink: "app:clipboard-link",
	workerRestart: "app:worker-restart",
	linkRefused: "app:link-refused",
	updateState: "update:state",
	updateCheck: "update:check",
	updateInstall: "update:install",
	updateChanged: "update:changed",
	siteShow: "sites:show",
	siteBounds: "sites:bounds",
	siteHide: "sites:hide",
	sitePage: "sites:page",
} as const;

/** The message the preload posts to the page with the oRPC port. */
export const RPC_PORT_MESSAGE = "offerfinch:rpc-port";
