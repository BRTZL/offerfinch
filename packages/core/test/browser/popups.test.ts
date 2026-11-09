import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	DESTINATION_REFUSED,
	type NetworkLogEntry,
	type SessionOptions,
} from "@offerfinch/core/scrape/browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureBrowser } from "./browser";

/**
 * Codex review (2026-11-09): a pop-up's first request went out before the session could close
 * the window, past the page's own request filter, even after the network was closed. The form is
 * on 127.0.0.1; localhost is another host. Every request the server sees is recorded.
 */

const EMAIL = "ada@example.test";
let server: Server;
let port = 0;
const hits: { host: string; path: string }[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		hits.push({
			host: (req.headers.host ?? "").split(":")[0] ?? "",
			path: req.url ?? "",
		});
		res.writeHead(200, { "content-type": "text/html" });
		res.end('<!doctype html><html><body><input id="email"></body></html>');
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
	await new Promise<void>((done) => {
		server.closeAllConnections?.();
		server.close(() => done());
	});
});

/**
 * Opens the form, types the email, then has the page open a pop-up carrying it to `host`.
 * `closeFirst`: the network is closed before typing, as dry runs and form reads do.
 */
async function popUp(
	options: SessionOptions,
	host: string,
	closeFirst: boolean,
): Promise<{ log: NetworkLogEntry[]; popupHits: string[] }> {
	const session = await fixtureBrowser().openSession(options);
	try {
		const page = await session.newPage();
		await page.goto(`http://127.0.0.1:${port}/form`);
		if (closeFirst) page.restrictNetwork("none");
		await page.fill("#email", EMAIL);
		await page.evaluate(
			`void window.open("http://${host}:${port}/popup?email=" + encodeURIComponent(document.querySelector("#email").value))`,
		);
		await page.waitForTimeout(1_200);
		return {
			log: page.networkLog(),
			popupHits: hits
				.filter((h) => h.path.startsWith("/popup"))
				.map((h) => `${h.host}${h.path}`),
		};
	} finally {
		hits.length = 0;
		await session.close();
	}
}

const attempts = (log: NetworkLogEntry[]) =>
	log.filter((r) => r.url.includes("/popup?email="));

describe("a pop-up the form opens", () => {
	it("sends nothing after the network is closed (dry run, form read), and is logged", async () => {
		for (const host of ["localhost", "127.0.0.1"]) {
			const { log, popupHits } = await popUp(
				{ network: "read_only", allowedHosts: ["127.0.0.1"] },
				host,
				true,
			);
			expect(popupHits).toEqual([]);
			expect(attempts(log).length).toBeGreaterThan(0);
			expect(attempts(log).every((r) => !r.allowed)).toBe(true);
		}
	});

	it("sends nothing from a read-only session either, network still open for reads", async () => {
		const { log, popupHits } = await popUp(
			{ network: "read_only" },
			"localhost",
			false,
		);
		expect(popupHits).toEqual([]);
		expect(attempts(log).length).toBeGreaterThan(0);
	});

	it("sends nothing in a real submission: to another host it stops the run", async () => {
		const options: SessionOptions = {
			network: "allowlist",
			allowedHosts: ["127.0.0.1"],
			formValues: [EMAIL],
		};
		const away = await popUp(options, "localhost", false);
		expect(away.popupHits).toEqual([]);
		expect(attempts(away.log).length).toBeGreaterThan(0);
		expect(attempts(away.log).map((r) => r.reason)).toContain(
			DESTINATION_REFUSED,
		);
		// Even to the form's own host: a window the session did not open loads nothing.
		const own = await popUp(options, "127.0.0.1", false);
		expect(own.popupHits).toEqual([]);
		expect(attempts(own.log).length).toBeGreaterThan(0);
		expect(attempts(own.log).every((r) => !r.allowed)).toBe(true);
	});
});
