/**
 * Decides which requests a read-only browser session may send to a live job board. Used when a
 * real form is inspected or dry-run filled: nothing that could submit, upload or record data
 * leaves the browser. GET and HEAD pass. A POST passes only when it is a GraphQL request whose
 * every operation is a `query` (Ashby loads its form that way); mutations, form posts, file
 * uploads, beacons and every other method are aborted.
 */
export type GuardDecision =
	| { allow: true; reason: string }
	| { allow: false; reason: string };

export function readOnlyDecision(
	method: string,
	body: string | null,
): GuardDecision {
	const verb = method.toUpperCase();
	if (verb === "GET" || verb === "HEAD") return { allow: true, reason: verb };
	if (verb !== "POST" || !body)
		return { allow: false, reason: `${verb} blocked` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { allow: false, reason: "non-JSON POST blocked" };
	}
	const operations = Array.isArray(parsed) ? parsed : [parsed];
	for (const op of operations) {
		const query =
			op && typeof op === "object" && "query" in op
				? (op as { query: unknown }).query
				: null;
		if (typeof query !== "string")
			return { allow: false, reason: "POST without a GraphQL query blocked" };
		const stripped = query.replace(/#[^\n]*/g, "").trim();
		if (
			!/^query\b/.test(stripped) ||
			/\b(mutation|subscription)\b/.test(stripped)
		)
			return { allow: false, reason: "GraphQL mutation blocked" };
	}
	return { allow: true, reason: "GraphQL query" };
}

/**
 * True when `host` matches `pattern`: the same name, or for `*.example.com` one more label in
 * front (`a.example.com`, not `a.b.example.com` and not `example.com`). Only for names one
 * company owns; never for suffixes anyone can register under (`s3.amazonaws.com`).
 */
export function hostMatches(host: string, pattern: string): boolean {
	const name = host.toLowerCase();
	const want = pattern.toLowerCase();
	if (!want.startsWith("*.")) return name === want;
	const suffix = want.slice(1);
	if (!name.endsWith(suffix)) return false;
	const label = name.slice(0, -suffix.length);
	return /^[a-z0-9-]+$/.test(label);
}

/**
 * A query value's rule: a pattern the whole value must match, one of the board's widget site
 * keys, one of the form's own hosts, or (reCAPTCHA's `co`) the form's own origin in base64.
 */
export type QueryValue = RegExp | "site-key" | "form-host" | "form-origin";

/**
 * A scoring widget a board embeds. `frames` and `endpoints` are `host/path-prefix` entries. A
 * widget frame is a frame whose own URL is under `frames` and carries one of `siteKeys` (in its
 * query or path, or, with `keyInFragment`, its fragment); only such a frame may call the
 * `endpoints`, with xhr or fetch. A frame the page made itself (about:blank, srcdoc, blob:,
 * data:) or loaded from anywhere else is never one.
 */
export interface WidgetRule {
	name: string;
	siteKeys: readonly string[];
	frames: readonly string[];
	endpoints: readonly string[];
	keyInFragment?: boolean;
}

/**
 * A real submission's rules for a board's hosts that do not receive the application.
 * `assets` (exact names, or `*.` for one label): scripts, styles, fonts, images and media, by GET
 * or HEAD, never xhr, fetch, a beacon or a ping, never a page or frame navigation, and with no
 * query string unless `query` lists every parameter for that host. `widgets`: the scoring
 * widgets and their exact endpoints.
 */
export interface HostRules {
	assets: readonly string[];
	/** By host pattern, then parameter: the rule (or any of the rules) its value must meet. */
	query?: Readonly<
		Record<string, Readonly<Record<string, QueryValue | readonly QueryValue[]>>>
	>;
	widgets?: readonly WidgetRule[];
}

/** What the guard knows of a request to a host outside the destinations. */
export interface RequestFacts {
	method: string;
	url: string;
	/** Playwright's resource type ("script", "fetch", "document"); "" when unknown. */
	resourceType: string;
	navigation: boolean;
	mainFrame: boolean;
	/** The URL of the frame that made the request ("" when unknown). */
	frameUrl: string;
}

const ASSET_TYPES = new Set(["script", "stylesheet", "font", "image", "media"]);

function parse(url: string): URL | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? parsed
			: null;
	} catch {
		return null;
	}
}

