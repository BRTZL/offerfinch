import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_OUTPUT_TOKENS,
	fullPrompt,
	type GenerateObjectRequest,
	type LlmBilling,
	LlmNotBilledError,
	type LlmProvider,
	type LlmUsage,
	NOT_BILLED_STATUSES,
	redactRequest,
	type SubscriptionPauseKind,
	SubscriptionUnavailableError,
} from "@offerfinch/core/scoring/llm";
import { toStrictJsonSchema } from "@offerfinch/core/scoring/openai";
import type { ModelPrice } from "@offerfinch/core/scoring/pricing";
import type { z } from "zod";
import { knownName, parseAnswer, unreadableAnswer } from "./answer";
import { Breaker } from "./breaker";
import { findCliOnPath } from "./cli-path";
import { subscriptionEnv } from "./env";
import {
	attemptCleanup,
	beginCall,
	type CallIntent,
	CLEANUP_GRACE_MS,
	CLEANUP_REFUSAL,
	CleanupFileError,
	CleanupLockBusyError,
	type CleanupTarget,
	cleanupDue,
	cleanupOverdue,
	finishCall,
	type PendingCleanup,
	readPendingCleanup,
	scheduleCleanupRetry,
} from "./opencode-cleanup";
import { readOpenCodeCredentials, type ScrubResult } from "./opencode-db";
import { type RelayLog, startRelay } from "./opencode-relay";

/**
 * OpenCode as a model provider (docs/model-providers.md, "OpenCode recipe (2.2.5)"): one
 * `opencode serve --stdio --port 0` per call on the user's own OpenCode login in place
 * (`XDG_DATA_HOME` is theirs), everything else in a stable private root, locked down by config,
 * checked before the prompt, through a single-request relay, and scrubbed from the user's
 * database afterwards. Every step is tied to the tested version, so the version gate comes first.
 */

const OPENCODE = "opencode";

/** The OpenCode version every proof (research notes, boundary test) was made on. */
export const OPENCODE_TESTED_VERSION = "2.2.5";

/**
 * The tested binaries, by version and platform: the sha256 of the `opencode` executable. A
 * binary not listed here (another build, another platform) is refused before it is started on
 * the user's data: `serve` opens and may migrate their database.
 */
const OPENCODE_TESTED_BINARIES: Record<string, Record<string, string>> = {
	"2.2.5": {
		"darwin-arm64":
			"abe4d88594bffb12b364375b8a6732d2d1f7a977195ed1a35c5c76f8e89c9e0e",
	},
};

/** Sources whose models are on a flat-rate plan; `opencode`'s `*-free` models are too. */
const OPENCODE_PLAN_SOURCES: readonly string[] = [
	"opencode-go",
	"zai-coding-plan",
];

/**
 * Source packages whose wire the relay has been proven on: an OpenAI-style `POST
 * …/chat/completions`. A source on any other package (Anthropic's messages, OpenAI's responses,
 * …) is not offered yet.
 */
const TESTED_PACKAGES: readonly string[] = [
	"@opencode/ai/providers/openai-compatible",
	"@opencode/ai/providers/zai-coding-plan/chat",
];

export const OPENCODE_WINDOWS_OFF = "OpenCode is not available on Windows yet.";

/** Installs the tested OpenCode 2 build into `~/.opencode/bin`. */
export const OPENCODE_INSTALL = `curl -fsSL https://opencode.ai/v2/install | bash -s -- --version ${OPENCODE_TESTED_VERSION}`;

/** The environment switches every OpenCode process gets. */
const SWITCHES: Record<string, string> = {
	OPENCODE_DISABLE_PROJECT_CONFIG: "1",
	OPENCODE_DISABLE_CLAUDE_CODE: "1",
	OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
	OPENCODE_DISABLE_AUTOUPDATE: "1",
	OPENCODE_DISABLE_MODELS_FETCH: "1",
	OPENCODE_DISABLE_FILEWATCHER: "1",
	OPENCODE_LOG_LEVEL: "ERROR",
};

const DENY_ALL = [{ action: "*", resource: "*", effect: "deny" }];

const HOWTO =
	"OfferFinch uses your OpenCode login in place and never changes it; check Settings › Models.";

// ---------------------------------------------------------------------------------------------
// Where things are.

/** The `opencode` binary: on PATH, else the installer's `~/.opencode/bin/opencode`. */
export function findOpenCodeBinary(
	pathEnv: string | undefined,
	home: string = homedir(),
	platform: NodeJS.Platform = process.platform,
): string | null {
	const found = findCliOnPath("opencode", pathEnv ?? "", platform);
	if (found) return found;
	const installed = join(home, ".opencode", "bin", "opencode");
	return platform !== "win32" && existsSync(installed) ? installed : null;
}

/** The user's data home, where OpenCode keeps its login and database. */
export function openCodeDataHome(
	parentEnv: Record<string, string | undefined> = process.env,
): string {
	return parentEnv.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

export function openCodeDbFile(dataHome: string): string {
	return join(dataHome, "opencode", "opencode.db");
}

interface RootDirs {
	/** The root's real path: OfferFinch's own files (the cleanup marker). */
	base: string;
	home: string;
	cfg: string;
	state: string;
	cache: string;
	tmp: string;
	/** OpenCode's project directory: an empty folder with a neutral path (it is in the prompt). */
	cwd: string;
	/** The version check's own data home, so `--version` never opens the user's database. */
	gateData: string;
}

/**
 * The stable private root (same path every call, so OpenCode's project for it is one row and
 * its environment block stays the same), with its folders private to the user. The config
 * folder is read-only, so nothing can be written into it.
 */
async function prepareRoot(root: string): Promise<RootDirs> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const real = await realpath(root);
	const dirs: Omit<RootDirs, "base"> = {
		home: join(real, "home"),
		cfg: join(real, "cfg"),
		state: join(real, "state"),
		cache: join(real, "cache"),
		tmp: join(real, "tmp"),
		cwd: join(real, "work"),
		gateData: join(real, "gate"),
	};
	for (const dir of Object.values(dirs))
		await mkdir(dir, { recursive: true, mode: 0o700 });
	const own = join(dirs.cfg, "opencode");
	await mkdir(own, { recursive: true });
	await chmod(own, 0o555);
	return { base: real, ...dirs };
}

/** The environment of every OpenCode process: the allowlist, the private root, the switches. */
function openCodeEnv(
	parentEnv: Record<string, string | undefined>,
	dirs: RootDirs,
	dataHome: string,
	extra: Record<string, string> = {},
): { env: Record<string, string>; removed: string[] } {
	const { env: allowed, removed } = subscriptionEnv(parentEnv);
	return {
		env: {
			PATH: allowed.PATH ?? "/usr/bin:/bin",
			...(allowed.USER ? { USER: allowed.USER } : {}),
			...(allowed.LANG ? { LANG: allowed.LANG } : {}),
			...(allowed.TZ ? { TZ: allowed.TZ } : {}),
			HOME: dirs.home,
			TMPDIR: dirs.tmp,
			XDG_CONFIG_HOME: dirs.cfg,
			XDG_STATE_HOME: dirs.state,
			XDG_CACHE_HOME: dirs.cache,
			XDG_DATA_HOME: dataHome,
			...SWITCHES,
			...extra,
		},
		removed,
	};
}

// ---------------------------------------------------------------------------------------------
// Version gate.

export type GateResult =
	| { ok: true; version: string; sha256: string }
	| { ok: false; version: string | null; detail: string };

/** Why a version and binary hash are not the tested ones, or null. */
export function gateProblem(
	version: string | null,
	sha256: string,
	platform = `${process.platform}-${process.arch}`,
): string | null {
	if (!version) return "its version could not be read";
	const tested = OPENCODE_TESTED_BINARIES[version];
	if (!tested)
		return `version ${version} is not the tested ${OPENCODE_TESTED_VERSION}`;
	if (!tested[platform])
		return `no tested ${version} build for ${platform} is known`;
	if (tested[platform] !== sha256)
		return `this ${version} binary is not the tested build (sha256 ${sha256.slice(0, 12)}…)`;
	return null;
}

