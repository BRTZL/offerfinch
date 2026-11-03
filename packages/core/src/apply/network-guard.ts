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
