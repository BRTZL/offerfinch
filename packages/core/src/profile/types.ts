export interface ProfileDocument {
	/** Path relative to the profile root, e.g. `experience/2023-brightloom.md`. */
	path: string;
	content: string;
}

export interface ProfileSnapshot {
	files: ProfileDocument[];
}

// Bounded runs (an email's local part is at most 64 characters, a host label 63), so a long
// prompt without an "@" or a "." costs linear time, not quadratic.
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}\.[\w.-]{1,253}/g;
const HAS_EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}\.[\w.-]{1,253}/;
/**
 * A phone-like run of digits. Not one glued to letters or digits on either side: an id such as
 * "8f57b868-5318-4ad1" is not a phone number (redacting it broke the claims check's citations).
 */
const PHONE = /(?<![A-Za-z0-9])\+?\d[\d\s().-]{8,}\d(?![A-Za-z0-9])/g;
/** A labelled phone number ("Phone: …", "**Mobile:** …"): redacted whatever it looks like. */
const LABELLED_PHONE =
	/\b((?:phone|telephone|tel|mobile|cell|whatsapp|gsm)(?:\s*(?:number|no\.?))?\s*[:=](?:\*\*|__)?\s*)([+$€£₺(]?\s?\d[\d\s().\-/+]*\d)/gi;
/** Messaging links whose path or query is a phone number: never kept. */
const MESSAGING =
	/(?:^|[/.])(?:wa\.me|whatsapp\.com|t\.me|telegram\.(?:me|org)|signal\.me|viber\.com|skype\.com|line\.me)\b|[?&](?:phone|tel|mobile|number|msisdn)=/i;
/** No digit next to a kept span, directly or across one of "-./": "2019-2021-123" hides a phone. */
const BEFORE = /(?<![\d+])(?<!\d[-./])/.source;
const AFTER = /(?!\d)(?![-./]\d)/.source;
/**
 * An amount: grouped ("100 000", "95,000"), or up to seven digits ungrouped ("100000"; a phone
 * number is longer), with decimals ("85.50", "60.000,00") or a "k".
 */
const AMOUNT = /(?:\d{1,3}(?:[ .,]\d{3})+|\d{1,7})(?:[.,]\d{1,2})?(?:\s?k\b)?/
	.source;
/** Before or after the amount. */
const CURRENCY = /(?:[€$£₺]|\b(?:EUR|USD|GBP|TRY|CHF)\b)/.source;
const TO = /\s*(?:-|–|—|\bto\b)\s*/.source;
/** No digit after an amount, so "$555 123 4567" is not read as "$555 123". */
const AMOUNT_END = /(?![\d.,]?\d)(?!\s\d)/.source;
/** "USD 100000 - 120000", "$95,000.50 to $120,000", "£60k - £80k". */
const MONEY_PREFIXED = `${CURRENCY}\\s?(?<![+])${AMOUNT}(?:${TO}(?:${CURRENCY}\\s?)?${AMOUNT})?${AMOUNT_END}`;
/** "100000 - 120000 EUR", "85.50 EUR", "60k - 80k". */
const MONEY_SUFFIXED = `(?<![+\\d.,])${AMOUNT}(?:${TO}${AMOUNT})?(?:\\s?${CURRENCY}|(?<=k))(?![\\p{L}\\d])`;

/**
 * Text that looks like a phone number to PHONE but is a fact the models must see and quote as
 * written: ISO dates ("2026-10-27"), day-first dates ("31.10.2026"), year ranges ("2019 - 2021"),
 * links (a job id in "…/jobs/4567890123"), and money with its currency ("€60 000 - 80 000",
 * "USD 100000 - 120000").
 * A messaging link ("wa.me/…", "…?phone=…") is not kept: it holds a phone number.
 */
const KEPT = new RegExp(
	[
		`${BEFORE}\\d{4}-\\d{2}-\\d{2}${AFTER}`,
		`${BEFORE}(?<!\\.)\\d{1,2}[./]\\d{1,2}[./](?:19|20)\\d{2}${AFTER}`,
		`${BEFORE}(?:19|20)\\d{2}\\s*-\\s*(?:19|20)\\d{2}${AFTER}`,
		/\b(?:https?:\/\/)?(?:[\w-]{1,63}\.){1,8}[a-z]{2,24}\/[^\s<>"')\]]*/.source,
		`${MONEY_PREFIXED}|${MONEY_SUFFIXED}`,
	].join("|"),
	"giu",
);

const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The user's own email and phone as patterns: the email in any case, the phone by its digits
 * with any separators, with or without its country code or a leading 0.
 */
function knownPatterns(
	known: readonly string[],
): { pattern: RegExp; label: string }[] {
	const out: { pattern: RegExp; label: string }[] = [];
	for (const value of known) {
		const trimmed = value.trim();
		if (trimmed.includes("@")) {
			out.push({
				pattern: new RegExp(escapeRegExp(trimmed), "gi"),
				label: "[email]",
			});
			continue;
		}
		const digits = trimmed.replace(/\D/g, "");
		if (digits.length < 7) continue;
		// The last nine digits are the number without its country code in most plans.
		const tail = digits.slice(-9).split("").join("[\\s().\\-/]*");
		out.push({
			pattern: new RegExp(
				`(?<!\\d)\\+?(?:\\d[\\s().\\-/]*){0,4}${tail}(?!\\d)`,
				"g",
			),
			label: "[phone]",
		});
	}
	return out;
}

/**
 * Removes email addresses and phone numbers before text leaves the machine or the database.
 * `known` are the user's own email and phone: removed first, whatever is around them. Dates,
 * links and amounts are kept (see KEPT), unless a digit touches them or a link is a messaging
 * link: redacting "2026-10-27" as a phone number made the claims check quote "[phone]" and then
 * fail to find its own quote in the file.
 */
export function redactContact(
	text: string,
	known: readonly string[] = [],
): string {
	let out = text;
	for (const { pattern, label } of knownPatterns(known))
		out = out.replace(pattern, label);
	out = out.replace(LABELLED_PHONE, (whole, label: string, number: string) =>
		number.replace(/\D/g, "").length >= 7 ? `${label}[phone]` : whole,
	);
	const kept: string[] = [];
	const held = out.replace(KEPT, (match) => {
		// An email inside a link is still an email; a messaging link holds a phone number.
		if (HAS_EMAIL.test(match) || MESSAGING.test(match)) return match;
		kept.push(match);
		return `\uE000${kept.length - 1}\uE000`;
	});
	return held
		.replace(EMAIL, "[email]")
		.replace(PHONE, "[phone]")
		.replace(/\uE000(\d+)\uE000/g, (_, i: string) => kept[Number(i)] ?? "");
}

/** The user's email and phone from personal.md, for `redactContact`. */
export function contactValues(profile: ProfileSnapshot): string[] {
	const personal =
		profile.files.find((f) => f.path === "personal.md")?.content ?? "";
	return ["Email", "Phone"]
		.map(
			(label) =>
				personal
					.match(new RegExp(`^-\\s+\\*\\*${label}:\\*\\*\\s+(.+)$`, "mi"))?.[1]
					?.trim() ?? "",
		)
		.filter(Boolean);
}

export function findDocument(
	profile: ProfileSnapshot,
	path: string,
): ProfileDocument | undefined {
	const wanted = path.replace(/^\.?\/*/, "").replace(/^profile\//, "");
	return profile.files.find((file) => file.path === wanted);
}
