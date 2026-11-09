import { z } from "zod";

/**
 * How exported documents look: a template, a font, an accent color and a page size. Every
 * combination is one column of real text in reading order, so the ATS check (`ats.ts`) reads it
 * the same way; templates differ only in typography, spacing, the header and the accent on
 * headings and rules.
 */

export const TEMPLATES = ["classic", "modern", "compact"] as const;
export type Template = (typeof TEMPLATES)[number];

/** System fonts headless Chrome has on macOS; each stack ends in a generic family. */
export const FONTS = {
	helvetica: {
		label: "Helvetica Neue",
		css: `"Helvetica Neue", Helvetica, Arial, sans-serif`,
		docx: "Arial",
	},
	avenir: {
		label: "Avenir Next",
		css: `"Avenir Next", Avenir, "Helvetica Neue", Arial, sans-serif`,
		docx: "Arial",
	},
	georgia: {
		label: "Georgia",
		css: `Georgia, "Times New Roman", serif`,
		docx: "Georgia",
	},
	charter: {
		label: "Charter",
		css: `Charter, "Bitstream Charter", Georgia, serif`,
		docx: "Georgia",
	},
} as const;
export type Font = keyof typeof FONTS;

/** Dark enough for print on white (each at least 7:1); ink is today's near-black. */
export const ACCENTS = {
	ink: { label: "Ink", hex: "#111111" },
	navy: { label: "Navy", hex: "#1f3a5f" },
	forest: { label: "Forest", hex: "#1f4d3a" },
	burgundy: { label: "Burgundy", hex: "#6e1f2e" },
	slate: { label: "Slate", hex: "#3b4656" },
} as const;
export type Accent = keyof typeof ACCENTS;

export const PAGE_SIZES = ["A4", "Letter"] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

const keys = <T extends Record<string, unknown>>(o: T) =>
	Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

/** Each field has its default, so a stored look missing a later field keeps the others. */
export const documentLookSchema = z.object({
	template: z.enum(TEMPLATES).default("classic"),
	font: z.enum(keys(FONTS)).default("helvetica"),
	accent: z.enum(keys(ACCENTS)).default("ink"),
	pageSize: z.enum(PAGE_SIZES).default("A4"),
});
export type DocumentLook = z.infer<typeof documentLookSchema>;

export const DEFAULT_LOOK: DocumentLook = {
	template: "classic",
	font: "helvetica",
	accent: "ink",
	pageSize: "A4",
};

/** Page width and height in millimetres. */
export const PAGE_MM: Record<PageSize, { width: number; height: number }> = {
	A4: { width: 210, height: 297 },
	Letter: { width: 215.9, height: 279.4 },
};

/**
 * The part of an export's file name that names its look: empty for the default (so files from
 * before looks existed keep their names), otherwise every field, readable.
 */
export function lookSlug(look: DocumentLook): string {
	if (sameLook(look, DEFAULT_LOOK)) return "";
	return `-${look.template}-${look.font}-${look.accent}-${look.pageSize.toLowerCase()}`;
}

function sameLook(a: DocumentLook, b: DocumentLook): boolean {
	return (
		a.template === b.template &&
		a.font === b.font &&
		a.accent === b.accent &&
		a.pageSize === b.pageSize
	);
}
