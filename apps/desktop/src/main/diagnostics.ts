import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactContact } from "@offerfinch/core/profile/types";
import { zipTools } from "./zip";

/**
 * Help › Export Diagnostics (issue #54): one zip the user can attach to a bug report themselves.
 * Nothing here sends anything. This module has no Electron import, so the tests build a bundle
 * from fabricated folders and prove the redaction on every file it holds.
 *
 * What goes in: the newest logs (their tails), the app's versions, a summary of settings the
 * worker builds from an allowlist (which roles use which kind of model, which sources are on,
 * the schedule), the newest site-debug pages (already a sanitized DOM) and a manifest. Every
 * file, the manifest and the summary included, goes through one redaction pass.
 */

/** The folder inside the zip, so unzipping never spills files into Downloads. */
export const BUNDLE_DIR = "offerfinch-diagnostics";
/** A log's newest part: the end of a log is what explains the problem just seen. */
export const LOG_FILE_LIMIT = 256 * 1024;
export const LOGS_TOTAL_LIMIT = 1024 * 1024;
export const DEBUG_KEEP = 3;
export const DEBUG_FILE_LIMIT = 256 * 1024;
export const DEBUG_TOTAL_LIMIT = 768 * 1024;
/** What the review sheet shows of each file; the zip holds all of it. */
export const PREVIEW_LIMIT = 64 * 1024;

/** The user's own details, for the redaction pass only: never written to the bundle. */
export interface KnownPersonal {
	names: string[];
	emails: string[];
	phones: string[];
	/** Profile links (LinkedIn, website, GitHub): a handle in a path escapes name matching. */
	links: string[];
}

export interface DiagnosticFile {
	/** Path inside the bundle's folder ("logs/main.log"). */
	name: string;
	text: string;
}

const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Letters Unicode does not decompose into an ASCII letter and a mark (Turkish dotless ı). */
const FOLD: Record<string, string> = { ı: "i", İ: "I" };

/**
 * A name as logs and URLs write it without its accents: "Öztürk" as "Ozturk", "Ayşe" as
 * "Ayse". NFD splits ö, ü, ş, ç and ğ into a letter and a mark; the marks are dropped.
 */
export const foldAccents = (text: string) =>
	text
		.replace(/[ıİ]/g, (c) => FOLD[c] ?? c)
		.normalize("NFD")
		.replace(/\p{M}/gu, "");

/** Not inside a longer word; a digit may touch it ("ozturk1987" still names the person). */
const LETTER_BEFORE = "(?<![\\p{L}])";
const LETTER_AFTER = "(?![\\p{L}])";

/** Parts written one after another, with or without a space, dot, dash or underscore. */
const joined = (parts: string[]) =>
	new RegExp(
		`${LETTER_BEFORE}${parts.map(escapeRegExp).join("[\\s._-]*")}${LETTER_AFTER}`,
		"giu",
	);

/** Every run of two parts or more, in order: "Ayşe Gül", "Gül Öztürk", "Ayşe Gül Öztürk". */
function partRuns(parts: string[]): string[][] {
	const runs: string[][] = [];
	for (let start = 0; start < parts.length; start++)
		for (let end = start + 2; end <= parts.length; end++)
			runs.push(parts.slice(start, end));
	return runs;
}

/**
 * The user's name as it can appear in a log or a URL, as written and without its accents:
 * every run of two parts or more, joined with or without separators ("aysegul",
 * "ayse.gul.ozturk", "AYSEGULOZTURK"), then each single part of three letters or more. A part
 * of one or two letters ("Li") is matched only inside a run, never alone.
 */
function namePatterns(names: readonly string[]): RegExp[] {
	const found = new Map<string, string[]>();
	for (const name of names)
		for (const form of new Set([name.trim(), foldAccents(name.trim())])) {
			const parts = form.split(/[\s,.]+/).filter(Boolean);
			for (const run of partRuns(parts)) found.set(run.join(" "), run);
			for (const part of parts) if (part.length >= 3) found.set(part, [part]);
		}
	// Longest first, so a whole name is replaced as one before its parts are.
	return [...found.entries()]
		.sort(([a], [b]) => b.length - a.length)
		.map(([, run]) => joined(run));
}

/** A profile link without its scheme or "www." ("linkedin.com/in/…"). */
const bareLink = (link: string) =>
	link
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/^www\./i, "")
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "");

/**
 * The profile's links matched anywhere, then their handles alone: the last part of the path
 * ("linkedin.com/in/<handle>", "github.com/<handle>") of three characters or more, which logs
 * and file names carry without the domain.
 */
