/**
 * Screenshots of a multi-step form's earlier steps (docs/auto-apply-plan.md, step 7): their
 * storage keys sit in the attempt's proof as `stepKeys`, in step order. The keys never leave the
 * worker; the dashboard gets the count and asks for `step-N`.
 */

/** The stored keys of an attempt's step screenshots, in step order. */
export function stepKeysOf(proof: unknown): string[] {
	if (!proof || typeof proof !== "object") return [];
	const keys = (proof as { stepKeys?: unknown }).stepKeys;
	return Array.isArray(keys)
		? keys.filter((k): k is string => typeof k === "string" && k.length > 0)
		: [];
}

/** The proof as the dashboard shows it: everything but the storage keys. */
export function publicProof(
	proof: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!proof) return proof;
	const { stepKeys: _keys, ...rest } = proof;
	return rest;
}

/** A proof screenshot: before or after the click, or a step of a multi-step form (`step-1` …). */
export type ProofShot = "before" | "after" | `step-${number}`;

export function isProofShot(value: unknown): value is ProofShot {
	return (
		typeof value === "string" && /^(before|after|step-\d{1,2})$/.test(value)
	);
}