/** `opencode v2.2.5` (or a bare `2.2.5`) as `2.2.5`. */
export function parseOpenCodeVersion(output: string): string | null {
	return /\bv?(\d+\.\d+\.\d+)\b/.exec(output.trim())?.[1] ?? null;
}

function sha256File(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(file)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex")));
	});
}

/** Hashing the 200 MB binary takes a while: kept per file identity. */
const gateCache = new Map<string, GateResult>();

/**
 * The version gate: the binary's sha256 and `opencode --version` (run with a private data home,
 * so it never opens the user's database) against the tested list. Kept per binary identity.
 */
export async function checkOpenCodeBinary(input: {
	binary: string;
	root: string;
	parentEnv?: Record<string, string | undefined>;
}): Promise<GateResult> {
	const binary = await realpath(input.binary);
	const info = await stat(binary);
	const key = `${binary}:${info.size}:${info.mtimeMs}:${info.ino}`;
	const cached = gateCache.get(key);
	if (cached) return cached;
	const dirs = await prepareRoot(input.root);
	const sha256 = await sha256File(binary);
	const { env } = openCodeEnv(
		input.parentEnv ?? process.env,
		dirs,
		dirs.gateData,
		{ OPENCODE_DB: ":memory:" },
	);
	const output = await new Promise<string | null>((resolve) =>
		execFile(
			binary,
			["--version"],
			{ env, cwd: dirs.cwd, timeout: 20_000 },
			(error, stdout) => resolve(error ? null : String(stdout)),
		),
	);
	const version = output ? parseOpenCodeVersion(output) : null;
	const problem = gateProblem(version, sha256);
	const result: GateResult = problem
		? {
				ok: false,
				version,
				detail: `OpenCode at ${binary} cannot be used: ${problem}. OfferFinch runs only the tested OpenCode ${OPENCODE_TESTED_VERSION} build. Install it with \`${OPENCODE_INSTALL}\`, and set "update": "disable" in OpenCode's config so it stays on it.`,
			}
		: { ok: true, version: version as string, sha256 };
	gateCache.set(key, result);
	return result;
}

// ---------------------------------------------------------------------------------------------
// Config.

/** The JSON schema the answer must match, as `response_format`. */
function responseFormat(schema: Record<string, unknown>) {
	return {
		response_format: {
			type: "json_schema",
			json_schema: { name: "output", strict: true, schema },
		},
	};
}

/**
 * `OPENCODE_CONFIG_CONTENT` for one call: deny-all permissions and policies, no MCP, plugins,
 * skills, instructions or commands, updates and sharing off, the source's `baseURL` pointed at
 * the relay, the schema as the model's `response_format`, the reserved output limit as its
 * `max_completion_tokens` (2.2.5 otherwise sends the model's own limit, 32,000 on the tested
 * model; the model's `body` overrides it), and one agent with our system prompt.
 * The nonce in the agent's description identifies this document in `GET /api/config`. Never
 * `agents.*.steps` (it injects an assistant message), never an API key.
 */
export function openCodeConfig(input: {
	source: string;
	model: string;
	relayUrl?: string;
	schema?: Record<string, unknown>;
	/** The output limit the call was reserved for. */
	maxTokens?: number;
	system?: string;
	nonce: string;
}): Record<string, unknown> {
	const provider: Record<string, unknown> = {};
	if (input.relayUrl) provider.settings = { baseURL: input.relayUrl };
	if (input.schema || input.maxTokens)
		provider.models = {
			[input.model]: {
				body: {
					...(input.schema ? responseFormat(input.schema) : {}),
					...(input.maxTokens
						? { max_completion_tokens: input.maxTokens }
						: {}),
				},
			},
		};
	const allowed = [...new Set(["opencode", input.source])];
	return {
		$schema: "https://opencode.ai/v2/config.json",
		update: "disable",
		share: "disabled",
		snapshots: false,
		warming: false,
		compaction: { auto: false },
		instructions: [],
		skills: [],
		plugins: [],
		references: {},
		commands: {},
		mcp: { servers: {} },
		providers: { [input.source]: provider },
		model: `${input.source}/${input.model}`,
		default_agent: "offerfinch",
		permissions: DENY_ALL,
		policies: [
			...[
				"tool.use",
				"mcp.use",
				"skill.use",
				"plugin.use",
				"integration.connect",
				"integration.use",
			].map((action) => ({ action, resource: "*", effect: "deny" })),
			...allowed.flatMap((id) => [
				{ action: "integration.use", resource: id, effect: "allow" },
				{ action: "integration.use", resource: `${id}#*`, effect: "allow" },
			]),
		],
		agents: {
			offerfinch: {
				mode: "primary",
				description: input.nonce,
				system: input.system ?? "You answer with JSON only.",
				permissions: DENY_ALL,
			},
		},
	};
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (v: unknown, keys: string[]) =>
	isObject(v) && Object.keys(v).every((k) => keys.includes(k));

/**
 * The OpenCode Console's org document, as the user's `opencode` login brings it: a name, the
 * org header and disabled models for `opencode`, a web search provider, deny-only policies. It
 * can carry no text and no tools in this shape.
 */
function isOrgDocument(info: unknown): boolean {
	if (!onlyKeys(info, ["providers", "websearch", "policies"])) return false;
	const doc = info as Record<string, unknown>;
	const providers = doc.providers ?? {};
	if (!onlyKeys(providers, ["opencode"])) return false;
	const opencode = (providers as Record<string, unknown>).opencode ?? {};
	if (!onlyKeys(opencode, ["name", "headers", "models"])) return false;
	const o = opencode as Record<string, unknown>;
	if (o.name !== undefined && typeof o.name !== "string") return false;
	if (!onlyKeys(o.headers ?? {}, ["x-opencode-org-id"])) return false;
	if (!isObject(o.models ?? {})) return false;
	if (
		!Object.values((o.models ?? {}) as Record<string, unknown>).every(
			(m) =>
				onlyKeys(m, ["disabled"]) &&
				typeof (m as { disabled?: unknown }).disabled === "boolean",
		)
	)
		return false;
	const policies = doc.policies ?? [];
	if (
		!Array.isArray(policies) ||
		!policies.every((p) => isObject(p) && p.effect === "deny")
	)
		return false;
	return (
		doc.websearch === undefined ||
		(onlyKeys(doc.websearch, ["provider"]) &&
			typeof (doc.websearch as { provider?: unknown }).provider === "string")
	);
}

/**
 * The check before the prompt: `GET /api/config` must list only our document (by its nonce),
 * our own config folder, and at most one Console org document of the known shape. Anything else
 * (a stored well-known integration, a config file found somewhere) can inject instructions the
 * lockdown does not remove. Null when it passes.
 */
export function configProblem(
	answer: unknown,
	nonce: string,
	cfgDir: string,
): string | null {
	const docs = Array.isArray(answer)
		? answer
		: isObject(answer) && Array.isArray(answer.data)
			? answer.data
			: null;
	if (!docs) return "OpenCode did not list its configuration";
	let own = 0;
	let org = 0;
	for (const doc of docs) {
		if (!isObject(doc)) return "an unreadable configuration entry";
		if (doc.type === "directory") {
			if (doc.path !== join(cfgDir, "opencode"))
				return `a configuration folder OfferFinch did not set (${String(doc.path)})`;
			continue;
		}
		if (doc.type !== "document")
			return `a configuration entry of type ${String(doc.type)}`;
		const info = doc.info;
		if (JSON.stringify(info ?? null).includes(nonce)) own++;
		else if (isOrgDocument(info)) org++;
		else
			return "a configuration document OfferFinch did not set (a stored integration or config file)";
	}
	if (own !== 1) return "OfferFinch's own configuration was not loaded once";
	if (org > 1) return "more than one OpenCode Console document";
	return null;
}

// ---------------------------------------------------------------------------------------------
// The server.

interface Serve {
	url: string;
	request<T = unknown>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<{ status: number; body: T }>;
	/** Subscribes to `/api/event`; resolves once the stream is connected (or after 5 s). */
	events(onEvent: (event: OpenCodeEvent) => void): Promise<void>;
	close(): Promise<{ exitedOnStdinClose: boolean }>;
	stderrTail(): string;
}

interface OpenCodeEvent {
	type?: string;
	data?: Record<string, unknown>;
}

/** Server-sent events: each `data:` block parsed as JSON. */
async function readSse(
	body: AsyncIterable<Uint8Array>,
	onEvent: (event: OpenCodeEvent) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let at = buffer.indexOf("\n\n");
		while (at >= 0) {
			const data = buffer
				.slice(0, at)
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trimStart())
				.join("\n");
			buffer = buffer.slice(at + 2);
			at = buffer.indexOf("\n\n");
			if (!data) continue;
			try {
				onEvent(JSON.parse(data) as OpenCodeEvent);
			} catch {}
		}
	}
}

