import { isPrivateAddress } from "@offerfinch/core/sources/link";
import {
	app,
	type BrowserWindow,
	type Session,
	session,
	WebContentsView,
} from "electron";
import {
	IPC,
	SITE_TABS,
	type SiteBounds,
	type SitePageInfo,
	type SiteSheetMode,
	type SiteShowResult,
	type SiteTabId,
} from "../shared/bridge";
import type { SiteCall, SiteSnapshot } from "../shared/worker-protocol";
import { snapshotScript } from "./page-read";

/** Each site's name and sign-in page (none: DuckDuckGo's results pages need no account). */
const SITES: Record<SiteTabId, { label: string; login: string | null }> = {
	linkedin: { label: "LinkedIn", login: "https://www.linkedin.com/login" },
	indeed: { label: "Indeed", login: "https://secure.indeed.com/auth" },
	glassdoor: {
		label: "Glassdoor",
		login: "https://www.glassdoor.com/profile/login_input.htm",
	},
	duckduckgo: { label: "DuckDuckGo", login: null },
	web: { label: "Web", login: null },
};

/** Reads run in their own JavaScript world: the page's scripts cannot see or change them. */
const READ_WORLD = 1_001;
const NAVIGATION_TIMEOUT_MS = 60_000;

interface Tab {
	site: SiteTabId;
	view: WebContentsView;
	/** The main frame's last HTTP status. */
	status: number | null;
	/** A run holds the tab (claimed by the worker). */
	run: boolean;
	/** The worker process (its generation) whose run holds the tab. */
	owner: number | null;
	/** The sheet showing it, if any, and the window it is attached to. */
	sheet: SiteSheetMode | null;
	window: BrowserWindow | null;
	idleTimer: NodeJS.Timeout | null;
	/** The current load reached a private address (web tab): it is stopped and never read. */
	refused: string | null;
	/** The current load's redirects (main frame), in order. */
	redirects: string[];
	/**
	 * Web tab: the page the run asked for. Any other main-frame navigation (an HTTP, meta or
	 * script redirect) is cancelled before its request and handed back as `redirect`, for the
	 * worker to authorize and open itself.
	 */
	expected: string | null;
	redirect: string | null;
	/** Web tab: this open's one main-frame request has been let through. */
	authorized: boolean;
}

export interface SiteBrowserOptions {
	/**
	 * Test runs only: each site's local stand-in. Its tab loads that origin and nothing else, and
	 * its sign-in page is the stand-in's.
	 */
	testOrigins?: Partial<Record<SiteTabId, string>>;
	/**
	 * Test runs: a site without a stand-in loads nothing, so a test never reaches a real site.
	 * Off only for a run made against the real sites on purpose (OFFERFINCH_REAL_SITES=1).
	 */
	blockReal?: boolean;
	/** Test runs: never move keyboard focus (the window is never put on screen). */
	quiet?: boolean;
	log: (message: string, data?: unknown) => void;
}

/**
 * The site readers' browser: one hidden tab per site (a WebContentsView attached to no window)
 * in Electron's own Chromium, on the site's own session partition `persist:site-<id>`, so a
 * sign-in made in the sheet is the session the runs use. No external browser is started.
 *
 * Every tab: no preload, no Node, context isolation and the sandbox on, every permission refused,
 * downloads cancelled, pop-ups loaded in the same tab (or refused during a run), no <webview>,
 * and Electron's default user agent. Nothing hides or disguises the automation (PLAN rule 4).
 * Operations on a site run one at a time, in order. The worker sends only navigate, wait, read:
 * the read is a fixed function here, never script from elsewhere.
 */
export class SiteBrowser {
	private readonly tabs = new Map<SiteTabId, Tab>();
	private readonly queues = new Map<SiteTabId, Promise<unknown>>();
	private readonly hardened = new Set<SiteTabId>();
	/** Worker processes that have exited: their calls still queued are refused. */
	private readonly gone = new Set<number>();

	/**
	 * Why no tab may open now (try-it mode and its switch: main/demo-actions.ts), else null. A
	 * sign-in sheet and a run's claim are refused with it; closeAll() closes the ones open.
	 */
	private blocked: string | null = null;

