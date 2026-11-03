import type { ApplicationWorkflowParams } from "../workflow/types";
import {
	type ApplicationOutcome,
	runApplicationFlow,
} from "./application-flow";
import {
	FlowPaused,
	type FlowStep,
	type InstanceStatus,
	type PipelineDeps,
	type StartBatchResult,
	type WorkflowStarter,
} from "./ports";

/** Runs steps inline with simple retries. Waits pause the flow instead of blocking for days. */
export class LocalStep implements FlowStep {
	readonly completed: string[] = [];

	async do<T>(
		name: string,
		fn: () => Promise<T>,
		options: { retries?: number } = {},
	): Promise<T> {
		const attempts = (options.retries ?? 0) + 1;
		let lastError: unknown;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				const value = await fn();
				this.completed.push(name);
				return value;
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError;
	}

	async waitForEvent<T>(name: string): Promise<{ payload: T }> {
		throw new FlowPaused(name);
	}
}

/**
 * Local stand-in for the ApplicationWorkflow binding: runs each application flow inline, in order.
 * Like Cloudflare, it never starts a second run for a job it has already started.
 */
export class LocalWorkflowStarter implements WorkflowStarter {
	readonly runtime = "local" as const;
	readonly outcomes = new Map<string, ApplicationOutcome>();
	private deps: PipelineDeps | null = null;

	bind(deps: PipelineDeps): void {
		this.deps = deps;
	}

	async startBatch(
		params: ApplicationWorkflowParams[],
	): Promise<StartBatchResult> {
		if (!this.deps)
			throw new Error("LocalWorkflowStarter is not bound to pipeline deps");
		const result: StartBatchResult = { created: [], existing: [], failed: [] };
		for (const p of params) {
			if (this.outcomes.has(p.jobId)) {
				result.existing.push(p.jobId);
				continue;
			}
			try {
				this.outcomes.set(
					p.jobId,
					await runApplicationFlow(new LocalStep(), this.deps, p),
				);
				result.created.push(p.jobId);
			} catch (error) {
				result.failed.push({
					jobId: p.jobId,
					error: error instanceof Error ? error.message : String(error),
				});
				this.errored.add(p.jobId);
			}
		}
		return result;
	}

	readonly errored = new Set<string>();

	/**
	 * Local runs have no durable instances. A job this process never ran was run by an earlier
	 * process that has ended (an earlier local run), so it counts as complete: the sweep
	 * (which only takes jobs started over an hour ago) may start it again. A run that returned a
	 * pause in `found` (the cap or a subscription stopped scoring) has ended too; only a run
	 * waiting for an event is still waiting.
	 */
	async status(jobId: string): Promise<InstanceStatus> {
		if (this.errored.has(jobId)) return "errored";
		const outcome = this.outcomes.get(jobId);
		if (!outcome) return "complete";
		return outcome.outcome === "paused" && outcome.state !== "found"
			? "waiting"
			: "complete";
	}

	/** Runs the flow again inline. */
	async restart(params: ApplicationWorkflowParams): Promise<void> {
		if (!this.deps)
			throw new Error("LocalWorkflowStarter is not bound to pipeline deps");
		this.errored.delete(params.jobId);
		try {
			this.outcomes.set(
				params.jobId,
				await runApplicationFlow(new LocalStep(), this.deps, params),
			);
		} catch (error) {
			this.errored.add(params.jobId);
			throw error;
		}
	}
}
