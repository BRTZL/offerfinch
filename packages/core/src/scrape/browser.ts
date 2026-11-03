import { readOnlyDecision } from "../apply/network-guard";

/**
 * Browser abstraction shared by desktop site reads and headless browser safety tests.
 * Implemented by the desktop browser bridge and Playwright test adapters.
 * No stealth or bot-detection evasion is ever configured here.
 */

export interface UploadFile {
	name: string;
	mimeType: string;
	buffer: Uint8Array;
}

export interface NavigationResult {
	/** HTTP status of the main document, or null when the browser could not tell. */
	status: number | null;
	url: string;
}

export interface GotoOptions {
	timeoutMs?: number;
	waitUntil?: "load" | "domcontentloaded" | "networkidle";
	/**
	 * Called with each top-level redirect destination (HTTP 3xx, or a navigation the page starts
	 * while loading) before it is fetched. Throwing stops the navigation with that error.
	 */
	beforeRedirect?: (url: string) => Promise<void>;
}

export interface BrowserPage {
	goto(url: string, options?: GotoOptions): Promise<NavigationResult>;
	content(): Promise<string>;
	title(): Promise<string>;
	url(): string;
	waitForSelector(
		selector: string,
		options?: { timeoutMs?: number },
	): Promise<void>;
	click(selector: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	selectOption(selector: string, value: string): Promise<void>;
	check(selector: string): Promise<void>;
	uncheck(selector: string): Promise<void>;
	setInputFiles(selector: string, files: UploadFile[]): Promise<void>;
	screenshot(options?: { fullPage?: boolean }): Promise<Uint8Array>;
	/** Loads HTML directly (used to print documents). */
	setContent(html: string): Promise<void>;
	/** Prints the page to PDF, honouring the page's CSS `@page` size and margins. */
	pdf(): Promise<Uint8Array>;
	/** Runs a script (an expression, as a string) in the page and returns its JSON result. */
	evaluate<T>(script: string): Promise<T>;
	/** Types text key by key, as a person would (comboboxes that filter on input). */
	type(selector: string, text: string): Promise<void>;
	press(selector: string, key: string): Promise<void>;
	waitForTimeout(ms: number): Promise<void>;
	/** Waits until the page has had no requests for a moment, at most `timeoutMs`; never throws. */
	waitForNetworkIdle(timeoutMs: number): Promise<void>;
	/**
	 * Tightens what the page may send. Only on sessions opened with a guarded network
	 * ("read_only" or "none"); it can only ever get stricter.
	 */
	restrictNetwork(mode: "read_only" | "none"): void;
	/** Every request a guarded page made, with the guard's decision. Empty on open sessions. */
	networkLog(): NetworkLogEntry[];
	close(): Promise<void>;
}

export interface NetworkLogEntry {
	method: string;
	url: string;
	allowed: boolean;
	reason: string;
}

export interface BrowserSession {
	newPage(): Promise<BrowserPage>;
	close(): Promise<void>;
}

/**
 * How much a session may do. Content the pipeline generated (documents printed to PDF) is
 * untrusted: it runs with scripts off and every network request aborted, so nothing in it can
 * fetch a URL and leak profile data.
 */
export interface SessionOptions {
	/** Default true. */
	javaScriptEnabled?: boolean;
	/**
	 * "none" aborts every request the page makes; "read_only" lets only GET, HEAD and GraphQL
	 * queries through (`readOnlyDecision`). "allowlist" (a real submission) keeps the page on
	 * `allowedHosts`: a top-level navigation or redirect elsewhere, and any request that sends
	 * data (every method but GET and HEAD, uploads included) to another host, is aborted and
	 * recorded as a violation; reads from other hosts (scripts, images) still load. Guarded
	 * sessions also block service workers and close WebSockets (in "allowlist", those to other
	 * hosts) and close pop-up windows, so nothing slips past the request filter. Default "open".
	 */
	network?: "open" | "read_only" | "none" | "allowlist" | "pinned";
	/** Hosts an "allowlist" session may navigate to and send data to. */
	allowedHosts?: string[];
	/**
	 * "pinned" (a page a user linked, from anywhere): the browser has no network of its own (it
	 * is started behind a proxy that refuses everything, with every host name unresolvable), and
	 * every request the page makes, of any kind (documents, frames, scripts, images, fetches,
	 * redirects, late navigations), is fetched by this function, which checks and pins its
	 * destination, and fulfilled from its answer. Only GET and HEAD; WebSockets, pop-ups and
	 * service workers are refused.
	 */
	fetcher?: PinnedFetcher;
}

export type PinnedFetcher = (request: {
	url: string;
	method: "GET" | "HEAD";
	headers: Record<string, string>;
}) => Promise<{
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}>;

/**
 * Chrome flags for a "pinned" session: no network of its own. Direct connections go to a proxy
 * that is not there, host names never resolve, and WebRTC sends nothing outside the proxy.
 */
export const NO_NETWORK_ARGS = [
	"--proxy-server=http://127.0.0.1:9",
	"--proxy-bypass-list=<-loopback>",
	"--host-resolver-rules=MAP * ~NOTFOUND",
	"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
	"--disable-background-networking",
	"--dns-prefetch-disable",
];

/** True when `url` is http(s) on one of `hosts` (hostname match, any port). */
export function urlOnHosts(url: string, hosts: string[]): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			return false;
		return hosts.includes(parsed.hostname);
	} catch {
		return false;
	}
}

