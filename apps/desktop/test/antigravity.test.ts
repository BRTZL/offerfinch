import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ opened: [] as string[] }));

vi.mock("electron", () => ({
	app: { isPackaged: false, getPath: () => os.tmpdir(), getVersion: () => "1" },
	BrowserWindow: { getAllWindows: () => [] },
	protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
	shell: {
		openExternal: async (url: string) => {
			h.opened.push(url);
		},
	},
}));

const { isGoogleSignInPage, openSignInPage } = await import(
	"../src/main/external-links"
);
const { antigravityModels, antigravityService, antigravityState } =
	await import("../src/worker/antigravity");
const { fakeSubscriptions } = await import("../src/worker/fake-clis");
const { withProviders } = await import("../src/worker/subscriptions");

const probe = {
	login: "logged_in" as const,
	detail: "Signed in with Google (Google AI Pro).",
	version: "1.4.1",
	families: [
		{
			id: "gemini-3.8-flash",
			name: "Gemini 3.8 Flash",
			levels: ["low", "medium", "high"] as ("low" | "medium" | "high")[],
		},
		{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B", levels: [] },
	],
};

describe("Gemini (Antigravity) state and models", () => {
	it("says what to do next: install, then sign in, then ready", () => {
		const missing = antigravityState({
			platform: "darwin",
			installed: null,
			signedIn: false,
			probe: null,
		});
		expect(missing.login.state).toBe("logged_out");
		expect(missing.fix).toMatchObject({ kind: "install", inApp: "install" });
		expect(missing.command).toBeNull();
		const out = antigravityState({
			platform: "darwin",
			installed: "/x/agy_acp_server.par",
			signedIn: false,
			probe: null,
		});
		expect(out.fix).toMatchObject({ kind: "login", inApp: "signIn" });
		expect(out.version).toBe("1.4.1");
		const ready = antigravityState({
			platform: "darwin",
			installed: "/x/agy_acp_server.par",
			signedIn: true,
			probe,
		});
		expect(ready.login).toEqual({
			state: "logged_in",
			detail: "Signed in with Google (Google AI Pro).",
		});
		expect(ready.fix).toBeNull();
		const expired = antigravityState({
			platform: "darwin",
			installed: "/x/agy_acp_server.par",
			signedIn: true,
			probe: { ...probe, login: "logged_out", detail: "expired" },
		});
		expect(expired.fix?.inApp).toBe("signIn");
	});

	it("is off on Windows with the providers' reason, and never starts anything there", async () => {
		const state = antigravityState({
			platform: "win32",
			installed: null,
			signedIn: false,
			probe: null,
		});
		expect(state.login).toEqual({
			state: "unknown",
			detail: "Gemini (Antigravity) is not available on Windows yet.",
		});
		expect(state.fix).toBeNull();
		const service = antigravityService({
			userData: path.join(os.tmpdir(), "offerfinch-never-created"),
			openSignIn: () => {},
			platform: "win32",
			sweep: false,
		});
		expect(await service.models()).toEqual([]);
		await expect(service.install()).rejects.toThrow(/not available on Windows/);
		await expect(service.signIn()).rejects.toThrow(/not available on Windows/);
		const call: unknown = await service
			.factory({
				role: "scoring",
				provider: "antigravity",
				model: "gemini-3.8-flash",
				ownerUserId: "u",
			})
			.generateObject({
				system: "s",
				prompt: "p",
				schema: {} as never,
				task: "t",
			})
			.catch((e: unknown) => e);
		expect(call).toMatchObject({ kind: "boundary" });
	});

	it("offers the server's families with their levels as efforts, only when signed in", () => {
		expect(antigravityModels(probe)).toEqual([
			{
				ref: "antigravity:gemini-3.8-flash",
				name: "Gemini 3.8 Flash",
				provider: "antigravity",
				billing: "subscription",
				efforts: ["low", "medium", "high"],
			},
			{
				ref: "antigravity:gpt-oss-120b-medium",
				name: "GPT-OSS 120B",
				provider: "antigravity",
				billing: "subscription",
				efforts: [],
			},
		]);
		expect(antigravityModels({ ...probe, login: "logged_out" })).toEqual([]);
		expect(antigravityModels(null)).toEqual([]);
	});

	it("reads not installed and not signed in from an empty data folder, without starting a server", async () => {
		const userData = fs.mkdtempSync(
			path.join(os.tmpdir(), "offerfinch-test-agy-"),
		);
		try {
			const service = antigravityService({
				userData,
				openSignIn: () => {},
				platform: "darwin",
				sweep: false,
			});
			const state = await service.state();
			expect(state.path).toBeNull();
			expect(state.fix?.inApp).toBe("install");
			expect(await service.models()).toEqual([]);
			await expect(service.signIn()).rejects.toThrow(/Install Gemini/);
		} finally {
			fs.rmSync(userData, { recursive: true, force: true });
		}
	});
});

describe("the test stand-in", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-fake-agy-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("installs, signs in and answers without a download or a browser", async () => {
		const real = withProviders({
			refresh: async () => "",
			usePath: () => {},
			factory: () => {
				throw new Error("no real factory in tests");
			},
			claude: async () => {
				throw new Error("unused");
			},
			codex: async () => {
				throw new Error("unused");
			},
		});
		const subs = fakeSubscriptions(dir, real);
		expect((await subs.state("antigravity")).fix?.inApp).toBe("install");
		await expect(subs.signIn("antigravity")).rejects.toThrow(/Install/);
		expect((await subs.install("antigravity")).fix?.inApp).toBe("signIn");
		expect(await subs.models("antigravity")).toEqual([]);
		const signedIn = await subs.signIn("antigravity");
		expect(signedIn.login.state).toBe("logged_in");
		const models = await subs.models("antigravity");
		expect(models.map((m) => m.ref)).toEqual([
			"antigravity:gemini-3.8-flash",
			"antigravity:gemini-4-argon",
		]);
		const llm = subs.factory({
			role: "scoring",
			provider: "antigravity",
			model: "gemini-3.8-flash",
			ownerUserId: "u",
		});
		expect(llm.vendor).toBe("google");
		expect(llm.billing).toBe("subscription");
		expect(llm.name).toBe("antigravity:gemini-3.8-flash");
		await expect(subs.install("opencode")).rejects.toThrow(/not installed/);
	});
});

describe("main opens only Google's sign-in page", () => {
	const back = "redirect_uri=http%3A%2F%2F127.0.0.1%3A4242%2F";
	it("checks the address", () => {
		expect(
			isGoogleSignInPage(
				`https://accounts.google.com/o/oauth2/v2/auth?${back}`,
			),
		).toBe(true);
		expect(isGoogleSignInPage(`https://evil.test/?${back}`)).toBe(false);
		expect(
			isGoogleSignInPage(
				"https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fevil.test%2F",
			),
		).toBe(false);
		expect(isGoogleSignInPage("javascript:alert(1)")).toBe(false);
	});

	it("hands a good page to the browser and drops anything else", async () => {
		h.opened = [];
		await openSignInPage(
			`https://accounts.google.com/o/oauth2/v2/auth?${back}`,
		);
		await openSignInPage(`https://evil.test/?${back}`);
		expect(h.opened).toEqual([
			`https://accounts.google.com/o/oauth2/v2/auth?${back}`,
		]);
	});
});
