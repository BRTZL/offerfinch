import fs from "node:fs";
import path from "node:path";
import { protocol } from "electron";

export const APP_ORIGIN = "app://local";

/**
 * Strict CSP for the renderer: only the app's own files, no remote scripts, styles, frames or
 * connections. `connect-src` is 'self' only: the API goes over a MessagePort, not the network.
 */
const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"frame-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".json": "application/json",
	".ico": "image/x-icon",
};

/** Must run before `app.ready`. */
export function registerAppScheme(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: "app",
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				codeCache: true,
			},
		},
	]);
}

/**
 * Serves the built renderer from disk. Unknown paths get index.html (client-side routes); paths
 * outside the folder are refused. Every response carries the CSP.
 */
export function serveRenderer(root: string): void {
	const resolvedRoot = path.resolve(root);
	protocol.handle("app", async (request) => {
		const url = new URL(request.url);
		if (url.host !== "local") return new Response("Not found", { status: 404 });
		const wanted = path.resolve(
			resolvedRoot,
			`.${decodeURIComponent(url.pathname)}`,
		);
		const relative = path.relative(resolvedRoot, wanted);
		const inside =
			!path.isAbsolute(relative) &&
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`);
		let file = inside ? wanted : "";
		if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory())
			file = path.extname(url.pathname)
				? ""
				: path.join(resolvedRoot, "index.html");
		if (!file) return new Response("Not found", { status: 404 });
		const body = await fs.promises.readFile(file);
		return new Response(body, {
			headers: {
				"content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
				"content-security-policy": CSP,
				"x-content-type-options": "nosniff",
				"cache-control": "no-cache",
			},
		});
	});
}
