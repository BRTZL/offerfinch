import { extractText } from "unpdf";

/** Text of an uploaded PDF resume, page by page. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
	const { text } = await extractText(bytes, { mergePages: false });
	return (Array.isArray(text) ? text : [text]).join("\n\n").trim();
}
