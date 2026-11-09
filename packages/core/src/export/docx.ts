import {
	AlignmentType,
	Document,
	HeadingLevel,
	Packer,
	Paragraph,
	TextRun,
} from "docx";
import { Marked, type Token, type Tokens } from "marked";

import { ACCENTS, DEFAULT_LOOK, type DocumentLook, FONTS } from "./look";

/** The same lexing as the HTML renderer (render.ts); DOCX has its own output. */
const marked = new Marked({ gfm: true, breaks: false });

interface RunStyle {
	bold?: boolean;
	italics?: boolean;
}

/** Inline tokens to runs; a hard line break ("\" at line end) becomes a break. */
function runs(tokens: Token[] | undefined, style: RunStyle = {}): TextRun[] {
	const out: TextRun[] = [];
	for (const token of tokens ?? []) {
		switch (token.type) {
			case "strong":
				out.push(
					...runs((token as Tokens.Strong).tokens, { ...style, bold: true }),
				);
				break;
			case "em":
				out.push(
					...runs((token as Tokens.Em).tokens, { ...style, italics: true }),
				);
				break;
			case "br":
				out.push(new TextRun({ text: "", break: 1 }));
				break;
			case "image":
			case "html":
				break;
			case "link":
				out.push(...runs((token as Tokens.Link).tokens, style));
				break;
			case "codespan":
				out.push(
					new TextRun({ text: (token as Tokens.Codespan).text, ...style }),
				);
				break;
			case "text": {
				const text = token as Tokens.Text;
				if (text.tokens?.length) out.push(...runs(text.tokens, style));
				else out.push(new TextRun({ text: decode(text.text), ...style }));
				break;
			}
			default:
				if ("text" in token && typeof token.text === "string")
					out.push(new TextRun({ text: decode(token.text), ...style }));
		}
	}
	return out;
}

function decode(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

const HEADINGS = [
	HeadingLevel.HEADING_1,
	HeadingLevel.HEADING_2,
	HeadingLevel.HEADING_3,
	HeadingLevel.HEADING_4,
] as const;

/** Page sizes in twips (1/1440 inch). */
const PAGE_TWIPS = {
	A4: { width: 11906, height: 16838 },
	Letter: { width: 12240, height: 15840 },
} as const;

/**
 * Markdown to DOCX bytes (loaded on demand through render.ts's markdownToDocx). Of the look, Word
 * gets the font (Arial for the sans fonts, Georgia for the serifs: fonts every Word has), the
 * page size and the accent on headings; the templates' spacing stays the PDF's.
 */
export async function buildDocx(
	markdown: string,
	look: DocumentLook = DEFAULT_LOOK,
): Promise<Uint8Array> {
	const paragraphs: Paragraph[] = [];
	for (const token of marked.lexer(markdown)) {
		if (token.type === "heading") {
			const heading = token as Tokens.Heading;
			paragraphs.push(
				new Paragraph({
					heading: HEADINGS[Math.min(heading.depth, 4) - 1],
					children: runs(heading.tokens),
				}),
			);
		} else if (token.type === "paragraph") {
			paragraphs.push(
				new Paragraph({
					children: runs((token as Tokens.Paragraph).tokens),
					spacing: { after: 120 },
					alignment: AlignmentType.LEFT,
				}),
			);
		} else if (token.type === "list") {
			for (const item of (token as Tokens.List).items)
				paragraphs.push(
					new Paragraph({
						bullet: { level: 0 },
						children: item.tokens.flatMap((t) =>
							t.type === "text" || t.type === "paragraph"
								? runs((t as Tokens.Text).tokens ?? [t])
								: [],
						),
					}),
				);
		}
	}
	const color = ACCENTS[look.accent].hex.slice(1);
	const doc = new Document({
		styles: {
			default: {
				document: { run: { font: FONTS[look.font].docx, size: 21 } },
				// The library's sizes, in the accent instead of Word's blue.
				heading1: { run: { color, size: 32 } },
				heading2: { run: { color, size: 26 } },
				heading3: { run: { color, size: 24 } },
				heading4: { run: { color, italics: true } },
			},
		},
		sections: [
			{
				properties: { page: { size: PAGE_TWIPS[look.pageSize] } },
				children: paragraphs,
			},
		],
	});
	return new Uint8Array(await Packer.toArrayBuffer(doc));
}
