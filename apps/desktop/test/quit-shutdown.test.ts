import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	closeAll: vi.fn(),
	stop: vi.fn(async () => {}),
}));
vi.mock("../src/main/state", () => ({
	mainState: {
		sites: { closeAll: mocks.closeAll },
		worker: { stop: mocks.stop },
	},
}));
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});

it("closes sites before stopping the worker, and reuses shutdown at later quit", async () => {
	let finish = () => {};
	mocks.stop.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const { shutdownForQuit } = await import("../src/main/quit-shutdown");
	const first = shutdownForQuit();
	expect(shutdownForQuit()).toBe(first);
	expect(mocks.closeAll.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.stop.mock.invocationCallOrder[0] ?? 0,
	);
	finish();
	await first;
	await shutdownForQuit();
	expect(mocks.closeAll).toHaveBeenCalledTimes(1);
	expect(mocks.stop).toHaveBeenCalledTimes(1);
});

it("allows quit to retry a failed shutdown", async () => {
	mocks.stop.mockRejectedValueOnce(new Error("still running"));
	const { shutdownForQuit } = await import("../src/main/quit-shutdown");
	await expect(shutdownForQuit()).rejects.toThrow("still running");
	await shutdownForQuit();
	expect(mocks.stop).toHaveBeenCalledTimes(2);
});
