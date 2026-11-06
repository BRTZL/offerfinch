import { existsSync } from "node:fs";
import path from "node:path";
import {
	type AntigravityProbe,
	AntigravityProvider,
	antigravityTokenFile,
	probeAntigravity,
	resumeAntigravityCalls,
	signInAntigravity,
	sweepAntigravityRoots,
} from "@offerfinch/local-llm/antigravity";
import {
	ANTIGRAVITY_VERSION,
	antigravityAsset,
	findAntigravity,
	installAntigravity,
} from "@offerfinch/local-llm/antigravity-release";
import { createZipTools } from "../main/zip";
import {
	formatModelRef,
	type ModelInfo,
	providerOff,
} from "../shared/providers";
import type { CliFix, CliState, ManagedProvider } from "./subscriptions";

/**
 * Gemini (Antigravity) for the worker: OfferFinch downloads Google's pinned ACP server into its
 * own folder, signs in with Google itself (the page opens in the browser), and runs each call
 * through `AntigravityProvider`. Nothing here reads the user's own Antigravity or Gemini files.
 */

/** Where the runtime and the sign-in live, inside OfferFinch's data folder. */
function antigravityPaths(userData: string) {
	const root = path.join(userData, "antigravity");
	return {
		runtime: path.join(root, "runtime"),
		geminiHome: path.join(root, "gemini-home"),
	};
}

const ANTIGRAVITY_FIX: Record<CliFix["kind"], CliFix> = {
	install: {
		kind: "install",
		command: "",
		after:
			"Install it from Settings › Models: OfferFinch downloads Google's Antigravity server and checks it before it runs.",
		inApp: "install",
	},
	login: {
		kind: "login",
		command: "",
		after:
			"Sign in with Google from Settings › Models, with the account that has your Google AI plan.",
		inApp: "signIn",
	},
};

/** How long a model list (and with it, the signed-in state) is trusted. */
const PROBE_TTL_MS = 5 * 60_000;
/** A failed check is tried again sooner. */
const PROBE_RETRY_MS = 30_000;

export function antigravityState(input: {
	platform: string;
	installed: string | null;
	signedIn: boolean;
	probe: AntigravityProbe | null;
}): CliState {
	const off = providerOff("antigravity", input.platform);
	const base = {
		path: input.installed,
		version: input.installed ? ANTIGRAVITY_VERSION : null,
		tested: ANTIGRAVITY_VERSION,
	};
	if (off)
		return {
			...base,
			login: { state: "unknown", detail: off },
			command: null,
			fix: null,
		};
	if (!input.installed)
		return {
			...base,
			login: {
				state: "logged_out",
				detail: "Gemini (Antigravity) is not installed.",
			},
			command: null,
			fix: ANTIGRAVITY_FIX.install,
		};
	if (!input.signedIn || input.probe?.login === "logged_out")
		return {
			...base,
			login: {
				state: "logged_out",
				detail:
					input.probe?.detail ??
					"Not signed in with Google for Gemini (Antigravity).",
			},
			command: null,
			fix: ANTIGRAVITY_FIX.login,
		};
	return {
		...base,
		version: input.probe?.version ?? base.version,
		login: input.probe
			? { state: input.probe.login, detail: input.probe.detail }
			: { state: "unknown", detail: "Not checked yet." },
		command: null,
		fix: null,
	};
}

/** The server's model families as picker entries, each with its thinking levels as efforts. */
export function antigravityModels(probe: AntigravityProbe | null): ModelInfo[] {
	if (probe?.login !== "logged_in") return [];
	return probe.families.map((family) => ({
		ref: formatModelRef("antigravity", family.id),
		name: family.name,
		provider: "antigravity",
		billing: "subscription",
		efforts: [...family.levels],
	}));
}

