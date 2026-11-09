import {
	boardHostDecision,
	carriesFormData,
	formValueNeedles,
	type GuardDecision,
	type HostRules,
	hostMatches,
	readOnlyDecision,
} from "../apply/network-guard";

export type { HostRules } from "../apply/network-guard";

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
	/**
	 * The URL of the document the browser answered with, after the HTTP redirects it followed
	 * (never a script's or a meta refresh's later navigation); null when it could not tell.
	 */
	responseUrl?: string | null;
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
	/**
	 * "allowlist" (a real submission), called before the first keystroke: the set of files the
	 * page may load from a host that is not a destination (`HostRules` assets and static files) is
	 * fixed to the exact URLs it loaded so far; any other is refused quietly (a filled value in it
	 * is still a violation). Widget endpoints keep their own rules. No-op in other modes.
	 */
	freezeAssets(): void;
	/** Every request a guarded page made, with the guard's decision. Empty on open sessions. */
	networkLog(): NetworkLogEntry[];
	close(): Promise<void>;
}

export interface NetworkLogEntry {
	method: string;
	url: string;
	allowed: boolean;
	reason: string;
	/** "allowlist": a navigation of the page itself (its main frame). */
	navigation?: true;
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
	 * `allowedHosts` (the destinations): a request elsewhere is aborted unless `hostRules` lets
	 * it through by its structure (a board's asset files and its scoring widget's own endpoints,
	 * `boardHostDecision` in apply/network-guard.ts). It is
	 * recorded as a violation (the run stops) when it could be the application leaving: the
	 * page's own navigation, an upload, or a filled value; anything else is refused quietly. Guarded
	 * sessions also block service workers and close WebSockets (in "allowlist", those to other
	 * hosts) and close pop-up windows, so nothing slips past the request filter. Default "open".
	 */
	network?: "open" | "read_only" | "none" | "allowlist" | "pinned";
	/** Hosts an "allowlist" session may navigate to and send data to. */
	allowedHosts?: string[];
	/** "allowlist": other hosts, by what they may receive (see `HostRules`). */
	hostRules?: HostRules;
	/**
	 * "allowlist": the values the form will hold. A request to a host outside `allowedHosts` that
	 * carries one (in its URL, or a widget post's body) is refused as a violation.
	 */
	formValues?: string[];
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

/** True when `url` is http(s) on one of `hosts` (hostname match, any port; `*.` for one label). */
export function urlOnHosts(url: string, hosts: readonly string[]): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			return false;
		return hosts.some((h) => hostMatches(parsed.hostname, h));
	} catch {
		return false;
	}
}

/** `boardHostDecision`'s reasons for a file read from a host that is not a destination. */
const FILE_READS = new Set(["board asset, read", "board static file, read"]);

/** The reason recorded for a request an "allowlist" session refused. */
export const DESTINATION_REFUSED = "destination not allowed";

/**
 * The reason recorded for a request an "allowlist" session refused quietly: it went to a host
 * that is neither a destination nor one of the board's asset hosts and carried nothing of the
 * form (analytics, error reporting). The run goes on.
 */
export const NOT_A_DESTINATION = "not a destination, refused";

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
	url?(): string;
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
		resourceType?(): string;
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
}

const MAX_REDIRECTS = 10;

