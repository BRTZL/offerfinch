import {
	boardHostDecision,
	carriesFormData,
	formValueNeedles,
	type GuardDecision,
	type HostRules,
	hostMatches,
	readOnlyDecision,
} from "../apply/network-guard";
import { isPrivateHost } from "../sources/link";

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
	/**
	 * "allowlist": how many requests the session has started so far (the last `seq` given), and
	 * those started but not yet in the log (still waiting for their answer). Zero and none in
	 * other modes.
	 */
	networkStarted(): { count: number; pending: PendingRequest[] };
	close(): Promise<void>;
}

/** A request the guard let through that has no answer yet (`BrowserPage.networkStarted`). */
export interface PendingRequest {
	seq: number;
	method: string;
	url: string;
}

export interface NetworkLogEntry {
	method: string;
	url: string;
	allowed: boolean;
	reason: string;
	/**
	 * "allowlist": the order the request started in (1, 2 …, counted when the guard first sees
	 * it), not the order it was answered in, which is the log's order.
	 */
	seq?: number;
	/** "allowlist": a navigation of the page itself (its main frame). */
	navigation?: true;
	/**
	 * "allowlist", a request to a destination that is not a read (POST, PUT …), or the page's own
	 * navigation there: the HTTP status it was answered with, its body and content type, so a run
	 * can tell what it carried.
	 */
	status?: number;
	body?: Uint8Array;
	contentType?: string;
	/** The same, when it was answered with HTML: that answer, cut at `ANSWER_LIMIT` characters. */
	answerHtml?: string;
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
	 * "allowlist" and "read_only" (a submission or a form read): refuse every request and
	 * navigation to this Mac or a private network (`localhost`, 127.0.0.0/8, ::1, 0.0.0.0, 10/8,
	 * 172.16/12, 192.168/16, 169.254/16, `.local` …) by its host, whatever `allowedHosts` and
	 * `hostRules` say: a redirect there, a page's fetch, a frame, a WebSocket. Set for every real
	 * run; only the fixture runs (local stand-in boards) leave it off.
	 */
	refusePrivateNetwork?: boolean;
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

/** True when `url`'s host is this Mac or a private network (`isPrivateHost`); false if no URL. */
export function privateUrl(url: string): boolean {
	try {
		return isPrivateHost(new URL(url).hostname);
	} catch {
		return false;
	}
}

/** The reason recorded for a request to this Mac or a private network a real run refused. */
export const PRIVATE_NETWORK_REFUSED = "private network refused";

/** One request of a redirect chain the guard follows itself (`followChecked`). */
interface Hop {
	url: string;
	method: string;
	/** True while the first request's body is sent again (307 and 308 keep it). */
	keepsBody: boolean;
}

/** The reason recorded for a redirect to something that is not an http(s) URL. */
const OFF_THE_WEB = "redirect off the web, refused";

/**
 * Where a 3xx answer to `from` leads, as the browser would follow it, or null for any other
 * answer: 307 and 308 send the same method and body again; 301, 302 and 303 turn a POST into a
 * GET without a body. An unreadable `Location` is kept as is (and refused as off the web).
 */
function nextHop(response: PlaywrightFetchResponseLike, from: Hop): Hop | null {
	const status = response.status();
	const location = response.headers().location;
	if (status < 300 || status >= 400 || !location) return null;
	let url = location;
	try {
		url = new URL(location, from.url).href;
	} catch {}
	const resent = status === 307 || status === 308;
	const method = resent || from.method === "HEAD" ? from.method : "GET";
	return { url, method, keepsBody: resent && from.keepsBody };
}

/** The reason logged for a frame's or subresource's redirect that ends on another origin. */
export const CROSS_ORIGIN_REFUSED = "cross-origin redirect refused";

/**
 * The reason logged for a hop to another origin in a redirect chain the guard follows for a
 * navigation's POST (a form's, in the page or a frame, answered 307 or 308): refused before it is
 * fetched, and the navigation aborted.
 */
export const CROSS_ORIGIN_POST_REFUSED =
	"form POST redirected to another origin, refused";

/** The reason logged for an answer the guard fetched that is larger than `MAX_FETCHED_BYTES`. */
export const TOO_LARGE_REFUSED = "answer too large, refused";

/** The largest answer the guard hands to the page from a request it fetched itself (25 MiB). */
export const MAX_FETCHED_BYTES = 25 * 1024 * 1024;

/** Credentials that never go on to another origin, nor come back once dropped in a chain. */
const CREDENTIALS = /^(?:cookie|authorization|proxy-authorization)$/i;

/**
 * True when `response` is larger than `MAX_FETCHED_BYTES`. Playwright has already read it whole by
 * then (its fetch has no size limit), so the cap bounds what reaches the page, not the download.
 * A `content-length` over the cap refuses it at once; otherwise the decoded body is measured, since
 * `content-length` counts the compressed bytes (a small gzip can decode past the cap).
 */
async function tooLarge(
	response: PlaywrightFetchResponseLike,
): Promise<boolean> {
	const length = response.headers()["content-length"];
	if (
		length !== undefined &&
		/^\d+$/.test(length) &&
		Number(length) > MAX_FETCHED_BYTES
	)
		return true;
	const body = await response.body?.();
	return (body?.byteLength ?? 0) > MAX_FETCHED_BYTES;
}

/** Removes from `headers` (in place) every header whose name matches `names`. */
function dropHeaders(headers: Record<string, string>, names: RegExp): void {
	for (const name of Object.keys(headers))
		if (names.test(name)) delete headers[name];
}

/** Why `hop`, after `count` hops followed, is refused before `check` runs, or null. */
function hopLimit(hop: Hop, count: number): string | null {
	if (!/^https?:/.test(hop.url)) return OFF_THE_WEB;
	return count >= MAX_REDIRECTS
		? `more than ${MAX_REDIRECTS} redirects, refused`
		: null;
}

/** The result of `followChecked`: the last answer, or the hop refused and why. */
type Followed =
	| { response: PlaywrightFetchResponseLike; followed: Hop[] }
	| { refused: string; hop: Hop; followed: Hop[] };

/**
 * Follows the redirects of a request the guard fetched (`first`, its answer to `route`'s own
 * request) here, one hop at a time with redirects off: the browser follows a fulfilled 3xx by
 * itself and never asks the route again, so a second hop (public, then this Mac) would go
 * unseen. Each hop is checked first (`check` returns why it is refused, or null); an off-the-web
 * hop and the eleventh are refused. Ends with the last answer, or the refused hop.
 *
 * The headers go forward hop by hop: once a hop changes origin, the credentials are dropped for
 * the rest of the chain, even back on the first origin. The `Cookie` header is never copied: the
 * context's request client adds the cookies it holds for each hop's own URL, and stores each
 * hop's `Set-Cookie` against that URL (`fulfillFollowed` keeps them from the page).
 *
 * The answer is fulfilled under the first URL, so it would take the first URL's origin. Anything
 * but the page's main frame (whose GET redirect becomes a new navigation): a chain that ends on
 * another origin is refused. A navigation's POST, in the main frame or a frame (a form's 307 or
 * 308, which sends the body again): a hop to another origin is refused before it is fetched
 * (`CROSS_ORIGIN_POST_REFUSED`),
 * so the body is sent nowhere else and nothing from there runs as the first origin. An answer
 * larger than `MAX_FETCHED_BYTES` is refused.
 */
async function followChecked(
	route: PlaywrightRouteLike,
	first: PlaywrightFetchResponseLike,
	check: (hop: Hop) => string | null,
	options: { mainFrame: boolean },
): Promise<Followed> {
	const request = route.request();
	const start: Hop = {
		url: request.url(),
		method: request.method(),
		keepsBody: true,
	};
	let from = start;
	let response = first;
	const followed: Hop[] = [];
	const headers = { ...(request.headers?.() ?? {}) };
	dropHeaders(headers, /^(?:host|cookie|content-length)$/i);
	// The last hop fetched, refused after all: not logged as followed.
	const refuseLast = (refused: string): Followed => ({
		refused,
		hop: from,
		followed: from === start ? followed : followed.slice(0, -1),
	});
	// A form's POST, in the page or a frame: its body goes nowhere but the first origin.
	const formPost =
		request.isNavigationRequest() && !/^(?:GET|HEAD)$/i.test(start.method);
	for (let hop = nextHop(response, from); hop; hop = nextHop(response, from)) {
		const refused =
			hopLimit(hop, followed.length) ??
			(formPost && originOf(hop.url) !== originOf(start.url)
				? CROSS_ORIGIN_POST_REFUSED
				: null) ??
			check(hop);
		if (refused) return { refused, hop, followed };
		// As the browser would: no credentials to another origin, and none again after that.
		if (originOf(hop.url) !== originOf(from.url))
			dropHeaders(headers, CREDENTIALS);
		if (!hop.keepsBody) dropHeaders(headers, /^content-type$/i);
		response = await route.fetch({
			url: hop.url,
			method: hop.method,
			headers: { ...headers },
			maxRedirects: 0,
			// Unset sends the first request's body again; a hop that drops it sends none.
			...(hop.keepsBody ? {} : { postData: Buffer.alloc(0) }),
		});
		followed.push(hop);
		from = hop;
	}
	if (!options.mainFrame && originOf(from.url) !== originOf(start.url))
		return refuseLast(CROSS_ORIGIN_REFUSED);
	if (await tooLarge(response)) return refuseLast(TOO_LARGE_REFUSED);
	return { response, followed };
}

/**
 * Fulfills `route` with the answer `followChecked` ended on. After a redirect, the answer's
 * `Set-Cookie` headers are dropped: the browser would apply them to the first URL's host, while
 * the request client has already stored them against the hop's real URL.
 */
function fulfillFollowed(
	route: PlaywrightRouteLike,
	result: { response: PlaywrightFetchResponseLike; followed: Hop[] },
): Promise<void> {
	if (result.followed.length === 0)
		return route.fulfill({ response: result.response as never });
	const headers = Object.fromEntries(
		Object.entries(result.response.headers()).filter(
			([name]) => !/^set-cookie2?$/i.test(name),
		),
	);
	return route.fulfill({ response: result.response as never, headers });
}

/**
 * A refusal `followChecked` makes after the request itself was sent: the request is logged as
 * sent, then the refusal. A cross-origin redirect or an answer too large ends the request quietly;
 * a form's POST redirected to another origin ends the run (`destinationProblem`).
 */
function refusedAfterSent(reason: string): boolean {
	return (
		reason === CROSS_ORIGIN_REFUSED ||
		reason === TOO_LARGE_REFUSED ||
		reason === CROSS_ORIGIN_POST_REFUSED
	);
}

/**
 * Why a read-only session refuses to follow a redirect `hop` of a request whose body is `body`
 * (sent as `contentType`), or null when it may: to this Mac or a private network, or no longer a
 * read (`readOnlyDecision`).
 */
function readHopRefusal(
	hop: Hop,
	body: string | null,
	contentType: string | undefined,
): string | null {
	if (privateUrl(hop.url)) return PRIVATE_NETWORK_REFUSED;
	const read = hop.keepsBody
		? readOnlyDecision(hop.method, body, contentType)
		: readOnlyDecision(hop.method, null, null);
	return read.allow ? null : read.reason;
}

/** The `content-type` header `request` was sent with, if any. */
function contentTypeOf(
	request: ReturnType<PlaywrightRouteLike["request"]>,
): string | undefined {
	return request.headers?.()["content-type"];
}

/** `url`'s origin, or "" when it is not a URL. */
function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}

