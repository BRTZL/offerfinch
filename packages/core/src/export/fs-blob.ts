// Node-only local fallback for R2. The worker uses its R2 binding instead.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { BlobStore } from "./export";

export class FsBlobStore implements BlobStore {
	readonly name = "local-fs";
	private readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	private path(key: string): string {
		const path = resolve(join(this.root, key));
		if (!path.startsWith(this.root + sep))
			throw new Error(`Blob key escapes the store: ${key}`);
		return path;
	}

	async put(key: string, bytes: Uint8Array): Promise<void> {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, bytes);
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			return new Uint8Array(await readFile(this.path(key)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async deletePrefix(prefix: string): Promise<number> {
		if (!prefix.endsWith("/"))
			throw new Error("deletePrefix needs a directory prefix ending in /");
		const dir = this.path(prefix.slice(0, -1));
		let count = 0;
		try {
			count = (
				await readdir(dir, { recursive: true, withFileTypes: true })
			).filter((e) => e.isFile()).length;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
		await rm(dir, { recursive: true, force: true });
		return count;
	}
}
