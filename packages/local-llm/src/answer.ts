import { z } from "zod";

/**
 * Errors about a model's answer that never carry the answer. What a model writes can hold the
 * user's private text (their CV, a job's notes, the prompt echoed back), and an error message is
 * kept: the spending ledger saves it, a workflow may save it. So these say what went wrong in
 * fixed words plus bounded facts about the answer's shape (its length, whether it had braces, the
 * schema paths and zod issue codes that failed), never a value from it.
 */

/** An answer that is not JSON. */
export function unreadableAnswer(
	provider: string,
	task: string,
	text: string,
): Error {
	const open = text.indexOf("{");
	const braces = open >= 0 && text.lastIndexOf("}") > open;
	return new Error(
		`${provider}: no valid structured output for ${task}: an answer of ${text.length} characters ${braces ? "whose braces did not hold valid JSON" : "with no JSON object"} (the answer is not kept)`,
	);
}

/** The property names the schema declares: the only path segments an error may name. */
function schemaKeys(schema: z.ZodType): Set<string> {
	try {
		return jsonSchemaKeys(z.toJSONSchema(schema, { unrepresentable: "any" }));
	} catch {
		return new Set();
	}
}

/** The property names a JSON schema declares. */
function jsonSchemaKeys(json: unknown): Set<string> {
	const keys = new Set<string>();
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (!node || typeof node !== "object") return;
		for (const [key, value] of Object.entries(node)) {
			if (key === "properties" && value && typeof value === "object")
				for (const name of Object.keys(value)) keys.add(name);
			walk(value);
		}
	};
	walk(json);
	return keys;
}

/** How many failed paths an error names. */
const MAX_ISSUES = 5;

/**
 * The answer, checked against the request's schema. On a mismatch: the failed paths (a key that
 * is not one of the schema's own, such as a record key the model chose, is shown as `*`) and zod's
 * issue codes; never zod's messages, which can quote the value.
 */
export function parseAnswer<T>(
	schema: z.ZodType<T>,
	value: unknown,
	provider: string,
	task: string,
): T {
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;
	const keys = schemaKeys(schema);
	const issues = parsed.error.issues;
	const named = issues.slice(0, MAX_ISSUES).map((issue) => {
		const path = issue.path
			.map((segment) =>
				typeof segment === "number"
					? String(segment)
					: typeof segment === "string" && keys.has(segment)
						? segment
						: "*",
			)
			.join(".");
		return `${path || "(root)"}: ${issue.code}`;
	});
	const more =
		issues.length > MAX_ISSUES ? ` and ${issues.length - MAX_ISSUES} more` : "";
	throw new Error(
		`${provider}: the answer for ${task} did not match the schema (${named.join("; ")}${more}; the answer is not kept)`,
	);
}

/**
 * A protocol value as it may be kept (an error kind, a result subtype, an item or event type, a
 * tool name): one of the values the tested protocol defines, else "other". Shape is not enough:
 * an identifier (`PRIVATE_CV_CANARY`) can be the user's text as well as any sentence can.
 */
export function knownName(value: unknown, known: ReadonlySet<string>): string {
	return typeof value === "string" && known.has(value) ? value : "other";
}

/** The error names a thrown error may be kept by (JavaScript's own, and the SDKs' abort). */
export const ERROR_NAMES: ReadonlySet<string> = new Set([
	"Error",
	"AbortError",
	"AggregateError",
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
]);

/**
 * Why a CLI's own schema check refused the answer, as it may be kept: how many errors, and the
 * required properties it says are missing when they are the schema's own names. Never the errors'
 * text, which can quote the answer.
 */
export function schemaCheckFailure(
	errors: string[],
	jsonSchema: unknown,
): string {
	const keys = jsonSchemaKeys(jsonSchema);
	const missing = new Set<string>();
	for (const error of errors)
		for (const match of error.matchAll(/required property '([^']{1,64})'/g))
			if (match[1] && keys.has(match[1])) missing.add(match[1]);
	const named = missing.size
		? `; missing ${[...missing].slice(0, MAX_ISSUES).join(", ")}`
		: "";
	return `the CLI's schema check refused the answer (${errors.length} ${errors.length === 1 ? "error" : "errors"}${named}; the answer is not kept)`;
}
