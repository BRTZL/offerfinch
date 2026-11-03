import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cn } from "../src/renderer/lib/utils";

/**
 * The design system's guard (docs/design/desktop/system.md). Screens compose the primitives in
 * components/system and the controls in components/ui; they never set their own sizes. This
 * reads every screen file and fails on anything outside the system, so the screens cannot drift
 * apart again.
 */

const RENDERER = path.resolve(import.meta.dirname, "../src/renderer");
/** Where exact values live: exempt. */
const EXEMPT = [
	"components/system/",
	"components/ui/",
	"components/brand-mark.tsx",
];

/**
 * Screens still being moved onto the system. This list only shrinks: an entry whose file is
 * already clean fails the test, so it has to be removed.
 */
const PENDING: string[] = [];

const SPACING = new Set([
	"0",
	"px",
	"0.5",
	"1",
	"1.5",
	"2",
	"2.5",
	"3",
	"4",
	"5",
	"6",
	"8",
	"10",
	"12",
	"auto",
]);

type Rule = { name: string; test: (source: string) => string[] };

const all = (source: string, re: RegExp) =>
	[...source.matchAll(re)].map((m) => m[0].trim());

const RULES: Rule[] = [
	{
		name: "arbitrary value (use a token or a primitive)",
		// p-[13px], text-[11px], bg-[#fff], data-[state=open]:, [&_svg]:size-3
		test: (s) =>
			all(s, /(?<![\w$.])(?:[a-z][\w-]*-\[[^\]\s]*\]|\[&[^\]\s]*\])/g),
	},
	{
		name: "spacing outside the scale",
		test: (s) =>
			all(
				s,
				/(?<=["'`\s:])-?(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-([\w.]+)(?=["'`\s])/g,
			).filter(
				(token) => !SPACING.has(token.replace(/^-?[a-z-]+?-(?=[\w.]+$)/, "")),
			),
	},
	{
		name: "font size outside the scale (2xs, xs, sm, base, xl)",
		test: (s) => all(s, /(?<=["'`\s:])text-(?:lg|[2-9]xl|xxs)(?=["'`\s])/g),
	},
	{
		name: "font weight outside 400, 500, 600",
		test: (s) =>
			all(
				s,
				/(?<=["'`\s:])font-(?:thin|extralight|light|bold|extrabold|black)(?=["'`\s])/g,
			),
	},
	{
		name: "raw palette colour (use a semantic token)",
		test: (s) =>
			all(
				s,
				/(?<=["'`\s:])(?:text|bg|border|ring|outline|fill|stroke|decoration|from|to|via|divide|shadow|accent|caret)-(?:(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}|white|black)(?:\/\d+)?(?=["'`\s])/g,
			),
	},
	{
		name: "radius outside the scale (sm 4, lg 8, xl 12, 2xl 16, full)",
		test: (s) =>
			all(
				s,
				/(?<=["'`\s:])rounded(?:-[trblse]{1,2})?-(?:none|xs|md|3xl|4xl)(?=["'`\s])/g,
			),
	},
	{
		name: "uppercase or tracked labels",
		test: (s) =>
			all(s, /(?<=["'`\s:])(?:uppercase|tracking-[\w.]+)(?=["'`\s])/g),
	},
	{
		name: "line height set by hand (it comes with the size)",
		test: (s) => all(s, /(?<=["'`\s:])leading-[\w.]+(?=["'`\s])/g),
	},
	{
		name: "inline style setting spacing, type or colour",
		test: (s) =>
			all(
				s,
				/style=\{\{[^}]*\b(?:padding\w*|margin\w*|gap|fontSize|fontWeight|lineHeight|color|background\w*)\s*:/g,
			),
	},
];

function screenFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
		}
	};
	walk(RENDERER);
	return out
		.map((f) => path.relative(RENDERER, f))
		.filter((f) => !EXEMPT.some((e) => f.startsWith(e)))
		.sort();
}

/** Comments are not classes. */
const stripComments = (s: string) =>
	s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function violations(file: string): string[] {
	const source = stripComments(
		fs.readFileSync(path.join(RENDERER, file), "utf8"),
	);
	return RULES.flatMap((rule) =>
		rule.test(source).map((hit) => `${rule.name}: ${hit}`),
	);
}

describe("design system", () => {
	const files = screenFiles();

	it("finds the screens", () => {
		expect(files.length).toBeGreaterThan(20);
		expect(files).toContain("pages/inbox.tsx");
	});

	for (const file of files) {
		if (PENDING.includes(file)) continue;
		it(`${file} stays inside the system`, () => {
			expect(violations(file)).toEqual([]);
		});
	}

	it("lists only screens that still need moving", () => {
		const clean = PENDING.filter((f) => violations(f).length === 0);
		expect(clean).toEqual([]);
	});

	it("keeps no square corners anywhere in the desktop UI", () => {
		const hits = [
			...files,
			...EXEMPT.flatMap((e) =>
				fs.existsSync(path.join(RENDERER, e)) &&
				fs.statSync(path.join(RENDERER, e)).isDirectory()
					? fs.readdirSync(path.join(RENDERER, e)).map((f) => e + f)
					: [],
			),
		].filter((f) =>
			/rounded-none/.test(fs.readFileSync(path.join(RENDERER, f), "utf8")),
		);
		expect(hits).toEqual([]);
	});

	it("merges the 11 px size with a colour without dropping either", () => {
		expect(cn("text-muted-foreground", "text-2xs")).toBe(
			"text-muted-foreground text-2xs",
		);
		expect(cn("text-xs", "text-2xs")).toBe("text-2xs");
	});

	it("catches what it is meant to catch", () => {
		const probe = (cls: string) =>
			RULES.some((r) => r.test(`className="${cls}"`).length > 0);
		for (const bad of [
			"p-[13px]",
			"text-[11px]",
			"bg-[#fff]",
			"px-7",
			"gap-3.5",
			"mt-9",
			"text-lg",
			"font-bold",
			"text-amber-700",
			"bg-white",
			"rounded-none",
			"rounded-md",
			"uppercase",
			"tracking-wide",
			"leading-relaxed",
			"[&_svg]:size-3",
			"data-[state=open]:bg-muted",
		])
			expect(probe(bad), bad).toBe(true);
		for (const good of [
			"px-4 py-3 gap-2 text-sm text-muted-foreground",
			"rounded-lg bg-card",
			"text-2xs font-medium",
			"-mx-1 mt-0.5",
			"hover:bg-hover",
			"text-xl font-semibold",
		])
			expect(probe(good), good).toBe(false);
	});
});
