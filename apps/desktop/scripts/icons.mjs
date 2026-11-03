// Renders the OfferFinch brand from docs/brand/marks.mjs with the installed Chrome (no downloads).
//
// Writes, for every direction: docs/brand/<direction>/*.svg, and docs/brand/options.png (the
// comparison sheet, each size rendered natively). For the selected direction (SELECTED in
// marks.mjs): build/icon.icns and build/icon.png (app icon, per-size renders through iconutil),
// build/volume.icns (the DMG's volume icon), build/background.tiff (DMG window, 1x and 2x),
// assets/tray*Template(@2x).png (menu bar), src/renderer/public/favicon.svg and
// src/renderer/components/brand-mark.tsx (the in-app mark).
// Usage: node scripts/icons.mjs [--direction round|facet|grid] [--no-sheet]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const app = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const repo = path.resolve(app, "../..");
const brandDir = path.join(repo, "docs/brand");
const brand = await import("../../../docs/brand/marks.mjs");
const { COLORS, DIRECTIONS, markSvg, wordmarkSvg, appIconSvg, cut } = brand;
const args = process.argv.slice(2);
const pick = args.includes("--direction")
	? args[args.indexOf("--direction") + 1]
	: brand.SELECTED;
if (!DIRECTIONS[pick]) throw new Error(`Unknown direction ${pick}`);

const exe = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: exe, headless: true });

function write(file, input) {
	// Standalone SVGs carry their name (assistive tech, and the linter asks for it).
	const text = file.endsWith(".svg")
		? input.replace(/(<svg[^>]*>)/, "$1<title>OfferFinch</title>")
		: input;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	console.log(path.relative(repo, file));
}

/** An SVG (or HTML) rendered to a PNG of exactly width × height device pixels. */
async function render(markup, width, height, file, { scale = 1 } = {}) {
	const page = await browser.newPage({
		viewport: { width: width / scale, height: height / scale },
		deviceScaleFactor: scale,
	});
	await page.setContent(
		`<html><body style="margin:0;background:transparent">${markup}</body></html>`,
	);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	await page.screenshot({ path: file, omitBackground: true });
	await page.close();
	console.log(path.relative(repo, file));
}
const sized = (svg, size) =>
	svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);

/* --------------------------------------------------- sources per direction */

