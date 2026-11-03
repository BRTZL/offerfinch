import path from "node:path";
import {
	MessageChannelMain,
	type UtilityProcess,
	utilityProcess,
} from "electron";

import {
	type MainToWorker,
	WORKER_STALL_EXIT,
	type WorkerInit,
	type WorkerMethod,
	type WorkerToMain,
} from "../shared/worker-protocol";

/** A message, and which worker process (its generation) sent it. */
type Listener = (message: WorkerToMain, generation: number) => void;

/**
 * The pipeline worker: a utility process (its own V8, off the main thread) running the database,
 * the job runner, scans, model calls and the oRPC API. The main process only relays: each
 * window gets a MessagePort straight to the worker, so API calls never pass through main.
 * If the worker dies it is started again (after the old one has exited), up to a few times.
 */
export class WorkerHost {
	private child: UtilityProcess | null = null;
	private nextId = 1;
	private readonly pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private readonly listeners = new Set<Listener>();
	private restarts = 0;
	/** Counts worker processes: each start is a new generation. */
	private generation = 0;
	private stopping = false;
	private readyWaiters: (() => void)[] = [];
	private isReady = false;
	/** Window ports asked for while no worker runs (between a crash and the restart). */
	private queuedPorts: Electron.MessagePortMain[] = [];

	constructor(
		private readonly entry: string,
		private readonly init: () => Promise<WorkerInit>,
		private readonly onRestart: () => void,
	) {}

	onOutput: ((text: string) => void) | null = null;
	/** A worker process exited: whatever it held (site tabs) must be let go. */
	onExit: ((generation: number) => void) | null = null;

	get pid(): number | undefined {
		return this.child?.pid;
	}

	on(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	start(): void {
		this.isReady = false;
		const generation = ++this.generation;
		const child = utilityProcess.fork(this.entry, [], {
			serviceName: "OfferFinch Worker",
			stdio: "pipe",
			cwd: path.dirname(this.entry),
		});
		this.child = child;
		for (const port of this.queuedPorts.splice(0))
			child.postMessage({ type: "connect" }, [port]);
		// The worker's own output (and a crash's stack) goes to the main log.
		const forward = (data: Buffer) => this.onOutput?.(data.toString());
		child.stdout?.on("data", forward);
		child.stderr?.on("data", forward);
		child.on("message", (message: WorkerToMain) => {
			if (message.type === "response") {
				const call = this.pending.get(message.id);
				this.pending.delete(message.id);
				if (message.ok) call?.resolve(message.value);
				else call?.reject(new Error(message.error));
				return;
			}
			if (message.type === "ready") {
				this.isReady = true;
				for (const w of this.readyWaiters.splice(0)) w();
			}
			for (const l of this.listeners) l(message, generation);
		});
		child.once("exit", (code) => {
			for (const call of this.pending.values())
				call.reject(new Error("The worker stopped"));
			this.pending.clear();
			if (this.child === child) this.child = null;
			this.onExit?.(generation);
			if (this.stopping) return;
			// Ended itself over a stalled step: planned, not a crash (the step limit bounds it).
			const stalled = code === WORKER_STALL_EXIT;
			process.stderr.write(
				`worker exited (${code}${stalled ? ": a step stalled" : ""}); restarting\n`,
			);
			if (stalled || this.restarts++ < 5) {
				// The old process has exited (this is its exit event), so its leases can be taken.
				setTimeout(
					() => {
						this.start();
						this.onRestart();
					},
					stalled ? 1_000 : 500 * this.restarts,
				);
			}
		});
		void this.init().then((message) => {
			if (this.child === child) this.post(message);
		});
	}

	post(message: MainToWorker, transfer?: Electron.MessagePortMain[]): void {
		this.child?.postMessage(message, transfer);
	}

	/**
	 * Posts only to the worker of that generation: an answer meant for a worker that has since
	 * died must never reach its replacement (whose call ids start again at 1).
	 */
	postTo(generation: number, message: MainToWorker): void {
		if (this.child && this.generation === generation)
			this.child.postMessage(message);
	}

	ready(): Promise<void> {
		if (this.isReady) return Promise.resolve();
		return new Promise((resolve) => this.readyWaiters.push(resolve));
	}

	request<T>(method: WorkerMethod, ...args: unknown[]): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			if (!this.child) {
				reject(new Error("The worker is not running"));
				return;
			}
			this.pending.set(id, {
				resolve: resolve as (v: unknown) => void,
				reject,
			});
			this.post({ type: "request", id, method, args });
		});
	}

	/** A port pair: one end to the worker's oRPC handler, the other returned for a window. */
	connectPort(): Electron.MessagePortMain {
		const { port1, port2 } = new MessageChannelMain();
		// No worker during a restart: hold the port for the next one, never drop it (a window
		// loaded in that gap would wait forever).
		if (this.child) this.child.postMessage({ type: "connect" }, [port1]);
		else this.queuedPorts.push(port1);
		return port2;
	}

	/**
	 * Starts the worker again after `stop()` (a restore swapped its database): later crashes
	 * restart it as before. Resolves once it is ready; rejects if it reports a failed start or
	 * is not ready in time, so the caller can put the earlier data back.
	 */
	restart(timeoutMs = 60_000): Promise<void> {
		this.stopping = false;
		this.restarts = 0;
		this.start();
		const generation = this.generation;
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error("The worker did not start in time"));
			}, timeoutMs);
			const off = this.on((message, from) => {
				if (from !== generation) return;
				if (message.type === "ready") {
					clearTimeout(timer);
					off();
					resolve();
				} else if (message.type === "fatal") {
					clearTimeout(timer);
					off();
					reject(new Error(message.error));
				}
			});
		});
	}

	/** Asks the worker to stop its runner and close the database, then waits for it to exit. */
	async stop(timeoutMs = 4_000): Promise<void> {
		this.stopping = true;
		const child = this.child;
		if (!child) return;
		const exited = new Promise<void>((resolve) =>
			child.once("exit", () => resolve()),
		);
		this.post({ type: "shutdown" });
		await Promise.race([
			exited,
			new Promise<void>((resolve) =>
				setTimeout(() => {
					child.kill();
					resolve();
				}, timeoutMs),
			),
		]);
	}
}
