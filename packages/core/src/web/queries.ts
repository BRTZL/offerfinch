/** Searches a web search scan makes at most. */
export const MAX_WEB_QUERIES = 8;

/**
 * One web search as sent to DuckDuckGo: plain words only. Search operators (site:, inurl:, ...),
 * links and stray punctuation are removed, so neither the model nor a typo can point a search at
 * one site or at anything but job postings; at most 100 characters.
 */
export function cleanQuery(input: string): string {
	return input
		.replace(/\bhttps?:\/\/\S+/gi, " ")
		.replace(/\b[\w-]+\.(?:com|io|co|org|net|dev|ai|app)\b\S*/gi, " ")
		.replace(
			/(?:^|\s)-?(?:site|inurl|intitle|intext|filetype|ext|related|cache|link|allinurl|allintitle):\S*/gi,
			" ",
		)
		.replace(/[^\p{L}\p{N}\s+#.,'"/&-]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 100)
		.trim();
}

/** Cleaned, without empties or repeats (case-insensitive), at most `max`. */
export function cleanQueries(
	queries: string[],
	max = MAX_WEB_QUERIES,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const q of queries) {
		const clean = cleanQuery(q);
		const key = clean.toLowerCase();
		if (clean.length < 3 || seen.has(key)) continue;
		seen.add(key);
		out.push(clean);
		if (out.length >= max) break;
	}
	return out;
}