const menuBarGlyph = (d, size) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${size <= 16 && d.glyphSmall ? d.glyphSmall : d.glyph}</svg>`;
// The status variant: the glyph plus a square at the top right (a scan stopped or failed).
const attentionGlyph = (d, size) =>
	menuBarGlyph(d, size).replace(
		"</svg>",
		`<rect x="${size <= 16 ? 26 : 26.5}" y="0" width="${size <= 16 ? 6 : 5.5}" height="${size <= 16 ? 6 : 5.5}"/></svg>`,
	);

for (const [key, d] of Object.entries(DIRECTIONS)) {
	const dir = path.join(brandDir, key);
	for (const theme of ["dark", "light"]) {
		write(path.join(dir, `mark-${theme}.svg`), markSvg(key, 512, theme));
		if (d.small)
			write(path.join(dir, `mark-16-${theme}.svg`), markSvg(key, 16, theme));
		write(path.join(dir, `wordmark-${theme}.svg`), wordmarkSvg(key, theme));
	}
	write(path.join(dir, "app-icon.svg"), appIconSvg(key));
	write(path.join(dir, "menu-bar-template.svg"), menuBarGlyph(d, 32));
	write(
		path.join(dir, "menu-bar-attention-template.svg"),
		attentionGlyph(d, 32),
	);
}

/* ------------------------------------------------------ comparison sheet */

if (!args.includes("--no-sheet")) {
	const SIZES = [16, 32, 128, 512];
	const panel = (key, theme) => {
		const bg = theme === "dark" ? COLORS.ink : COLORS.paper;
		const fg = theme === "dark" ? COLORS.onDark : COLORS.onLight;
		const muted = theme === "dark" ? "#8e8e93" : "#6e6e73";
		const marks = SIZES.map(
			(s) =>
				`<figure style="margin:0;display:flex;flex-direction:column;align-items:center;gap:8px">${markSvg(key, s, theme)}<figcaption style="color:${muted}">${s}</figcaption></figure>`,
		).join("");
		const icon = sized(appIconSvg(key, { small: false }), 128);
		const icon32 = sized(appIconSvg(key, { small: false }), 32);
		const icon16 = sized(appIconSvg(key, { small: true }), 16);
		return `<div style="background:${bg};color:${fg};padding:28px 32px;border:1px solid ${theme === "dark" ? "#2c2c2e" : "#d2d2d7"}">
			<div style="display:flex;align-items:flex-end;gap:28px">${marks}</div>
			<div style="display:flex;align-items:center;gap:28px;margin-top:28px">
				${wordmarkSvg(key, theme, 48)}
				<span style="flex:1"></span>${icon16}${icon32}${icon}
			</div>
			<div style="color:${muted};margin-top:6px">${theme} · mark at 16, 32, 128, 512 px · wordmark · app icon at 16, 32, 128 px</div>
		</div>`;
	};
	const rows = Object.entries(DIRECTIONS)
		.map(
			([key, d]) => `<section style="margin-top:40px">
			<h2 style="font-size:20px;margin:0 0 4px">${d.label}${key === pick ? ' <span style="font-size:12px;font-weight:600;background:#34c759;color:#0d0d0f;padding:2px 6px;vertical-align:middle">SELECTED</span>' : ""}</h2>
			<p style="margin:0 0 14px;max-width:1100px;color:#3a3a3c">${d.idea}</p>
			<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${panel(key, "dark")}${panel(key, "light")}</div>
		</section>`,
		)
		.join("");
	const html = `<div style="font:13px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;background:#f2f2f4;color:#111113;padding:40px;width:1840px;box-sizing:border-box">
		<h1 style="font-size:28px;margin:0">OfferFinch: three logo directions</h1>
		<p style="margin:6px 0 0;color:#3a3a3c;max-width:1300px">A small bird that brings back offers. Every size is rendered at its real pixel size (no downscaling); 16 px uses the hinted drawing where a direction has one. Compared by eye against Twitter/X's former bird, Duolingo's owl, the Finch self-care app's bird, Swift's bird and Thunderbird's bird: none shares their silhouette, pose or colour use. This is a visual comparison, not a trademark check.</p>
		${rows}
	</div>`;
	const page = await browser.newPage({
		viewport: { width: 1840, height: 1000 },
		deviceScaleFactor: 1,
	});
	await page.setContent(`<html><body style="margin:0">${html}</body></html>`);
	await page.screenshot({
		path: path.join(brandDir, "options.png"),
		fullPage: true,
	});
	await page.close();
	console.log("docs/brand/options.png");
}

/* ----------------------------------------------- the selected direction */

const d = DIRECTIONS[pick];
const build = path.join(app, "build");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-icons-"));

// App icon: every size of the iconset rendered on its own (16 px from the hinted drawing).
const iconset = path.join(tmp, "icon.iconset");
fs.mkdirSync(iconset);
for (const [name, px] of [
	["16x16", 16],
	["16x16@2x", 32],
	["32x32", 32],
	["32x32@2x", 64],
	["128x128", 128],
	["128x128@2x", 256],
	["256x256", 256],
	["256x256@2x", 512],
	["512x512", 512],
	["512x512@2x", 1024],
])
	await render(
		sized(appIconSvg(pick, { small: px <= 16 }), px),
		px,
		px,
		path.join(iconset, `icon_${name}.png`),
	);
execFileSync("iconutil", [
	"-c",
	"icns",
	iconset,
	"-o",
	path.join(build, "icon.icns"),
]);
fs.copyFileSync(
	path.join(iconset, "icon_512x512@2x.png"),
	path.join(build, "icon.png"),
);
fs.copyFileSync(path.join(build, "icon.icns"), path.join(build, "volume.icns"));
console.log("apps/desktop/build/icon.icns, icon.png, volume.icns");

// macOS 26 and later: an Icon Composer document, compiled into Assets.car. Its canvas is the whole rounded square, so the
// bird is the app icon's drawing scaled from the 824 body to 1024. One layer: two layers leave
// a hairline seam where the beak meets the body. Without it, macOS 26+ shows the plain .icns
// on a grey plate at small sizes.
{
	// The compiled icon takes the document's name: CFBundleIconName is "OfferFinch".
	fs.rmSync(path.join(build, "icon.icon"), { recursive: true, force: true });
	const iconDoc = path.join(build, "OfferFinch.icon");
	fs.rmSync(iconDoc, { recursive: true, force: true });
	fs.mkdirSync(path.join(iconDoc, "Assets"), { recursive: true });
	const fill = "#121214";
	const scale = 17.5 * (1024 / 824);
	const tx = 512 - 16 * scale + 6 * (1024 / 824);
	const ty = 512 - 16.5 * scale;
	fs.writeFileSync(
		path.join(iconDoc, "Assets/bird.svg"),
		`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g transform="translate(${tx} ${ty}) scale(${scale})">${d.mark(COLORS.onDark, COLORS.greenOnDark, fill, 1024)}</g></svg>`,
	);
	const srgb = (hex) =>
		`srgb:${[1, 3, 5].map((i) => (Number.parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(",")},1.00000`;
	fs.writeFileSync(
		path.join(iconDoc, "icon.json"),
		`${JSON.stringify(
			{
				fill: { solid: srgb(fill) },
				groups: [
					{
						layers: [{ "image-name": "bird.svg", name: "bird" }],
						shadow: { kind: "neutral", opacity: 0.5 },
						translucency: { enabled: false, value: 0.5 },
					},
				],
				"supported-platforms": { squares: ["macOS"] },
			},
			null,
			2,
		)}\n`,
	);
	// Compiled here (actool from Xcode 26+) and committed, so a build needs no Xcode: the
	// Assets.car ships beside build/icon.icns, which macOS 13-15 keep using.
	const compiled = path.join(tmp, "actool");
	fs.mkdirSync(compiled);
	execFileSync(
		"xcrun",
		[
			"actool",
			iconDoc,
			"--compile",
			compiled,
			"--output-format",
			"human-readable-text",
			"--errors",
			"--output-partial-info-plist",
			path.join(compiled, "info.plist"),
			"--app-icon",
			"OfferFinch",
			"--include-all-app-icons",
			"--enable-on-demand-resources",
			"NO",
			"--development-region",
			"en",
			"--target-device",
			"mac",
			"--minimum-deployment-target",
			"13.0",
			"--platform",
			"macosx",
		],
		{ cwd: build, stdio: "ignore" },
	);
	fs.copyFileSync(
		path.join(compiled, "Assets.car"),
		path.join(build, "Assets.car"),
	);
	console.log("apps/desktop/build/OfferFinch.icon, Assets.car");
}

// Menu bar: template images (black and alpha only), 16 pt at 1x and 2x, plus the status variant.
await render(
	menuBarGlyph(d, 16),
	16,
	16,
	path.join(app, "assets/trayTemplate.png"),
);
await render(
	menuBarGlyph(d, 32),
	32,
	32,
	path.join(app, "assets/trayTemplate@2x.png"),
);
await render(
	attentionGlyph(d, 16),
	16,
	16,
	path.join(app, "assets/trayAttentionTemplate.png"),
);
await render(
	attentionGlyph(d, 32),
	32,
	32,
	path.join(app, "assets/trayAttentionTemplate@2x.png"),
);

// DMG window: 540 × 380 points, the app at (150, 196) and Applications at (390, 196).
const dmg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380" viewBox="0 0 540 380">
	<defs><pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
		<path d="M20 0H0V20" fill="none" stroke="#fff" stroke-opacity="0.045" stroke-width="1"/></pattern></defs>
	<rect width="540" height="380" fill="${COLORS.ink}"/>
	<rect width="540" height="380" fill="url(#grid)"/>
	<g transform="translate(223 40)">
		<g transform="scale(${17 / 32})">${cut(d.mark, COLORS.onDark, COLORS.greenOnDark, "dm", 17)}</g>
		<text x="22" y="13.5" font-family='${d.wordmark.family}' font-weight="${d.wordmark.weight}" font-size="14" letter-spacing="${d.wordmark.tracking}">${d.wordmark.text(COLORS.onDark, COLORS.greenOnDark)}</text>
	</g>
	<path d="M232 196H300" stroke="#8e8e93" stroke-width="1.5"/>
	<path d="M300 190 308 196 300 202Z" fill="${COLORS.greenOnDark}"/>
	<text x="270" y="330" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12" fill="#8e8e93">Drag OfferFinch to Applications</text>
</svg>`;
await render(dmg, 540, 380, path.join(tmp, "background.png"));
await render(dmg, 1080, 760, path.join(tmp, "background@2x.png"), { scale: 2 });
execFileSync("tiffutil", [
	"-cathidpicheck",
	path.join(tmp, "background.png"),
	path.join(tmp, "background@2x.png"),
	"-out",
	path.join(build, "background.tiff"),
]);
write(path.join(brandDir, "dmg-background.svg"), dmg);
console.log("apps/desktop/build/background.tiff");

// Favicon (the app icon; the window does not show one, a browser tab or a saved page does).
write(
	path.join(app, "src/renderer/public/favicon.svg"),
	sized(appIconSvg(pick), 64).replace(/<svg /, `<svg data-brand="${pick}" `),
);

// The in-app mark: JSX of the selected drawing; body in currentColor, the green from --brand.
// Directions with an `inline` drawing render without a mask (cheaper to composite).
const inlineJsx = (part) =>
	`<path fillRule="evenodd" d="${part.body}" fill="currentColor" /><path d="${part.accent}" fill="var(--brand)" />`;
const jsx = (draw, size) =>
	cut(draw, "currentColor", "var(--brand)", "MASK", size)
		.replace(/id="MASK"/, "id={id}")
		// biome-ignore lint/suspicious/noTemplateCurlyInString: JSX written out as text
		.replace(/mask="url\(#MASK\)"/, "mask={`url(#${id})`}")
		.replace(/fill-rule=/g, "fillRule=");
write(
	path.join(app, "src/renderer/components/brand-mark.tsx"),
	`// Generated by scripts/icons.mjs from docs/brand/marks.mjs (direction: ${pick}). Do not edit.
${d.inline ? "" : 'import { useId } from "react";\n'}
/**
 * The OfferFinch mark: body in the text colour, the beak in the brand green. Decorative: the
 * name is always written next to it.
 */
export function BrandMark({
	size = 16,
	className,
}: {
	size?: number;
	className?: string;
}) {
${d.inline ? "" : "\tconst id = useId();\n"}	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 32 32"
			width={size}
			height={size}
			className={className}
			aria-hidden="true"
			data-brand="${pick}"
		>
			{size <= 16 ? (
				<>${d.inline ? inlineJsx(d.inlineSmall ?? d.inline) : jsx(d.small ?? d.mark, 16)}</>
			) : (
				<>${d.inline ? inlineJsx(d.inline) : jsx(d.mark, 512)}</>
			)}
		</svg>
	);
}
`,
);

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
execFileSync(
	path.join(repo, "node_modules/.bin/biome"),
	["format", "--write", "apps/desktop/src/renderer/components/brand-mark.tsx"],
	{ cwd: repo, stdio: "ignore" },
);
