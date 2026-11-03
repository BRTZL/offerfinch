import { codePoint, decodeEntities, htmlToText } from "../domain/text";
import type { WorkplaceType } from "../domain/types";
import { type FetchLike, USER_AGENT } from "../sources/types";

/**
 * Reading a public feed: one GET with the app's honest User-Agent, a time limit and a size
 * limit. A refusal (403, 429), a server error or a page where the feed should be (a browser
 * check serves HTML) is a `FeedReadError`; the provider keeps it as a transient stop.
 */

/** A feed's whole answer at most (Remote OK's API is about 0.7 MB, an HN thread a few MB). */
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export class FeedReadError extends Error {
	constructor(
		message: string,
		/** The HTTP status, when there was one. */
		readonly status: number | null,
		/** A refusal or a check page, as opposed to a network or server error. */
		readonly refused: boolean,
	) {
		super(message);
		this.name = "FeedReadError";
	}
}

/** Reads one feed URL as text (JSON or XML). */
export type FeedFetch = (
	url: string,
	kind: "json" | "xml",
	signal?: AbortSignal,
) => Promise<string>;

export function feedFetcher(fetchImpl: FetchLike): FeedFetch {
	return async (url, kind, signal) => {
		const timeout = AbortSignal.timeout(TIMEOUT_MS);
		const res = await fetchImpl(url, {
			headers: {
				accept:
					kind === "json"
						? "application/json"
						: "application/rss+xml, application/xml, text/xml",
				"user-agent": USER_AGENT,
			},
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		}).catch((error: unknown) => {
			if (signal?.aborted) throw error;
			throw new FeedReadError(
				`could not reach ${new URL(url).host} (${error instanceof Error ? error.message : String(error)})`,
				null,
				false,
			);
		});
		if (res.status === 403 || res.status === 429)
			throw new FeedReadError(
				`${new URL(url).host} refused the request (HTTP ${res.status})`,
				res.status,
				true,
			);
		if (!res.ok)
			throw new FeedReadError(
				`${new URL(url).host} answered HTTP ${res.status}`,
				res.status,
				false,
			);
		const length = Number(res.headers.get("content-length") ?? 0);
		if (length > MAX_BYTES)
			throw new FeedReadError("the feed is too large to read", null, false);
		const text = await res.text();
		if (text.length > MAX_BYTES)
			throw new FeedReadError("the feed is too large to read", null, false);
		// A browser check or an error page where the feed should be.
		const head = text.trimStart().slice(0, 200).toLowerCase();
		const html = head.startsWith("<!doctype html") || head.startsWith("<html");
		if (html || (kind === "json" && !/^[[{]/.test(head)))
			throw new FeedReadError(
				`${new URL(url).host} sent a web page instead of its feed`,
				res.status,
				true,
			);
		return text;
	};
}

/** Hex references (`&#x2F;`, as HN writes) as decimal ones, which the decoders read. */
const hexToDecimal = (text: string) =>
	text.replace(
		/&#x([0-9a-f]+);/gi,
		(_, hex: string) => `&#${Number.parseInt(hex, 16)};`,
	);

/** `&#x2F;` and the other hex references HN writes, then the usual entities. */
function decodeAll(text: string): string {
	return decodeEntities(hexToDecimal(text));
}

/**
 * XML's escapes undone once (an RSS field's text: its HTML arrives escaped), each character
 * reference range-checked; `&amp;` last, so "&amp;lt;" stays the text "&lt;".
 */
function xmlText(text: string): string {
	return hexToDecimal(text)
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => codePoint(Number(code)))
		.replace(/&amp;/g, "&");
}

/**
 * UTF-8 read as Latin-1 somewhere upstream ("Â·" for "·", "â€“" for "–"), as Remote OK's
 * descriptions arrive: each such run is decoded again when it forms valid UTF-8.
 */
export function fixMojibake(text: string): string {
	return text.replace(/[Â-ô][\u0080-¿]+/g, (run) => {
		const fixed = Buffer.from(run, "latin1").toString("utf8");
		return fixed.includes("�") ? run : fixed;
	});
}

/**
 * A feed's HTML description (as HTML: an RSS field is unescaped by `rssItems` first) as the plain
 * text the filter and the scorer read. Entities are decoded after the HTML is parsed, so an
 * escaped "&lt;jobs@acme.example&gt;" stays text instead of being read as a tag.
 */
export function feedText(html: string): string {
	// `htmlToText` decodes the whole input first when it sees "&lt;" + a letter (Greenhouse
	// escapes its HTML); feeds don't, so their escaped brackets go in as numeric references.
	return htmlToText(
		hexToDecimal(html).replace(/&lt;/g, "&#60;").replace(/&gt;/g, "&#62;"),
	);
}

/** One line of text from a feed field: entities decoded, tags and extra spaces gone. */
export function feedLine(text: string): string {
	return decodeAll(text.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

/** A date a feed gave, or nothing when it can't be read. */
export function feedDate(value: unknown): Date | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const date = new Date(
		typeof value === "number" && value < 1e12 ? value * 1000 : value,
	);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Remote when the place says so, hybrid or on-site likewise; else what the feed is. */
export function workplaceOf(
	text: string,
	fallback: WorkplaceType,
): WorkplaceType {
	if (/\bhybrid\b/i.test(text)) return "hybrid";
	if (/\bremote\b|\banywhere\b|\bworldwide\b/i.test(text)) return "remote";
	if (/\bon[- ]?site\b|\bin[- ]office\b/i.test(text)) return "onsite";
	return fallback;
}

/** The text of each `<tag>` in an RSS item, CDATA unwrapped (one level, as feeds write it). */
export function rssItems(xml: string): Record<string, string>[] {
	const items: Record<string, string>[] = [];
	for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
		const fields: Record<string, string> = {};
		for (const f of (match[1] ?? "").matchAll(
			/<([a-z][\w:-]*)\b[^>]*>([\s\S]*?)<\/\1>/gi,
		)) {
			const name = (f[1] ?? "").toLowerCase();
			if (name in fields) continue;
			const raw = f[2] ?? "";
			const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
			// The field's own text: CDATA as it is, anything else with XML's escapes undone once.
			fields[name] = cdata ? (cdata[1] ?? "") : xmlText(raw);
		}
		items.push(fields);
	}
	return items;
}

/** A feed's postings, and how many of its items could not be read (skipped, never fatal). */
export interface FeedParse<P> {
	postings: P[];
	skipped: number;
}

/**
 * Reads each item on its own: `read` returns the posting, null for an item that is no posting
 * (a legal notice, a reply, a deleted comment), or "bad" for one that can't be read; a throw is
 * bad too. One broken item never costs the rest of a read the pace allows only so often.
 */
export function parseEach<P>(
	items: unknown,
	read: (item: unknown) => P | null | "bad",
): FeedParse<P> {
	const out: FeedParse<P> = { postings: [], skipped: 0 };
	for (const item of Array.isArray(items) ? items : []) {
		let posting: P | null | "bad";
		try {
			posting = read(item);
		} catch {
			posting = "bad";
		}
		if (posting === "bad") out.skipped++;
		else if (posting) out.postings.push(posting);
	}
	return out;
}

/** A field's text: "" when absent, null when it is there but not text (the item is bad). */
export function field(value: unknown): string | null {
	if (value === undefined || value === null) return "";
	return typeof value === "string" ? value : null;
}

/** An object item's fields, or null for anything else (a number, a string, null). */
export function record(item: unknown): Record<string, unknown> | null {
	return item && typeof item === "object" && !Array.isArray(item)
		? (item as Record<string, unknown>)
		: null;
}

/** A link a job may carry: http(s) only, never `javascript:` or a file. */
export const webUrl = (url: string) => /^https?:\/\/[^\s/]+/i.test(url);

/** A feed's tags: its strings, nothing when it gives no list. */
export const tagList = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((t): t is string => typeof t === "string")
		: [];
