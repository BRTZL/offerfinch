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
	/** Calls waiting for an answer, with the generation of the worker they went to. */
	private readonly pending = new Map<
		number,
		{
			resolve: (v: unknown) => void;
			reject: (e: Error) => void;
			generation: number;
		}
	>();
	private readonly listeners = new Set<Listener>();
	private restarts = 0;
	/** Counts worker processes: each start is a new generation. */
	private generation = 0;
	private stopping = false;
	/** A crash's restart, waiting its delay: cancelled by stop() and restart(). */
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	/** Settles when the current child's process has exited (its "exit" event). */
	private childExit: Promise<void> = Promise.resolve();
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

	/** The running worker's generation: `postTo` it to reach that worker and no later one. */
	get currentGeneration(): number {
		return this.generation;
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
		this.childExit = new Promise<void>((resolve) =>
			child.once("exit", (code) => {
				this.exited(child, generation, code);
				resolve();
			}),
		);
		void this.init().then((message) => {
			if (this.child === child) this.post(message);
		});
	}

	/**
	 * A worker process exited: its calls fail and what it held is let go. Only the current
	 * worker's unplanned exit restarts it: a stale one (a generation already replaced) or a
	 * stopped one never starts anything.
	 */
	private exited(child: UtilityProcess, generation: number, code: number) {
		for (const [id, call] of this.pending) {
			if (call.generation !== generation) continue;
			this.pending.delete(id);
			call.reject(new Error("The worker stopped"));
		}
		if (this.child === child) this.child = null;
		this.onExit?.(generation);
		if (this.stopping || generation !== this.generation) return;
		// Ended itself over a stalled step: planned, not a crash (the step limit bounds it).
		const stalled = code === WORKER_STALL_EXIT;
		process.stderr.write(
			`worker exited (${code}${stalled ? ": a step stalled" : ""}); restarting\n`,
		);
		if (!stalled && this.restarts++ >= 5) return;
		// The old process has exited (this is its exit event), so its leases can be taken.
		this.restartTimer = setTimeout(
			() => {
				this.restartTimer = null;
				if (this.stopping || generation !== this.generation) return;
				this.start();
				this.onRestart();
			},
			stalled ? 1_000 : 500 * this.restarts,
		);
	}

	private cancelRestart() {
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = null;
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
				generation: this.generation,
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
		this.cancelRestart();
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

	/**
	 * Asks the worker to stop its runner and close the database, then waits for its process to
	 * exit: after `timeoutMs` it is killed (SIGTERM), after `killMs` more killed hard (SIGKILL).
	 * Resolves only once the process has exited, so its database and files are let go; rejects
	 * if it is still there after all that. No crash restart runs after it.
	 */
	async stop(timeoutMs = 4_000, killMs = 2_000): Promise<void> {
		this.stopping = true;
		this.cancelRestart();
		const child = this.child;
		if (!child) return;
		const exited = this.childExit;
		this.post({ type: "shutdown" });
		if (await settlesWithin(exited, timeoutMs)) return;
		child.kill();
		if (await settlesWithin(exited, killMs)) return;
		try {
			if (child.pid) process.kill(child.pid, "SIGKILL");
		} catch {
			// Already gone (ESRCH): its exit event is on the way.
		}
		if (await settlesWithin(exited, killMs)) return;
		throw new Error("The worker did not stop");
	}
}

/** Whether the promise settles within `ms`. */
async function settlesWithin(promise: Promise<void>, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([promise.then(() => true as const), timeout]);
	} finally {
		clearTimeout(timer);
	}
}
