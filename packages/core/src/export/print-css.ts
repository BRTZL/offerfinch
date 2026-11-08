import {
	ACCENTS,
	DEFAULT_LOOK,
	type DocumentLook,
	FONTS,
	PAGE_MM,
	type Template,
} from "./look";

/**
 * Print stylesheets, one per template, from my-profile's tailor-application skill
 * (assets/print.css): classic is that stylesheet verbatim with the default look.
 */

interface Parts {
	/** `body` when printed; the page's content element in the settings preview. */
	root: string;
	/** The `@page` rule when printed; the page's box on screen. */
	page: string;
	font: string;
	/** The accent's color; null for ink, which keeps each template's own neutral rules. */
	accent: string | null;
}

const SHARED = `a {
  color: inherit;
  text-decoration: none;
}

h2, h3 {
  break-after: avoid;
}

li {
  break-inside: avoid;
}
`;

/** Accent on the headings and the rule under them (classic and compact). */
const headingAccent = (accent: string | null) =>
	accent
		? `
h2 {
  color: ${accent};
  border-bottom-color: ${accent};
}
`
		: "";

/** The skill's stylesheet. */
const classic = ({ root, page, font, accent }: Parts) => `${page}

${root} {
  font-family: ${font};
  font-size: 10.5pt;
  line-height: 1.35;
  color: #111;
  font-variant-ligatures: none;
  max-width: none;
  margin: 0;
  padding: 0;
}

h1 {
  font-size: 20pt;
  margin: 0 0 2pt;
}

h1 + p {
  margin-top: 0;
  color: #444;
}

h2 {
  font-size: 11.5pt;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  border-bottom: 1px solid #999;
  padding-bottom: 2pt;
  margin: 12pt 0 4pt;
}

h3 {
  font-size: 10.5pt;
  margin: 8pt 0 0;
}

h3 + p {
  margin: 0 0 2pt;
  color: #444;
}

ul {
  margin: 2pt 0 4pt;
  padding-left: 14pt;
}

li {
  margin: 1pt 0;
}

p {
  margin: 4pt 0;
}

${SHARED}${headingAccent(accent)}`;

/** A larger name over a heavier rule, headings in the accent with no rule of their own. */
const modern = ({ root, page, font, accent }: Parts) => `${page}

${root} {
  font-family: ${font};
  font-size: 10.5pt;
  line-height: 1.4;
  color: #1a1a1a;
  font-variant-ligatures: none;
  max-width: none;
  margin: 0;
  padding: 0;
}

h1 {
  font-size: 23pt;
  font-weight: 700;
  margin: 0 0 3pt;
  color: ${accent ?? "#111"};
}

h1 + p {
  margin: 0 0 4pt;
  padding-bottom: 7pt;
  border-bottom: 2pt solid ${accent ?? "#111"};
  color: #444;
}

h2 {
  font-size: 10.5pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: ${accent ?? "#111"};
  margin: 13pt 0 4pt;
}

h3 {
  font-size: 10.5pt;
  font-weight: 700;
  margin: 8pt 0 0;
}

h3 + p {
  margin: 0 0 2pt;
  color: #555;
}

ul {
  margin: 2pt 0 4pt;
  padding-left: 13pt;
}

li {
  margin: 1.5pt 0;
}

p {
  margin: 4pt 0;
}

${SHARED}`;

/** Classic, tighter: smaller type and margins, for a CV close to its page limit. */
const compact = ({ root, page, font, accent }: Parts) => `${page}

${root} {
  font-family: ${font};
  font-size: 9.5pt;
  line-height: 1.25;
  color: #111;
  font-variant-ligatures: none;
  max-width: none;
  margin: 0;
  padding: 0;
}

h1 {
  font-size: 17pt;
  margin: 0 0 1pt;
}

h1 + p {
  margin-top: 0;
  color: #444;
}

h2 {
  font-size: 10pt;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid #999;
  padding-bottom: 1pt;
  margin: 8pt 0 3pt;
}

h3 {
  font-size: 9.5pt;
  margin: 5pt 0 0;
}

h3 + p {
  margin: 0 0 1pt;
  color: #444;
}

ul {
  margin: 1pt 0 3pt;
  padding-left: 12pt;
}

li {
  margin: 0.5pt 0;
}

p {
  margin: 3pt 0;
}

${SHARED}${headingAccent(accent)}`;

const TEMPLATE_CSS: Record<Template, (parts: Parts) => string> = {
	classic,
	modern,
	compact,
};

const MARGINS: Record<Template, string> = {
	classic: "14mm 16mm",
	modern: "15mm 17mm",
	compact: "10mm 13mm",
};

/**
 * The print stylesheet for a look. With `preview` set to a selector, the same rules for a page
 * drawn on screen: that element becomes the sheet (the page's size, the margins as padding) and
 * its child `div` holds the document.
 */
export function printCss(
	look: DocumentLook = DEFAULT_LOOK,
	preview?: string,
): string {
	const margin = MARGINS[look.template];
	const size = PAGE_MM[look.pageSize];
	const page = preview
		? `${preview} {
  box-sizing: border-box;
  width: ${size.width}mm;
  height: ${size.height}mm;
  padding: ${margin};
  overflow: hidden;
  background: #fff;
}`
		: `@page {
  size: ${look.pageSize};
  margin: ${margin};
}`;
	return TEMPLATE_CSS[look.template]({
		root: preview ? `${preview} > div` : "body",
		page,
		font: FONTS[look.font].css,
		accent: look.accent === "ink" ? null : ACCENTS[look.accent].hex,
	});
}

/** The classic look with the default font, accent and page size: the skill's stylesheet. */
export const PRINT_CSS = printCss(DEFAULT_LOOK);
