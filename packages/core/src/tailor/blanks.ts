/**
 * Square-bracket blanks the answer helper leaves where a fact is missing ("[which bundle
 * analyzer?]"). Its own module, with no imports, so the Questions page can block Save on them
 * without pulling the prompt code into the window.
 */
export const BLANK = /\[[^\]\n]*\]/g;

/** The blanks still in a text, in order. */
export function bracketBlanks(text: string): string[] {
	return text.match(BLANK) ?? [];
}
