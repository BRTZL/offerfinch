import {
	AlignmentType,
	Document,
	HeadingLevel,
	Packer,
	Paragraph,
	TextRun,
} from "docx";
import { Marked, type Token, type Tokens } from "marked";

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

/** Markdown to DOCX bytes (loaded on demand through render.ts's markdownToDocx). */
export async function buildDocx(markdown: string): Promise<Uint8Array> {
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
	const doc = new Document({
		styles: {
			default: {
				document: { run: { font: "Arial", size: 21 } },
			},
		},
		sections: [{ children: paragraphs }],
	});
	return new Uint8Array(await Packer.toArrayBuffer(doc));
}
