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
 * The values a filled form holds, as they may appear in a request: each value (lower case), the
 * first 24 characters of a long one, and a phone number's digits and its text without the "+".
 * Values under 4 characters
 * ("Yes", "No") are left out: they would match everywhere.
 */
export function formValueNeedles(values: string[]): string[] {
	const needles = new Set<string>();
	for (const raw of values) {
		const value = raw.trim().toLowerCase();
		if (value.length >= 4)
			needles.add(value.length > 40 ? value.slice(0, 24) : value);
		const digits = value.replace(/\D/g, "");
		if (/^\+?[\d\s().-]+$/.test(value) && digits.length >= 7) {
			needles.add(digits);
			needles.add(value.replace(/^\+/, ""));
		}
	}
	return [...needles];
}

/**
 * True when `text` (a URL or a request body) carries one of the form's values in plain sight:
 * as typed, URL-encoded, or a phone number's digits inside one run of digits. Catches plain
 * copies only; an encoded or hashed value passes.
 */
export function carriesFormData(
	text: string | null,
	needles: string[],
): boolean {
	if (!text || needles.length === 0) return false;
	let decoded = text;
	try {
		decoded = decodeURIComponent(text.replace(/\+/g, " "));
	} catch {}
	const haystack = `${text}\n${decoded}`.toLowerCase();
	const runs = haystack.match(/\d+/g) ?? [];
	return needles.some((n) =>
		/^\d+$/.test(n) ? runs.some((r) => r.includes(n)) : haystack.includes(n),
	);
}
