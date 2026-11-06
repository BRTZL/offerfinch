import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Google's Antigravity ACP server, pinned. OfferFinch downloads exactly this release and runs it
 * only when the archive's size and sha256 match (docs/research/antigravity-1.4.1-pin.md). Every
 * bump re-runs the lockdown proof: the switches the provider relies on are undocumented.
 */
export const ANTIGRAVITY_VERSION = "1.4.1";

const BASE = "https://dl.google.com/agy-extensions/releases/";

export interface AntigravityAsset {
	/** `${process.platform}-${process.arch}`. */
	key: string;
	url: string;
	sha256: string;
	archiveBytes: number;
	executable: { name: string; bytes: number };
	harness: { name: string; bytes: number };
}

const POSIX = {
	executable: "agy_acp_server.par",
	harness: "localharness_external",
};
const WINDOWS = {
	executable: "agy_acp_server.exe",
	harness: "localharness_external.exe",
};

// biome-ignore lint/complexity/useMaxParams: One row of the pinned table, read as a table.
function asset(
	key: string,
	path: string,
	sha256: string,
	archiveBytes: number,
	executableBytes: number,
	harnessBytes: number,
): AntigravityAsset {
	const names = key.startsWith("win32") ? WINDOWS : POSIX;
	return {
		key,
		url: `${BASE}${path}`,
		sha256,
		archiveBytes,
		executable: { name: names.executable, bytes: executableBytes },
		harness: { name: names.harness, bytes: harnessBytes },
	};
}

/** The 1.4.1 release for every platform Google publishes (T3 Code's table, checked). */
export const ANTIGRAVITY_RELEASE: readonly AntigravityAsset[] = [
	asset(
		"darwin-arm64",
		"macos/agy-acp-server-1.4.1-darwin-arm64.zip",
		"f9bdd68291ae78c38d2141e63bc86b84e6cc7b9f60f71652c68435a7943deb17",
		112737434,
		280996576,
		120246928,
	),
	asset(
		"darwin-x64",
		"macos/agy-acp-server-1.4.1-darwin-x86_64.zip",
		"27e31f096874704f14167b07ef9e84cc77134615ee41d024f7b1c957add85307",
		118349036,
		285186624,
		124910048,
	),
	asset(
		"linux-x64",
		"linux/agy-acp-server-1.4.1-linux-x86_64.zip",
		"2e37012ceb2a5c7fc7309b6e6596234fb637ee3c62a5199f65d4cbe777871384",
		336170339,
		930826753,
		131187512,
	),
	asset(
		"linux-arm64",
		"linux/agy-acp-server-1.4.1-linux-arm64.zip",
		"609336a1c97545487e3ddd55dbd153dc0f40f4e6534486cc1c5f4c0ebb85c2da",
		321922507,
		933416796,
		124895000,
	),
	asset(
		"win32-x64",
		"windows/agy-acp-server-1.4.1-windows-x86_64.zip",
		"5f5b7d0328df17c128b2be338d4567b0d24e56ace8196e88794fec37d1372554",
		129599308,
		86098784,
		146036888,
	),
	asset(
		"win32-arm64",
		"windows/agy-acp-server-1.4.1-windows-arm64.zip",
		"24c52bbc12aae20f55eb53d373669412d95a9c44fd59be4ea4e355918b91fbf7",
		132507344,
		93197744,
		136970904,
	),
];

/** The pinned release for this platform, or null when Google publishes none. */
export function antigravityAsset(
	platform: string = process.platform,
	arch: string = process.arch,
): AntigravityAsset | null {
	return (
		ANTIGRAVITY_RELEASE.find((a) => a.key === `${platform}-${arch}`) ?? null
	);
}

/** An installed, verified runtime. */
export interface AntigravityInstall {
	server: string;
	harness: string;
	version: string;
}

const RECORD = ".install-complete.json";

function installDir(root: string, release: AntigravityAsset): string {
	return join(root, `${ANTIGRAVITY_VERSION}-${release.key}`);
}

async function isExecutableFile(file: string, bytes: number, platform: string) {
	try {
		const info = await lstat(file);
		return (
			info.isFile() &&
			info.size === bytes &&
			(platform === "win32" || (info.mode & 0o111) !== 0)
		);
	} catch {
		return false;
	}
}

/**
 * The runtime installed under `root`, or null. Installed means: the record written after the
 * archive's hash matched, and both files there with their pinned sizes, executable.
 */
export async function findAntigravity(
	root: string,
	platform: string = process.platform,
	arch: string = process.arch,
	pinned: AntigravityAsset | null = antigravityAsset(platform, arch),
): Promise<AntigravityInstall | null> {
	if (!pinned) return null;
	const dir = installDir(root, pinned);
	try {
		const record = JSON.parse(await readFile(join(dir, RECORD), "utf8")) as {
			version?: string;
			sha256?: string;
		};
		if (
			record.version !== ANTIGRAVITY_VERSION ||
			record.sha256 !== pinned.sha256
		)
			return null;
	} catch {
		return null;
	}
	const server = join(dir, pinned.executable.name);
	const harness = join(dir, pinned.harness.name);
	if (
		!(await isExecutableFile(server, pinned.executable.bytes, platform)) ||
		!(await isExecutableFile(harness, pinned.harness.bytes, platform))
	)
		return null;
	return { server, harness, version: ANTIGRAVITY_VERSION };
}