export function antigravityService(input: {
	userData: string;
	/** Opens Google's sign-in page in the user's browser (main checks the address again). */
	openSignIn: (url: string) => void;
	log?: (message: string, data?: Record<string, unknown>) => void;
	platform?: NodeJS.Platform;
	/** Deletes call folders a crash left (default on; tests turn it off). */
	sweep?: boolean;
}): ManagedProvider {
	const platform = input.platform ?? process.platform;
	const paths = antigravityPaths(input.userData);
	const tokenFile = antigravityTokenFile(paths.geminiHome);
	const runtime = () => findAntigravity(paths.runtime, platform);
	let probe: {
		at: number;
		ttl: number;
		value: Promise<AntigravityProbe>;
	} | null = null;
	let installing: Promise<unknown> | null = null;
	let signingIn: { url: string | null; done: Promise<void> } | null = null;

	if (input.sweep !== false && !providerOff("antigravity", platform))
		void sweepAntigravityRoots().catch(() => {});

	const check = (fresh: boolean): Promise<AntigravityProbe> | null => {
		if (!fresh && probe && Date.now() - probe.at < probe.ttl)
			return probe.value;
		const value = (async (): Promise<AntigravityProbe> => {
			const installed = await runtime();
			if (!installed)
				return {
					login: "logged_out",
					detail: "",
					version: null,
					families: [],
				};
			return probeAntigravity({ runtime: installed, tokenFile }).catch(
				(error) => ({
					login: "unknown" as const,
					detail: `Gemini (Antigravity) could not be checked: ${String(error).slice(0, 200)}`,
					version: null,
					families: [],
				}),
			);
		})();
		const entry = { at: Date.now(), ttl: PROBE_TTL_MS, value };
		probe = entry;
		void value.then((v) => {
			if (v.login !== "logged_in") entry.ttl = PROBE_RETRY_MS;
		});
		return value;
	};

	const state = async (fresh = false): Promise<CliState> => {
		if (providerOff("antigravity", platform))
			return antigravityState({
				platform,
				installed: null,
				signedIn: false,
				probe: null,
			});
		const installed = await runtime();
		const signedIn = existsSync(tokenFile);
		return antigravityState({
			platform,
			installed: installed?.server ?? null,
			signedIn,
			probe: installed && signedIn ? await check(fresh) : null,
		});
	};

	return {
		state: (options) => state(Boolean(options?.fresh)),
		async models() {
			if (providerOff("antigravity", platform)) return [];
			if (!(await runtime()) || !existsSync(tokenFile)) return [];
			return antigravityModels(await check(false));
		},
		factory: ({ model, effort, ownerUserId }) =>
			new AntigravityProvider({
				model,
				effort,
				ownerUserId,
				runtime,
				tokenFile,
				log: input.log,
				platform,
			}),
		async install() {
			const off = providerOff("antigravity", platform);
			if (off) throw new Error(off);
			if (!antigravityAsset(platform))
				throw new Error(
					`Google publishes no Antigravity server for ${platform}-${process.arch}.`,
				);
			installing ??= installAntigravity({
				root: paths.runtime,
				platform,
				extract: (zip, dir) => createZipTools({ platform }).extract(zip, dir),
			}).finally(() => {
				installing = null;
			});
			await installing;
			input.log?.("antigravity installed", { version: ANTIGRAVITY_VERSION });
			resumeAntigravityCalls();
			probe = null;
			return state(true);
		},
		async signIn() {
			const off = providerOff("antigravity", platform);
			if (off) throw new Error(off);
			const installed = await runtime();
			if (!installed)
				throw new Error(
					"Install Gemini (Antigravity) first, then sign in with Google.",
				);
			if (signingIn) {
				// Already waiting for the browser: show the same page again.
				if (signingIn.url) input.openSignIn(signingIn.url);
			} else {
				const current: { url: string | null; done: Promise<void> } = {
					url: null,
					done: Promise.resolve(),
				};
				current.done = signInAntigravity({
					runtime: installed,
					geminiHome: paths.geminiHome,
					onUrl: (url) => {
						current.url = url;
						input.openSignIn(url);
					},
				}).finally(() => {
					signingIn = null;
				});
				signingIn = current;
			}
			await signingIn?.done;
			input.log?.("antigravity signed in");
			resumeAntigravityCalls();
			probe = null;
			return state(true);
		},
	};
}
