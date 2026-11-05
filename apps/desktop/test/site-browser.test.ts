import { describe, expect, it, vi } from "vitest";

import type { MainToWorker, WorkerToMain } from "../src/shared/worker-protocol";

/** Electron's view and session, faked: enough for the tab bookkeeping (no page is loaded). */
vi.mock("electron", () => {
	let nextId = 1;
	class FakeContents {
		id = nextId++;
		destroyed = false;
		url = "about:blank";
		on() {}
		setWindowOpenHandler() {}
		setAudioMuted() {}
		focus() {}
		isDestroyed() {
			return this.destroyed;
		}
		close() {
			this.destroyed = true;
		}
		getURL() {
			return this.url;
		}
		getTitle() {
			return "";
		}
		isLoading() {
			return false;
		}
		async loadURL(url: string) {
			(globalThis as { __loading?: (u: string) => void }).__loading?.(url);
			this.url = url;
		}
		stop() {}
		async executeJavaScriptInIsolatedWorld() {
			return { html: "<html></html>", title: "" };
		}
	}
	class WebContentsView {
		webContents = new FakeContents();
		bounds = { x: 0, y: 0, width: 0, height: 0 };
		setBounds(b: typeof this.bounds) {
			this.bounds = b;
		}
		getBounds() {
			return this.bounds;
		}
	}
	const hooks = () => {
		const g = globalThis as {
			__webRequest?: Record<string, (d: unknown) => void>;
		};
		g.__webRequest ??= {};
		return g.__webRequest;
	};
	const fakeSession = {
		setPermissionRequestHandler() {},
		setPermissionCheckHandler() {},
		setDevicePermissionHandler() {},
		on() {},
		// The handlers each session registers, for a test to fire (web tab: redirects, responses).
		webRequest: {
			onBeforeRequest(fn: (d: unknown, cb: (r: unknown) => void) => void) {
				(hooks() as Record<string, unknown>).before = fn;
			},
			onBeforeRedirect(fn: (d: unknown) => void) {
				hooks().redirect = fn;
			},
			onResponseStarted(fn: (d: unknown) => void) {
				hooks().started = fn;
			},
			onBeforeSendHeaders(fn: (d: unknown, cb: (r: unknown) => void) => void) {
				(hooks() as Record<string, unknown>).sendHeaders = fn;
			},
		},
		resolveHost: async () => ({ endpoints: [{ address: "93.184.216.34" }] }),
		clearStorageData: async (options?: { storages?: string[] }) => {
			(hooks() as Record<string, unknown>).cleared = options?.storages ?? "all";
		},
		clearCache: async () => {
			(hooks() as Record<string, unknown>).cacheCleared = true;
		},
		clearAuthCache: async () => {
			(hooks() as Record<string, unknown>).authCleared = true;
		},
	};
	return {
		app: { isPackaged: false },
		WebContentsView,
		session: { fromPartition: () => fakeSession },
	};
});

const { SiteBrowser, privateGuard, readOnlyNavigation } = await import(
	"../src/main/site-browser"
);
const { connectSiteTabs } = await import("../src/main/site-wiring");

const browser = () => new SiteBrowser({ log: () => {} });

describe("site tabs belong to the worker process that claimed them", () => {
	it("a worker that dies lets its claims go: the restarted worker can claim again", async () => {
		const sites = browser();
		await sites.handle({ op: "claim", site: "indeed" }, 1);
		await expect(
			sites.handle({ op: "claim", site: "indeed" }, 2),
		).rejects.toThrow(/already being read/);
		sites.workerGone(1);
		// Closed: nothing is attached, so the dead run's tab goes.
		expect(sites.describe()).toEqual([]);
		await expect(
			sites.handle({ op: "claim", site: "indeed" }, 2),
		).resolves.toBe(true);
		expect(sites.describe()).toMatchObject([
			{ site: "indeed", run: true, owner: 2 },
		]);
	});

	it("refuses calls a dead worker still had queued, and its stale release", async () => {
		const sites = browser();
		await sites.handle({ op: "claim", site: "linkedin" }, 1);
		sites.workerGone(1);
		await expect(
			sites.handle(
				{ op: "navigate", site: "linkedin", url: "https://example.test/" },
				1,
			),
		).rejects.toThrow(/stopped/);
		await sites.handle({ op: "claim", site: "linkedin" }, 2);
		// A late release from the dead process must not free the new run's tab.
		await sites.handle({ op: "release", site: "linkedin" }, 1).catch(() => {});
		expect(sites.describe()).toMatchObject([{ run: true, owner: 2 }]);
	});

	it("only the owning run may drive the tab", async () => {
		const sites = browser();
		await sites.handle({ op: "claim", site: "glassdoor" }, 3);
		await expect(
			sites.handle(
				{ op: "navigate", site: "glassdoor", url: "https://example.test/" },
				4,
			),
		).rejects.toThrow(/not open for this run/);
		await expect(
			sites.handle(
				{ op: "navigate", site: "glassdoor", url: "https://example.test/" },
				3,
			),
		).resolves.toMatchObject({ url: "https://example.test/" });
	});
});

