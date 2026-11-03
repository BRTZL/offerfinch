const TRACKING_PARAMS = new Set([
	"gh_src",
	"gh_jid_src",
	"lever-source",
	"lever-origin",
	"source",
	"src",
	"ref",
	"referrer",
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
	"trk",
	"trackingid",
]);

/**
 * Normalizes a job URL for deduplication: https, lowercase host without `www.`,
 * no fragment, no tracking parameters, sorted remaining parameters, no trailing slash.
 */
export function normalizeUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return input.trim().toLowerCase();
	}
	url.protocol = "https:";
	url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
	url.hash = "";
	url.port = "";
	const kept = [...url.searchParams.entries()]
		.filter(
			([key]) =>
				!TRACKING_PARAMS.has(key.toLowerCase()) &&
				!key.toLowerCase().startsWith("utm_"),
		)
		.sort(([a], [b]) => a.localeCompare(b));
	url.search = "";
	for (const [key, value] of kept) url.searchParams.append(key, value);
	let path = url.pathname.replace(/\/+$/, "");
	if (path === "") path = "/";
	url.pathname = path;
	const text = url.toString();
	return text.endsWith("/") && url.search === "" ? text.slice(0, -1) : text;
}

/** Latin letters that do not decompose into a base letter and an accent. */
const LATIN_FOLD: Record<string, string> = {
	ø: "o",
	đ: "d",
	ð: "d",
	ł: "l",
	ħ: "h",
	ı: "i",
	æ: "ae",
	œ: "oe",
	ß: "ss",
	þ: "th",
};

/** Legal forms dropped from a company's name: "ClickHouse, Inc." is ClickHouse. */
const LEGAL_FORM =
	/(?<![\p{L}\p{N}\p{M}])(inc|ltd|llc|gmbh|bv|ag|sa|co)(?![\p{L}\p{N}\p{M}])\.?/gu;

/**
 * Bumped whenever `companyNameKey` changes, so stored keys are computed again on start
 * (db's migrate).
 */
export const COMPANY_NAME_KEY_VERSION = 2;

/**
 * The key that recognizes the same company across sources and spellings: case, punctuation,
 * spaces, legal forms and the accents of Latin, Greek and Cyrillic letters do not count
 * ("Société Générale" is "Societe Generale"). Letters and digits of every script are kept, so
 * "東京Tech" and "大阪Tech" stay two companies.
 */
export function companyNameKey(name: string): string {
	return (
		name
			.normalize("NFKD")
			// Accents off Latin, Greek and Cyrillic letters only; other scripts keep their marks.
			.replace(
				/([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu,
				"$1",
			)
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[øđðłħıæœßþ]/g, (c) => LATIN_FOLD[c] ?? c)
			.replace(LEGAL_FORM, "")
			.replace(/[^\p{L}\p{N}\p{M}]+/gu, "")
	);
}