/**
 * `opencode serve --stdio --port 0`: prints `{"url": …}` on stdout, serves HTTP on a random
 * localhost port behind a per-process password (removed from the server's env in stdio mode),
 * and exits when its stdin closes.
 */
async function startServe(input: {
	binary: string;
	env: Record<string, string>;
	cwd: string;
	timeoutMs?: number;
}): Promise<Serve> {
	const password = randomBytes(24).toString("hex");
	const child: ChildProcess = spawn(
		input.binary,
		["serve", "--stdio", "--port", "0"],
		{
			cwd: input.cwd,
			env: { ...input.env, OPENCODE_PASSWORD: password },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stderr?.on("data", (d) => {
		stderr = (stderr + String(d)).slice(-4000);
	});
	const exited = new Promise<void>((resolve) =>
		child.once("exit", () => resolve()),
	);
	child.once("error", () => {});
	const close = async () => {
		child.stdin?.end();
		const timer = new Promise<boolean>((r) => setTimeout(() => r(false), 1500));
		const clean = await Promise.race([exited.then(() => true), timer]);
		if (!clean) {
			child.kill("SIGKILL");
			await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
		}
		return { exitedOnStdinClose: clean };
	};
	const url = await new Promise<string | null>((resolve) => {
		const timer = setTimeout(() => resolve(null), input.timeoutMs ?? 30_000);
		child.stdout?.on("data", (d) => {
			stdout += String(d);
			for (const line of stdout.split("\n")) {
				if (!line.includes('"url"')) continue;
				try {
					const parsed = JSON.parse(line) as { url?: unknown };
					if (typeof parsed.url === "string") {
						clearTimeout(timer);
						resolve(parsed.url);
						return;
					}
				} catch {}
			}
		});
		void exited.then(() => {
			clearTimeout(timer);
			resolve(null);
		});
	});
	if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) {
		await close();
		// Its output is not quoted: an error line can carry a provider's answer.
		throw new Error(
			`opencode serve did not start (${child.exitCode ?? child.signalCode ?? "no exit"}, ${stderr.length} characters on stderr)`,
		);
	}
	const streams = new AbortController();
	const headers = {
		authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
		"content-type": "application/json",
	};
	return {
		url,
		async request<T>(method: string, path: string, body?: unknown) {
			const res = await fetch(url + path, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			});
			const text = await res.text();
			let parsed: unknown = text;
			try {
				parsed = text ? JSON.parse(text) : null;
			} catch {}
			return { status: res.status, body: parsed as T };
		},
		events(onEvent) {
			return new Promise<void>((connected) => {
				const timer = setTimeout(connected, 5_000);
				void (async () => {
					try {
						const res = await fetch(`${url}/api/event`, {
							headers,
							signal: streams.signal,
						});
						if (!res.body) return;
						await readSse(res.body, (event) => {
							clearTimeout(timer);
							connected();
							onEvent(event);
						});
					} catch {
					} finally {
						clearTimeout(timer);
						connected();
					}
				})();
			});
		},
		close: () => {
			streams.abort();
			return close();
		},
		stderrTail: () => stderr.slice(-500),
	};
}

// ---------------------------------------------------------------------------------------------
// The model list.

export interface OpenCodeCatalogModel {
	source: string;
	model: string;
	name: string;
	enabled: boolean;
	package: string | null;
	/** The source's real base URL: where the relay forwards. */
	baseURL: string | null;
	variants: string[];
	/** USD per million tokens, per context tier as OpenCode lists them. */
	cost: {
		input: number;
		output: number;
		cache?: { read?: number; write?: number };
	}[];
}

export interface OpenCodeCatalog {
	version: string;
	models: OpenCodeCatalogModel[];
}

/**
 * The models OpenCode offers on the user's login, with prices and effort variants: `GET
 * /api/model` and `/api/provider` on the same locked-down server a call uses (2.2.5 has no
 * `opencode models --verbose`; plain `opencode models` attaches to the user's background
 * service). No session is created and nothing is sent to a model.
 */
export async function listOpenCodeCatalog(input: {
	binary: string;
	root: string;
	parentEnv?: Record<string, string | undefined>;
	dataHome?: string;
	timeoutMs?: number;
}): Promise<OpenCodeCatalog> {
	const parentEnv = input.parentEnv ?? process.env;
	const gate = await checkOpenCodeBinary({
		binary: input.binary,
		root: input.root,
		parentEnv,
	});
	if (!gate.ok) throw new Error(gate.detail);
	const dirs = await prepareRoot(input.root);
	const nonce = `offerfinch-${randomBytes(8).toString("hex")}`;
	const { env } = openCodeEnv(
		parentEnv,
		dirs,
		input.dataHome ?? openCodeDataHome(parentEnv),
		{
			OPENCODE_CONFIG_CONTENT: JSON.stringify(
				openCodeConfig({ source: "opencode", model: "list", nonce }),
			),
		},
	);
	const serve = await startServe({
		binary: input.binary,
		env,
		cwd: dirs.cwd,
		timeoutMs: input.timeoutMs,
	});
	try {
		const info = await serve.request<{ version?: string }>("GET", "/api/info");
		if (info.body?.version !== gate.version)
			throw new Error(
				`opencode serve reported version ${String(info.body?.version)}`,
			);
		type ProviderRow = {
			id: string;
			package?: string;
			settings?: { baseURL?: string };
		};
		type ModelRow = {
			id: string;
			providerID: string;
			name?: string;
			enabled?: boolean;
			package?: string;
			settings?: { baseURL?: string };
			variants?: { id: string }[];
			cost?: OpenCodeCatalogModel["cost"];
		};
		const providers = await serve.request<{ data?: ProviderRow[] }>(
			"GET",
			"/api/provider",
		);
		const models = await serve.request<{ data?: ModelRow[] }>(
			"GET",
			"/api/model",
		);
		const bySource = new Map(
			(providers.body?.data ?? []).map((p) => [p.id, p] as const),
		);
		return {
			version: gate.version,
			models: (models.body?.data ?? []).map((m) => {
				const source = bySource.get(m.providerID);
				return {
					source: m.providerID,
					model: m.id,
					name: m.name ?? m.id,
					enabled: m.enabled !== false,
					package: m.package ?? source?.package ?? null,
					baseURL: m.settings?.baseURL ?? source?.settings?.baseURL ?? null,
					variants: (m.variants ?? []).map((v) => v.id),
					cost: Array.isArray(m.cost) ? m.cost : [],
				};
			}),
		};
	} finally {
		await serve.close();
	}
}

/** One model as OfferFinch offers it (or says why not). */
export interface OpenCodeModelEntry {
	source: string;
	model: string;
	name: string;
	billing: LlmBilling;
	/** Effort variants the model takes, as OpenCode names them. */
	variants: string[];
	/** Its price; for pay-per-use, what the spending cap reserves and settles at. */
	price: ModelPrice | null;
	baseURL: string | null;
	/** Why it is not offered; null when it is. */
	unavailable: string | null;
}