/** The reason recorded for a request an "allowlist" session refused. */
export const DESTINATION_REFUSED = "destination not allowed";

export const UNTRUSTED_CONTENT: SessionOptions = {
	javaScriptEnabled: false,
	network: "none",
};

export interface BrowserProvider {
	readonly name: string;
	/** Launches with `NO_NETWORK_ARGS` for "pinned" sessions; other providers refuse them. */
	readonly isolates?: boolean;
	openSession(options?: SessionOptions): Promise<BrowserSession>;
}

/* Structural subset of the Playwright API, satisfied by both `playwright` and `@cloudflare/playwright`. */

interface PlaywrightResponseLike {
	status(): number;
}

interface PlaywrightFetchResponseLike {
	status(): number;
	headers(): Record<string, string>;
}

interface PlaywrightWebSocketRouteLike {
	close(): Promise<void> | void;
	url(): string;
	connectToServer?(): unknown;
}

interface PlaywrightRouteLike {
	request(): {
		url(): string;
		method(): string;
		postData(): string | null;
		isNavigationRequest(): boolean;
		frame(): unknown;
		headers?(): Record<string, string>;
	};
	continue(): Promise<void>;
	abort(errorCode?: string): Promise<void>;
	fetch(options?: {
		maxRedirects?: number;
	}): Promise<PlaywrightFetchResponseLike>;
	/** `response` is the object `fetch` returned, passed back opaquely. */
	fulfill(options: {
		response?: never;
		status?: number;
		headers?: Record<string, string>;
		body?: Buffer;
	}): Promise<void>;
}

interface PlaywrightPageLike {
	goto(
		url: string,
		options?: {
			timeout?: number;
			waitUntil?: "load" | "domcontentloaded" | "networkidle";
		},
	): Promise<PlaywrightResponseLike | null>;
	content(): Promise<string>;
	title(): Promise<string>;
	url(): string;
	waitForSelector(
		selector: string,
		options?: { timeout?: number },
	): Promise<unknown>;
	click(selector: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	selectOption(selector: string, value: string): Promise<unknown>;
	check(selector: string): Promise<void>;
	uncheck(selector: string): Promise<void>;
	setInputFiles(
		selector: string,
		files: { name: string; mimeType: string; buffer: Buffer }[],
	): Promise<void>;
	screenshot(options?: { fullPage?: boolean }): Promise<Uint8Array>;
	setContent(
		html: string,
		options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" },
	): Promise<void>;
	pdf(options?: {
		preferCSSPageSize?: boolean;
		printBackground?: boolean;
	}): Promise<Uint8Array>;
	close(): Promise<void>;
	route(
		url: string,
		handler: (route: PlaywrightRouteLike) => Promise<void>,
	): Promise<unknown>;
	unroute(
		url: string,
		handler?: (route: PlaywrightRouteLike) => Promise<void>,
	): Promise<void>;
	mainFrame(): unknown;
	evaluate(script: string): Promise<unknown>;
	pressSequentially?(selector: string, text: string): Promise<void>;
	type?(selector: string, text: string): Promise<void>;
	press(selector: string, key: string): Promise<void>;
	waitForTimeout(ms: number): Promise<void>;
	waitForLoadState(
		state: "networkidle",
		options?: { timeout?: number },
	): Promise<void>;
	routeWebSocket?(
		url: RegExp,
		handler: (ws: PlaywrightWebSocketRouteLike) => unknown,
	): Promise<void>;
}

const MAX_REDIRECTS = 10;

interface PlaywrightContextLike {
	newPage(): Promise<PlaywrightPageLike>;
	close(): Promise<void>;
	on?(
		event: "page",
		handler: (page: {
			close(): Promise<void>;
			opener(): Promise<unknown>;
		}) => void,
	): void;
}

export interface PlaywrightBrowserLike {
	newContext(options?: {
		userAgent?: string;
		locale?: string;
		javaScriptEnabled?: boolean;
		serviceWorkers?: "allow" | "block";
		viewport?: { width: number; height: number };
	}): Promise<PlaywrightContextLike>;
	close(): Promise<void>;
}

type GuardMode = "open" | "read_only" | "none" | "allowlist" | "pinned";

class PlaywrightPage implements BrowserPage {
	private readonly log: NetworkLogEntry[] = [];
	private mode: GuardMode;
	/** "pinned": the main frame has its document; later navigations are refused. */
	private landed = false;