interface PlaywrightContextLike {
	newPage(): Promise<PlaywrightPageLike>;
	close(): Promise<void>;
	/** Covers every page of the context, pop-ups included, from their first request. */
	route?(
		url: string,
		handler: (route: PlaywrightRouteLike) => Promise<void>,
	): Promise<unknown>;
	routeWebSocket?(
		url: RegExp,
		handler: (ws: PlaywrightWebSocketRouteLike) => unknown,
	): Promise<void>;
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

/**
 * True when a request sends a file: a PUT, a multipart body, a document type (PDF, Word) or raw
 * bytes, or a body that is a PDF. Presigned uploads send the raw file.
 */
function isUpload(method: string, type: string, body: string | null): boolean {
	return (
		method === "PUT" ||
		/^(?:multipart\/|application\/(?:pdf|octet-stream|msword|vnd\.openxmlformats))/i.test(
			type,
		) ||
		(body ?? "").includes("%PDF-")
	);
}

/**
 * The page a request belongs to, or null when it cannot be told: a pop-up's first request comes
 * before its frame exists.
 */
function pageOf(request: { frame(): unknown }): unknown {
	try {
		const frame = request.frame() as { page?: () => unknown } | null;
		return frame?.page?.() ?? null;
	} catch {
		return null;
	}
}

/**
 * What every page of one guarded session shares: the mode (closing the network on one page
 * closes it on all), and one log, so a pop-up's refused request shows on the page that opened it.
 */
interface GuardState {
	mode: GuardMode;
	readonly log: NetworkLogEntry[];
	/** "allowlist": the other-host files (assets, static files) loaded before `freezeAssets`. */
	readonly loaded: Set<string>;
	/** "allowlist": set by `freezeAssets`; only a file in `loaded` may load from then on. */
	frozen: boolean;
}

/** The URL of the frame that made a request, or "" when it cannot be told. */
function frameUrl(request: { frame(): unknown }): string {
	try {
		const frame = request.frame() as { url?: () => string } | null;
		return frame?.url?.() ?? "";
	} catch {
		return "";
	}
}

class PlaywrightPage implements BrowserPage {
	private readonly state: GuardState;
	private readonly needles: string[];
	/** "pinned": the main frame has its document; later navigations are refused. */
	private landed = false;

	private readonly allowedHosts: string[];
	private readonly fetcher?: PinnedFetcher;
	private readonly hostRules?: HostRules;

	constructor(
		private readonly page: PlaywrightPageLike,
		state: GuardState,
		options: Pick<
			SessionOptions,
			"allowedHosts" | "fetcher" | "hostRules" | "formValues"
		> = {},
	) {
		const { mode } = state;
		this.state = state;
		this.allowedHosts = options.allowedHosts ?? [];
		this.fetcher = options.fetcher;
		// Host classes and the form-value check apply to a real submission only.
		this.hostRules = mode === "allowlist" ? options.hostRules : undefined;
		this.needles = formValueNeedles(options.formValues ?? []);
	}