/** True when `url` is under a `host/path-prefix` entry (whole path segments). */
function under(url: URL, entry: string): boolean {
	const slash = entry.indexOf("/");
	const host = slash < 0 ? entry : entry.slice(0, slash);
	const prefix = slash < 0 ? "/" : entry.slice(slash);
	if (!hostMatches(url.hostname, host)) return false;
	const path = url.pathname;
	return prefix.endsWith("/")
		? path.startsWith(prefix)
		: path === prefix || path.startsWith(`${prefix}/`);
}

/** reCAPTCHA's `co`: the page's origin, base64url with "." for padding. */
function decodedOrigin(value: string): string | null {
	if (!/^[A-Za-z0-9_-]+\.{0,2}$/.test(value)) return null;
	try {
		return atob(
			value.replace(/\./g, "=").replace(/-/g, "+").replace(/_/g, "/"),
		);
	} catch {
		return null;
	}
}

function valueAllowed(
	value: string,
	rule: QueryValue,
	siteKeys: readonly string[],
	formHosts: readonly string[],
): boolean {
	if (rule === "site-key") return siteKeys.includes(value);
	if (rule === "form-host") return formHosts.some((h) => hostMatches(value, h));
	if (rule === "form-origin") {
		const origin = parse(decodedOrigin(value) ?? "");
		return (
			origin !== null &&
			origin.pathname === "/" &&
			!origin.search &&
			formHosts.some((h) => hostMatches(origin.hostname, h))
		);
	}
	const match = value.match(rule);
	return match !== null && match.index === 0 && match[0] === value;
}

/** True when every query parameter of `url` is one its host's rules list, with a value they allow. */
function queryAllowed(
	url: URL,
	rules: HostRules,
	siteKeys: readonly string[],
	formHosts: readonly string[],
): boolean {
	if (!url.search) return true;
	const params = Object.entries(rules.query ?? {}).find(([host]) =>
		hostMatches(url.hostname, host),
	)?.[1];
	if (!params) return false;
	for (const [key, value] of url.searchParams) {
		const rule = Object.hasOwn(params, key) ? params[key] : undefined;
		const allowed: readonly QueryValue[] = Array.isArray(rule)
			? rule
			: rule
				? [rule as QueryValue]
				: [];
		if (!allowed.some((r) => valueAllowed(value, r, siteKeys, formHosts)))
			return false;
	}
	return true;
}

/** True when `url` carries one of `keys` as a query value, a path segment or a fragment value. */
function carriesKey(
	url: URL,
	keys: readonly string[],
	fragment: boolean,
): boolean {
	const values = fragment
		? [...new URLSearchParams(url.hash.slice(1)).values()]
		: [...url.searchParams.values(), ...url.pathname.split("/")];
	return values.some((v) => keys.includes(v));
}

/** True when `frameUrl` is one of `widget`'s own frames, loaded with the board's site key. */
function isWidgetFrame(frameUrl: string, widget: WidgetRule): boolean {
	const frame = parse(frameUrl);
	return (
		frame !== null &&
		widget.frames.some((entry) => under(frame, entry)) &&
		carriesKey(frame, widget.siteKeys, widget.keyInFragment ?? false)
	);
}

/**
 * How a real submission treats a request to a board host that is not a destination, by structure
 * alone (the filled-value check runs before it, in the browser guard):
 * - a widget endpoint: xhr or fetch (GET or POST) from that widget's own frame;
 * - a widget frame: a frame navigation (GET) under the widget's frame paths, its query allowed and,
 *   unless the key travels in the fragment, carrying the board's site key;
 * - an asset: GET or HEAD of a script, style, font, image or media file, its query allowed.
 * Anything else is refused. `formHosts` are the session's destinations.
 */
export function boardHostDecision(
	request: RequestFacts,
	rules: HostRules,
	formHosts: readonly string[],
): GuardDecision {
	const url = parse(request.url);
	if (!url) return { allow: false, reason: "not http" };
	const method = request.method.toUpperCase();
	const widgets = rules.widgets ?? [];
	const siteKeys = widgets.flatMap((w) => [...w.siteKeys]);
	const read = method === "GET" || method === "HEAD";
	for (const widget of widgets) {
		if (
			widget.endpoints.some((e) => under(url, e)) &&
			(method === "GET" || method === "POST") &&
			(request.resourceType === "xhr" || request.resourceType === "fetch") &&
			!request.mainFrame &&
			isWidgetFrame(request.frameUrl, widget)
		)
			return { allow: true, reason: `${widget.name} endpoint` };
		if (
			widget.frames.some((e) => under(url, e)) &&
			method === "GET" &&
			request.navigation &&
			!request.mainFrame &&
			request.resourceType === "document" &&
			queryAllowed(url, rules, siteKeys, formHosts) &&
			(widget.keyInFragment || carriesKey(url, widget.siteKeys, false))
		)
			return { allow: true, reason: `${widget.name} frame` };
	}
	if (
		read &&
		!request.navigation &&
		ASSET_TYPES.has(request.resourceType) &&
		rules.assets.some((h) => hostMatches(url.hostname, h)) &&
		queryAllowed(url, rules, siteKeys, formHosts)
	)
		return { allow: true, reason: "board asset, read" };
	return { allow: false, reason: "not an asset or a widget endpoint" };
}

