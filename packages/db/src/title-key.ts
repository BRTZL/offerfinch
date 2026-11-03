/** Lowercased words of a title, for matching the same role across sources. */
export function titleKey(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\p{L}\d+#]+/gu, " ")
		.trim();
}
