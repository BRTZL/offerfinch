import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MainToWorker, WorkerInit } from "../src/shared/worker-protocol";

/** A worker process stand-in: it exits only when the test (or its `onKill`) says so. */
class FakeChild extends EventEmitter {
	static all: FakeChild[] = [];
	readonly pid = 900_000 + FakeChild.all.length;
	readonly posted: MainToWorker[] = [];
	kills = 0;
	exitedWith: number | null = null;
	/** What a SIGTERM does: by default nothing (a worker stuck in a step). */
	onKill: () => void = () => {};
	stdout = null;
	stderr = null;
	constructor() {
		super();
		FakeChild.all.push(this);
	}
	postMessage(message: MainToWorker) {
		this.posted.push(message);
	}
	kill() {
		this.kills++;
		this.onKill();
		return true;
	}
	exit(code: number) {
		if (this.exitedWith !== null) return;
		this.exitedWith = code;
		this.emit("exit", code);
	}
	ready() {
		this.emit("message", { type: "ready" });
	}
}

vi.mock("electron", () => ({
	utilityProcess: { fork: () => new FakeChild() },
	MessageChannelMain: class {},
}));

const { WorkerHost } = await import("../src/main/worker-host");

const init = async () => ({ type: "init" }) as WorkerInit;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function host() {
	FakeChild.all = [];
	const restarted: number[] = [];
	const h = new WorkerHost("/no/worker.mjs", init, () =>
		restarted.push(FakeChild.all.length),
	);
	return { h, restarted, child: (i: number) => FakeChild.all[i] as FakeChild };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("WorkerHost.stop", () => {
	it("resolves only once the process has exited, after the kill", async () => {
		const { h, child } = host();
		h.start();
		const first = child(0);
		const order: string[] = [];
		// SIGTERM: the process ends a moment later, as a real one does.
		first.onKill = () => {
			order.push("killed");
			setTimeout(() => {
				order.push("exited");
				first.exit(0);
			}, 30);
		};
		await h.stop(10, 1_000);
		order.push("stop resolved");
		expect(first.posted.some((m) => m.type === "shutdown")).toBe(true);
		expect(order).toEqual(["killed", "exited", "stop resolved"]);
	});

	it("kills hard when the kill is ignored, and rejects if the process is still there", async () => {
		const { h, child } = host();
		h.start();
		const stuck = child(0);
		const signals: string[] = [];
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			expect(pid).toBe(stuck.pid);
			signals.push(String(signal));
			return true;
		});
		await expect(h.stop(5, 5)).rejects.toThrow("The worker did not stop");
		expect(stuck.kills).toBe(1);
		expect(signals).toEqual(["SIGKILL"]);

		// SIGKILL that works: stop resolves once the exit event came.
		h.start();
		const second = child(1);
		vi.spyOn(process, "kill").mockImplementation(() => {
			setTimeout(() => second.exit(-9), 1);
			return true;
		});
		await expect(h.stop(5, 200)).resolves.toBeUndefined();
		expect(second.exitedWith).toBe(-9);
	});

	it("cancels a crash's pending restart", async () => {
		vi.useFakeTimers();
		const { h, child, restarted } = host();
		h.start();
		child(0).exit(1);
		// The restart waits 500 ms; the switch stops the worker first.
		await h.stop();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(FakeChild.all).toHaveLength(1);
		expect(restarted).toEqual([]);
	});

	it("never restarts or fails calls for a stale worker's late exit", async () => {
		const { h, child, restarted } = host();
		h.start();
		const old = child(0);
		vi.spyOn(process, "kill").mockImplementation(() => true);
		await expect(h.stop(1, 1)).rejects.toThrow();
		// A retry starts the next worker while the old process is still there.
		const started = h.restart(1_000);
		const next = child(1);
		await flush();
		next.ready();
		await started;
		const call = h.request("status");
		old.exit(1);
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(FakeChild.all).toHaveLength(2);
		expect(restarted).toEqual([]);
		// The new worker's call is still waiting for its answer.
		const id = (next.posted.find((m) => m.type === "request") as { id: number })
			.id;
		next.emit("message", { type: "response", id, ok: true, value: "fine" });
		await expect(call).resolves.toBe("fine");
	});

	it("posts to one generation only", async () => {
		const { h, child } = host();
		h.start();
		const generation = h.currentGeneration;
		const first = child(0);
		first.onKill = () => first.exit(0);
		await h.stop(1, 100);
		const started = h.restart(1_000);
		child(1).ready();
		await started;
		h.postTo(generation, { type: "secrets", secrets: { openai: "real" } });
		expect(child(1).posted.some((m) => m.type === "secrets")).toBe(false);
		h.postTo(h.currentGeneration, { type: "secrets", secrets: {} });
		expect(child(1).posted.some((m) => m.type === "secrets")).toBe(true);
	});
});