const PRICE_SOURCE = `OpenCode's model list (opencode ${OPENCODE_TESTED_VERSION}, GET /api/model)`;

/**
 * A model's price for the cap: the highest rate of any context tier for each kind of token, so
 * the estimate is never below what a long prompt costs. Null without a usable price.
 */
export function openCodePrice(
	cost: OpenCodeCatalogModel["cost"],
): ModelPrice | null {
	const tiers = cost.filter(
		(c) =>
			Number.isFinite(c?.input) &&
			Number.isFinite(c?.output) &&
			c.input >= 0 &&
			c.output >= 0,
	);
	if (!tiers.length) return null;
	return {
		input: Math.max(...tiers.map((c) => c.input)),
		cachedInput: Math.max(...tiers.map((c) => c.cache?.read ?? c.input)),
		output: Math.max(...tiers.map((c) => c.output)),
		source: PRICE_SOURCE,
	};
}

/** `subscription` for a plan source or an `opencode` free model; else pay per use. */
export function openCodeBilling(source: string, model: string): LlmBilling {
	if (OPENCODE_PLAN_SOURCES.includes(source)) return "subscription";
	return source === "opencode" && model.endsWith("-free")
		? "subscription"
		: "api";
}

/** OpenCode's own sources: free models answer without any login (a public key). */
const KEYLESS_SOURCES = ["opencode"];

/**
 * What OfferFinch offers of the catalog, from the user's credentials (types only, never values):
 * a source is offered when its package's wire is tested and it is signed in with an API key (or,
 * for `opencode`, its Console login, or no login for the free models). Another company's plan
 * login inside OpenCode (ChatGPT, xAI, …) is not offered: it is that company's subscription, not
 * pay-per-use, and those are used through their own providers. A pay-per-use model without a
 * price is not offered.
 */
export function openCodeEntries(
	catalog: OpenCodeCatalog,
	credentials: { integration: string; type: string; active: boolean }[],
): OpenCodeModelEntry[] {
	return catalog.models
		.filter((m) => m.enabled)
		.map((m) => {
			const billing = openCodeBilling(m.source, m.model);
			const price = openCodePrice(m.cost);
			const creds = credentials.filter(
				(c) => c.integration === m.source && c.active,
			);
			const signedIn = creds.length > 0;
			const unavailable =
				!m.package || !TESTED_PACKAGES.includes(m.package)
					? `${m.source} is not supported yet (its API has not been tested with OfferFinch's safeguards).`
					: !m.baseURL
						? `${m.source} has no API address in OpenCode's list.`
						: creds.some((c) => c.type === "oauth") && m.source !== "opencode"
							? `${m.source} is signed in with another company's plan login, which OfferFinch does not use through OpenCode.`
							: !signedIn && !KEYLESS_SOURCES.includes(m.source)
								? `${m.source} is not signed in.`
								: billing === "api" && !price
									? `${m.source}/${m.model} has no known price, so the spending cap cannot cover it.`
									: null;
			return {
				source: m.source,
				model: m.model,
				name: m.name,
				billing,
				variants: m.variants,
				price,
				baseURL: m.baseURL,
				unavailable,
			};
		});
}

// ---------------------------------------------------------------------------------------------
// One call.

export interface OpenCodeCallInput {
	binary: string;
	/** The stable private root (an app-data folder). */
	root: string;
	/** The user's data home (`XDG_DATA_HOME`); default theirs. Tests: a fake one. */
	dataHome?: string;
	source: string;
	model: string;
	variant?: string;
	/** The source's real base URL, where the relay forwards the one request. */
	upstream: string;
	system: string;
	prompt: string;
	schema: Record<string, unknown>;
	/** The output limit the call was reserved for: set in the config and held by the relay. */
	maxTokens: number;
	parentEnv?: Record<string, string | undefined>;
	onModelCall?: () => void;
	timeoutMs?: number;
	/** How long calls go on while an earlier cleanup is unfinished; default `CLEANUP_GRACE_MS`. */
	cleanupGraceMs?: number;
	/** Where the cleanup marker and intents live (the app's data folder); default the root. */
	stateDir?: string;
	log?: (message: string, data?: Record<string, unknown>) => void;
	/** Tests: runs before the server is stopped and the session scrubbed. */
	beforeScrub?: (input: { sessionId: string | null }) => Promise<void>;
	/** Tests: runs between the session's deletion and the cleanup marker (a failure there). */
	afterDelete?: () => void;
	/** Tests: the relay's upstream fetch. */
	fetch?: typeof fetch;
}

export interface OpenCodeCallResult {
	version: string | null;
	/** The prompt was posted (the model request may have gone out). */
	sent: boolean;
	sessionId: string | null;
	text: string | null;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cache: { read: number; write: number };
	} | null;
	/** The cost OpenCode computed for the answer (USD); > 0 on a plan source means paid. */
	cost: number | null;
	/** `session.execution.failed`'s error (type `provider.auth`, `provider.free-limit`, …). */
	failure: {
		type: string;
		message: string;
		status: number | null;
		body: string | null;
	} | null;
	/** OpenCode scheduled a retry: the session was interrupted on it. */
	retried: boolean;
	toolAttempt: string | null;
	/** Refused before the prompt (version, configuration): nothing was sent. */
	boundary: string | null;
	timedOut: boolean;
	relay: RelayLog | null;
	scrub: ScrubResult | null;
	scrubError: string | null;
	/** A cleanup (this call's or an earlier one's) is unfinished; it is retried. */
	cleanupPending: boolean;
	/** Refused before starting: an earlier cleanup has been unfinished past the grace period. */
	cleanupRefused: boolean;
	removedEnv: string[];
}

function emptyResult(removedEnv: string[]): OpenCodeCallResult {
	return {
		version: null,
		sent: false,
		sessionId: null,
		text: null,
		tokens: null,
		cost: null,
		failure: null,
		retried: false,
		toolAttempt: null,
		boundary: null,
		timedOut: false,
		relay: null,
		scrub: null,
		scrubError: null,
		cleanupPending: false,
		cleanupRefused: false,
		removedEnv,
	};
}

interface CleanupContext {
	target: CleanupTarget;
	binary: string;
	root: string;
	parentEnv: Record<string, string | undefined>;
	log?: (message: string, data?: Record<string, unknown>) => void;
}

/** OpenCode calls running, per cleanup target: a sweep must not delete their sessions. */
const running = new Map<string, number>();
/** Targets swept since this process started (the crash sweep runs once, then on the marker). */
const started = new Set<string>();

const targetKey = (target: CleanupTarget) => `${target.dbFile}\0${target.cwd}`;

function cleanupTarget(
	dirs: RootDirs,
	dbFile: string,
	stateDir: string | undefined,
): CleanupTarget {
	return { base: stateDir ?? dirs.base, dbFile, cwd: dirs.cwd };
}

/** Retries an unfinished cleanup later, on the tested build only (the sweep is schema-bound). */
function retryLater(ctx: CleanupContext, pending: PendingCleanup): void {
	scheduleCleanupRetry(ctx.target, pending.attempts, async () => {
		const gate = await checkOpenCodeBinary({
			binary: ctx.binary,
			root: ctx.root,
			parentEnv: ctx.parentEnv,
		});
		// Another build now: the next call or start retries after its own gate (and refuses).
		if (gate.ok) cleanupNow(ctx, new Date());
	});
}