describe("the worker host wiring", () => {
	function fakeHost() {
		let listener: (m: WorkerToMain, g: number) => void = () => {};
		const posted: { generation: number; message: MainToWorker }[] = [];
		const host = {
			current: 1,
			onExit: null as ((g: number) => void) | null,
			on(l: (m: WorkerToMain, g: number) => void) {
				listener = l;
			},
			postTo(generation: number, message: MainToWorker) {
				// Like WorkerHost: only the live process gets it.
				if (generation === host.current) posted.push({ generation, message });
			},
			send: (m: WorkerToMain, g: number) => listener(m, g),
			posted,
		};
		return host;
	}

	it("answers the process that asked, drops answers for a dead one, frees its claims", async () => {
		const sites = browser();
		const host = fakeHost();
		connectSiteTabs(host, sites);
		host.send(
			{ type: "site", id: 1, call: { op: "claim", site: "indeed" } },
			1,
		);
		await vi.waitFor(() => expect(host.posted).toHaveLength(1));
		expect(host.posted[0]).toMatchObject({
			generation: 1,
			message: { type: "site-result", id: 1, ok: true },
		});

		// Worker 1 asks for a page, then dies before the answer; worker 2 starts.
		host.send(
			{
				type: "site",
				id: 2,
				call: { op: "navigate", site: "indeed", url: "https://example.test/" },
			},
			1,
		);
		host.current = 2;
		host.onExit?.(1);
		await new Promise((r) => setTimeout(r, 10));
		expect(host.posted).toHaveLength(1);

		// Worker 2's first call (id 1 again) claims the freed tab and gets its own answer.
		host.send(
			{ type: "site", id: 1, call: { op: "claim", site: "indeed" } },
			2,
		);
		await vi.waitFor(() => expect(host.posted).toHaveLength(2));
		expect(host.posted[1]).toMatchObject({
			generation: 2,
			message: { type: "site-result", id: 1, ok: true },
		});
		expect(sites.describe()).toMatchObject([{ owner: 2, run: true }]);
	});
});

