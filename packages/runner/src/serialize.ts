/**
 * Step results are stored as JSON with Dates tagged, so a replayed step returns the same shapes
 * the first run did (Cloudflare uses structured clone, which keeps Dates too). `undefined` is
 * stored as a tagged value so a step that returned nothing replays as nothing.
 */
const DATE = "$date";
const UNDEFINED = "$undefined";

export function encode(value: unknown): string {
	if (value === undefined) return JSON.stringify({ [UNDEFINED]: true });
	return JSON.stringify(
		value,
		function (this: Record<string, unknown>, key, converted: unknown) {
			// `converted` already went through Date#toJSON; the holder still has the Date.
			const raw = this[key];
			if (raw instanceof Date) return { [DATE]: raw.toISOString() };
			if (raw instanceof Map || raw instanceof Set)
				throw new Error("Step results must be plain JSON (no Map or Set)");
			return converted;
		},
	);
}

export function decode<T>(text: string | null): T {
	if (text === null) return undefined as T;
	const parsed = JSON.parse(text, (_key, value) => {
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).length === 1
		) {
			if (DATE in value) return new Date(value[DATE] as string);
		}
		return value;
	});
	if (
		parsed !== null &&
		typeof parsed === "object" &&
		UNDEFINED in parsed &&
		Object.keys(parsed).length === 1
	)
		return undefined as T;
	return parsed as T;
}
