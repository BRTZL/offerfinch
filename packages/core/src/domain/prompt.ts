/**
 * Text the pipeline did not write itself (profile files, postings, careers pages, board labels,
 * model drafts) goes into prompts through these, so it can never open or close the prompt's own
 * tags or attributes. `normalizeForMatch` maps the replacements back, so a quote the model copies
 * from an escaped prompt still verifies against the original text.
 */
export function promptText(text: string): string {
	return text.replace(/</g, "‹").replace(/>/g, "›");
}

/** For a value inside a double-quoted attribute: no tag brackets, no quote, one line. */
export function promptAttr(text: string): string {
	return promptText(text).replace(/"/g, "”").replace(/\s+/g, " ");
}