describe("web search's tab and private networks", () => {
	const resolver = (answer: () => string[] | Error) => {
		const asked: string[] = [];
		return {
			asked,
			resolveHost: async (host: string) => {
				asked.push(host);
				const a = answer();
				if (a instanceof Error) throw a;
				return { endpoints: a.map((address) => ({ address })) };
			},
		};
	};

	it("refuses this Mac and private networks in every written form, by name and by what it resolves to", async () => {
		const refused = privateGuard(resolver(() => ["93.184.216.34"]));
		for (const host of [
			"localhost",
			"ｌｏｃａｌｈｏｓｔ",
			"printer.local",
			"127.99.1.2",
			"10.1.2.3",
			"172.16.1.2",
			"172.31.255.1",
			"192.168.1.2",
			"169.254.169.254",
			"2130706433",
			"0x7f000001",
			"0177.0.0.1",
			"127。0。0。1",
			"[::]",
			"[::1]",
			"[fc00::1]",
			"[fdff::1]",
			"[fe80::1]",
			"[::ffff:127.0.0.1]",
			"[::ffff:7f00:1]",
		])
			expect(await refused(`http://${host}/`), host).toBe(true);
		expect(await refused("https://careers.example.com/jobs/1")).toBe(false);
		// An IDN host is checked by what it resolves to, like any name.
		expect(await refused("https://bücher.example/jobs")).toBe(false);
	});

	it("asks the resolver on every request (no answer kept) and refuses what it cannot answer", async () => {
		let answer: string[] | Error = ["93.184.216.34"];
		const ses = resolver(() => answer);
		const refused = privateGuard(ses);
		expect(await refused("http://rebind.example/jobs")).toBe(false);
		answer = ["127.0.0.1"];
		expect(await refused("http://rebind.example/private")).toBe(true);
		answer = ["93.184.216.34", "192.168.1.20"];
		expect(await refused("http://rebind.example/mixed")).toBe(true);
		expect(ses.asked).toHaveLength(3);
		answer = new Error("DNS unavailable");
		expect(await refused("http://fail.example/")).toBe(true);
		answer = [];
		expect(await refused("http://nothing.example/")).toBe(true);
	});

	it("stops a load that connected to a private address and hands back nothing of it", async () => {
		const sites = browser();
		await sites.handle({ op: "claim", site: "web" }, 1);
		const hooks = (
			globalThis as { __webRequest?: Record<string, (d: unknown) => void> }
		).__webRequest as Record<string, (d: unknown) => void>;
		const g = globalThis as { __loading?: (u: string) => void };
		g.__loading = (url) => {
			hooks.redirect?.({
				resourceType: "mainFrame",
				url,
				redirectURL: "https://b.example/job",
				ip: "93.184.216.34",
			});
			hooks.started?.({
				resourceType: "mainFrame",
				url: "https://b.example/job",
				ip: "10.0.0.7",
			});
		};
		const nav = await sites.handle(
			{ op: "navigate", site: "web", url: "https://a.example/job" },
			1,
		);
		expect(nav).toMatchObject({
			redirects: ["https://b.example/job"],
			refused: "it reached a private network address",
		});
		expect(
			await sites.handle({ op: "snapshot", site: "web" }, 1),
		).toMatchObject({
			html: "",
			text: "",
			refused: "it reached a private network address",
		});
		// The next load, to a public address, reads as usual.
		g.__loading = (url) =>
			hooks.started?.({ resourceType: "mainFrame", url, ip: "93.184.216.34" });
		const next = await sites.handle(
			{ op: "navigate", site: "web", url: "https://c.example/job" },
			1,
		);
		expect(next).not.toHaveProperty("refused");
		expect(
			await sites.handle({ op: "snapshot", site: "web" }, 1),
		).toMatchObject({ html: "<html></html>" });
		g.__loading = undefined;
	});

	it("follows no redirect: the page it heads for is not requested, and comes back for the worker", async () => {
		const sites = browser();
		await sites.handle({ op: "claim", site: "web" }, 2);
		const hooks = (globalThis as { __webRequest?: Record<string, unknown> })
			.__webRequest as Record<string, unknown>;
		const before = hooks.before as (
			d: unknown,
			cb: (r: { cancel?: boolean }) => void,
		) => void;
		const ask = (url: string) =>
			new Promise<{ cancel?: boolean }>((done) =>
				before({ resourceType: "mainFrame", method: "GET", url }, done),
			);
		const answers: { cancel?: boolean }[] = [];
		const g = globalThis as { __loading?: (u: string) => void };
		g.__loading = () => {
			void ask("https://a.example/job").then((r) => answers.push(r));
			void ask("https://b.example/elsewhere").then((r) => answers.push(r));
		};
		const nav = await sites.handle(
			{ op: "navigate", site: "web", url: "https://a.example/job" },
			2,
		);
		await new Promise((r) => setTimeout(r, 10));
		g.__loading = undefined;
		// The page asked for may load (after the address check); the redirect is never requested.
		expect(answers).toContainEqual({ cancel: true });
		expect(answers).toContainEqual({});
		expect(nav).toMatchObject({ redirect: "https://b.example/elsewhere" });
		expect(
			await sites.handle({ op: "snapshot", site: "web" }, 2),
		).toMatchObject({
			html: "",
			redirect: "https://b.example/elsewhere",
		});
	});
});

