/** The part of the secret store a save needs; values may be written asynchronously. */
export interface SecretWrites<Name extends string> {
	set(name: Name, value: string): Promise<void> | void;
	remove(name: Name): Promise<void> | void;
	all(): Promise<Record<string, string>> | Record<string, string>;
}

/**
 * Saves a secret, then sends the worker what was saved. The worker must not read the store
 * before the write finishes, or it keeps using a missing or old key until it restarts.
 */
export function secretUpdater<Name extends string>(
	store: SecretWrites<Name>,
	send: (all: Record<string, string>) => void,
) {
	const push = async () => send(await store.all());
	return {
		async set(name: Name, value: string) {
			await store.set(name, value);
			await push();
		},
		async remove(name: Name) {
			await store.remove(name);
			await push();
		},
	};
}
