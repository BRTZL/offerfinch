import { afterEach, expect, it, vi } from "vitest";
import {
	fallbackDirs,
	mergePath,
	subscriptions,
} from "../src/worker/subscriptions";

afterEach(() => vi.restoreAllMocks());

it("uses Windows install folders and deduplicates PATH without case sensitivity", () => {
	const env = {
		UserProfile: "C:\\Users\\Sample",
		AppData: "C:\\Roaming",
		LocalAppData: "C:\\Local",
		Path: "C:\\BIN;C:\\other",
	};
	expect(fallbackDirs("win32", env)).toEqual([
		"C:\\Users\\Sample\\.local\\bin",
		"C:\\Users\\Sample\\.claude\\local",
		"C:\\Users\\Sample\\.bun\\bin",
		"C:\\Users\\Sample\\scoop\\shims",
		"C:\\Roaming\\npm",
		"C:\\Local\\pnpm",
		"C:\\Local\\Volta\\bin",
	]);
	const dirs = mergePath("C:\\bin", "win32", env).split(";");
	expect(dirs.filter((dir) => dir.toLowerCase() === "c:\\bin")).toHaveLength(1);
	expect(dirs).not.toContain("/opt/homebrew/bin");
});

it("reports the macOS boundary and pauses Codex without install advice on Windows", async () => {
	vi.spyOn(process, "platform", "get").mockReturnValue("win32");
	const cli = subscriptions({ hostScript: "unused" });
	const state = await cli.codex();
	expect(state.login.detail).toContain("macOS only");
	expect(state.command).toBeNull();
	expect(state.fix).toBeNull();
	const provider = cli.factory({
		role: "scoring",
		provider: "codex",
		model: "default",
		ownerUserId: "synthetic",
	});
	await expect(provider.generateObject({} as never)).rejects.toMatchObject({
		kind: "boundary",
	});
});