/** `url` without its fragment, as a request's URL is; `url` itself when it is not a URL. */
function withoutHash(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		return parsed.href;
	} catch {
		return url;
	}
}

/** The reason logged for a redirect hop the guard checked and followed itself. */
export const REDIRECT_FOLLOWED = "redirect followed";

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
	body?(): Promise<Buffer>;
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
		postDataBuffer?(): Buffer | null;
		isNavigationRequest(): boolean;
		frame(): unknown;
		resourceType?(): string;
		headers?(): Record<string, string>;
	};
	continue(): Promise<void>;
	abort(errorCode?: string): Promise<void>;
	fetch(options?: {
		url?: string;
		method?: string;
		headers?: Record<string, string>;
		postData?: Buffer;
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

/** How much of an HTML answer to a destination the log keeps (`NetworkLogEntry.answerHtml`). */
const ANSWER_LIMIT = 200_000;

/** The HTML a destination answered with, or null for any other answer (JSON, a redirect …). */
async function answerHtmlOf(
	response: PlaywrightFetchResponseLike,
): Promise<string | null> {
	if (!/text\/html|xhtml/i.test(response.headers()["content-type"] ?? ""))
		return null;
	try {
		const body = await response.body?.();
		return body ? body.toString("utf8").slice(0, ANSWER_LIMIT) : null;
	} catch {
		return null;
	}
}

/** What a request to a destination carried, and how it was answered (`NetworkLogEntry`). */
function sentOf(
	request: ReturnType<PlaywrightRouteLike["request"]>,
	status: number,
): Pick<NetworkLogEntry, "status" | "body" | "contentType"> {
	const buffer =
		request.postDataBuffer?.() ??
		(request.postData() === null
			? null
			: Buffer.from(request.postData() ?? "", "utf8"));
	return {
		status,
		...(buffer ? { body: new Uint8Array(buffer) } : {}),
		contentType: request.headers?.()["content-type"] ?? "",
	};
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
	/** "allowlist": requests started so far (`NetworkLogEntry.seq`). */
	started: number;
	/** "allowlist": requests started and not yet logged, by `seq`. */
	readonly pending: Map<number, PendingRequest>;
	/** Set when the session starts closing: requests still in flight end with it. */
	closing: boolean;
	/** `SessionOptions.refusePrivateNetwork`: no request may reach this Mac or a private network. */
	readonly refusePrivate: boolean;
}

/** The reason recorded for a request the session's closing (or its page's) cut off. */
const SESSION_CLOSED = "session closed";

/**
 * Runs a route handler. Closing the session or its page cancels the requests still in flight
 * (`route.fetch: Request context disposed.`, "Target page, context or browser has been closed");
 * such a request is logged and ends there, and the handler never throws for it.
 */
async function routeUntilClosed(
	state: GuardState,
	route: PlaywrightRouteLike,
	handler: (route: PlaywrightRouteLike) => Promise<void>,
): Promise<void> {
	const request = route.request();
	try {
		await handler(route);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!state.closing && !/disposed|has been closed/i.test(message))
			throw error;
		state.log.push({
			method: request.method(),
			url: request.url(),
			allowed: false,
			reason: SESSION_CLOSED,
		});
	}
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
	/**
	 * Guarded sessions: the URL `goto` is loading. A redirect of that navigation is checked and
	 * then loaded by `goto` as a new navigation (`gotoRedirect`), so the page ends on its real
	 * URL and every hop passes the filter.
	 */
	private gotoUrl: string | null = null;
	private gotoRedirect: string | null = null;
	/** Redirects of the page's own main-frame navigations loaded in a row (`loadHop`). */
	private pageHops = 0;

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

	/** On the destinations, and not on a private network when the session refuses one. */
	private onHosts(url: string): boolean {
		return (
			urlOnHosts(url, this.allowedHosts) &&
			!(this.state.refusePrivate && privateUrl(url))
		);
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
		// Counted when it starts, before anything is awaited: a run tells which requests a click
		// started by this order, whatever order they are answered in.
		const seq = ++this.state.started;
		this.state.pending.set(seq, { seq, method, url });
		try {
			return await this.allowlistSend(route, seq);
		} finally {
			this.state.pending.delete(seq);
		}
	}

	/** `allowlistRoute` for one http(s) request, its log entries numbered `seq`. */
	private async allowlistSend(
		route: PlaywrightRouteLike,
		seq: number,
	): Promise<void> {
		const request = route.request();
		const method = request.method();
		const url = request.url();
		const destination = this.onHosts(url);
		let reason = "allowed host";
		if (!destination) {
			const decision = this.otherHostDecision(request, url);
			if (!decision.allow) {
				this.state.log.push({
					method,
					url,
					allowed: false,
					reason: decision.reason,
					seq,
				});
				return route.abort("blockedbyclient");
			}
			reason = decision.reason;
		}
		const first = await route.fetch({ maxRedirects: 0 });
		const navigation =
			request.isNavigationRequest() &&
			request.frame() === this.page.mainFrame();
		// A hop to another host meets the same rules as a new request from the same frame; a
		// destination's must stay on the destinations.
		const check = (hop: Hop): string | null => {
			if (this.onHosts(hop.url)) return null;
			if (destination) return DESTINATION_REFUSED;
			const decision = this.otherHostDecision(request, hop.url);
			return decision.allow ? null : decision.reason;
		};
		const refuseHop = (hop: Hop, refusal: string) => {
			this.state.log.push({
				method: hop.method,
				url: hop.url,
				allowed: false,
				reason: refusal,
				seq,
			});
			return route.abort("blockedbyclient");
		};
		const mainHop = this.mainFrameHop(request, first);
		if (mainHop) {
			const refused = check(mainHop);
			if (refused) return refuseHop(mainHop, refused);
		}
		const result: Followed = mainHop
			? { response: first, followed: [] }
			: await followChecked(route, first, check, {
					mainFrame: navigation,
				});
		// Refused after the request itself was sent: it is logged first, then the refusal.
		if ("refused" in result && !refusedAfterSent(result.refused)) {
			this.logFollowed(result.followed, seq);
			return refuseHop(result.hop, result.refused);
		}
		const sent = destination && (navigation || !/^(?:GET|HEAD)$/i.test(method));
		const answerHtml = sent ? await answerHtmlOf(first) : null;
		this.state.log.push({
			method,
			url,
			allowed: true,
			reason,
			seq,
			...(navigation ? { navigation: true as const } : {}),
			...(sent ? sentOf(request, first.status()) : {}),
			...(answerHtml ? { answerHtml } : {}),
		});
		this.logFollowed(result.followed, seq);
		if ("refused" in result) return refuseHop(result.hop, result.refused);
		if (mainHop) return this.loadHop(route, request, mainHop);
		if (navigation) this.pageHops = 0;
		return fulfillFollowed(route, result);
	}

	/**
	 * The redirect `first` answers to a navigation of the page's main frame with, as a GET, or
	 * null: any other request, any other answer, or a 307 or 308 that sends a body again (that one
	 * is followed by the guard, `followChecked`). Once checked, the page loads it as a new
	 * navigation (`loadHop`), so the page ends on its real URL and the filter sees every hop.
	 */
	private mainFrameHop(
		request: ReturnType<PlaywrightRouteLike["request"]>,
		first: PlaywrightFetchResponseLike,
	): Hop | null {
		if (
			!request.isNavigationRequest() ||
			request.frame() !== this.page.mainFrame()
		)
			return null;
		const hop = nextHop(first, {
			url: request.url(),
			method: request.method(),
			keepsBody: true,
		});
		return hop && /^https?:/.test(hop.url) && hop.method === "GET" ? hop : null;
	}

	/**
	 * Ends a main-frame navigation at its checked redirect `hop` and loads `hop` as a new one:
	 * `goto`'s own by `goto` (`guardedGoto`), the page's own (a form's POST answered 303) here.
	 */
	private async loadHop(
		route: PlaywrightRouteLike,
		request: ReturnType<PlaywrightRouteLike["request"]>,
		hop: Hop,
	): Promise<void> {
		if (this.gotoUrl !== null && request.url() === this.gotoUrl) {
			this.gotoRedirect = hop.url;
			return route.abort("aborted");
		}
		await route.abort("aborted");
		// A loop of redirects ends where the browser would end it.
		if (++this.pageHops > MAX_REDIRECTS) return;
		// Not awaited: this request's handler ends here; the new navigation passes the filter.
		void this.page.goto(hop.url).catch(() => {});
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
		// This Mac or a private network is never reached from a real run, whatever the rules say.
		if (this.state.refusePrivate && privateUrl(url))
			return { allow: false, reason: PRIVATE_NETWORK_REFUSED };
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
		if (!this.onHosts(url)) {
			this.refuse(method, url);
			await route.abort("blockedbyclient");
			return true;
		}
		const type = contentTypeOf(request);
		if (!readOnlyDecision(method, request.postData(), type).allow) return false;
		const first = await route.fetch({ maxRedirects: 0 });
		// Every hop stays on the hosts and stays a read.
		const check = (hop: Hop): string | null =>
			!this.onHosts(hop.url)
				? DESTINATION_REFUSED
				: readHopRefusal(hop, request.postData(), type);
		const mainHop = this.mainFrameHop(request, first);
		const hopRefusal = mainHop && check(mainHop);
		const result: Followed = mainHop
			? { response: first, followed: [] }
			: await followChecked(route, first, check, { mainFrame: true });
		const refused =
			mainHop && hopRefusal
				? { refused: hopRefusal, hop: mainHop }
				: "refused" in result
					? result
					: null;
		this.logFollowed(result.followed);
		if (refused) {
			this.state.log.push({
				method: refused.hop.method,
				url: refused.hop.url,
				allowed: false,
				reason: refused.refused,
			});
			await route.abort("blockedbyclient");
			return true;
		}
		this.state.log.push({ method, url, allowed: true, reason: "allowed host" });
		if (mainHop) await this.loadHop(route, request, mainHop);
		else if ("response" in result) {
			this.pageHops = 0;
			await fulfillFollowed(route, result);
		}
		return true;
	}

	/** Logs the redirect hops the guard checked and followed itself (`followChecked`). */
	private logFollowed(hops: Hop[], seq?: number): void {
		for (const hop of hops)
			this.state.log.push({
				method: hop.method,
				url: hop.url,
				allowed: true,
				reason: REDIRECT_FOLLOWED,
				...(seq === undefined ? {} : { seq }),
			});
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
		// A form read: its page, frames and fetches never reach this Mac or a private network.
		if (this.state.refusePrivate && privateUrl(request.url())) {
			const leaving =
				request.isNavigationRequest() &&
				request.frame() === this.page.mainFrame();
			this.state.log.push({
				method,
				url: request.url(),
				allowed: false,
				reason: leaving ? DESTINATION_REFUSED : PRIVATE_NETWORK_REFUSED,
			});
			return route.abort("blockedbyclient");
		}
		if (this.state.mode === "read_only" && this.allowedHosts.length > 0)
			if (await this.refusedNavigation(route)) return;
		const decision =
			this.state.mode === "none"
				? { allow: false, reason: "network closed" }
				: readOnlyDecision(method, request.postData(), contentTypeOf(request));
		this.state.log.push({
			method,
			url: request.url(),
			allowed: decision.allow,
			reason: decision.reason,
		});
		if (!decision.allow) return route.abort("blockedbyclient");
		// `continue` would let the browser follow a redirect unseen (a public host's 302 or 307 to
		// this Mac): with private networks refused, every read is fetched with redirects off.
		if (this.state.refusePrivate && /^https?:/.test(request.url()))
			return this.readWithoutRedirects(route);
		return route.continue();
	}

	/**
	 * A permitted read of a session that refuses private networks: fetched here with redirects
	 * off, and each redirect checked and followed here (`followChecked`): `continue` would let the
	 * browser follow them unseen. A hop must meet the same rules as a new request: not this Mac or
	 * a private network, and still a read (`readHopRefusal`). A refused hop is aborted quietly and
	 * logged; the page's main frame stays on its hosts (`refusedNavigation`). A GET redirect of the
	 * page's main frame is never fulfilled under the first URL (the next origin's page would run as
	 * the first): once checked, the navigation ends there and the hop loads as a new navigation
	 * (`mainFrameHop`, `loadHop`), which the filter decides again, as in every guarded session.
	 */
	private async readWithoutRedirects(
		route: PlaywrightRouteLike,
	): Promise<void> {
		const request = route.request();
		const mainFrame =
			request.isNavigationRequest() &&
			request.frame() === this.page.mainFrame();
		const check = (hop: Hop) =>
			readHopRefusal(hop, request.postData(), contentTypeOf(request));
		let result: Followed;
		let mainHop: Hop | null = null;
		try {
			const first = await route.fetch({ maxRedirects: 0 });
			mainHop = this.mainFrameHop(request, first);
			const refusal = mainHop && check(mainHop);
			result =
				mainHop && refusal
					? { refused: refusal, hop: mainHop, followed: [] }
					: mainHop
						? { response: first, followed: [] }
						: await followChecked(route, first, check, { mainFrame });
		} catch (error) {
			// Closing the session ends it in `routeUntilClosed`; a host that cannot be reached (an
			// unknown name, a refused connection) fails this read only, as the browser would.
			const message = error instanceof Error ? error.message : String(error);
			if (this.state.closing || /disposed|has been closed/i.test(message))
				throw error;
			return route.abort("failed");
		}
		this.logFollowed(result.followed);
		if ("refused" in result) {
			this.state.log.push({
				method: result.hop.method,
				url: result.hop.url,
				allowed: false,
				reason: result.refused,
			});
			return route.abort("blockedbyclient");
		}
		if (mainHop) return this.loadHop(route, request, mainHop);
		if (mainFrame) this.pageHops = 0;
		return fulfillFollowed(route, result);
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

	networkStarted(): { count: number; pending: PendingRequest[] } {
		return {
			count: this.state.started,
			pending: [...this.state.pending.values()],
		};
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

	/**
	 * `goto` in a guarded session: the filter checks a redirect of this navigation and ends it
	 * (`loadAfterGoto`); the checked hop is then loaded here as a new navigation, which the filter
	 * decides again. The page ends on its real URL, and no hop is followed unseen.
	 */
	private async guardedGoto(
		url: string,
		gotoOptions: {
			timeout: number;
			waitUntil: "load" | "domcontentloaded" | "networkidle";
		},
	) {
		let target = url;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			this.gotoUrl = withoutHash(target);
			this.gotoRedirect = null;
			let response: PlaywrightResponseLike | null = null;
			try {
				response = await this.page.goto(target, gotoOptions);
			} catch (error) {
				if (!this.gotoRedirect) throw error;
			} finally {
				this.gotoUrl = null;
			}
			const next = this.gotoRedirect;
			this.gotoRedirect = null;
			if (!next)
				return {
					status: response?.status() ?? null,
					url: this.page.url(),
					responseUrl: response?.url?.() ?? null,
				};
			target = next;
		}
		throw new Error(`More than ${MAX_REDIRECTS} redirects from ${url}`);
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
		if (
			!beforeRedirect &&
			(this.state.mode === "allowlist" || this.state.mode === "read_only")
		)
			return this.guardedGoto(url, gotoOptions);
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
		const guarded = (route: PlaywrightRouteLike) =>
			routeUntilClosed(this.state, route, handler);
		await this.page.route("**/*", guarded);
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
			await this.page.unroute("**/*", guarded);
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
			started: 0,
			pending: new Map(),
			closing: false,
			refusePrivate:
				Boolean(options.refusePrivateNetwork) &&
				(network === "allowlist" || network === "read_only"),
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
			const filter = async (route: PlaywrightRouteLike) => {
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
						state.mode === "allowlist" &&
						(!urlOnHosts(url, allowed) ||
							(state.refusePrivate && privateUrl(url)))
							? DESTINATION_REFUSED
							: "pop-up refused",
				});
				return route.abort("blockedbyclient");
			};
			await context.route("**/*", (route) =>
				routeUntilClosed(state, route, filter),
			);
			await context.routeWebSocket(/.*/, (ws) => {
				const wsUrl = ws.url().replace(/^ws/, "http");
				if (
					state.mode === "allowlist" &&
					urlOnHosts(wsUrl, allowed) &&
					!(state.refusePrivate && privateUrl(wsUrl)) &&
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
				state.closing = true;
				await context.close().catch(() => {});
				await browser.close();
			},
		};
	}
}
