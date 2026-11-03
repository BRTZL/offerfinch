import { useEffect, useRef } from "react";
import { desktop } from "@/lib/desktop";

/** Cell size and gap, in CSS pixels, from the Grid mark's 4-unit cells. */
const CELL = 10;
const GAP = 18;
/** Frames a second: slow enough to cost next to nothing, fast enough to read as a glow. */
const FPS = 6;
/** Cells lit at once, and how long one glow lasts. */
const LIT = 14;
const GLOW_MS = 7000;

type Glow = { i: number; start: number };

/**
 * The first run's background: a faint grid of the mark's cells, a few of them slowly lighting
 * up in the brand colour and fading. A canvas redrawn at 6 frames a second, only while the window
 * is visible and focused; one still frame under reduced motion. The middle is masked out (see
 * `.ambient-field` in index.css), so it never sits behind text. It exists only while mounted:
 * unmounting stops the timer and every listener.
 */
export function AmbientField() {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const canvas = ref.current;
		const ctx = canvas?.getContext("2d", { alpha: true });
		if (!canvas || !ctx) return;
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
		let cols = 0;
		let rows = 0;
		let ink = "";
		let brand = "";
		let dark = false;
		let glows: Glow[] = [];
		let timer: number | null = null;

		const colours = () => {
			const css = getComputedStyle(document.documentElement);
			ink = css.getPropertyValue("--foreground").trim() || "#000";
			brand = css.getPropertyValue("--brand").trim() || "#15803d";
			dark = document.documentElement.classList.contains("dark");
		};
		const resize = () => {
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const { width, height } = canvas.getBoundingClientRect();
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			cols = Math.ceil(width / (CELL + GAP)) + 1;
			rows = Math.ceil(height / (CELL + GAP)) + 1;
			glows = glows.filter((g) => g.i < cols * rows);
		};
		const draw = (now: number) => {
			const { width, height } = canvas.getBoundingClientRect();
			ctx.clearRect(0, 0, width, height);
			ctx.fillStyle = ink;
			ctx.globalAlpha = dark ? 0.03 : 0.022;
			for (let r = 0; r < rows; r++)
				for (let c = 0; c < cols; c++)
					ctx.fillRect(c * (CELL + GAP), r * (CELL + GAP), CELL, CELL);
			ctx.fillStyle = brand;
			for (const g of glows) {
				const t = (now - g.start) / GLOW_MS;
				if (t < 0 || t > 1) continue;
				ctx.globalAlpha = (dark ? 0.16 : 0.14) * Math.sin(Math.PI * t);
				const c = g.i % cols;
				const r = Math.floor(g.i / cols);
				ctx.fillRect(c * (CELL + GAP), r * (CELL + GAP), CELL, CELL);
			}
			ctx.globalAlpha = 1;
		};
		const step = () => {
			const now = performance.now();
			glows = glows.filter((g) => now - g.start < GLOW_MS);
			while (glows.length < LIT && cols * rows > 0)
				glows.push({
					i: Math.floor(Math.random() * cols * rows),
					// Staggered, so cells never light together.
					start: now + Math.random() * GLOW_MS,
				});
			draw(now);
		};
		// Main says whether the window is focused, shown and not minimised; the page's own
		// visibility covers the rest.
		let windowActive = document.hasFocus();
		const running = () => !reduced.matches && !document.hidden && windowActive;
		const sync = () => {
			if (running() && timer === null)
				timer = window.setInterval(step, 1000 / FPS);
			else if (!running() && timer !== null) {
				window.clearInterval(timer);
				timer = null;
			}
			// For tests and measurement: whether the field is animating now.
			canvas.parentElement?.setAttribute(
				"data-running",
				String(timer !== null),
			);
		};
		const restyle = () => {
			colours();
			draw(performance.now());
		};

		colours();
		resize();
		draw(performance.now());
		sync();
		const observer = new ResizeObserver(() => {
			resize();
			draw(performance.now());
		});
		observer.observe(canvas);
		// The theme is the page's class (set from main), so its colours follow the class.
		const theme = new MutationObserver(restyle);
		theme.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
		const onFocus = () => {
			windowActive = true;
			sync();
		};
		const onBlur = () => {
			windowActive = false;
			sync();
		};
		document.addEventListener("visibilitychange", sync);
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		reduced.addEventListener("change", sync);
		const offWindow = desktop.onWindowActive?.((active) => {
			windowActive = active;
			sync();
		});
		return () => {
			if (timer !== null) window.clearInterval(timer);
			observer.disconnect();
			document.removeEventListener("visibilitychange", sync);
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
			offWindow?.();
			reduced.removeEventListener("change", sync);
			theme.disconnect();
		};
	}, []);
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0"
			data-testid="ambient-field"
		>
			<canvas ref={ref} className="ambient-field size-full" />
		</div>
	);
}