class AntigravityInstallError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AntigravityInstallError";
	}
}

export interface InstallInput {
	/** OfferFinch's own folder for the runtime (app data). */
	root: string;
	/** Unpacks a zip into an empty folder without a shell (the desktop's `zipTools.extract`). */
	extract: (zip: string, dir: string) => Promise<void>;
	platform?: string;
	arch?: string;
	fetch?: typeof fetch;
	/** Downloaded bytes so far, of `total`. */
	onProgress?: (done: number, total: number) => void;
	signal?: AbortSignal;
	/** Tests only: another release than the pinned one for this platform. */
	asset?: AntigravityAsset;
}

/**
 * Downloads the pinned release into `root`, checks its size and sha256 before anything is
 * unpacked, unpacks it into a fresh folder, checks it holds exactly the two pinned files, marks
 * them executable and records the install. Refuses on any mismatch; leaves nothing half done.
 */
export async function installAntigravity(
	input: InstallInput,
): Promise<AntigravityInstall> {
	const platform = input.platform ?? process.platform;
	const arch = input.arch ?? process.arch;
	const pinned = input.asset ?? antigravityAsset(platform, arch);
	const existing = await findAntigravity(input.root, platform, arch, pinned);
	if (existing) return existing;
	if (!pinned)
		throw new AntigravityInstallError(
			`Google publishes no Antigravity ${ANTIGRAVITY_VERSION} for ${platform}-${arch}.`,
		);
	await mkdir(input.root, { recursive: true, mode: 0o700 });
	const tag = randomBytes(6).toString("hex");
	const zip = join(input.root, `.download-${tag}.zip`);
	const staging = join(input.root, `.staging-${tag}`);
	try {
		await download(pinned, zip, input);
		await mkdir(staging, { mode: 0o700 });
		await input.extract(zip, staging);
		await rm(zip, { force: true });
		const entries = (await readdir(staging)).sort();
		const expected = [pinned.executable.name, pinned.harness.name].sort();
		if (entries.join("\n") !== expected.join("\n"))
			throw new AntigravityInstallError(
				"The Antigravity download did not hold the expected files; nothing was installed.",
			);
		for (const file of [pinned.executable, pinned.harness]) {
			const path = join(staging, file.name);
			const info = await lstat(path);
			if (!info.isFile() || info.size !== file.bytes)
				throw new AntigravityInstallError(
					`${file.name} in the Antigravity download is not the pinned file; nothing was installed.`,
				);
			if (platform !== "win32") await chmod(path, 0o755);
		}
		await writeFile(
			join(staging, RECORD),
			JSON.stringify({
				version: ANTIGRAVITY_VERSION,
				sha256: pinned.sha256,
				executable: pinned.executable,
				harness: pinned.harness,
			}),
		);
		const dir = installDir(input.root, pinned);
		await rm(dir, { recursive: true, force: true });
		await rename(staging, dir);
	} finally {
		await rm(zip, { force: true });
		await rm(staging, { recursive: true, force: true });
	}
	const installed = await findAntigravity(input.root, platform, arch, pinned);
	if (!installed)
		throw new AntigravityInstallError(
			"Antigravity was unpacked but could not be verified; nothing is used.",
		);
	return installed;
}

async function download(
	pinned: AntigravityAsset,
	zip: string,
	input: InstallInput,
): Promise<void> {
	const response = await (input.fetch ?? fetch)(pinned.url, {
		signal: input.signal,
		redirect: "follow",
	});
	if (!response.ok || !response.body)
		throw new AntigravityInstallError(
			`The Antigravity download failed (HTTP ${response.status}).`,
		);
	const hash = createHash("sha256");
	let done = 0;
	const count = new Transform({
		transform(chunk: Buffer, _encoding, next) {
			done += chunk.length;
			if (done > pinned.archiveBytes) {
				next(
					new AntigravityInstallError(
						"The Antigravity download is larger than the pinned release; refused.",
					),
				);
				return;
			}
			hash.update(chunk);
			input.onProgress?.(done, pinned.archiveBytes);
			next(null, chunk);
		},
	});
	await pipeline(
		Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
		count,
		createWriteStream(zip, { mode: 0o600 }),
	);
	const size = (await stat(zip)).size;
	const digest = hash.digest("hex");
	if (size !== pinned.archiveBytes || digest !== pinned.sha256)
		throw new AntigravityInstallError(
			`The Antigravity download does not match the pinned ${ANTIGRAVITY_VERSION} release (size or sha256); nothing was installed.`,
		);
}
