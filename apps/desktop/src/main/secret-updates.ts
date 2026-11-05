import type { MainToWorker } from "../shared/worker-protocol";

/** The part of the secret store a save needs; values may be written asynchronously. */
export interface SecretWrites<Name extends string> {
	set(name: Name, value: string): Promise<void> | void;
	remove(name: Name): Promise<void> | void;
	all(): Promise<Record<string, string>> | Record<string, string>;
}

/**
 * Saves a secret, then hands `deliver` everything saved. The worker must not read the store
 * before the write finishes, or it keeps using a missing or old key until it restarts.
 *
 * Where the keys go is decided only once the write is done (`keysToWorker`): a worker that
 * crashed while the key was being encrypted, and was replaced by one that read the old keys,
 * still gets the new ones.
 */
export function secretUpdater<Name extends string>(
	store: SecretWrites<Name>,
	deliver: (all: Record<string, string>) => void,
) {
	return {
		async set(name: Name, value: string) {
			await store.set(name, value);
			deliver(await store.all());
		},
		async remove(name: Name) {
			await store.remove(name);
			deliver(await store.all());
		},
	};
}

/** The parts of WorkerHost a key save reaches. */
export interface KeyWorker {
	/** Resolves once the running worker has started (its init, with the keys it read, is in). */
	ready(): Promise<void>;
	post(message: MainToWorker): void;
}

/**
 * Sends saved keys to the worker running when they arrive, whichever process that is (a crash's
 * replacement too), once it is ready: a replacement still starting may have read the old keys
 * for its init, which must not land after these. Never to a demo worker: `demo` is asked when
 * the keys are sent (try-it mode's worker ignores them as well).
 */
export async function keysToWorker(
	worker: KeyWorker,
	demo: () => boolean,
	secrets: Record<string, string>,
): Promise<void> {
	await worker.ready();
	if (demo()) return;
	worker.post({ type: "secrets", secrets });
}