	constructor(
		private readonly page: PlaywrightPageLike,
		mode: GuardMode = "open",
		private readonly allowedHosts: string[] = [],
		private readonly fetcher?: PinnedFetcher,
	) {
		this.mode = mode;
	}

	/** "pinned": every http(s) request is fetched by the checking, pinning fetcher. */
	private async pinnedRoute(route: PlaywrightRouteLike): Promise<void> {
		const request = route.request();
		const method = request.method();
		const url = request.url();
		// data: and blob: stay inside the browser; nothing else is allowed out.
		if (/^(?:data|blob|about):/.test(url)) return route.continue();
		if (!/^https?:/.test(url) || (method !== "GET" && method !== "HEAD")) {
			this.log.push({ method, url, allowed: false, reason: "not a read" });
			return route.abort("blockedbyclient");
		}
		const fetcher = this.fetcher;
		if (!fetcher) return route.abort("blockedbyclient");
		// The page is read where it first landed: a later navigation of the main frame (a timer,
		// a script) is answered "no content", so it fetches nothing and the page stays.
		const mainNavigation =
			request.isNavigationRequest() &&
			request.frame() === this.page.mainFrame();
		if (mainNavigation && this.landed) {
			this.log.push({ method, url, allowed: false, reason: "late navigation" });
			return route.fulfill({ status: 204, headers: {}, body: Buffer.alloc(0) });
		}
		try {
			const headers = { ...(request.headers?.() ?? {}) };
			for (const name of Object.keys(headers))
				if (/^(?:host|connection|accept-encoding|cookie)$/i.test(name))
					delete headers[name];
			const response = await fetcher({ url, method, headers });
			this.log.push({
				method,
				url,
				allowed: true,
				reason: "checked and pinned",
			});
			if (mainNavigation && (response.status < 300 || response.status >= 400))
				this.landed = true;
			const out = { ...response.headers };
			// The body is already decoded and whole.
			delete out["content-encoding"];
			delete out["transfer-encoding"];
			delete out["content-length"];
			return route.fulfill({
				status: response.status,
				headers: out,
				body: response.body,
			});
		} catch (error) {
			this.log.push({
				method,
				url,
				allowed: false,
				reason: error instanceof Error ? error.message : DESTINATION_REFUSED,
			});
			return route.abort("blockedbyclient");
		}
	}

	private refuse(method: string, url: string): void {
		this.log.push({ method, url, allowed: false, reason: DESTINATION_REFUSED });
	}