describe("main-frame requests while a run reads a tab", () => {
	const web = {
		site: "web" as const,
		run: true,
		sheet: null,
		expected: "https://jobs.example/same",
		authorized: false,
	};
	const get = (url: string) => ({
		url,
		method: "GET",
		resourceType: "mainFrame",
	});

	it("web tab: one request per open is the page asked for; every later one, the same URL too, is refused", () => {
		expect(readOnlyNavigation(web, get("https://jobs.example/same"))).toBe(
			"authorize",
		);
		const after = { ...web, authorized: true };
		// A 302 to the very same URL, in another host case, a reload: none reuse the authorization.
		for (const url of [
			"https://jobs.example/same",
			"https://JOBS.example/same",
			"https://jobs.example/same#again",
			"https://jobs.example/other",
		])
			expect(readOnlyNavigation(after, get(url)), url).toBe("redirect");
		// The fragment is never sent: the page asked for with one still matches once.
		expect(
			readOnlyNavigation(
				{ ...web, expected: "https://jobs.example/same#top" },
				get("https://jobs.example/same"),
			),
		).toBe("authorize");
		// Subresources and in-page changes (pushState, hash) are not main-frame requests.
		expect(
			readOnlyNavigation(after, {
				url: "https://jobs.example/app.js",
				method: "GET",
				resourceType: "script",
			}),
		).toBe("allow");
	});

	it("refuses a form a page sends by itself while it is only read, and lets the user's own go", () => {
		const post = {
			url: "https://jobs.example/same",
			method: "POST",
			resourceType: "mainFrame",
		};
		expect(readOnlyNavigation(web, post)).toBe("send");
		for (const site of ["linkedin", "indeed", "glassdoor"] as const) {
			const reading = { ...web, site, expected: null };
			expect(readOnlyNavigation(reading, post), site).toBe("send");
			// Their own scripts' requests go as they are (signed-in reads may need them).
			expect(
				readOnlyNavigation(reading, { ...post, resourceType: "xhr" }),
				site,
			).toBe("allow");
			// The site's own redirects still go (regional hosts, search URLs).
			expect(
				readOnlyNavigation(reading, get("https://tr.indeed.com/jobs?q=x")),
				site,
			).toBe("allow");
		}
	});

	it("with a sheet open the user acts in the page of a sign-in site; reading resumes when it closes", () => {
		const post = {
			url: "https://jobs.example/challenge",
			method: "POST",
			resourceType: "mainFrame",
		};
		for (const site of [
			"linkedin",
			"indeed",
			"glassdoor",
			"duckduckgo",
		] as const) {
			const tab = { ...web, site, authorized: true };
			expect(readOnlyNavigation({ ...tab, sheet: "live" }, post), site).toBe(
				"allow",
			);
			expect(
				readOnlyNavigation(
					{ ...tab, sheet: "live" },
					get("https://jobs.example/next"),
				),
				site,
			).toBe("allow");
			expect(
				readOnlyNavigation({ ...tab, run: false, sheet: "sign-in" }, post),
				site,
			).toBe("allow");
			// Sheet closed: read-only again.
			expect(readOnlyNavigation(tab, post), site).toBe("send");
		}
		expect(
			readOnlyNavigation(
				{ ...web, authorized: true },
				get("https://jobs.example/next"),
			),
		).toBe("redirect");
	});

	it("web tab: no WebSocket, whose messages after its opening GET are never seen", () => {
		const reading = { ...web, authorized: true };
		expect(
			readOnlyNavigation(reading, {
				url: "wss://jobs.example/socket",
				method: "GET",
				resourceType: "webSocket",
			}),
		).toBe("send");
		// LinkedIn's own scripts keep theirs (signed-in pages may need them).
		expect(
			readOnlyNavigation(
				{ ...reading, site: "linkedin" },
				{
					url: "wss://www.linkedin.com/realtime",
					method: "GET",
					resourceType: "webSocket",
				},
			),
		).toBe("allow");
	});

	it("Watch live on the web tab stays read only: a careers page's scripts can't submit while watched", () => {
		const watched = { ...web, authorized: true, sheet: "live" as const };
		for (const resourceType of ["mainFrame", "xhr", "ping", "subFrame"])
			expect(
				readOnlyNavigation(watched, {
					url: "https://jobs.example/apply",
					method: "POST",
					resourceType,
				}),
				resourceType,
			).toBe("send");
		// Another page is the worker's to open, as without the sheet.
		expect(readOnlyNavigation(watched, get("https://jobs.example/next"))).toBe(
			"redirect",
		);
	});

	it("web tab: no request that writes, of any kind, and no frame from another origin", () => {
		const reading = { ...web, authorized: true };
		for (const resourceType of ["xhr", "ping", "subFrame", "other", "script"])
			for (const method of ["POST", "PUT", "DELETE", "PATCH"])
				expect(
					readOnlyNavigation(reading, {
						url: "https://jobs.example/sent",
						method,
						resourceType,
					}),
					`${method} ${resourceType}`,
				).toBe("send");
		expect(
			readOnlyNavigation(reading, {
				url: "https://tracker.example/frame",
				method: "GET",
				resourceType: "subFrame",
			}),
		).toBe("send");
		expect(
			readOnlyNavigation(reading, {
				url: "https://jobs.example/frame",
				method: "GET",
				resourceType: "subFrame",
			}),
		).toBe("allow");
	});

	it("web tab: refuses a service worker's script and starts each run with its storage cleared", async () => {
		const sites = browser();
		await sites.handle({ op: "claim", site: "web" }, 7);
		const hooks = (globalThis as { __webRequest?: Record<string, unknown> })
			.__webRequest as Record<string, unknown>;
		expect(hooks.cleared).toEqual(
			expect.arrayContaining([
				"serviceworkers",
				"cookies",
				"localstorage",
				"cachestorage",
			]),
		);
		// The HTTP cache too, or a page cached by an earlier run is served with no request.
		expect(hooks.cacheCleared).toBe(true);
		const send = hooks.sendHeaders as (
			d: unknown,
			cb: (r: { cancel?: boolean }) => void,
		) => void;
		const answer = (headers: Record<string, string>) =>
			new Promise<{ cancel?: boolean }>((done) =>
				send(
					{ url: "https://jobs.example/sw.js", requestHeaders: headers },
					done,
				),
			);
		expect(await answer({ "Service-Worker": "script" })).toEqual({
			cancel: true,
		});
		expect(await answer({ Accept: "*/*" })).toMatchObject({
			requestHeaders: { Accept: "*/*" },
		});
	});
});

