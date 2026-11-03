import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.resolve(import.meta.dirname, "src/renderer");

/** The renderer: React, split per screen; loaded from app://local with a strict CSP. */
export default defineConfig({
	root,
	base: "/",
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: { "@": root },
	},
	build: {
		outDir: path.resolve(import.meta.dirname, "out/renderer"),
		emptyOutDir: true,
		target: "chrome140",
		modulePreload: { polyfill: false },
		reportCompressedSize: false,
		sourcemap: false,
	},
});