	/**
	 * "allowlist" (a page holding the applicant's data): every request, whatever its method, must
	 * go to an allowed host: navigations, form posts and uploads, and also fetches, images,
	 * iframes and scripts, since a GET can carry typed values out in its URL. Each is fetched here
	 * with redirects off, so a redirect to another host (which the browser would follow without
	 * asking, re-posting the body on 307/308) is refused before it is followed. Scraping uses
	 * "open" sessions and is not affected.
	 */
	private async allowlistRoute(route: PlaywrightRouteLike): Promise<void> {
		const request = route.request();
		const method = request.method();
		const url = request.url();
		// data:, blob: and about: stay inside the browser.
		if (!/^https?:/.test(url)) return route.continue();
		if (!urlOnHosts(url, this.allowedHosts)) {
			this.refuse(method, url);
			return route.abort("blockedbyclient");
		}
		const response = await route.fetch({ maxRedirects: 0 });
		const location = response.headers().location;
		if (response.status() >= 300 && response.status() < 400 && location) {
			const target = new URL(location, url).href;
			if (!urlOnHosts(target, this.allowedHosts)) {
				this.refuse(method, target);
				return route.abort("blockedbyclient");
			}
		}
		this.log.push({ method, url, allowed: true, reason: "allowed host" });
		return route.fulfill({ response: response as never });
	}

	/** Installs the request filter for a guarded page. Called once, before the first navigation. */
	async guard(): Promise<void> {
		if (this.mode === "open") return;
		await this.page.route("**/*", async (route) => {
			if (this.mode === "allowlist") return this.allowlistRoute(route);
			if (this.mode === "pinned") return this.pinnedRoute(route);
			const request = route.request();
			const method = request.method();
			const decision =
				this.mode === "none"
					? { allow: false, reason: "network closed" }
					: readOnlyDecision(method, request.postData());
			this.log.push({
				method,
				url: request.url(),
				allowed: decision.allow,
				reason: decision.reason,
			});
			if (decision.allow) return route.continue();
			return route.abort("blockedbyclient");
		});
		await this.page.routeWebSocket?.(/.*/, (ws) => {
			if (
				this.mode === "allowlist" &&
				urlOnHosts(ws.url().replace(/^ws/, "http"), this.allowedHosts) &&
				ws.connectToServer
			) {
				ws.connectToServer();
				return;
			}
			this.log.push({
				method: "WEBSOCKET",
				url: ws.url(),
				allowed: false,
				reason:
					this.mode === "allowlist" ? DESTINATION_REFUSED : "WebSocket closed",
			});
			return ws.close();
		});
	}

	restrictNetwork(mode: "read_only" | "none"): void {
		if (this.mode === "open")
			throw new Error(
				"restrictNetwork needs a session opened with a guarded network",
			);
		if (this.mode === "allowlist" || this.mode === "pinned")
			throw new Error(
				`restrictNetwork does not apply to a ${this.mode} session`,
			);
		if (mode === "none" || this.mode === "read_only") this.mode = mode;
	}

	networkLog(): NetworkLogEntry[] {
		return [...this.log];
	}

	async evaluate<T>(script: string): Promise<T> {
		return (await this.page.evaluate(script)) as T;
	}

	async type(selector: string, text: string): Promise<void> {
		if (this.page.pressSequentially)
			await this.page.pressSequentially(selector, text);
		else await this.page.type?.(selector, text);
	}

	press(selector: string, key: string): Promise<void> {
		return this.page.press(selector, key);
	}

	waitForTimeout(ms: number): Promise<void> {
		return this.page.waitForTimeout(ms);
	}

	async waitForNetworkIdle(timeoutMs: number): Promise<void> {
		await this.page
			.waitForLoadState("networkidle", { timeout: timeoutMs })
			.catch(() => {});
	}

