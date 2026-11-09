import type { NetworkLogEntry } from "../scrape/browser";

/**
 * Whether a request after the submit click on an employer's form is the application itself
 * (docs/decisions.md, 2026-11-09, step 6 re-review): its body, decoded, carries the approved
 * values. Form-encoded, multipart and JSON bodies are read; anything else is plain text.
 */

/** What an employer's form was filled with that its application request must carry. */
export interface SentValues {
	/** Every approved value typed into a text box (the email among them). */
	typed: string[];
	/** The CV's file name, when one was chosen. */
	cv: string | null;
}

interface Decoded {
	texts: string[];
	files: { name: string; pdf: boolean }[];
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Every string and number in a JSON value. */
function leaves(value: unknown, out: string[]): void {
	if (typeof value === "string") out.push(value);
	else if (typeof value === "number" || typeof value === "boolean")
		out.push(String(value));
	else if (Array.isArray(value)) for (const v of value) leaves(v, out);
	else if (value && typeof value === "object")
		for (const v of Object.values(value)) leaves(v, out);
}

function multipart(body: Uint8Array, boundary: string): Decoded {
	const raw = Buffer.from(body).toString("latin1");
	const out: Decoded = { texts: [], files: [] };
	for (const part of raw.split(`--${boundary}`)) {
		const split = part.indexOf("\r\n\r\n");
		if (split < 0) continue;
		const head = part.slice(0, split);
		const content = part.slice(split + 4).replace(/\r\n$/, "");
		const file = head.match(/filename="([^"]*)"/i);
		const utf8 = (text: string) => Buffer.from(text, "latin1").toString("utf8");
		if (file)
			out.files.push({
				name: utf8(file[1] ?? ""),
				pdf: content.startsWith("%PDF-"),
			});
		else out.texts.push(utf8(content));
	}
	return out;
}

/** The values a request body carries, by its content type. */
export function decodeBody(body: Uint8Array, contentType: string): Decoded {
	const type = contentType.toLowerCase();
	const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
	if (type.startsWith("multipart/form-data") && boundary)
		return multipart(body, boundary[1] ?? boundary[2] ?? "");
	const text = Buffer.from(body).toString("utf8");
	if (type.includes("json") || /^\s*[[{]/.test(text)) {
		try {
			const texts: string[] = [];
			leaves(JSON.parse(text), texts);
			return { texts, files: [] };
		} catch {}
	}
	if (
		type.startsWith("application/x-www-form-urlencoded") ||
		/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(text)
	)
		return { texts: [...new URLSearchParams(text).values()], files: [] };
	return { texts: [text], files: [] };
}

/** What a request carries: its body, decoded; a GET's (a native GET form's) is its query. */
function carried(entry: NetworkLogEntry): Decoded | null {
	if (entry.body) return decodeBody(entry.body, entry.contentType ?? "");
	if (!/^GET$/i.test(entry.method)) return null;
	try {
		return {
			texts: [...new URL(entry.url).searchParams.values()],
			files: [],
		};
	} catch {
		return null;
	}
}

/**
 * True when `entry`'s body (a GET's query) carries every approved typed value (each as one whole
 * value; spaces and line ends compared loosely), or, when nothing was typed, the CV file.
 */
export function carriesValues(
	entry: NetworkLogEntry,
	values: SentValues,
): boolean {
	const decoded = carried(entry);
	if (!decoded) return false;
	const sent = new Set(decoded.texts.map(squash));
	const typed = values.typed.map(squash).filter(Boolean);
	if (typed.length > 0) return typed.every((v) => sent.has(v));
	return (
		values.cv !== null &&
		decoded.files.some((f) => f.name === values.cv || f.pdf)
	);
}

/** True when the request answered 2xx or 3xx. */
export const answeredOk = (entry: NetworkLogEntry): boolean =>
	entry.status !== undefined && entry.status >= 200 && entry.status < 400;

/**
 * True when `entry` is the application: a request answered 2xx or 3xx whose body carries the
 * approved values (`carriesValues`).
 */
export function carriesApplication(
	entry: NetworkLogEntry,
	values: SentValues,
): boolean {
	return answeredOk(entry) && carriesValues(entry, values);
}

/**
 * Wording that says an application did not go through, or may not have: on the page after the
 * click, or in the HTML the application request was answered with, any of these makes the
 * outcome unknown, whatever else the page says (docs/decisions.md, 2026-11-09, step 6 third
 * pass); it covers every wording of the boards' `REFUSAL` and `DUPLICATE` (forms.ts). Unknown is
 * the safe side: a confirmation page that happens to say "no further action is
 * required" is checked by hand. Each entry is a regular expression source, matched whole-word,
 * case-insensitive.
 */
export const OUTCOME_REFUSALS: readonly string[] = [
	// English
	// The longer wordings first, so the message quotes them whole.
	"could ?n[o'’]t be (?:submitted|sent|processed|completed|saved|received)",
	"could ?n[o'’]t (?:submit|send|process|complete|save)",
	"could ?n[o'’]t",
	"unable to (?:submit|send|process|complete|save)",
	"not (?:been )?(?:submitted|sent|received|accepted|processed)",
	"(?:something|it) went wrong",
	"errors?",
	"fail(?:ed|ure|s)?",
	"invalid",
	"required",
	"missing",
	"try again",
	"already (?:applied|submitted|received|sent)",
	"duplicate",
	"rejected",
	"declined",
	"unsuccessful",
	"problem",
	"please (?:correct|fix|check|review)",
	"expired",
	"too many (?:requests|attempts)",
	"access denied",
	"forbidden",
	// German
	"fehler",
	"fehlgeschlagen",
	"ungültig",
	"erforderlich",
	"pflichtfeld",
	"erneut versuchen",
	"bereits beworben",
	// French
	"erreur",
	"échec",
	"invalide",
	"obligatoire",
	"requis",
	"réessayer",
	"déjà postulé",
	// Spanish
	"inválido",
	"obligatorio",
	"requerido",
	"(?:inténtalo|intente|intenta) de nuevo",
	"vuelva a intentar(?:lo)?",
];

/** Letters and digits on either side end a match: `\b` knows no letter outside ASCII. */
const REFUSAL_WORDING = new RegExp(
	`(?<![\\p{L}\\p{N}])(?:${OUTCOME_REFUSALS.join("|")})(?![\\p{L}\\p{N}])`,
	"iu",
);

/** The first refusal or error wording in `text` (`OUTCOME_REFUSALS`), or null. */
export function refusalIn(text: string): string | null {
	return text.replace(/\s+/g, " ").match(REFUSAL_WORDING)?.[0] ?? null;
}

/** The text of an HTML answer: scripts, styles and tags dropped, hidden parts kept. */
export function htmlText(html: string): string {
	return html
		.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&#39;|&apos;|&rsquo;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}