describe("try-it mode closes every site tab and opens none", () => {
	const fakeWindow = () =>
		({
			isDestroyed: () => false,
			getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
			contentView: {
				children: [] as unknown[],
				addChildView() {},
				removeChildView() {},
			},
			webContents: { send() {} },
		}) as never;
	const bounds = { x: 0, y: 0, width: 400, height: 300 };

	it("closes a sign-in tab kept after its sheet closed, and refuses sheets and claims while blocked", async () => {
		const sites = browser();
		expect(sites.show("linkedin", "sign-in", fakeWindow(), bounds).ok).toBe(
			true,
		);
		// The sheet closes; the signed-in tab stays a minute (the real session in it).
		sites.hide("linkedin");
		expect(sites.describe()).toMatchObject([
			{ site: "linkedin", sheet: null, run: false },
		]);
		const contents = sites.contents("linkedin");
		sites.block("switching");
		sites.closeAll();
		expect(sites.describe()).toEqual([]);
		expect(contents?.isDestroyed()).toBe(true);
		expect(sites.show("linkedin", "sign-in", fakeWindow(), bounds)).toEqual({
			ok: false,
			reason: "switching",
		});
		await expect(
			sites.handle({ op: "claim", site: "indeed" }, 3),
		).rejects.toThrow("switching");
		expect(sites.describe()).toEqual([]);
		// Back on the real data: tabs open again.
		sites.block(null);
		expect(sites.show("linkedin", "sign-in", fakeWindow(), bounds).ok).toBe(
			true,
		);
		sites.closeAll();
	});

	it("refuses to sign out, read or clear a site's session while blocked, even a call queued before", async () => {
		const g = globalThis as { __webRequest?: Record<string, unknown> };
		const cleared = () => {
			const hooks = g.__webRequest ?? {};
			return {
				storage: hooks.cleared,
				cache: hooks.cacheCleared,
				auth: hooks.authCleared,
			};
		};
		const reset = () => {
			g.__webRequest ??= {};
			delete g.__webRequest.cleared;
			delete g.__webRequest.cacheCleared;
			delete g.__webRequest.authCleared;
		};
		const nothing = { storage: undefined, cache: undefined, auth: undefined };
		const sites = browser();
		// A signed-in tab kept after its sheet closed: the real session is in it.
		sites.show("linkedin", "sign-in", fakeWindow(), bounds);
		sites.hide("linkedin");
		reset();
		sites.block("switching");
		await expect(
			sites.handle({ op: "signOut", site: "linkedin" }, 3),
		).rejects.toThrow("switching");
		await expect(
			sites.handle({ op: "snapshot", site: "linkedin" }, 3),
		).rejects.toThrow("switching");
		// The web tab's claim clears its session first: not while blocked.
		await expect(sites.handle({ op: "claim", site: "web" }, 3)).rejects.toThrow(
			"switching",
		);
		expect(cleared()).toEqual(nothing);
		// A sign out asked for just before the switch, still queued when it starts, is refused when
		// its turn comes.
		sites.block(null);
		const late = sites.handle({ op: "signOut", site: "indeed" }, 3);
		sites.block("switching");
		await expect(late).rejects.toThrow("switching");
		expect(cleared()).toEqual(nothing);
		// Back on the real data: signing out clears the whole session.
		sites.block(null);
		await sites.handle({ op: "signOut", site: "linkedin" }, 3);
		expect(cleared()).toEqual({ storage: "all", cache: true, auth: true });
		sites.closeAll();
	});
});