/**
 * The values a filled form holds, as they may appear in a request. A single word ("LinkedIn",
 * a city, a first name) is left out: it is an option's text or too common to tell apart, and
 * would match a board's own URLs. Kept: an email, a phone number (as typed, without its "+",
 * and its digits), a link without its scheme and host (only the part that names the person),
 * and any other value of two words or more (the first 24 characters of a long one).
 */
export function formValueNeedles(values: string[]): string[] {
	const needles = new Set<string>();
	for (const raw of values) {
		const value = raw.trim().toLowerCase();
		const digits = value.replace(/\D/g, "");
		if (/^\+?[\d\s().-]+$/.test(value)) {
			if (digits.length >= 7) {
				needles.add(digits);
				needles.add(value);
				needles.add(value.replace(/^\+/, ""));
			}
			continue;
		}
		const link = value.match(
			/^(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(\/.*)$/,
		);
		if (link) {
			// The path that names the person ("/in/ada-example"), never the bare host.
			const path = (link[1] ?? "").replace(/\/+$/, "");
			if (path.replace(/[^a-z0-9]/g, "").length >= 6) needles.add(path);
			continue;
		}
		if (value.includes("@") || /\s/.test(value)) {
			if (value.length >= 4)
				needles.add(value.length > 40 ? value.slice(0, 24) : value);
		}
	}
	return [...needles];
}

/** Base64 runs long enough to hold a value (standard or URL alphabet). */
const BASE64_RUN = /[A-Za-z0-9+/_-]{8,}={0,2}/g;

/** `text` decoded the ways a script may wrap a value: URL-encoded (up to three times), JSON escapes. */
function decodings(text: string): string[] {
	const out = [text];
	let current = text;
	for (let i = 0; i < 3; i++) {
		let next = current;
		try {
			next = decodeURIComponent(current.replace(/\+/g, " "));
		} catch {}
		if (next === current) break;
		out.push(next);
		current = next;
	}
	const unescaped = current.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
	if (unescaped !== current) out.push(unescaped);
	return out;
}

/** Each base64 run in `text`, decoded (runs that do not decode are skipped). */
function base64Decoded(text: string): string[] {
	const out: string[] = [];
	for (const run of text.match(BASE64_RUN) ?? []) {
		const standard = run.replace(/-/g, "+").replace(/_/g, "/");
		// Every alignment: a value may start mid-run when its base64 was glued to other text.
		for (let shift = 0; shift < 4; shift++) {
			const part = standard.slice(shift).replace(/=+$/, "");
			const whole = part.length % 4 === 1 ? part.slice(0, -1) : part;
			if (whole.length < 8) continue;
			const usable = whole.padEnd(Math.ceil(whole.length / 4) * 4, "=");
			try {
				out.push(atob(usable));
			} catch {}
		}
	}
	return out;
}

/**
 * True when `text` (a URL or a request body) carries one of the form's values: as typed,
 * URL-encoded (even repeatedly), JSON-escaped, base64-encoded, or a phone number's digits inside
 * one run of digits. A second layer under the structural rules (`boardHostDecision`): a value
 * split across requests, hashed or encrypted still passes it.
 */
export function carriesFormData(
	text: string | null,
	needles: string[],
): boolean {
	if (!text || needles.length === 0) return false;
	const plain = decodings(text);
	const haystack = [...plain, ...plain.flatMap(base64Decoded)]
		.join("\n")
		.toLowerCase();
	const runs = haystack.match(/\d+/g) ?? [];
	return needles.some((n) =>
		/^\d+$/.test(n) ? runs.some((r) => r.includes(n)) : haystack.includes(n),
	);
}