/** One cleanup attempt now; a retry is scheduled while it stays unfinished. */
function cleanupNow(ctx: CleanupContext, now: Date): PendingCleanup | null {
	const key = targetKey(ctx.target);
	const start = !started.has(key);
	started.add(key);
	const attempt = attemptCleanup(ctx.target, {
		idle: !running.get(key),
		now,
		start,
	});
	if (attempt.result?.rows)
		ctx.log?.("opencode cleanup removed sessions a call left", {
			rows: attempt.result.rows,
		});
	if (attempt.pending) {
		ctx.log?.("warning: an OpenCode cleanup is unfinished; retrying", {
			busy: attempt.result?.busy ?? null,
			error: attempt.error,
			attempts: attempt.pending.attempts,
			since: attempt.pending.since,
		});
		retryLater(ctx, attempt.pending);
	}
	return attempt.pending;
}

/**
 * Before a call: the crash sweep once per process, then a retry of any unfinished cleanup. A
 * refusal (in words) when the cleanup has been unfinished past the grace period; else null.
 */
function settleCleanup(
	ctx: CleanupContext,
	now: Date,
	graceMs: number,
): string | null {
	const first = !started.has(targetKey(ctx.target));
	let pending: PendingCleanup | null;
	try {
		pending =
			first || cleanupDue(ctx.target, now) ? cleanupNow(ctx, now) : null;
	} catch (error) {
		if (!(error instanceof CleanupFileError)) throw error;
		warnCleanupFile(ctx);
		return CLEANUP_FILE_REFUSAL;
	}
	return cleanupOverdue(pending, now, graceMs) ? CLEANUP_REFUSAL : null;
}

/** No path or system message: only that the cleanup's files could not be read or written. */
function warnCleanupFile(ctx: CleanupContext): void {
	ctx.log?.(
		"warning: OfferFinch could not read or write a file its OpenCode cleanup needs; OpenCode calls are refused",
		{},
	);
}

/**
 * The start-up sweep: sessions a crash left in the user's database (the app stopped between a
 * prompt and its scrub), and any cleanup an earlier run left unfinished. Only on the tested
 * build, only OfferFinch's own project.
 */
