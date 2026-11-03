import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

import {
	RETIRED_SECRETS,
	SECRET_NAMES,
	type SecretName,
} from "../shared/bridge";

const NAMES: readonly SecretName[] = SECRET_NAMES;

/**
 * API keys, encrypted with safeStorage (a key kept in the macOS Keychain) in a file under
 * userData. Plain text is never written; values never reach a log or the renderer. A file that
 * no longer decrypts (a rebuilt, differently signed app gets a new Keychain item) is reported as
 * missing, so the user enters the key again instead of the app failing. The Keychain is not
 * touched until a key is stored (no prompt on a first start).
 */
export class SecretStore {
	private readonly file: string;
	private cache: Partial<Record<SecretName, string>> | null = null;

	constructor(userData: string) {
		this.file = path.join(userData, "secrets.json");
	}

	available(): Promise<boolean> {
		return safeStorage.isAsyncEncryptionAvailable();
	}

	private read(): Partial<Record<SecretName, string>> {
		try {
			return JSON.parse(fs.readFileSync(this.file, "utf8"));
		} catch {
			return {};
		}
	}

	private write(data: Partial<Record<SecretName, string>>) {
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
		fs.renameSync(tmp, this.file);
	}

	async set(name: SecretName, value: string): Promise<void> {
		if (!NAMES.includes(name)) throw new Error("Unknown key");
		const trimmed = value.trim();
		if (!trimmed || trimmed.length > 500 || /\s/.test(trimmed))
			throw new Error("That does not look like an API key");
		if (!(await this.available()))
			throw new Error(
				"macOS Keychain encryption is not available, so the key was not stored",
			);
		const data = this.read();
		data[name] = (await safeStorage.encryptStringAsync(trimmed)).toString(
			"base64",
		);
		this.write(data);
		this.cache = null;
	}

	/**
	 * Drops keys of features that are gone (the Brave Search key): the encrypted value is deleted
	 * from the file without being decrypted, so the Keychain is not touched.
	 */
	forgetRetired(): string[] {
		const data = this.read() as Record<string, string>;
		const gone = RETIRED_SECRETS.filter((name) => name in data);
		if (gone.length === 0) return [];
		for (const name of gone) delete data[name];
		this.write(data as Partial<Record<SecretName, string>>);
		this.cache = null;
		return gone;
	}

	remove(name: SecretName): void {
		const data = this.read();
		delete data[name];
		this.write(data);
		this.cache = null;
	}

	/** Decrypted keys, for the worker's memory only. Undecryptable entries are left out. */
	async all(): Promise<Partial<Record<SecretName, string>>> {
		if (this.cache) return { ...this.cache };
		const stored = this.read();
		const out: Partial<Record<SecretName, string>> = {};
		if (Object.keys(stored).length === 0) return out;
		if (!(await this.available())) return out;
		for (const [name, blob] of Object.entries(stored)) {
			if (!NAMES.includes(name as SecretName) || !blob) continue;
			try {
				const { result } = await safeStorage.decryptStringAsync(
					Buffer.from(blob, "base64"),
				);
				// A wrong key passes the padding check about once in 256 and yields garbage: only
				// a printable, key-shaped value counts as readable.
				if (/^[\x21-\x7e]{1,500}$/.test(result))
					out[name as SecretName] = result;
			} catch {
				// Encrypted by another build's Keychain item: treated as not set.
			}
		}
		this.cache = out;
		return { ...out };
	}

	/** Keys in the file that do not decrypt here (another app's or build's Keychain item). */
	async unreadable(): Promise<SecretName[]> {
		const stored = this.read();
		const readable = await this.all();
		return NAMES.filter((name) => Boolean(stored[name]) && !readable[name]);
	}

	async status(): Promise<Record<SecretName, boolean>> {
		const keys = await this.all();
		return {
			anthropic: Boolean(keys.anthropic),
			openai: Boolean(keys.openai),
		};
	}
}