	constructor(private readonly options: SiteBrowserOptions) {}

	/**
	 * Refuses every new tab (sheets and runs) and every operation on a site's session (sign out,
	 * reads, clearing) with `reason` until called with null.
	 */
	block(reason: string | null) {
		this.blocked = reason;
	}

	static partition(site: SiteTabId): string {
		return `persist:site-${site}`;
	}

	loginUrl(site: SiteTabId): string | null {
		const login = SITES[site].login;
		if (!login) return null;
		const stand = this.options.testOrigins?.[site];
		// The stand-in's sign-in page, on a path the site's detector knows as one.
		if (stand)
			return `${stand}${
				site === "linkedin"
					? "/authwall?trk=sign-in"
					: site === "indeed"
						? "/auth"
						: "/profile/login_input.htm"
			}`;
		return login;
	}

	/** The site's session, locked down the first time it is used. */
	private session(site: SiteTabId): Session {
		const ses = session.fromPartition(SiteBrowser.partition(site));
		if (this.hardened.has(site)) return ses;
		this.hardened.add(site);
		ses.setPermissionRequestHandler((_wc, _permission, callback) =>
			callback(false),
		);
		ses.setPermissionCheckHandler(() => false);
		ses.setDevicePermissionHandler(() => false);
		ses.on("will-download", (event, item) => {
			event.preventDefault();
			this.options.log("site download refused", {
				site,
				file: item.getFilename(),
			});
		});
		const only = this.options.testOrigins?.[site];
		const nothing = !only && Boolean(this.options.blockReal);
		// Web search's pages are on any site: none may reach this Mac or a private network, by its
		// name or by any address the name resolves to, on every request (redirects and a page's
		// own requests included).
		const guard = site === "web" && !only ? privateGuard(ses) : null;
		ses.webRequest.onBeforeRequest((details, callback) => {
			const url = details.url;
			const tab = this.alive(site);
			const decision = tab
				? readOnlyNavigation(tab, {
						url,
						method: details.method,
						resourceType: details.resourceType,
					})
				: "allow";
			if (decision === "authorize" && tab) tab.authorized = true;
			else if (decision === "redirect" && tab) {
				tab.redirect ??= url;
				return callback({ cancel: true });
			} else if (decision === "send" && tab) {
				this.options.log("page-initiated request refused while reading", {
					site,
					method: details.method,
					type: details.resourceType,
				});
				// Only the page's own navigation empties it; a refused script or frame request does not.
				if (site === "web" && details.resourceType === "mainFrame")
					tab.refused ??= "the page tried to send a form";
				return callback({ cancel: true });
			}
			// Web pages only: never the app's own origin, files or browser pages.
			if (!/^(?:https?|wss?|data|blob|about):/i.test(url))
				return callback({ cancel: true });
			if (guard && /^(?:https?|wss?):/i.test(url)) {
				void guard(url).then((refused) => {
					if (refused)
						this.options.log("web page refused: private address", { site });
					callback(refused ? { cancel: true } : {});
				});
				return;
			}
			// Test runs: the stand-in only (or nothing), so a run never reaches the real site.
			if ((only || nothing) && /^(?:https?|wss?):/i.test(url)) {
				const origin = new URL(url).origin.replace(/^ws/, "http");
				if (nothing || origin !== only) return callback({ cancel: true });
			}
			callback({});
		});
		if (site === "web") {
			// No service worker: its script is refused, so no page can install one that answers
			// the next navigation or sends from the background (its storage is cleared per run).
			ses.webRequest.onBeforeSendHeaders((details, callback) => {
				const sw = Object.keys(details.requestHeaders).some(
					(h) => h.toLowerCase() === "service-worker",
				);
				if (sw) {
					this.options.log("service worker refused", { site });
					return callback({ cancel: true });
				}
				callback({ requestHeaders: details.requestHeaders });
			});
			// Where each response really came from (the address connected to): a private one stops
			// the load, and the page is never handed to the reader. The redirects are reported.
			const seen = (details: {
				ip?: string;
				resourceType?: string;
				redirectURL?: string;
			}) => {
				const tab = this.alive(site);
				if (!tab) return;
				if (details.resourceType === "mainFrame" && details.redirectURL)
					tab.redirects.push(details.redirectURL);
				if (guard && details.ip && isPrivateAddress(details.ip)) {
					tab.refused = "it reached a private network address";
					this.options.log("web page refused: private address", { site });
					if (!tab.view.webContents.isDestroyed()) tab.view.webContents.stop();
				}
			};
			ses.webRequest.onBeforeRedirect(seen);
			ses.webRequest.onResponseStarted(seen);
		}
		return ses;
	}