export async function sweepOpenCodeCrashes(input: {
	binary: string;
	root: string;
	/** Where the cleanup marker and intents live; default the root. */
	stateDir?: string;
	parentEnv?: Record<string, string | undefined>;
	log?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<PendingCleanup | null> {
	const parentEnv = input.parentEnv ?? process.env;
	const gate = await checkOpenCodeBinary({ ...input, parentEnv });
	if (!gate.ok) return null;
	const dirs = await prepareRoot(input.root);
	const ctx: CleanupContext = {
		target: cleanupTarget(
			dirs,
			openCodeDbFile(openCodeDataHome(parentEnv)),
			input.stateDir,
		),
		binary: input.binary,
		root: input.root,
		parentEnv,
		log: input.log,
	};
	try {
		return cleanupNow(ctx, new Date());
	} catch (error) {
		if (!(error instanceof CleanupFileError)) throw error;
		// Every call refuses until it can be read (settleCleanup reads it again).
		warnCleanupFile(ctx);
		return null;
	}
}

const INTENT_REFUSAL =
	"OfferFinch could not write the note it keeps while an OpenCode call runs (so that a crash cannot leave the prompt in OpenCode's database unnoticed); nothing was sent. Check that OfferFinch's data folder is writable.";

const CLEANUP_FILE_REFUSAL =
	"OfferFinch could not read or write a file it keeps to clean up after OpenCode calls (a permission or disk error, not a missing file), so it cannot tell whether an earlier call's prompt is still in OpenCode's database; nothing was sent. Check that OfferFinch's data folder and OpenCode's database are readable.";

const LOCK_REFUSAL =
	"Another OfferFinch process kept OpenCode's cleanup busy for longer than a call waits; nothing was sent. Try again in a moment.";

/** Event types that mean the model tried something other than answering. */
const TOOL_EVENT = /^session\.(tool|shell|skill|permission|form|subagent)\b/;

type Failure = NonNullable<OpenCodeCallResult["failure"]>;

/** `session.execution.failed`'s error, read field by field. */
function failureOf(raw: unknown): Failure {
	const error = isObject(raw) ? raw : {};
	const response = isObject(error.response) ? error.response : {};
	return {
		type: String(error.type ?? "unknown"),
		message: String(error.message ?? "OpenCode failed"),
		status: typeof error.status === "number" ? error.status : null,
		body: typeof response.body === "string" ? response.body : null,
	};
}

/**
 * What the call's events mean: a retry (interrupted at once, so one request is all that goes
 * out), anything tool-like (interrupted, the answer discarded), the end of the execution.
 */
function sessionEvents(
	result: OpenCodeCallResult,
	interrupt: () => void,
	settle: () => void,
): (event: OpenCodeEvent) => void {
	return (event) => {
		const type = event.type ?? "";
		const data = event.data ?? {};
		if (!result.sessionId || data.sessionID !== result.sessionId) return;
		if (type === "session.retry.scheduled") result.retried = true;
		else if (TOOL_EVENT.test(type)) result.toolAttempt ??= type;
		else if (
			type === "session.step.ended" &&
			(data.finish === "tool-calls" || data.finish === "tool_calls")
		)
			result.toolAttempt ??= "a tool call";
		else if (type === "session.execution.failed")
			result.failure = failureOf(data.error);
		else if (!/^session\.execution\.(succeeded|interrupted)$/.test(type))
			return;
		if (result.retried || result.toolAttempt) interrupt();
		settle();
	};
}

type MessageRow = {
	type?: string;
	content?: { type?: string; text?: string }[];
	tokens?: OpenCodeCallResult["tokens"];
	cost?: number;
};

/** The answer, its tokens and cost, from the session's messages; tool content is flagged. */
function readAnswer(rows: MessageRow[], result: OpenCodeCallResult): void {
	const assistant = rows.filter((m) => m.type === "assistant");
	for (const message of assistant) {
		const tool = (message.content ?? []).find(
			(c) => c.type !== "text" && c.type !== "reasoning",
		);
		if (tool) result.toolAttempt ??= `content ${String(tool.type)}`;
	}
	const answer = assistant[0];
	if (!answer) return;
	if (answer.tokens) result.tokens = answer.tokens;
	if (typeof answer.cost === "number") result.cost = answer.cost;
	const text = (answer.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
	if (text) result.text = text;
}

/**
 * The recipe's HTTP part on a started server: version again, the configuration check, then the
 * session, the prompt, the wait and the answer. Returns early (nothing sent) on a refusal.
 */
async function converse(
	serve: Serve,
	input: OpenCodeCallInput,
	check: { version: string; nonce: string; dirs: RootDirs },
	result: OpenCodeCallResult,
): Promise<void> {
	const info = await serve.request<{ version?: string }>("GET", "/api/info");
	if (info.body?.version !== check.version) {
		result.boundary = `opencode serve reported version ${String(info.body?.version)}, not ${check.version}`;
		return;
	}
	const config = await serve.request("GET", "/api/config");
	const problem = configProblem(config.body, check.nonce, check.dirs.cfg);
	if (problem) {
		result.boundary = `OpenCode's configuration is not the locked-down one: ${problem}; nothing was sent`;
		return;
	}
	let settle: () => void = () => {};
	const ended = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const interrupt = () => {
		if (result.sessionId)
			void serve
				.request("POST", `/api/session/${result.sessionId}/interrupt`)
				.catch(() => {});
	};
	await serve.events(sessionEvents(result, interrupt, settle));
	const session = await serve.request<{ data?: { id?: string } }>(
		"POST",
		"/api/session",
		{
			title: "offerfinch",
			agent: "offerfinch",
			model: {
				id: input.model,
				providerID: input.source,
				...(input.variant ? { variant: input.variant } : {}),
			},
			permissions: DENY_ALL,
			location: { directory: check.dirs.cwd },
		},
	);
	result.sessionId = session.body?.data?.id ?? null;
	if (!result.sessionId) {
		result.failure = {
			type: "session",
			message: `OpenCode did not open a session (HTTP ${session.status})`,
			status: session.status,
			body: null,
		};
		return;
	}
	input.onModelCall?.();
	result.sent = true;
	const prompt = await serve.request(
		"POST",
		`/api/session/${result.sessionId}/prompt`,
		{ text: input.prompt },
	);
	if (prompt.status >= 400) {
		result.failure = {
			type: "prompt",
			message: `OpenCode refused the prompt (HTTP ${prompt.status})`,
			status: prompt.status,
			body: null,
		};
		return;
	}
	const timer = setTimeout(
		() => {
			result.timedOut = true;
			interrupt();
			settle();
		},
		input.timeoutMs ?? 10 * 60_000,
	);
	await ended;
	clearTimeout(timer);
	const messages = await serve.request<{ data?: MessageRow[] }>(
		"GET",
		`/api/session/${result.sessionId}/message`,
	);
	readAnswer(messages.body?.data ?? [], result);
}

/**
 * The call's own cleanup, after its server exited (`finishCall`: scrub, marker, then its intent):
 * unfinished (it threw, or its checkpoint was busy) keeps the cleanup pending and retries it.
 */
function scrubAfterCall(
	ctx: CleanupContext,
	intent: CallIntent,
	result: OpenCodeCallResult,
	afterDelete?: () => void,
): void {
	const finished = finishCall(ctx.target, intent, result.sessionId, {
		idle: !running.get(targetKey(ctx.target)),
		now: new Date(),
		afterDelete,
	});
	result.scrub = finished.scrub;
	result.scrubError = finished.scrubError;
	result.cleanupPending = finished.pending !== null;
	if (finished.pending) retryLater(ctx, finished.pending);
}

/**
 * Runs one locked-down OpenCode call (the recipe's steps 1 to 5) and reports what happened;
 * it never throws for an outcome the provider maps (a failure, a retry, a refusal).
 */
export async function runOpenCodeCall(
	input: OpenCodeCallInput,
): Promise<OpenCodeCallResult> {
	const parentEnv = input.parentEnv ?? process.env;
	const dataHome = input.dataHome ?? openCodeDataHome(parentEnv);
	const dbFile = openCodeDbFile(dataHome);
	const result = emptyResult(subscriptionEnv(parentEnv).removed);
	const gate = await checkOpenCodeBinary({
		binary: input.binary,
		root: input.root,
		parentEnv,
	});
	result.version = gate.version;
	if (!gate.ok) {
		result.boundary = gate.detail;
		return result;
	}
	const dirs = await prepareRoot(input.root);
	const ctx: CleanupContext = {
		target: cleanupTarget(dirs, dbFile, input.stateDir),
		binary: input.binary,
		root: input.root,
		parentEnv,
		log: input.log,
	};
	const refusal = settleCleanup(
		ctx,
		new Date(),
		input.cleanupGraceMs ?? CLEANUP_GRACE_MS,
	);
	if (refusal) {
		result.boundary = refusal;
		result.cleanupPending = true;
		result.cleanupRefused = true;
		return result;
	}
	result.cleanupPending = readPendingCleanup(ctx.target) !== null;
	// On disk before OpenCode can write anything: a crash from here on leaves a cleanup to adopt.
	let intent: CallIntent;
	try {
		intent = beginCall(ctx.target, new Date());
	} catch (error) {
		result.boundary =
			error instanceof CleanupLockBusyError
				? LOCK_REFUSAL
				: error instanceof CleanupFileError
					? CLEANUP_FILE_REFUSAL
					: INTENT_REFUSAL;
		result.cleanupRefused = true;
		return result;
	}
	const key = targetKey(ctx.target);
	running.set(key, (running.get(key) ?? 0) + 1);
	let counted = true;
	const done = () => {
		if (!counted) return;
		counted = false;
		running.set(key, (running.get(key) ?? 1) - 1);
	};
	let serve: Serve | null = null;
	let relay: Awaited<ReturnType<typeof startRelay>> | null = null;
	try {
		relay = await startRelay(input.upstream, {
			maxTokens: input.maxTokens,
			fetch: input.fetch,
		});
		result.relay = relay.log;
		const nonce = `offerfinch-${randomBytes(8).toString("hex")}`;
		const { env } = openCodeEnv(parentEnv, dirs, dataHome, {
			OPENCODE_CONFIG_CONTENT: JSON.stringify(
				openCodeConfig({
					source: input.source,
					model: input.model,
					relayUrl: relay.url,
					schema: input.schema,
					maxTokens: input.maxTokens,
					system: input.system,
					nonce,
				}),
			),
		});
		serve = await startServe({ binary: input.binary, env, cwd: dirs.cwd });
		await converse(
			serve,
			input,
			{ version: gate.version, nonce, dirs },
			result,
		);
	} catch (error) {
		result.failure ??= {
			type: "client",
			message: error instanceof Error ? error.message : String(error),
			status: null,
			body: null,
		};
	} finally {
		if (input.beforeScrub)
			await input.beforeScrub({ sessionId: result.sessionId }).catch(() => {});
		await serve?.close();
		await relay?.close();
		done();
		scrubAfterCall(ctx, intent, result, input.afterDelete);
	}
	return result;
}

// ---------------------------------------------------------------------------------------------
// Errors.

export interface OpenCodePause {
	kind: SubscriptionPauseKind;
	detail: string;
	resetsAt?: Date;
	paid?: boolean;
	notBilled?: boolean;
}

/**
 * OpenCode 2.2.5's provider error types (read from the binary): the only ones an error, a pause
 * or the log may name. Any other is "other", even a bare identifier: it may be the user's text.
 */
const FAILURE_TYPES: ReadonlySet<string> = new Set([
	"provider.auth",
	"provider.budget-limit",
	"provider.chatgpt-limit",
	"provider.content-filter",
	"provider.error",
	"provider.free-limit",
	"provider.go-limit",
	"provider.internal",
	"provider.invalid-output",
	"provider.invalid-request",
	"provider.model-budget-limit",
	"provider.no-route",
	"provider.quota",
	"provider.rate-limit",
	"provider.timeout",
	"provider.transport",
	"provider.unknown",
	"provider.unsupported-operation",
	"unknown",
]);

/** OpenCode 2.2.5's tool-like session events and message content types, for a tool attempt. */
const TOOL_ATTEMPTS: ReadonlySet<string> = new Set([
	"a tool call",
	"session.tool.called",
	"session.tool.failed",
	"session.tool.input.delta",
	"session.tool.input.ended",
	"session.tool.input.started",
	"session.tool.progress",
	"session.tool.success",
	"session.shell.started",
	"session.shell.ended",
	"session.permission.create",
	"session.permission.reply",
	...[
		"tool",
		"file",
		"agent",
		"subtask",
		"step-start",
		"step-finish",
		"snapshot",
		"patch",
		"compaction",
		"retry",
	].map((type) => `content ${type}`),
]);

/** OpenCode's error type as it may be shown; never its message or body. */
function failureType(failure: { type: string }): string {
	return knownName(failure.type, FAILURE_TYPES);
}

/** A tool attempt as it may be shown: an event or content type of OpenCode's own, else "other". */
function toolAttemptName(attempt: string): string {
	return knownName(attempt, TOOL_ATTEMPTS);
}

/** The failure's type and the upstream's status, for a pause's detail. */
function failureLabel(failure: { type: string }, upstream: number | null) {
	return `${failureType(failure)}${upstream ? `, HTTP ${upstream}` : ""}`;
}

/** `retry-after` in seconds or as an HTTP date, as a time. */
export function retryAfterDate(
	value: string | null,
	now: Date,
): Date | undefined {
	if (!value) return;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0)
		return new Date(now.getTime() + seconds * 1000);
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Maps a call's outcome to a pause, or null: a plan's limit (OpenCode's free limit, Go's limit,
 * a coding plan's rate limit) waits for its reset; a refused login waits for the user. A plan
 * model that OpenCode lists at $0 (a free model, a coding plan's) whose answer still cost money
 * drew on the paid balance and stops like Claude's extra usage. OpenCode Go lists its models at
 * their per-token price, so a Go answer's cost says nothing about the plan and is not used.
 */
export function openCodePause(
	result: Pick<OpenCodeCallResult, "failure" | "cost" | "sent" | "relay">,
	billing: LlmBilling,
	vendor: string,
	now: Date,
	/** The model is listed at $0, so any cost on its answer was charged. */
	listedFree = false,
): OpenCodePause | null {
	const upstream = result.relay?.upstreamStatus ?? null;
	const notBilled =
		!result.sent ||
		!result.relay?.forwarded ||
		(upstream !== null && NOT_BILLED_STATUSES.has(upstream));
	const failure = result.failure;
	const text = `${failure?.type ?? ""} ${failure?.message ?? ""} ${failure?.body ?? ""}`;
	if (failure) {
		if (
			failure.type === "provider.auth" ||
			upstream === 401 ||
			upstream === 403
		)
			return {
				kind: "logged_out",
				detail: `${vendor} refused OpenCode's login. Run \`opencode auth login\` (or open OpenCode so it signs in again). ${HOWTO}`,
				notBilled,
			};
		if (
			/free-limit|go-limit|FreeUsageLimit|Go limit reached|account_rate_limit|usage limit|rate.?limit/i.test(
				text,
			) ||
			upstream === 429
		)
			return {
				kind: "usage_limit",
				detail: `${vendor}'s usage limit is reached (${failureLabel(failure, upstream)}). Preparation waits and resumes after a later scan once it resets, with status in Settings › Models.`,
				resetsAt: retryAfterDate(result.relay?.retryAfter ?? null, now),
				notBilled,
			};
		if (
			/insufficient|balance|payment required|credits?/i.test(text) ||
			upstream === 402
		)
			return {
				kind: "usage_limit",
				detail: `${vendor} has no balance left for this model (${failureLabel(failure, upstream)}). Add balance in OpenCode or choose another model in Settings › Models.`,
				notBilled,
			};
		return null;
	}
	if (billing === "subscription" && listedFree && (result.cost ?? 0) > 0)
		return {
			kind: "extra_usage",
			detail: `OpenCode charged this call to your paid balance ($${(result.cost ?? 0).toFixed(4)}) instead of the plan: it is recorded at its price, and ${vendor} calls are stopped until you resume them in Settings › Models.`,
			paid: true,
		};
	return null;
}

// ---------------------------------------------------------------------------------------------
// The provider.

export interface OpenCodeProviderOptions {
	source: string;
	model: string;
	/** Effort, mapped to the model's variant of the same name when it has one. */
	effort?: string;
	ownerUserId: string;
	/** The stable private root (OfferFinch's app-data folder for OpenCode). */
	root: string;
	/** The model as listed now; the price and upstream come from it. Read at call time. */
	entry: () => OpenCodeModelEntry | null;
	/** Lists the models again (when `entry` has none yet). */
	refresh?: () => Promise<unknown>;
	binary?: string;
	parentEnv?: Record<string, string | undefined>;
	dataHome?: string;
	log?: (message: string, data?: Record<string, unknown>) => void;
	now?: () => Date;
	timeoutMs?: number;
	/** How long calls go on while an earlier cleanup is unfinished; default `CLEANUP_GRACE_MS`. */
	cleanupGraceMs?: number;
	/** Where the cleanup marker and intents live (the app's data folder); default the root. */
	stateDir?: string;
	/** Tests: stands in for `runOpenCodeCall`. */
	runCall?: (input: OpenCodeCallInput) => Promise<OpenCodeCallResult>;
	/** Tests: the user's credentials (types only). */
	credentials?: () => {
		integration: string;
		type: string;
		expiresAt: Date | null;
		active: boolean;
	}[];
	/** Tests: the relay's upstream instead of the source's own (a capture server). */
	upstream?: string;
	breaker?: Breaker;
}

/** Refusals that never trip a source's breaker (see `OpenCodeProvider.refuse`). */
const LOCAL_REFUSALS = new WeakSet<SubscriptionUnavailableError>();

/** One breaker per OpenCode source: a limit or logout stops that source's callers only. */
const BREAKERS = new Map<string, Breaker>();
function breakerFor(vendor: string): Breaker {
	let breaker = BREAKERS.get(vendor);
	if (!breaker) {
		breaker = new Breaker();
		BREAKERS.set(vendor, breaker);
	}
	return breaker;
}

/** The user resumed a source after a call it charged to the paid balance (Settings › Models). */
export function resumeOpenCodeCalls(vendor: string): void {
	breakerFor(vendor).clear("extra_usage", { paidOnly: true });
}

/** An OAuth login closer than this to expiry is not used: our server would refresh it. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

/**
 * Structured generation through OpenCode on the user's own login. Billing is per source: plan
 * sources (and OpenCode's free models) are `subscription`; any other source is pay per use,
 * priced from OpenCode's own list and held under the spending cap.
 */
export class OpenCodeProvider implements LlmProvider {
	readonly name: string;
	readonly vendor: string;
	readonly billing: LlmBilling;
	readonly ownerUserId: string;
	readonly reportsModelCalls = true;
	private readonly breaker: Breaker;
	private readonly now: () => Date;
	/** The last price the cap read (it reserves each call at the price it reads first). */
	private quoted: ModelPrice | null = null;

	constructor(private readonly options: OpenCodeProviderOptions) {
		if (!options.ownerUserId)
			throw new Error("OpenCode models need the owner's account id");
		this.name = `${OPENCODE}:${options.source}/${options.model}`;
		this.vendor = `${OPENCODE}:${options.source}`;
		this.billing = openCodeBilling(options.source, options.model);
		this.ownerUserId = options.ownerUserId;
		this.breaker = options.breaker ?? breakerFor(this.vendor);
		this.now = options.now ?? (() => new Date());
	}

	/** The model's own price, as OpenCode lists it (the cap reserves and settles at it). */
	get price(): ModelPrice | undefined {
		const price = this.options.entry()?.price ?? null;
		if (price) this.quoted = price;
		return price ?? undefined;
	}

	private pause(
		kind: SubscriptionPauseKind,
		detail: string,
		extra: { resetsAt?: Date; paid?: boolean; notBilled?: boolean } = {},
	): SubscriptionUnavailableError {
		return new SubscriptionUnavailableError(
			kind,
			this.name,
			detail,
			extra.resetsAt,
			extra.paid ?? false,
			extra.notBilled ?? false,
		);
	}

	async generateObject<T>(raw: GenerateObjectRequest<T>): Promise<T> {
		const request = redactRequest(raw);
		const open = this.breaker.current(this.now());
		if (open) throw open;
		try {
			return await this.call(request);
		} catch (error) {
			if (
				error instanceof SubscriptionUnavailableError &&
				!LOCAL_REFUSALS.has(error)
			)
				this.breaker.trip(error, this.now());
			throw error;
		}
	}

	/**
	 * A refusal about this one model on this computer (not listed yet, not offered, its price not
	 * reserved): it pauses the call but never stops the source's other models.
	 */
	private refuse(detail: string): SubscriptionUnavailableError {
		const error = this.pause("boundary", detail, { notBilled: true });
		LOCAL_REFUSALS.add(error);
		return error;
	}

	private loginProblem(): string | null {
		const read = this.options.credentials;
		const parentEnv = this.options.parentEnv ?? process.env;
		let credentials: ReturnType<NonNullable<typeof read>>;
		try {
			credentials = read
				? read()
				: readOpenCodeCredentials(
						openCodeDbFile(
							this.options.dataHome ?? openCodeDataHome(parentEnv),
						),
					);
		} catch {
			return "OpenCode's database could not be read";
		}
		const mine = credentials.filter(
			(c) => c.integration === this.options.source && c.active,
		);
		const soon = this.now().getTime() + EXPIRY_MARGIN_MS;
		const expired = mine.find(
			(c) => c.type === "oauth" && c.expiresAt && c.expiresAt.getTime() < soon,
		);
		if (expired)
			return `the ${this.options.source} login in OpenCode has expired (${expired.expiresAt?.toISOString()}). Open OpenCode once so it refreshes its own login; OfferFinch never refreshes it`;
		if (!mine.length && !KEYLESS_SOURCES.includes(this.options.source))
			return `OpenCode is not signed in to ${this.options.source}. Run \`opencode auth login\``;
		return null;
	}

	private async call<T>(request: GenerateObjectRequest<T>): Promise<T> {
		const quoted = this.quoted;
		if (process.platform === "win32")
			throw this.pause("boundary", OPENCODE_WINDOWS_OFF, { notBilled: true });
		const parentEnv = this.options.parentEnv ?? process.env;
		const binary =
			this.options.binary ?? findOpenCodeBinary(parentEnv.PATH ?? "");
		if (!binary)
			throw this.pause(
				"logged_out",
				`OpenCode (\`opencode\`) was not found. Install it (\`${OPENCODE_INSTALL}\`), run \`opencode auth login\`, then check Settings › Models.`,
				{ notBilled: true },
			);
		let entry = this.options.entry();
		if (!entry && this.options.refresh) {
			await this.options.refresh().catch(() => {});
			entry = this.options.entry();
		}
		if (!entry)
			throw this.refuse(
				`${this.options.source}/${this.options.model} is not in OpenCode's model list on this computer. Choose another model in Settings › Models.`,
			);
		if (entry.unavailable) throw this.refuse(entry.unavailable);
		// A pay-per-use call is sent only at the price the cap reserved it at.
		if (
			this.billing === "api" &&
			(!quoted ||
				!entry.price ||
				entry.price.output > quoted.output ||
				entry.price.input > quoted.input)
		)
			throw this.refuse(
				`the price of ${this.options.source}/${this.options.model} was not known when the call was reserved; it runs on the next try.`,
			);
		const login = this.loginProblem();
		if (login)
			throw this.pause("logged_out", `${login}. ${HOWTO}`, { notBilled: true });
		const upstream = this.options.upstream ?? entry.baseURL;
		if (!upstream)
			throw this.pause("boundary", `${entry.source} has no API address`, {
				notBilled: true,
			});
		const schema = toStrictJsonSchema(request.schema as z.ZodType);
		const effort = this.options.effort;
		// What the cap reserved for (MeteredLlm reserves at the same default).
		const maxTokens = request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
		const result = await (this.options.runCall ?? runOpenCodeCall)({
			binary,
			root: this.options.root,
			dataHome: this.options.dataHome,
			source: this.options.source,
			model: this.options.model,
			variant: effort && entry.variants.includes(effort) ? effort : undefined,
			upstream,
			system: `${request.system}\n\nAnswer with one JSON object that matches this JSON schema, and nothing else:\n${JSON.stringify(schema)}`,
			prompt: fullPrompt(request),
			schema,
			maxTokens,
			parentEnv,
			timeoutMs: this.options.timeoutMs,
			cleanupGraceMs: this.options.cleanupGraceMs,
			stateDir: this.options.stateDir,
			log: this.options.log,
			onModelCall: () => request.onModelCall?.(),
		});
		return this.outcome(request, result, maxTokens);
	}

	private outcome<T>(
		request: GenerateObjectRequest<T>,
		result: OpenCodeCallResult,
		maxTokens: number,
	): T {
		this.options.log?.("opencode call", {
			provider: this.name,
			version: result.version,
			sent: result.sent,
			forwarded: result.relay?.forwarded ?? 0,
			refused: result.relay?.refused ?? 0,
			upstreamStatus: result.relay?.upstreamStatus ?? null,
			retried: result.retried,
			toolAttempt: result.toolAttempt && toolAttemptName(result.toolAttempt),
			boundary: result.boundary,
			failure: result.failure ? failureType(result.failure) : null,
			scrubbedRows: result.scrub?.rows ?? null,
			scrubBusy: result.scrub?.busy ?? null,
			scrubError: result.scrubError,
			cleanupPending: result.cleanupPending,
			limitClamped: result.relay?.limitClamped ?? null,
			removedEnv: result.removedEnv,
		});
		if (result.scrubError || (result.scrub && !result.scrub.clean))
			this.options.log?.(
				"warning: the OpenCode call's cleanup did not finish in OpenCode's database; it is retried, and OpenCode calls stop if it stays unfinished",
				{ provider: this.name, error: result.scrubError },
			);
		if (
			result.tokens &&
			result.tokens.output + result.tokens.reasoning > maxTokens
		)
			this.options.log?.(
				"warning: the answer used more output tokens than its limit (the source does not count reasoning in it)",
				{
					provider: this.name,
					maxTokens,
					output: result.tokens.output,
					reasoning: result.tokens.reasoning,
				},
			);
		if (result.tokens) {
			const usage: LlmUsage = {
				model: `${this.options.source}/${this.options.model}`,
				inputTokens: result.tokens.input,
				outputTokens: result.tokens.output + result.tokens.reasoning,
				cachedInputTokens: result.tokens.cache.read,
				cacheWriteTokens: result.tokens.cache.write,
			};
			request.onUsage?.(usage);
		}
		// About this computer's cleanup, not the source: never trips the breaker, so calls resume
		// as soon as the cleanup finishes.
		if (result.cleanupRefused)
			throw this.refuse(result.boundary ?? CLEANUP_REFUSAL);
		if (result.boundary)
			throw this.pause("boundary", result.boundary, {
				notBilled: !result.sent,
			});
		const price = this.options.entry()?.price;
		const listedFree =
			!!price &&
			price.input === 0 &&
			price.output === 0 &&
			price.cachedInput === 0;
		const pause = openCodePause(
			result,
			this.billing,
			this.vendor,
			this.now(),
			listedFree,
		);
		if (pause) throw this.pause(pause.kind, pause.detail, pause);
		this.throwFailure(request, result);
		if (result.text === null)
			throw new Error(`${this.name}: ${request.task} ended without an answer`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripFence(result.text));
		} catch {
			throw unreadableAnswer(this.name, request.task, result.text);
		}
		return parseAnswer(request.schema, parsed, this.name, request.task);
	}

	/**
	 * A call that ended without an answer. Pay per use: when the request never left the relay, or
	 * the vendor refused it before processing (400, 401, 403, 404, 413, 422, 429), it was not
	 * billed, and says so, so the cap releases its reservation instead of holding it.
	 */
	private throwFailure<T>(
		request: GenerateObjectRequest<T>,
		result: OpenCodeCallResult,
	): void {
		const message = this.failureMessage(request, result);
		if (!message) return;
		const upstream = result.relay?.upstreamStatus ?? null;
		const notBilled =
			!result.relay?.forwarded ||
			(upstream !== null && NOT_BILLED_STATUSES.has(upstream));
		if (this.billing === "api" && notBilled && !result.tokens)
			throw new LlmNotBilledError(request.task, upstream ?? 400, message);
		throw new Error(message);
	}

	private failureMessage<T>(
		request: GenerateObjectRequest<T>,
		result: OpenCodeCallResult,
	): string | null {
		if (result.toolAttempt)
			return `${this.name}: the model tried to use a tool during ${request.task} (${toolAttemptName(result.toolAttempt)}); OpenCode offered none, the session was stopped and the answer discarded.`;
		if (result.retried)
			return `${this.name}: OpenCode scheduled a retry during ${request.task}; it was stopped after one request${result.relay?.upstreamStatus ? ` (upstream HTTP ${result.relay.upstreamStatus})` : ""}.`;
		if (result.timedOut) return `${this.name}: ${request.task} timed out`;
		if (result.failure) {
			const status = result.relay?.upstreamStatus ?? result.failure.status;
			return `${this.name}: ${request.task} failed: ${failureType(result.failure)}${status ? ` (HTTP ${status})` : ""}`;
		}
		return null;
	}
}

/** A model that wraps its JSON in a Markdown fence despite the schema. */
function stripFence(text: string): string {
	const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
	return fenced?.[1] ?? text;
}