function linkPatterns(links: readonly string[]): RegExp[] {
	const bare = links.map(bareLink).filter((link) => link.length >= 6);
	const handles = bare
		.filter((link) => link.includes("/"))
		.map((link) => link.slice(link.lastIndexOf("/") + 1))
		.filter((handle) => handle.length >= 3);
	return [
		...bare.map((link) => new RegExp(escapeRegExp(link), "gi")),
		...handles.map(
			(handle) =>
				new RegExp(
					`(?<![\\p{L}\\p{N}_-])${escapeRegExp(handle)}(?![\\p{L}\\p{N}_-])`,
					"giu",
				),
		),
	];
}

/** A URL's query and fragment: they carry tokens, search terms and session ids. */
const URL_QUERY =
	/\b((?:https?|wss?|file):\/\/[^\s?#"'<>`\\]*)[?#][^\s"'<>`\\]*/gi;
/** Any user's home folder, not only this one ("/Users/<name>/…" names the account). */
const HOME_FOLDER = /\/Users\/[^/\s"'`:]+/g;
// Includes slash-normalized and JSON-escaped paths, and accounts other than this user's.
const WINDOWS_HOME_FOLDER = /(?:[a-z]:)?[\\/]+Users[\\/]+[^\\/"'`\r\n]+/gi;
const ENCODED_WINDOWS_HOME_FOLDER =
	/(?:[a-z]%3a)?(?:%5c|%2f)+Users(?:%5c|%2f)+(?:(?!%5c|%2f|%22|%27|%0a|%0d)[^"'`\r\n])+/gi;
const SECRET_KEY = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g;
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g;
/**
 * "apiKey": "…", token=…, Cookie: …: the value goes whatever it looks like. Quotes may be
 * escaped (a log line's JSON inside a JSON string: \"password\":\"…\").
 */
const LABELLED =
	/((?:api[_-]?key|access[_-]?key|token|secret|password|passwd|authorization|cookie|session[_-]?id|csrf)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)([^\s"'\\,;}&]+)/gi;
const LONG_HEX = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g;
const LONG_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

/**
 * A long run is a key or a token when letters of both cases and digits are mixed all through
 * it, as in base64. A timestamped file name or a path ("2026-11-03T09-00-00-000Z-linkedin")
 * has one or two capitals at most, so it stays readable.
 */
const count = (run: string, pattern: RegExp) => run.match(pattern)?.length ?? 0;
const looksRandom = (run: string) =>
	count(run, /[A-Z]/g) >= 4 &&
	count(run, /[a-z]/g) >= 4 &&
	count(run, /\d/g) >= 2;

function redactSecrets(text: string): string {
	return text
		.replace(SECRET_KEY, "[key]")
		.replace(BEARER, "$1 [token]")
		.replace(JWT, "[token]")
		.replace(LABELLED, "$1[redacted]")
		.replace(LONG_HEX, "[token]")
		.replace(LONG_RUN, (run) => (looksRandom(run) ? "[token]" : run));
}

/**
 * The one redaction pass every file of the bundle goes through, in this order: URL queries,
 * home folders (to ~), the user's own name, links, email and phone, then anything that looks
 * like a key or a token, then any email address or phone number at all (core's redactContact,
 * which keeps dates, links and amounts readable).
 */
export function redactDiagnostics(
	text: string,
	known: KnownPersonal,
	home: string = os.homedir(),
): string {
	const held: string[] = [];
	const hold = text.replace(STAMPS, (stamp) => {
		held.push(stamp);
		return `\uE001${held.length - 1}\uE001`;
	});
	return redactAll(hold, known, home).replace(
		/\uE001(\d+)\uE001/g,
		(_, i: string) => held[Number(i)] ?? "",
	);
}

/**
 * Time stamps written as one run of digits, which the phone pattern would take for a number:
 * a migration's "20261101120000_init" (year to second) and a millisecond time (13 digits, 2020
 * to 2286). No phone number has either shape: E.164 numbers have at most 15 digits, and these
 * are anchored to a date or to the epoch's range.
 */
const STAMPS =
	/(?<![\d+])(?:20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[01]\d|2[0-3])[0-5]\d[0-5]\d|1[6-9]\d{11})(?!\d)/g;

function redactAll(text: string, known: KnownPersonal, home: string): string {
	let out = text.replace(URL_QUERY, "$1");
	if (home.length > 1) {
		const windows = path.win32.isAbsolute(home);
		const pattern = windows
			? home
					.split(/[\\/]+/)
					.map(escapeRegExp)
					.join(String.raw`[\\/]+`)
			: escapeRegExp(home);
		out = out.replace(new RegExp(pattern, windows ? "gi" : "g"), "~");
	}
	out = out
		.replace(ENCODED_WINDOWS_HOME_FOLDER, "~")
		.replace(WINDOWS_HOME_FOLDER, "~")
		.replace(HOME_FOLDER, "~");
	for (const pattern of linkPatterns(known.links))
		out = out.replace(pattern, "[link]");
	out = redactContact(out, [...known.emails, ...known.phones]);
	for (const pattern of namePatterns(known.names))
		out = out.replace(pattern, "[name]");
	out = redactSecrets(out);
	// Last, so a key or token pattern cannot have split an address the first pass missed.
	return redactContact(out);
}

/** Bytes 0b10xxxxxx continue a UTF-8 character; they never start one. */
const continuation = (byte: number | undefined) =>
	byte !== undefined && (byte & 0xc0) === 0x80;

/** A character's length in bytes from its first byte (1 for ASCII or a stray byte). */
const charLength = (byte: number) =>
	byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;

/**
 * The bytes as text, without a character cut at either end: a read that starts or stops
 * inside a character would otherwise show it as "�".
 */
export function decodeWhole(bytes: Buffer): string {
	let start = 0;
	while (start < bytes.length && continuation(bytes[start])) start++;
	let end = bytes.length;
	let lead = end - 1;
	while (lead > start && continuation(bytes[lead])) lead--;
	const first = bytes[lead];
	if (first !== undefined && lead + charLength(first) > end) end = lead;
	return bytes.subarray(start, end).toString("utf8");
}

/** Reads `length` bytes at `position`, never more: a huge file is not loaded whole. */
function readBytes(file: string, position: number, length: number): Buffer {
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const read = fs.readSync(fd, buffer, 0, length, position);
		return buffer.subarray(0, read);
	} finally {
		fs.closeSync(fd);
	}
}

/** The last `limit` bytes of a file, from the first whole line, with a note when cut. */
export function readTail(file: string, limit: number): string {
	const size = fs.statSync(file).size;
	if (size <= limit) return decodeWhole(readBytes(file, 0, size));
	const text = decodeWhole(readBytes(file, size - limit, limit));
	// From the first whole line; a log with no line break at all is kept from its first character.
	const firstLine = text.indexOf("\n");
	return `[older lines left out: the file has ${size} bytes]\n${text.slice(firstLine + 1)}`;
}

const CUT_NOTE = "\n[cut at the size limit]\n";

/** The first `limit` bytes of a file at most (the note included), read no further. */
export function readHead(file: string, limit: number): string {
	const size = fs.statSync(file).size;
	if (size <= limit) return decodeWhole(readBytes(file, 0, size));
	const room = limit - Buffer.byteLength(CUT_NOTE);
	return decodeWhole(readBytes(file, 0, room)) + CUT_NOTE;
}

/** The first `limit` bytes of text, cut at a character, never a byte inside one. */
function capBytes(text: string, limit: number): string {
	if (Buffer.byteLength(text) <= limit) return text;
	const room = limit - Buffer.byteLength(CUT_NOTE);
	return decodeWhole(Buffer.from(text).subarray(0, room)) + CUT_NOTE;
}

/** Files in a folder with the given ending, newest first; none when it does not exist. */
function newestFiles(dir: string, ending: string): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(ending));
	} catch {
		return [];
	}
	return names
		.map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
		.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
		.map((f) => f.name);
}

/** Adds files while the total stays within `total`; the rest are listed as left out. */
function takeWithin(
	names: string[],
	read: (name: string) => string,
	total: number,
	leftOut: string[],
	prefix: string,
): DiagnosticFile[] {
	const out: DiagnosticFile[] = [];
	let used = 0;
	for (const name of names) {
		const text = read(name);
		const bytes = Buffer.byteLength(text);
		if (used + bytes > total) {
			leftOut.push(`${prefix}/${name}`);
			continue;
		}
		used += bytes;
		out.push({ name: `${prefix}/${name}`, text });
	}
	return out;
}

export interface DiagnosticsInput {
	logsDir: string;
	userDataDir: string;
	/** Versions, OS and build: shown as "label: value" lines. */
	system: Record<string, string>;
	/** The worker's settings summary, or why it could not be read. */
	settings: unknown;
	known: KnownPersonal;
	home?: string;
	now?: Date;
}

/** What the manifest says is never in the bundle, whatever the logs held. */
const NEVER_INCLUDED = [
	"API keys, tokens, cookies and site sign-in sessions",
	"Your profile, answers, notes and chat",
	"Job descriptions, CVs, letters and other documents",
	"The database and the Keychain",
];

const REDACTION_RULES = [
	"Web addresses lose their query and fragment",
	"Home folders are written as ~",
	"Your name, email, phone and profile links become [name], [email], [phone] and [link]",
	"Any email address or phone number becomes [email] or [phone]",
	"Anything that looks like a key or a token (sk-…, Bearer …, long hex or base64) becomes [key], [token] or [redacted]",
];

/** Every file of the bundle, redacted, in the order the review sheet lists them. */
export function buildDiagnostics(input: DiagnosticsInput): DiagnosticFile[] {
	const leftOut: string[] = [];
	const logs = takeWithin(
		newestFiles(input.logsDir, ".log"),
		(name) => readTail(path.join(input.logsDir, name), LOG_FILE_LIMIT),
		LOGS_TOTAL_LIMIT,
		leftOut,
		"logs",
	);
	const debugDir = path.join(input.userDataDir, "site-debug");
	const pages = takeWithin(
		newestFiles(debugDir, ".html").slice(0, DEBUG_KEEP),
		(name) => readHead(path.join(debugDir, name), DEBUG_FILE_LIMIT),
		DEBUG_TOTAL_LIMIT,
		leftOut,
		"site-debug",
	);
	const system = Object.entries(input.system)
		.map(([label, value]) => `${label}: ${value}`)
		.join("\n");
	const files: DiagnosticFile[] = [
		{ name: "system.txt", text: `${system}\n` },
		{
			name: "settings.json",
			text: `${JSON.stringify(input.settings, null, 2)}\n`,
		},
		...logs,
		...pages,
	];
	const redact = (text: string) =>
		redactDiagnostics(text, input.known, input.home);
	const redacted = files.map((f) => ({
		name: redact(f.name),
		text: redact(f.text),
	}));
	const manifest = {
		bundle: "OfferFinch diagnostics",
		createdAt: (input.now ?? new Date()).toISOString(),
		files: redacted.map((f) => ({
			name: f.name,
			bytes: Buffer.byteLength(f.text),
		})),
		leftOutForSize: leftOut.map(redact),
		limits: {
			logFileBytes: LOG_FILE_LIMIT,
			logsTotalBytes: LOGS_TOTAL_LIMIT,
			siteDebugPages: DEBUG_KEEP,
			siteDebugFileBytes: DEBUG_FILE_LIMIT,
			siteDebugTotalBytes: DEBUG_TOTAL_LIMIT,
		},
		neverIncluded: NEVER_INCLUDED,
		redaction: REDACTION_RULES,
	};
	return [
		{
			name: "manifest.json",
			text: redact(`${JSON.stringify(manifest, null, 2)}\n`),
		},
		...redacted,
	];
}

/** What the review sheet shows of a file: its start, with a note when there is more. */
export function previewOf(file: DiagnosticFile): {
	name: string;
	bytes: number;
	preview: string;
	cut: boolean;
} {
	const bytes = Buffer.byteLength(file.text);
	return {
		name: file.name,
		bytes,
		preview: capBytes(file.text, PREVIEW_LIMIT),
		cut: bytes > PREVIEW_LIMIT,
	};
}

/**
 * Writes the files into a private temporary folder and zips it with built-in tools (no new
 * dependency), then removes the folder. The zip holds exactly the files the sheet showed. As a
 * backup is (backup.ts), it is written beside the target as `.partial`, made readable by this
 * user only, then renamed over the target: a failed save leaves no half zip and keeps the
 * file that was there.
 */
export async function zipDiagnostics(
	files: readonly DiagnosticFile[],
	target: string,
): Promise<void> {
	const temp = fs.mkdtempSync(
		path.join(os.tmpdir(), "offerfinch-diagnostics-"),
	);
	try {
		const root = path.join(temp, BUNDLE_DIR);
		for (const file of files) {
			const full = path.join(root, file.name);
			if (!full.startsWith(`${root}${path.sep}`))
				throw new Error(`Bad file name in the bundle: ${file.name}`);
			fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
			fs.writeFileSync(full, file.text, { mode: 0o600 });
		}
		const final = path.resolve(target);
		const partial = `${final}.partial`;
		fs.rmSync(partial, { force: true });
		try {
			await zipTools.create(root, partial, true);
			fs.chmodSync(partial, 0o600);
			fs.renameSync(partial, final);
		} catch (error) {
			fs.rmSync(partial, { force: true });
			throw error;
		}
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
}