	private alive(site: SiteTabId): Tab | null {
		const tab = this.tabs.get(site);
		if (!tab) return null;
		if (tab.view.webContents.isDestroyed()) {
			this.tabs.delete(site);
			return null;
		}
		return tab;
	}

	private create(site: SiteTabId): Tab {
		this.session(site);
		const view = new WebContentsView({
			webPreferences: {
				partition: SiteBrowser.partition(site),
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				nodeIntegrationInSubFrames: false,
				nodeIntegrationInWorker: false,
				webSecurity: true,
				webviewTag: false,
				// No DevTools in a packaged build (security audit, 2026-11-03).
				devTools: !app.isPackaged,
				// A hidden tab still loads and runs at full speed.
				backgroundThrottling: false,
				spellcheck: false,
				// alert() in a tab nobody sees would hang the page.
				disableDialogs: true,
			},
		});
		const tab: Tab = {
			site,
			view,
			status: null,
			run: false,
			owner: null,
			sheet: null,
			window: null,
			idleTimer: null,
			refused: null,
			redirects: [],
			expected: null,
			redirect: null,
			authorized: false,
		};
		const wc = view.webContents;
		wc.setAudioMuted(true);
		// Pop-ups open in the same tab while you use it in a sheet; during a run they are refused.
		wc.setWindowOpenHandler(({ url }) => {
			if (!tab.run && /^https?:\/\//i.test(url))
				void wc.loadURL(url).catch(() => {});
			return { action: "deny" };
		});
		wc.on("will-attach-webview", (event) => event.preventDefault());
		wc.on("will-navigate", (event, url) => {
			if (!/^https?:\/\//i.test(url)) event.preventDefault();
		});
		wc.on("did-navigate", (_event, _url, code) => {
			tab.status = code > 0 ? code : null;
		});
		const changed = () => this.sendPage(tab);
		for (const event of [
			"did-navigate",
			"did-navigate-in-page",
			"page-title-updated",
			"did-start-loading",
			"did-stop-loading",
		] as const)
			wc.on(event as "did-start-loading", changed);
		wc.on("render-process-gone", (_event, details) => {
			this.options.log("site tab gone", { site, reason: details.reason });
			this.close(tab);
		});
		this.tabs.set(site, tab);
		return tab;
	}

	private info(tab: Tab): SitePageInfo {
		const wc = tab.view.webContents;
		return {
			site: tab.site,
			url: wc.isDestroyed() ? "" : wc.getURL(),
			title: wc.isDestroyed() ? "" : wc.getTitle(),
			loading: wc.isDestroyed() ? false : wc.isLoading(),
		};
	}

	/** Tells the sheet showing the tab where it is now. */
	private sendPage(tab: Tab) {
		const win = tab.window;
		if (!win || win.isDestroyed()) return;
		win.webContents.send(IPC.sitePage, this.info(tab));
	}

	private close(tab: Tab) {
		if (tab.idleTimer) clearTimeout(tab.idleTimer);
		this.detach(tab);
		if (this.tabs.get(tab.site) === tab) this.tabs.delete(tab.site);
		if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
	}

	private detach(tab: Tab) {
		const win = tab.window;
		tab.window = null;
		tab.sheet = null;
		if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view);
	}

	/** Runs one operation on a site after the ones before it. */
	private enqueue<T>(site: SiteTabId, fn: () => Promise<T>): Promise<T> {
		const before = this.queues.get(site) ?? Promise.resolve();
		const next = before.catch(() => {}).then(fn);
		this.queues.set(site, next);
		return next;
	}

	private held(site: SiteTabId, generation: number): Tab {
		const tab = this.alive(site);
		if (!tab?.run || tab.owner !== generation)
			throw new Error(`${SITES[site].label}'s tab is not open for this run`);
		return tab;
	}

	/** A run takes the site's tab (opened if needed); refused while one is blocked or in use. */
	private async claim(site: SiteTabId, generation: number): Promise<true> {
		// Web search starts each run clean: no cookies, storage, caches or service worker a
		// page of an earlier run left behind. Never while blocked (handle() refused it already).
		if (this.blocked) throw new Error(this.blocked);
		if (site === "web" && !this.alive(site)?.run) {
			const ses = this.session(site);
			// The HTTP cache too: a page cached by an earlier run would be served without
			// a request, skipping this run's checks.
			await ses.clearCache().catch(() => {});
			await ses
				.clearStorageData({
					storages: [
						"cookies",
						"filesystem",
						"indexdb",
						"localstorage",
						"shadercache",
						"serviceworkers",
						"cachestorage",
					],
				})
				.catch(() => {});
		}
		// Checked after the clearing above: a block set meanwhile still holds.
		if (this.blocked) throw new Error(this.blocked);
		const current = this.alive(site);
		if (current?.sheet === "sign-in")
			throw new Error(
				`The ${SITES[site].label} sign-in sheet is open: close it, then run again`,
			);
		if (current?.run)
			throw new Error(`${SITES[site].label} is already being read`);
		const tab = current ?? this.create(site);
		if (tab.idleTimer) clearTimeout(tab.idleTimer);
		tab.run = true;
		tab.owner = generation;
		this.sendPage(tab);
		return true;
	}

	/**
	 * One operation a worker process asked for; `generation` says which one. A claim belongs to
	 * that process: when it exits (`workerGone`) its claims are let go and its queued calls
	 * refused, so a restarted worker finds the tabs free.
	 */
	handle(call: SiteCall, generation = 0): Promise<unknown> {
		const site = call.site;
		return this.enqueue(site, async () => {
			if (this.gone.has(generation))
				throw new Error("The worker that asked has stopped");
			// Try-it mode and its switch (block()): no call reaches a site's session, which is the
			// real one with its sign-in (no sign out, read, clearing or claim). Checked when the call
			// runs, so one queued before the block is refused too. Letting a run's tab go and
			// closing an idle tab touch no session.
			if (this.blocked && call.op !== "release" && call.op !== "closeIdle")
				throw new Error(this.blocked);
			switch (call.op) {
				case "claim":
					return this.claim(site, generation);
				case "release": {
					const tab = this.alive(site);
					// Only the run's own process lets it go.
					if (!tab?.run || tab.owner !== generation) return true;
					tab.run = false;
					tab.owner = null;
					// Someone is watching: the tab stays until the sheet closes.
					if (tab.sheet) this.sendPage(tab);
					else this.close(tab);
					return true;
				}
				case "navigate":
					return this.navigate(this.held(site, generation), call.url);
				case "waitFor":
					return this.waitFor(
						this.held(site, generation),
						call.selector,
						call.timeoutMs,
					);
				case "snapshot": {
					const tab = this.alive(site);
					if (!tab) throw new Error(`${SITES[site].label}'s tab is closed`);
					return this.snapshot(tab, call.exclude);
				}
				case "closeIdle": {
					const tab = this.alive(site);
					if (tab && !tab.run && !tab.sheet) this.close(tab);
					return true;
				}
				case "signOut": {
					const tab = this.alive(site);
					if (tab?.run)
						throw new Error(
							`${SITES[site].label} is being read now; sign out after the run`,
						);
					if (tab) this.close(tab);
					const ses = this.session(site);
					await ses.clearStorageData();
					await ses.clearCache();
					await ses.clearAuthCache();
					return true;
				}
			}
		});
	}

	private async navigate(
		tab: Tab,
		url: string,
	): Promise<{
		url: string;
		status: number | null;
		redirects: string[];
		refused?: string;
		redirect?: string;
	}> {
		if (!/^https?:\/\//i.test(url) || url.length > 4_000)
			throw new Error("Only web pages are opened");
		const wc = tab.view.webContents;
		tab.status = null;
		tab.refused = null;
		tab.redirects = [];
		tab.redirect = null;
		tab.authorized = false;
		if (tab.site === "web") tab.expected = new URL(url).href;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				if (!wc.isDestroyed()) wc.stop();
				reject(new Error("The page did not load within 60 seconds"));
			}, NAVIGATION_TIMEOUT_MS);
		});
		try {
			await Promise.race([
				wc.loadURL(url).catch((error: { code?: string; message?: string }) => {
					// The web tab stopped a redirect: where it headed is the result.
					if (tab.redirect) return;
					// A script redirect replaced this load: the page it went to is the result.
					if (String(error?.code ?? error?.message).includes("ERR_ABORTED"))
						return;
					throw error;
				}),
				timeout,
			]);
		} finally {
			clearTimeout(timer);
		}
		return {
			url: wc.getURL(),
			status: tab.status,
			redirects: [...tab.redirects],
			...(tab.refused ? { refused: tab.refused } : {}),
			...(tab.redirect ? { redirect: tab.redirect } : {}),
		};
	}

	private async read<T>(tab: Tab, code: string): Promise<T> {
		return (await tab.view.webContents.executeJavaScriptInIsolatedWorld(
			READ_WORLD,
			[{ code }],
		)) as T;
	}

	private async waitFor(
		tab: Tab,
		selector: string,
		timeoutMs: number,
	): Promise<boolean> {
		if (selector.length > 1_000) throw new Error("Selector too long");
		const deadline =
			Date.now() + Math.max(0, Math.min(60_000, Number(timeoutMs) || 0));
		const code = `(() => { try { return Boolean(document.querySelector(${JSON.stringify(selector)})); } catch { return false; } })()`;
		for (;;) {
			const found = await this.read<boolean>(tab, code).catch(() => false);
			if (found) return true;
			if (Date.now() >= deadline) return false;
			await new Promise((r) => setTimeout(r, 250));
		}
	}

	/**
	 * The page as it is: its HTML, and the text it shows, for the readers' check and sign-in
	 * markers. The text is what the browser renders (an element `checkVisibility()` says is not
	 * shown, hidden or display:none, is left out with all it holds), without elements matching
	 * `exclude` (the posting's own words). Read in the isolated world; the page is not changed.
	 */
	private async snapshot(tab: Tab, exclude?: string): Promise<SiteSnapshot> {
		// A refused load is never read: nothing of it leaves this process. Nor is a page that
		// headed elsewhere (the worker opens the redirect itself, if it may).
		if (tab.refused || tab.redirect)
			return {
				url: tab.view.webContents.getURL(),
				status: tab.status,
				title: "",
				html: "",
				text: "",
				...(tab.refused ? { refused: tab.refused } : {}),
				...(tab.redirect ? { redirect: tab.redirect } : {}),
			};
		if (exclude && exclude.length > 1_000) throw new Error("Selector too long");
		const page = await this.read<{ html: string; title: string; text: string }>(
			tab,
			snapshotScript(exclude ?? ""),
		);
		return {
			url: tab.view.webContents.getURL(),
			status: tab.status,
			title: String(page?.title ?? ""),
			html: String(page?.html ?? ""),
			text: String(page?.text ?? ""),
		};
	}

	/**
	 * A worker process exited (killed or crashed mid-read): its runs are over. Their tabs close,
	 * unless a sheet shows one (it stays until the sheet closes), and calls it still had queued
	 * are refused.
	 */
	workerGone(generation: number) {
		this.gone.add(generation);
		for (const tab of [...this.tabs.values()]) {
			if (!tab.run || tab.owner !== generation) continue;
			tab.run = false;
			tab.owner = null;
			if (tab.sheet) this.sendPage(tab);
			else this.close(tab);
		}
	}

	/* ------------------------------------------------------------ sheets */

	/**
	 * Attaches a site's view inside the window. Sign-in: the site's login page in its own session
	 * (refused while a run reads the site). Live: the very tab the run is using.
	 */
	show(
		site: SiteTabId,
		mode: SiteSheetMode,
		win: BrowserWindow,
		bounds: SiteBounds,
	): SiteShowResult {
		if (this.blocked) return { ok: false, reason: this.blocked };
		const label = SITES[site].label;
		const existing = this.alive(site);
		if (mode === "live" && !existing?.run && existing?.sheet !== "live")
			return { ok: false, reason: `Nothing is reading ${label} right now.` };
		if (mode === "sign-in" && existing?.run)
			return {
				ok: false,
				reason: `A run is reading ${label} now. Use Watch live to see it.`,
			};
		if (mode === "sign-in" && !SITES[site].login)
			return { ok: false, reason: `${label} needs no sign-in.` };
		// One sheet at a time.
		for (const other of this.tabs.values())
			if (other.site !== site && other.window) this.hide(other.site);
		const tab = existing ?? this.create(site);
		if (tab.idleTimer) clearTimeout(tab.idleTimer);
		if (tab.window !== win) {
			this.detach(tab);
			win.contentView.addChildView(tab.view);
		}
		tab.window = win;
		tab.sheet = mode;
		tab.view.setBounds(clampBounds(win, bounds));
		if (!this.options.quiet) tab.view.webContents.focus();
		const login = this.loginUrl(site);
		if (mode === "sign-in" && login)
			void this.enqueue(site, async () => {
				if (tab.sheet === "sign-in")
					await tab.view.webContents.loadURL(login).catch((error) =>
						this.options.log("sign-in page failed", {
							site,
							error: String(error),
						}),
					);
			});
		return { ok: true, page: this.info(tab) };
	}

	setBounds(site: SiteTabId, bounds: SiteBounds) {
		const tab = this.alive(site);
		if (!tab?.window || tab.window.isDestroyed()) return;
		tab.view.setBounds(clampBounds(tab.window, bounds));
	}

	/**
	 * Detaches the sheet's view. A run's tab keeps running hidden. A sign-in tab stays a minute,
	 * so the worker can read whether the sign-in worked, then closes.
	 */
	hide(site: SiteTabId) {
		const tab = this.alive(site);
		if (!tab) return;
		const mode = tab.sheet;
		this.detach(tab);
		if (tab.run) return;
		if (mode === "sign-in") {
			tab.idleTimer = setTimeout(() => {
				if (!tab.run && !tab.sheet) this.close(tab);
			}, 60_000);
		} else this.close(tab);
	}

	/** The window is closing: its sheets let go of their views first, so no run's tab goes with it. */
	detachAll(win: BrowserWindow) {
		for (const tab of [...this.tabs.values()])
			if (tab.window === win) this.hide(tab.site);
	}

	/** Closes every tab: a run's, a sheet's, and a sign-in tab kept after its sheet closed. */
	closeAll() {
		for (const tab of [...this.tabs.values()]) this.close(tab);
	}

	/** Test runs: what each tab is doing and where its view is. */
	describe() {
		return SITE_TABS.flatMap((site) => {
			const tab = this.alive(site);
			if (!tab) return [];
			const win = tab.window;
			return [
				{
					site,
					webContentsId: tab.view.webContents.id,
					run: tab.run,
					owner: tab.owner,
					sheet: tab.sheet,
					attached: Boolean(
						win &&
							!win.isDestroyed() &&
							win.contentView.children.includes(tab.view),
					),
					bounds: tab.view.getBounds(),
					content: win && !win.isDestroyed() ? win.getContentBounds() : null,
					url: tab.view.webContents.getURL(),
				},
			];
		});
	}

	/** Test runs: the tab's web contents, for the stand-in's own test controls and captures. */
	contents(site: SiteTabId) {
		return this.alive(site)?.view.webContents ?? null;
	}
}