	/** "pinned": every http(s) request is fetched by the checking, pinning fetcher. */
	private async pinnedRoute(route: PlaywrightRouteLike): Promise<void> {
		const request = route.request();
		const method = request.method();
		const url = request.url();
		// data: and blob: stay inside the browser; nothing else is allowed out.
		if (/^(?:data|blob|about):/.test(url)) return route.continue();
		if (!/^https?:/.test(url) || (method !== "GET" && method !== "HEAD")) {
			this.state.log.push({
				method,
				url,
				allowed: false,
				reason: "not a read",
			});
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
			this.state.log.push({
				method,
				url,
				allowed: false,
				reason: "late navigation",
			});
			return route.fulfill({ status: 204, headers: {}, body: Buffer.alloc(0) });
		}
		try {
			const headers = { ...(request.headers?.() ?? {}) };
			for (const name of Object.keys(headers))
				if (/^(?:host|connection|accept-encoding|cookie)$/i.test(name))
					delete headers[name];
			const response = await fetcher({ url, method, headers });
			this.state.log.push({
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
			this.state.log.push({
				method,
				url,
				allowed: false,
				reason: error instanceof Error ? error.message : DESTINATION_REFUSED,
			});
			return route.abort("blockedbyclient");
		}
	}

	private refuse(method: string, url: string): void {
		this.state.log.push({
			method,
			url,
			allowed: false,
			reason: DESTINATION_REFUSED,
		});
	}

	/**
	 * "allowlist" (a page holding the applicant's data): a request to an allowed host (a
	 * destination) passes, whatever its method. Any other request is decided by
	 * `otherHostDecision`: read from a board's asset or scoring host, refused quietly, or refused
	 * as a violation that stops the run. Each passing request is fetched here with redirects off,
	 * so a redirect is checked before it is followed (the browser would follow it without asking,
	 * re-posting the body on 307/308): a destination's must stay on the destinations, an asset
	 * host's must meet the same rule as a new request. Scraping uses "open" sessions.
	 */
	private async allowlistRoute(route: PlaywrightRouteLike): Promise<void> {
		const request = route.request();
		const method = request.method();
		const url = request.url();
		// data:, blob: and about: stay inside the browser.
		if (!/^https?:/.test(url)) return route.continue();
		const destination = urlOnHosts(url, this.allowedHosts);
		let reason = "allowed host";
		if (!destination) {
			const decision = this.otherHostDecision(request, url);
			if (!decision.allow) {
				this.state.log.push({
					method,
					url,
					allowed: false,
					reason: decision.reason,
				});
				return route.abort("blockedbyclient");
			}
			reason = decision.reason;
		}
		const response = await route.fetch({ maxRedirects: 0 });
		const location = response.headers().location;
		if (response.status() >= 300 && response.status() < 400 && location) {
			const target = new URL(location, url).href;
			// A hop to another host meets the same rules as a new request from the same frame.
			const hop = urlOnHosts(target, this.allowedHosts)
				? null
				: destination
					? { allow: false, reason: DESTINATION_REFUSED }
					: this.otherHostDecision(request, target);
			const refusal = hop && !hop.allow ? hop.reason : null;
			if (refusal) {
				this.state.log.push({
					method,
					url: target,
					allowed: false,
					reason: refusal,
				});
				return route.abort("blockedbyclient");
			}
		}
		this.state.log.push({
			method,
			url,
			allowed: true,
			reason,
			...(request.isNavigationRequest() &&
			request.frame() === this.page.mainFrame()
				? { navigation: true as const }
				: {}),
		});
		return route.fulfill({ response: response as never });
	}

	/**
	 * How a request to `url`, not a destination, is decided. What could be the application leaving
	 * is refused as a violation that stops the run: the page's own navigation, a file upload, or a
	 * request carrying a filled value (in its URL or body; plain, encoded or escaped copies). The
	 * rest passes only when the board's rules allow it by structure (`boardHostDecision`: an asset
	 * file with no query the board does not use, or a scoring widget's own frame calling its own
	 * endpoints); everything else is refused quietly (analytics, error reports) and the run goes on.
	 */
	private otherHostDecision(
		request: ReturnType<PlaywrightRouteLike["request"]>,
		url: string,
	): GuardDecision {
		const mainFrame = request.frame() === this.page.mainFrame();
		const type = request.headers?.()["content-type"] ?? "";
		if (
			(request.isNavigationRequest() && mainFrame) ||
			isUpload(request.method(), type, request.postData()) ||
			carriesFormData(url, this.needles) ||
			carriesFormData(request.postData(), this.needles)
		)
			return { allow: false, reason: DESTINATION_REFUSED };
		if (!this.hostRules) return { allow: false, reason: NOT_A_DESTINATION };
		const decision = boardHostDecision(
			{
				method: request.method(),
				url,
				resourceType: request.resourceType?.() ?? "",
				navigation: request.isNavigationRequest(),
				mainFrame,
				frameUrl: frameUrl(request),
			},
			this.hostRules,
			this.allowedHosts,
		);
		if (!decision.allow) return { allow: false, reason: NOT_A_DESTINATION };
		if (!FILE_READS.has(decision.reason)) return decision;
		// Files are fixed before the first keystroke: a new path could carry what was typed.
		if (this.state.frozen && !this.state.loaded.has(url))
			return { allow: false, reason: NOT_A_DESTINATION };
		if (!this.state.frozen) this.state.loaded.add(url);
		return decision;
	}

	/**
	 * "read_only" with `allowedHosts` (reading an application form): the page itself stays on
	 * those hosts. A main-frame navigation elsewhere, or one that redirects elsewhere, is aborted
	 * before it is followed; subresources and frames (a board's scoring widget) load as reads.
	 * True when the request was handled here.
	 */
	private async refusedNavigation(
		route: PlaywrightRouteLike,
	): Promise<boolean> {
		const request = route.request();
		if (
			!request.isNavigationRequest() ||
			request.frame() !== this.page.mainFrame()
		)
			return false;
		const method = request.method();
		const url = request.url();
		if (!/^https?:/.test(url)) return false;
		if (!urlOnHosts(url, this.allowedHosts)) {
			this.refuse(method, url);
			await route.abort("blockedbyclient");
			return true;
		}
		if (!readOnlyDecision(method, request.postData()).allow) return false;
		const response = await route.fetch({ maxRedirects: 0 });
		const location = response.headers().location;
		if (response.status() >= 300 && response.status() < 400 && location) {
			const target = new URL(location, url).href;
			if (!urlOnHosts(target, this.allowedHosts)) {
				this.refuse(method, target);
				await route.abort("blockedbyclient");
				return true;
			}
		}
		this.state.log.push({ method, url, allowed: true, reason: "allowed host" });
		await route.fulfill({ response: response as never });
		return true;
	}

	/**
	 * Decides one request of this page. Called by the session's filter, which the context installs
	 * before any page exists, so it sees every request of every page, pop-ups included.
	 */
	async handle(route: PlaywrightRouteLike): Promise<void> {
		if (this.state.mode === "allowlist") return this.allowlistRoute(route);
		if (this.state.mode === "pinned") return this.pinnedRoute(route);
		const request = route.request();
		const method = request.method();
		if (this.state.mode === "read_only" && this.allowedHosts.length > 0)
			if (await this.refusedNavigation(route)) return;
		const decision =
			this.state.mode === "none"
				? { allow: false, reason: "network closed" }
				: readOnlyDecision(method, request.postData());
		this.state.log.push({
			method,
			url: request.url(),
			allowed: decision.allow,
			reason: decision.reason,
		});
		if (decision.allow) return route.continue();
		return route.abort("blockedbyclient");
	}

	freezeAssets(): void {
		if (this.state.mode === "allowlist") this.state.frozen = true;
	}

	restrictNetwork(mode: "read_only" | "none"): void {
		if (this.state.mode === "open")
			throw new Error(
				"restrictNetwork needs a session opened with a guarded network",
			);
		if (this.state.mode === "allowlist" || this.state.mode === "pinned")
			throw new Error(
				`restrictNetwork does not apply to a ${this.state.mode} session`,
			);
		if (mode === "none" || this.state.mode === "read_only")
			this.state.mode = mode;
	}

	networkLog(): NetworkLogEntry[] {
		return [...this.state.log];
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
		// Its hop handler is a page route, which runs before the session's filter and would let
		// requests past it; guarded sessions check every hop in their filter instead.
		if (beforeRedirect && this.state.mode !== "open")
			throw new Error("beforeRedirect is only for open sessions");
		if (!beforeRedirect) {
			const response = await this.page.goto(url, gotoOptions);
			return {
				status: response?.status() ?? null,
				url: this.page.url(),
				responseUrl: response?.url?.() ?? null,
			};
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
					return {
						status: response?.status() ?? null,
						url: this.page.url(),
						responseUrl: response?.url?.() ?? null,
					};
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
		const state: GuardState = {
			mode: network,
			log: [],
			loaded: new Set(),
			frozen: false,
		};
		const pages = new Map<unknown, PlaywrightPage>();
		if (network !== "open") {
			if (!context.route || !context.routeWebSocket) {
				await context.close().catch(() => {});
				await browser.close();
				throw new Error(
					"A guarded session needs a browser that filters a whole context",
				);
			}
			const allowed = options.allowedHosts ?? [];
			// One filter for the whole context, installed before the first page: a pop-up's first
			// request (and every later one) passes through it too, never around it.
			await context.route("**/*", async (route) => {
				const page = pages.get(pageOf(route.request()));
				if (page) return page.handle(route);
				// A window the session did not open (a pop-up): nothing it asks for is fetched.
				const request = route.request();
				const url = request.url();
				state.log.push({
					method: request.method(),
					url,
					allowed: false,
					reason:
						state.mode === "allowlist" && !urlOnHosts(url, allowed)
							? DESTINATION_REFUSED
							: "pop-up refused",
				});
				return route.abort("blockedbyclient");
			});
			await context.routeWebSocket(/.*/, (ws) => {
				if (
					state.mode === "allowlist" &&
					urlOnHosts(ws.url().replace(/^ws/, "http"), allowed) &&
					ws.connectToServer
				) {
					ws.connectToServer();
					return;
				}
				state.log.push({
					method: "WEBSOCKET",
					url: ws.url(),
					allowed: false,
					// Closed, never opened: nothing goes out over it, so the run goes on.
					reason:
						state.mode === "allowlist" ? NOT_A_DESTINATION : "WebSocket closed",
				});
				return ws.close();
			});
			// A backstop: the window itself is closed as soon as it shows.
			context.on?.("page", (popup) => {
				if (pages.has(popup)) return;
				void popup
					.opener()
					.then((opener) => (opener ? popup.close() : undefined))
					.catch(() => {});
			});
		}
		return {
			newPage: async () => {
				const raw = await context.newPage();
				const page = new PlaywrightPage(raw, state, options);
				pages.set(raw, page);
				return page;
			},
			close: async () => {
				await context.close().catch(() => {});
				await browser.close();
			},
		};
	}
}
