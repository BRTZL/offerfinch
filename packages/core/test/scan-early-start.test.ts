import { describe, expect, it } from "vitest";
import type { FlowStep, PipelineDeps } from "../src/pipeline/ports";
import type { ScanProvider } from "../src/pipeline/providers";
import { runScanFlow } from "../src/pipeline/scan-flow";

const step: FlowStep = {
	do: (_name, fn) => fn(new AbortController().signal),
	waitForEvent: async () => {
		throw new Error("no waits");
	},
};

/** A repository where saved jobs wait unstarted until a start marks them. */
function fakeScan(startDuringScanMs?: number) {
	const unstarted: string[] = [];
	const startedAt: Record<string, string> = {};
	let current = "";
	const provider = (id: string, saves: string[]): ScanProvider => ({
		id,
		label: id,
		run: async () => {
			current = id;
			for (const jobId of saves) unstarted.push(jobId);
			// A slow source: long enough for a pass of the early start to run.
			await new Promise((resolve) => setTimeout(resolve, 60));
			return {
				provider: id,
				queries: 1,
				found: saves.length,
				fetched: saves.length,
				newJobIds: saves,
			};
		},
	});
	const deps = {
		providers: async () => [provider("a", ["j1", "j2"]), provider("b", ["j3"])],
		repo: {
			listUnstartedJobIds: async () => [...unstarted],
			markWorkflowsStarted: async (_u: string, ids: string[]) => {
				for (const id of ids) {
					const i = unstarted.indexOf(id);
					if (i >= 0) unstarted.splice(i, 1);
				}
			},
		},
		workflows: {
			runtime: "local",
			startBatch: async (params: { jobId: string }[]) => {
				for (const p of params) startedAt[p.jobId] ??= current;
				return {
					created: params.map((p) => p.jobId),
					existing: [],
					failed: [],
				};
			},
		},
		log: () => {},
		startDuringScanMs,
	} as unknown as PipelineDeps;
	return { deps, startedAt };
}

describe("scoring starts while the scan goes on", () => {
	it("starts a source's jobs while later sources still search", async () => {
		const { deps, startedAt } = fakeScan(5);
		// The sweep after the sources needs a fuller repository; the starts before it count here.
		await runScanFlow(step, deps, { userId: "u1", trigger: "manual" }).catch(
			() => undefined,
		);
		// a's jobs started while a was still running, before b searched.
		expect(startedAt).toEqual({ j1: "a", j2: "a", j3: "b" });
	});

	it("without the setting, starts every job once, after the last source", async () => {
		const { deps, startedAt } = fakeScan(undefined);
		await runScanFlow(step, deps, { userId: "u1", trigger: "manual" }).catch(
			() => undefined,
		);
		// Every start came after b, the last source, had run.
		expect(startedAt).toEqual({ j1: "b", j2: "b", j3: "b" });
	});
});