/** The sheet's rectangle, in whole points, kept inside the window's content area. */
export function clampBounds(
	win: { getContentBounds(): { width: number; height: number } },
	bounds: SiteBounds,
): SiteBounds {
	const { width: maxW, height: maxH } = win.getContentBounds();
	const n = (v: unknown) => (Number.isFinite(v) ? Math.round(v as number) : 0);
	const x = Math.min(Math.max(0, n(bounds?.x)), maxW);
	const y = Math.min(Math.max(0, n(bounds?.y)), maxH);
	return {
		x,
		y,
		width: Math.min(Math.max(0, n(bounds?.width)), maxW - x),
		height: Math.min(Math.max(0, n(bounds?.height)), maxH - y),
	};
}

const PRIVATE_NAMES =
	/^(?:localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.(?:localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/i;

/**
 * True when a request would reach this Mac or a private network: by its host name, its literal
 * address, or any address the session's resolver gives for the name. The address a response
 * really came from is checked again when it starts (onResponseStarted, onBeforeRedirect).
 */
export function privateGuard(ses: {
	resolveHost(host: string): Promise<{ endpoints: { address: string }[] }>;
}): (url: string) => Promise<boolean> {
	// No answer is kept: a name that resolves to a public address now may resolve to a private
	// one on the next request. Whatever the resolver cannot answer is refused (fail closed).
	return async (url) => {
		let host: string;
		try {
			host = new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
		} catch {
			return true;
		}
		host = host.replace(/^\[|\]$/g, "");
		if (!host || PRIVATE_NAMES.test(host) || isPrivateAddress(host))
			return true;
		try {
			const { endpoints } = await ses.resolveHost(host);
			return (
				endpoints.length === 0 ||
				endpoints.some((e) => isPrivateAddress(e.address))
			);
		} catch {
			return true;
		}
	};
}

/** The URL without its fragment (never sent with a request). */
const withoutHash = (url: string) => {
	try {
		const u = new URL(url);
		u.hash = "";
		return u.href;
	} catch {
		return url;
	}
};

/** The page's origin, or null. */
const originOf = (url: string | null) => {
	try {
		return url ? new URL(url).origin : null;
	} catch {
		return null;
	}
};

/**
 * What a site tab does with a request while a run reads it (read only):
 * - A sheet open on LinkedIn, Indeed, Glassdoor or DuckDuckGo (Watch live, sign-in): `allow`.
 *   The user acts in the page (solves a check, signs in) and their requests go out; the rules
 *   below apply again once the sheet closes.
 * - Watch live on the web tab changes nothing: it shows any careers site, whose own scripts
 *   could otherwise submit a form while it is watched (security audit, 2026-11-03), and a page
 *   there with a check is skipped, never solved, so nothing in it needs the user to act.
 * - LinkedIn, Indeed, Glassdoor: a main-frame request that is not a GET (a form a page submits
 *   by itself) is refused (`send`). Their own scripts' requests go as they are: signed-in
 *   reads may need them. Their redirects are followed (regional hosts, search URLs).
 * - Web tab (any site on the web): nothing that writes goes out, of any kind (`send`: forms,
 *   frames, beacons, a service worker's fetch); no frame loads another origin (`send`); and
 *   exactly one main-frame request per open is the page asked for (`authorize`). Every other
 *   main-frame request (an HTTP, meta or script redirect, a redirect to the very same URL, a
 *   reload) is refused and reported (`redirect`), for the worker to authorize and open itself.
 */
export function readOnlyNavigation(
	tab: {
		site: SiteTabId;
		run: boolean;
		sheet: SiteSheetMode | null;
		expected: string | null;
		authorized: boolean;
	},
	request: { url: string; method: string; resourceType: string },
): "allow" | "authorize" | "redirect" | "send" {
	if (!tab.run || (tab.sheet && tab.site !== "web")) return "allow";
	const get = (request.method ?? "GET").toUpperCase() === "GET";
	const main = request.resourceType === "mainFrame";
	if (tab.site !== "web") return main && !get ? "send" : "allow";
	// A WebSocket opens with a GET, but what it sends after is never seen here.
	if (!get || request.resourceType === "webSocket") return "send";
	if (
		request.resourceType === "subFrame" &&
		originOf(request.url) !== originOf(tab.expected)
	)
		return "send";
	if (!main) return "allow";
	if (
		!tab.authorized &&
		tab.expected &&
		withoutHash(request.url) === withoutHash(tab.expected)
	)
		return "authorize";
	return "redirect";
}
