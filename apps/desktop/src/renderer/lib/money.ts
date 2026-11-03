/** An estimated cost in micro-dollars as dollars: "$0.42", "<$0.01" for anything smaller. */
export function usd(micros: number | null | undefined): string {
	if (micros === null || micros === undefined) return "";
	if (micros === 0) return "$0";
	if (micros < 10_000) return "<$0.01";
	return `$${(micros / 1_000_000).toFixed(2)}`;
}
