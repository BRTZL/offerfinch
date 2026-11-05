/** The part of the secret store a save needs; values may be written asynchronously. */
export interface SecretWrites<Name extends string> {
	set(name: Name, value: string): Promise<void> | void;
	remove(name: Name): Promise<void> | void;
	all(): Promise<Record<string, string>> | Record<string, string>;
}

/**
 * Saves a secret, then sends the worker what was saved. The worker must not read the store
 * before the write finishes, or it keeps using a missing or old key until it restarts.
 *
 * `target` is asked when the save begins and returns where its keys go: the worker running
 * then, and only that one (main/ipc.ts binds it to the worker's generation). A worker started
 * while the save ran (try-it mode's, or a restart's, which reads the store itself) never gets
 * keys meant for the one before it.
 */
export function secretUpdater<Name extends string>(
	store: SecretWrites<Name>,
	target: () => (all: Record<string, string>) => void,
) {
	return {
		async set(name: Name, value: string) {
			const send = target();
			await store.set(name, value);
			send(await store.all());
		},
		async remove(name: Name) {
			const send = target();
			await store.remove(name);
			send(await store.all());
		},
	};
}
