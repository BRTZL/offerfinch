import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { MainToWorker, WorkerInit } from "../src/shared/worker-protocol";

/** A worker process stand-in: exits and reports ready when the test says so. */
class FakeChild extends EventEmitter {
	static all: FakeChild[] = [];
	readonly pid = 910_000 + FakeChild.all.length;
	readonly posted: MainToWorker[] = [];
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
		return true;
	}
	exit(code: number) {
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

const { keysToWorker, secretUpdater } = await import(
	"../src/main/secret-updates"
);
const { WorkerHost } = await import("../src/main/worker-host");

const slowStore = (initial: Record<string, string> = {}) => {
	const data = { ...initial };
	return {
		async set(name: string, value: string) {
			await new Promise((r) => setTimeout(r, 5));
			data[name] = value;
		},
		async remove(name: string) {
			await new Promise((r) => setTimeout(r, 5));
			delete data[name];
		},
		async all() {
			return { ...data };
		},
	};
};

describe("secretUpdater", () => {
	it("sends the worker a first key only after it is saved", async () => {
		const sent: Record<string, string>[] = [];
		await secretUpdater(slowStore(), (all) => sent.push(all)).set(
			"openai",
			"k1",
		);
		expect(sent).toEqual([{ openai: "k1" }]);
	});

	it("never leaves the worker on the replaced key", async () => {
		const sent: Record<string, string>[] = [];
		await secretUpdater(slowStore({ openai: "old" }), (all) =>
			sent.push(all),
		).set("openai", "new");
		expect(sent.at(-1)).toEqual({ openai: "new" });
	});

	it("reports a failed save and sends nothing", async () => {
		const sent: Record<string, string>[] = [];
		const store = {
			...slowStore(),
			set: async () => {
				throw new Error("no keychain");
			},
		};
		await expect(
			secretUpdater(store, (all) => sent.push(all)).set("openai", "k"),
		).rejects.toThrow("no keychain");
		expect(sent).toEqual([]);
	});

	it("sends the worker the removal after it is saved", async () => {
		const sent: Record<string, string>[] = [];
		await secretUpdater(slowStore({ openai: "k" }), (all) =>
			sent.push(all),
		).remove("openai");
		expect(sent).toEqual([{}]);
	});
});

describe("where a key save's keys go", () => {
	/** A keychain write that ends when the test says so (encryption can take a while). */
	const heldStore = (stored: Record<string, string>) => {
		let finish = () => {};
		return {
			finish: () => finish(),
			store: {
				set: (name: string, value: string) =>
					new Promise<void>((resolve) => {
						finish = () => {
							stored[name] = value;
							resolve();
						};
					}),
				remove: async () => {},
				all: () => ({ ...stored }),
			},
		};
	};
	const secretsPosted = (child: FakeChild | undefined) =>
		(child?.posted ?? []).filter((m) => m.type === "secrets");

	it("reaches the worker that replaced one that crashed while the key was encrypted", async () => {
		FakeChild.all = [];
		const stored: Record<string, string> = { openai: "old" };
		// The worker reads the store for its init, as main's workerInit does.
		const host = new WorkerHost(
			"/no/worker.mjs",
			async () => ({ type: "init", secrets: { ...stored } }) as WorkerInit,
			() => {},
		);
		host.start();
		FakeChild.all[0]?.ready();
		const { store, finish } = heldStore(stored);
		const updates = secretUpdater(
			store,
			(all) => void keysToWorker(host, () => false, all),
		);
		const saving = updates.set("openai", "new");
		// The worker crashes; its replacement starts and reads the old key.
		FakeChild.all[0]?.exit(1);
		await vi.waitFor(() => expect(FakeChild.all).toHaveLength(2), {
			timeout: 2_000,
		});
		const replacement = FakeChild.all[1] as FakeChild;
		await vi.waitFor(() =>
			expect(replacement.posted.map((m) => m.type)).toContain("init"),
		);
		expect(
			(replacement.posted.find((m) => m.type === "init") as WorkerInit).secrets,
		).toEqual({ openai: "old" });
		replacement.ready();
		finish();
		await saving;
		await vi.waitFor(() =>
			expect(secretsPosted(replacement)).toEqual([
				{ type: "secrets", secrets: { openai: "new" } },
			]),
		);
		await host.stop(10, 10).catch(() => {});
	});

	it("waits for a replacement still starting, so its init cannot land after the new key", async () => {
		const posted: MainToWorker[] = [];
		let ready = () => {};
		const starting = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const sending = keysToWorker(
			{ ready: () => starting, post: (m) => posted.push(m) },
			() => false,
			{ openai: "new" },
		);
		await new Promise((r) => setTimeout(r, 5));
		expect(posted).toEqual([]);
		ready();
		await sending;
		expect(posted).toEqual([{ type: "secrets", secrets: { openai: "new" } }]);
	});

	it("never reaches a demo worker", async () => {
		const posted: MainToWorker[] = [];
		await keysToWorker(
			{ ready: async () => {}, post: (m) => posted.push(m) },
			() => true,
			{ openai: "real-key" },
		);
		expect(posted).toEqual([]);
	});
});
