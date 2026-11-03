// Builds the desktop app into out/: main and preload (CommonJS), the worker (ESM with code
// splitting, so rarely used code loads on demand) and the renderer (Vite).
// Usage: node scripts/build.mjs [--production] [--watch] [--no-renderer]
import fs from "node:fs";
import path from "node:path";
import { context, build as esbuild } from "esbuild";

const app = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.join(app, "out");
const args = new Set(process.argv.slice(2));
const production = args.has("--production");
const watch = args.has("--watch");

// Native or self-locating packages stay in node_modules.
const external = [
	"electron",
	"better-sqlite3",
	"playwright-core",
	"playwright-core/*",
];

const common = {
	bundle: true,
	platform: "node",
	target: "node24",
	sourcemap: production ? false : "linked",
	minify: production,
	legalComments: "none",
	external,
	define: {
		"process.env.NODE_ENV": JSON.stringify(
			production ? "production" : "development",
		),
	},
	logLevel: "warning",
	metafile: true,
};

const targets = [
	{
		...common,
		entryPoints: [path.join(app, "src/main/index.ts")],
		outfile: path.join(out, "main.cjs"),
		format: "cjs",
	},
	{
		...common,
		entryPoints: [path.join(app, "src/preload/index.ts")],
		outfile: path.join(out, "preload.cjs"),
		format: "cjs",
	},
	{
		...common,
		entryPoints: { index: path.join(app, "src/worker/index.ts") },
		outdir: path.join(out, "worker"),
		outExtension: { ".js": ".mjs" },
		format: "esm",
		splitting: true,
		chunkNames: "chunks/[name]-[hash]",
		// Some dependencies still call require(); give ESM chunks one.
		banner: {
			js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
		},
	},
	// The Claude Agent SDK's host process (local-llm's claude-host.ts), forked as Node with
	// Electron's binary for each Claude subscription call. The SDK is bundled in; the CLI it
	// drives is the user's installed Claude Code.
	{
		...common,
		entryPoints: [
			path.join(app, "../../packages/local-llm/src/claude-host.ts"),
		],
		outfile: path.join(out, "worker", "claude-host.mjs"),
		format: "esm",
		banner: {
			js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
		},
	},
];

fs.rmSync(path.join(out, "worker"), { recursive: true, force: true });
if (watch) {
	for (const t of targets) await (await context(t)).watch();
	console.log("watching main, preload and worker");
} else {
	const results = await Promise.all(targets.map((t) => esbuild(t)));
	fs.writeFileSync(
		path.join(out, "meta.json"),
		JSON.stringify(results.map((r) => r.metafile)),
	);
}

if (!args.has("--no-renderer") && !watch) {
	const { build } = await import("vite");
	await build({
		configFile: path.join(app, "vite.config.mts"),
		mode: production ? "production" : "development",
		logLevel: "warn",
	});
}
console.log(
	`built ${production ? "(production) " : ""}into ${path.relative(process.cwd(), out)}`,
);
