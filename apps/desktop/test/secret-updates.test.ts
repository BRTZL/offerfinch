import { describe, expect, it } from "vitest";

import { secretUpdater } from "../src/main/secret-updates";

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
		await secretUpdater(slowStore(), () => (all) => sent.push(all)).set(
			"openai",
			"k1",
		);
		expect(sent).toEqual([{ openai: "k1" }]);
	});

	it("never leaves the worker on the replaced key", async () => {
		const sent: Record<string, string>[] = [];
		await secretUpdater(
			slowStore({ openai: "old" }),
			() => (all) => sent.push(all),
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
			secretUpdater(store, () => (all) => sent.push(all)).set("openai", "k"),
		).rejects.toThrow("no keychain");
		expect(sent).toEqual([]);
	});

	it("sends the worker the removal after it is saved", async () => {
		const sent: Record<string, string>[] = [];
		await secretUpdater(
			slowStore({ openai: "k" }),
			() => (all) => sent.push(all),
		).remove("openai");
		expect(sent).toEqual([{}]);
	});

	it("sends nothing to a worker started while the save ran", async () => {
		const sent: { generation: number; all: Record<string, string> }[] = [];
		let generation = 1;
		const updates = secretUpdater(slowStore(), () => {
			const at = generation;
			return (all) => {
				if (generation === at) sent.push({ generation: at, all });
			};
		});
		const saving = updates.set("openai", "real-key");
		// Try-it mode starts its worker while the key is being encrypted.
		generation = 2;
		await saving;
		expect(sent).toEqual([]);
		await updates.set("anthropic", "k2");
		expect(sent).toEqual([
			{ generation: 2, all: { openai: "real-key", anthropic: "k2" } },
		]);
	});
});
