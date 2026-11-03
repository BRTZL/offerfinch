// OfferFinch: the three logo directions as vector geometry. Everything the brand renders
// (comparison sheet, app icon, menu bar icon, DMG art, the in-app mark) is drawn from here by
// apps/desktop/scripts/icons.mjs. Change SELECTED and run that script to switch direction.
//
// Every mark is drawn on a 32-unit grid, the bird facing right. `fg` is the body, `accent`
// the one green, `bg` the colour behind it (used for knock-outs such as the eye).

export const SELECTED = "grid";

export const COLORS = {
	ink: "#0d0d0f", // the dark ground: app icon, DMG, dark theme
	paper: "#ffffff",
	onDark: "#f5f5f7",
	onLight: "#111113",
	// The one accent. Lighter on dark; darker on light so a small beak still reaches 3:1
	// (#15803d on white is 5.0:1; #34c759 on #0d0d0f is 9.6:1).
	greenOnDark: "#34c759",
	greenOnLight: "#15803d",
};

/**
 * Each direction: `mark(fg, accent, bg)` at 32 units, `small(fg, accent, bg)` hinted for 16 px
 * (same viewBox), `glyph` a one-colour silhouette for template images (holes are transparent:
 * fill-rule evenodd), the wordmark's type, and a note on the idea.
 */
export const DIRECTIONS = {
	/** A: round. Circles and wedges; the finch carries a green square (the offer) in its beak. */
	round: {
		label: "A · Round",
		idea: "A perched finch built from two circles and three wedges, carrying a green square: the offer it brings back. Friendly, the softest of the three.",
		mark: (fg, accent, bg) => `
	<circle cx="12.5" cy="20" r="9" fill="${fg}"/>
	<circle cx="19" cy="11.5" r="6" fill="${fg}"/>
	<path d="M8 13.2 15.5 6.6 23 15 19 26Z" fill="${fg}"/>
	<path d="M6 23.5 1 30 10.5 28Z" fill="${fg}"/>
	<path d="M24.4 8.6 29 11.2 24.4 14.4Z" fill="${fg}"/>
	<circle cx="20.4" cy="10.6" r="1.35" fill="${bg}"/>
	<rect x="26" y="12" width="5" height="5" fill="${accent}"/>`,
		small: null,
		glyph: `<path fill-rule="evenodd" d="M12.5 11a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M19 5.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z M20.4 9.25a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7Z"/>
	<path d="M8 13.2 15.5 6.6 23 15 19 26Z M6 23.5 1 30 10.5 28Z M24.4 8.6 29 11.2 24.4 14.4Z M26 12h5v5h-5Z"/>`,
		wordmark: {
			family: '"SF Pro Rounded", ui-rounded, -apple-system, sans-serif',
			weight: 600,
			tracking: "-0.01em",
			text: (fg) => `<tspan fill="${fg}">OfferFinch</tspan>`,
		},
	},

	/** B: facet. Straight edges only; the beak is the green, the wing a cut. The pick. */
	facet: {
		label: "B · Facet",
		idea: "A finch cut from straight edges, like folded paper: a stout green beak (a finch's tell), a square eye and a wing cut out of the body. Square and precise like the app; one green.",
		mark: (fg, accent, bg) => `
	<path d="M24.5 8 20.5 4.5 13.5 6.5 4.5 18.5 .5 27 8 24.5 13.5 28 21.5 24 25.5 15Z" fill="${fg}"/>
	<path d="M24.5 8 31.5 12 25.5 15Z" fill="${accent}"/>
	<path d="M8.5 21.5 17.5 12.5 16 19.5Z" fill="${bg}"/>
	<rect x="19" y="8" width="2.5" height="2.5" fill="${bg}"/>`,
		// 16 px: the same outline snapped to a 16 grid, no wing, a 1 px eye.
		small: (fg, accent, bg) => `
	<path d="M24 8 20 4 14 6 4 18 0 28 8 25 14 28 22 24 26 15Z" fill="${fg}"/>
	<path d="M24 8 32 12 26 15Z" fill="${accent}"/>
	<rect x="18" y="8" width="2" height="2" fill="${bg}"/>`,
		// For the in-app mark: the body with its holes as one even-odd path, and the beak. No
		// mask, so no offscreen surface in the window.
		inline: {
			body: "M24.5 8 20.5 4.5 13.5 6.5 4.5 18.5 .5 27 8 24.5 13.5 28 21.5 24 25.5 15Z M8.5 21.5 17.5 12.5 16 19.5Z M19 8h2.5v2.5H19Z",
			accent: "M24.5 8 31.5 12 25.5 15Z",
		},
		inlineSmall: {
			body: "M24 8 20 4 14 6 4 18 0 28 8 25 14 28 22 24 26 15Z M18 8h2v2h-2Z",
			accent: "M24 8 32 12 26 15Z",
		},
		glyph: `<path fill-rule="evenodd" d="M24.5 8 20.5 4.5 13.5 6.5 4.5 18.5 .5 27 8 24.5 13.5 28 21.5 24 25.5 15 31.5 12Z M8.5 21.5 17.5 12.5 16 19.5Z M19 8h2.5v2.5H19Z"/>`,
		glyphSmall: `<path fill-rule="evenodd" d="M24 8 20 4 14 6 4 18 0 28 8 25 14 28 22 24 26 15 32 12Z M18 8h2v2h-2Z"/>`,
		wordmark: {
			family:
				'-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif',
			weight: 650,
			tracking: "-0.025em",
			text: (fg) => `<tspan fill="${fg}">OfferFinch</tspan>`,
		},
	},

	/** C: grid. The finch on an 8×8 grid of squares, the beak one green cell. */
	grid: {
		label: "C · Grid",
		idea: "The finch on an 8×8 grid, each cell a square, the beak one green cell. Pixel-exact at 16 px; at large sizes the cells part, like the app's dense tables. The wordmark splits offer/finch with a slash.",
		mark: (fg, accent, _bg, size = 512) =>
			gridCells(fg, accent, size > 32 ? 0.5 : 0),
		small: null,
		get glyph() {
			return gridCells("#000", "#000", 0);
		},
		wordmark: {
			family: 'ui-monospace, "SF Mono", Menlo, monospace',
			weight: 600,
			tracking: "-0.01em",
			text: (fg, accent) =>
				`<tspan fill="${fg}">offer</tspan><tspan fill="${accent}">/</tspan><tspan fill="${fg}">finch</tspan>`,
		},
	},
};