	async goto(url: string, options: GotoOptions = {}) {
		const gotoOptions = {
			timeout: options.timeoutMs ?? 30_000,
			waitUntil: options.waitUntil ?? "load",
		};
		const { beforeRedirect } = options;
		// Allowlist and pinned pages already check every request, every hop, in their guard.
		if (
			!beforeRedirect ||
			this.mode === "allowlist" ||
			this.mode === "pinned"
		) {
			const response = await this.page.goto(url, gotoOptions);
			return { status: response?.status() ?? null, url: this.page.url() };
		}
		// Playwright follows redirects inside one request and its route handler never sees the hops,
		// so main-frame documents are fetched with redirects off and each hop is followed here, after
		// `beforeRedirect` has checked it.
		let target = new URL(url).href;
		let redirect: string | null = null;
		let failure: unknown = null;
		const handler = async (route: PlaywrightRouteLike) => {
			const request = route.request();
			if (
				!request.isNavigationRequest() ||
				request.frame() !== this.page.mainFrame()
			)
				return route.continue();
			if (request.url() !== target) {
				try {
					await beforeRedirect(request.url());
				} catch (error) {
					failure = error;
					return route.abort("blockedbyclient");
				}
			}
			const response = await route.fetch({ maxRedirects: 0 });
			const location = response.headers().location;
			if (response.status() >= 300 && response.status() < 400 && location) {
				redirect = new URL(location, request.url()).href;
				return route.abort("aborted");
			}
			return route.fulfill({ response: response as never });
		};
		await this.page.route("**/*", handler);
		try {
			for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
				redirect = null;
				let response: PlaywrightResponseLike | null = null;
				try {
					response = await this.page.goto(target, gotoOptions);
				} catch (error) {
					if (!failure && !redirect) throw error;
				}
				if (failure) throw failure;
				if (!redirect)
					return { status: response?.status() ?? null, url: this.page.url() };
				await beforeRedirect(redirect);
				target = redirect;
			}
			throw new Error(`More than ${MAX_REDIRECTS} redirects from ${url}`);
		} finally {
			await this.page.unroute("**/*", handler);
		}
	}
	content() {
		return this.page.content();
	}
	title() {
		return this.page.title();
	}
	url() {
		return this.page.url();
	}
	async waitForSelector(
		selector: string,
		options: { timeoutMs?: number } = {},
	) {
		await this.page.waitForSelector(selector, {
			timeout: options.timeoutMs ?? 10_000,
		});
	}
	click(selector: string) {
		return this.page.click(selector);
	}
	fill(selector: string, value: string) {
		return this.page.fill(selector, value);
	}
	async selectOption(selector: string, value: string) {
		await this.page.selectOption(selector, value);
	}
	check(selector: string) {
		return this.page.check(selector);
	}
	uncheck(selector: string) {
		return this.page.uncheck(selector);
	}
	setInputFiles(selector: string, files: UploadFile[]) {
		return this.page.setInputFiles(
			selector,
			files.map((file) => ({
				name: file.name,
				mimeType: file.mimeType,
				buffer: Buffer.from(file.buffer),
			})),
		);
	}
	async screenshot(options: { fullPage?: boolean } = {}) {
		return new Uint8Array(
			await this.page.screenshot({ fullPage: options.fullPage ?? true }),
		);
	}
	async setContent(html: string) {
		await this.page.setContent(html, { waitUntil: "load" });
	}
	async pdf() {
		return new Uint8Array(
			await this.page.pdf({ preferCSSPageSize: true, printBackground: false }),
		);
	}
	close() {
		return this.page.close();
	}
}

/** Adapts any Playwright-compatible browser. `launch` is called once per session. */
export class PlaywrightBrowserProvider implements BrowserProvider {
	constructor(
		readonly name: string,
		private readonly launch: (options?: {
			args?: string[];
		}) => Promise<PlaywrightBrowserLike>,
		private readonly userAgent?: string,
		/** True when `launch` applies the args it is given (a local Chrome). */
		readonly isolates = false,
	) {}

	async openSession(options: SessionOptions = {}): Promise<BrowserSession> {
		const network = options.network ?? "open";
		if (network === "allowlist" && !options.allowedHosts?.length)
			throw new Error("An allowlist session needs allowedHosts");
		if (network === "pinned" && (!options.fetcher || !this.isolates))
			throw new Error(
				"A pinned session needs a fetcher and a browser started without network",
			);
		const browser = await this.launch(
			network === "pinned" ? { args: NO_NETWORK_ARGS } : undefined,
		);
		const context = await browser.newContext({
			userAgent: this.userAgent,
			locale: "en-US",
			viewport: { width: 1280, height: 900 },
			javaScriptEnabled: options.javaScriptEnabled ?? true,
			// route() does not see a service worker's fetches, so guarded pages get none.
			...(network === "open" ? {} : { serviceWorkers: "block" as const }),
		});
		// route() covers one page; a pop-up the form opens would escape it.
		if (network !== "open")
			context.on?.("page", (popup) => {
				void popup
					.opener()
					.then((opener) => (opener ? popup.close() : undefined))
					.catch(() => {});
			});
		return {
			newPage: async () => {
				const page = new PlaywrightPage(
					await context.newPage(),
					network,
					options.allowedHosts ?? [],
					options.fetcher,
				);
				await page.guard();
				return page;
			},
			close: async () => {
				await context.close().catch(() => {});
				await browser.close();
			},
		};
	}
}
