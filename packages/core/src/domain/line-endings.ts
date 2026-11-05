/** Canonical line endings for imported text, including older Mac files. */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}