const GRID = [
	"........",
	"....###.",
	"...#.##G",
	"..#####.",
	".#####..",
	"#####...",
	"#..#....",
	"........",
];

function gridCells(fg, accent, gap) {
	return GRID.flatMap((row, y) =>
		[...row].map((c, x) =>
			c === "."
				? ""
				: `<rect x="${x * 4 + gap}" y="${y * 4 + gap + 2}" width="${4 - 2 * gap}" height="${4 - 2 * gap}" fill="${c === "G" ? accent : fg}"/>`,
		),
	).join("");
}

/**
 * A drawing with its knock-outs (eye, wing) as real holes: a luminance mask of the same drawing
 * in white with the knock-outs black, over the drawing with the knock-outs left out.
 */
export function cut(draw, fg, accent, id, size) {
	return `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="32" height="32" fill="#000"/>${draw("#fff", "#fff", "#000", size)}</mask><g mask="url(#${id})">${draw(fg, accent, "none", size)}</g>`;
}

/** The mark as a standalone SVG at a pixel size; the hinted drawing at 16 px when there is one. */
export function markSvg(key, size, theme) {
	const d = DIRECTIONS[key];
	const fg = theme === "dark" ? COLORS.onDark : COLORS.onLight;
	const accent = theme === "dark" ? COLORS.greenOnDark : COLORS.greenOnLight;
	const draw = size <= 16 && d.small ? d.small : d.mark;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${cut(draw, fg, accent, `m-${key}-${size}`, size)}</svg>`;
}

/** Mark plus name, for documents. Text stays live (system fonts); outline it before print use. */
export function wordmarkSvg(key, theme, height = 64) {
	const d = DIRECTIONS[key];
	const fg = theme === "dark" ? COLORS.onDark : COLORS.onLight;
	const accent = theme === "dark" ? COLORS.greenOnDark : COLORS.greenOnLight;
	const w = d.wordmark;
	const width = Math.round(height * 5.6);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
	<g transform="scale(${height / 32})">${cut(d.mark, fg, accent, `w-${key}-${theme}`, height)}</g>
	<text x="${Math.round(height * 1.22)}" y="${Math.round(height * 0.71)}" font-family='${w.family}' font-weight="${w.weight}" font-size="${Math.round(height * 0.6)}" letter-spacing="${w.tracking}">${w.text(fg, accent)}</text>
</svg>`;
}

/**
 * The macOS app icon on Apple's 1024 grid: an 824 rounded square inset 100 (corner 185.4), the
 * system's drop shadow below it, the mark inside the grid's central area. `small` uses the
 * hinted drawing (16 px renders).
 */
export function appIconSvg(key, { small = false } = {}) {
	const d = DIRECTIONS[key];
	const draw = small && d.small ? d.small : d.mark;
	// The mark's 32-unit box scaled to 560 (68% of the body), centred optically (a bird's mass
	// sits low and left, so it moves up and right a little).
	const scale = 17.5;
	const tx = 512 - 16 * scale + 6;
	const ty = 512 - 16.5 * scale;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
	<defs>
		<linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#1c1c1f"/><stop offset="1" stop-color="#0b0b0d"/>
		</linearGradient>
		<filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
			<feGaussianBlur stdDeviation="10"/>
		</filter>
	</defs>
	<rect x="100" y="110" width="824" height="824" rx="185.4" fill="#000" fill-opacity="0.3" filter="url(#shadow)"/>
	<rect x="100" y="100" width="824" height="824" rx="185.4" fill="url(#body)"/>
	<rect x="100.5" y="100.5" width="823" height="823" rx="185" fill="none" stroke="#fff" stroke-opacity="0.09"/>
	<g transform="translate(${tx} ${ty}) scale(${scale})">${cut(draw, COLORS.onDark, COLORS.greenOnDark, `i-${key}`, small ? 16 : 1024)}</g>
</svg>`;
}
