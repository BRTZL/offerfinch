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

/**
 * True when `entry`'s body carries every approved typed value (each as one whole value; spaces
 * and line ends compared loosely), or, when nothing was typed, the CV file.
 */
export function carriesValues(
	entry: NetworkLogEntry,
	values: SentValues,
): boolean {
	if (!entry.body) return false;
	const decoded = decodeBody(entry.body, entry.contentType ?? "");
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
