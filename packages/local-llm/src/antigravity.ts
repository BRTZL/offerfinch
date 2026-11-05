import { existsSync } from "node:fs";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fullPrompt,
	type GenerateObjectRequest,
	type LlmProvider,
	type LlmUsage,
	redactRequest,
	type SubscriptionPauseKind,
	SubscriptionUnavailableError,
} from "@offerfinch/core/scoring/llm";
import { z } from "zod";
import { type Gate, type GateRecord, startGate } from "./antigravity-gate";
import {
	ANTIGRAVITY_VERSION,
	type AntigravityInstall,
} from "./antigravity-release";
import { Breaker } from "./breaker";
import { type RpcMessage, startAppServer } from "./codex-rpc";
import { subscriptionEnv } from "./env";

/**
 * Gemini (and the other models Google's plan offers) through Google's Antigravity ACP server
 * 1.4.1, on OfferFinch's own Google sign-in. One server process per call in a private root that
 * is deleted afterwards; no tools, no user files, one model request (docs/model-providers.md,
 * "Antigravity recipe").
 */

export const ANTIGRAVITY_SUBSCRIPTION = "antigravity";
export const ANTIGRAVITY_VENDOR = "google";
export const ANTIGRAVITY_WINDOWS =
	"Gemini (Antigravity) is not available on Windows yet.";

const ROOT_PREFIX = "offerfinch-agy-";
/** The only PATH the lockdown proof ran with. */
const SERVER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const AUTH_SETTINGS = JSON.stringify({ auth: { type: "oauth-personal" } });
/** No tools and no MCP servers, under the 1.4.1 name and the legacy one it still reads. */
const LOCKDOWN_META = {
	antigravity: { enabledTools: [] },
	agy: { enabledTools: [] },
};
const SIGN_IN =
	"Sign in with Google for Gemini (Antigravity) in Settings › Models.";

export type AntigravityEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevel = "low" | "medium" | "high";
const LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high"];

/** The runtime's `thinking_level` for an effort: the top two map to high; unset is high. */
export function thinkingLevel(effort?: AntigravityEffort): ThinkingLevel {
	return effort === "low" || effort === "medium" ? effort : "high";
}

/** A model family the server offers, and the thinking levels it takes. */
export interface AntigravityFamily {
	id: string;
	name: string;
	levels: ThinkingLevel[];
}

/** The model the wire request names: `<family>-<level>`, or the family when it has no levels. */
export function wireModel(
	family: AntigravityFamily,
	level: ThinkingLevel,
): string {
	return family.levels.length ? `${family.id}-${level}` : family.id;
}

/** The families from `session/new`: `configOptions[model]`, levels from the legacy model list. */
export function familiesOf(session: unknown): AntigravityFamily[] {
	const s = session as {
		configOptions?: {
			id?: string;
			options?: { value?: string; name?: string }[];
		}[];
		models?: { availableModels?: { modelId?: string }[] };
	};
	const slugs = new Set(
		(s?.models?.availableModels ?? []).map((m) => String(m.modelId ?? "")),
	);
	const option = s?.configOptions?.find((o) => o.id === "model");
	return (option?.options ?? [])
		.filter(
			(o): o is { value: string; name?: string } => typeof o.value === "string",
		)
		.map((o) => ({
			id: o.value,
			name: o.name || o.value,
			levels: LEVELS.filter((level) => slugs.has(`${o.value}-${level}`)),
		}));
}

/** The answer's JSON: code fences stripped, else the outermost object in the text. */
export function parseJsonAnswer(text: string): unknown {
	let body = text.trim();
	const fence = /^```[a-z]*\s*\n?([\s\S]*?)\n?\s*```$/i.exec(body);
	if (fence?.[1] !== undefined) body = fence[1].trim();
	try {
		return JSON.parse(body);
	} catch {}
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(body.slice(start, end + 1));
		} catch {}
	}
	throw new SyntaxError("no JSON object in the answer");
}

/** What the model is sent: our system text, how to answer, then the prompt. */
export function antigravityPrompt<T>(
	request: GenerateObjectRequest<T>,
): string {
	const schema = z.toJSONSchema(request.schema as z.ZodType, {
		target: "draft-7",
	}) as Record<string, unknown>;
	delete schema.$schema;
	const text = [
		request.system,
		`Answer with one JSON object only, matching this JSON Schema. No prose, no Markdown, no code fences.\n${JSON.stringify(schema)}`,
		fullPrompt(request),
	]
		.filter(Boolean)
		.join("\n\n");
	// A prompt starting with "/" would be read as one of the server's own commands.
	return text.trimStart().startsWith("/") ? `Task:\n${text}` : text;
}

/** "reset in 4 hours, 12 minutes" (the server's quota text), from now. */
function resetFromText(text: string, now: Date): Date | undefined {
	const match = /reset in ((?:\d+\s*\w+[,\s]*)+)/i.exec(text);
	if (!match?.[1]) return;
	let ms = 0;
	for (const [, n, unit] of match[1].matchAll(
		/(\d+)\s*(day|hour|minute|second)/gi,
	))
		ms +=
			Number(n) *
			({ day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1000 }[
				(unit ?? "").toLowerCase() as "day"
			] ?? 0);
	return ms ? new Date(now.getTime() + ms) : undefined;
}

/** The pause an error answer stands for, read from the gate first, then the answer text. */
export function errorPause(
	gate: Pick<GateRecord, "forwarded" | "error">,
	text: string,
	now: Date,
): { kind: SubscriptionPauseKind; detail: string; resetsAt?: Date } | null {
	const error = gate.error;
	if (gate.forwarded && error) {
		const quota =
			error.reason === "QUOTA_EXHAUSTED" ||
			(error.status === 429 &&
				error.reason !== "MODEL_CAPACITY_EXHAUSTED" &&
				/quota|usage limit/i.test(error.message));
		if (quota)
			return {
				kind: "usage_limit",
				detail: `Google's usage limit for this model is reached: ${error.message.slice(0, 200)}`,
				resetsAt: error.resetsAt ?? resetFromText(text, now),
			};
		if (error.status === 401)
			return {
				kind: "logged_out",
				detail: `Google refused the sign-in. ${SIGN_IN}`,
			};
		return null;
	}
	if (gate.forwarded) return null;
	if (/usage limit reached|exhausted your (capacity|quota)|quota/i.test(text))
		return {
			kind: "usage_limit",
			detail: `Google's usage limit is reached: ${text.slice(0, 200)}`,
			resetsAt: resetFromText(text, now),
		};
	if (
		/invalid authentication credentials|unauthenticated|not signed in/i.test(
			text,
		)
	)
		return {
			kind: "logged_out",
			detail: `Google refused the sign-in. ${SIGN_IN}`,
		};
	return null;
}

// ---------------------------------------------------------------------------------------------
// One server process.

interface Root {
	root: string;
	cwd: string;
	home: string;
	tmp: string;
	geminiHome: string;
	tokenFile: string;
	browser: string;
	browserUrl: string;
}

async function makeRoot(tokenFile: string | null): Promise<Root> {
	const base = await realpath(tmpdir());
	const root = await mkdtemp(join(base, ROOT_PREFIX));
	await chmod(root, 0o700);
	if (root.includes("'")) throw new Error("unusable temp folder name");
	const r: Root = {
		root,
		cwd: join(root, "cwd"),
		home: join(root, "home"),
		tmp: join(root, "tmp"),
		geminiHome: join(root, "gh"),
		tokenFile: join(root, "gh", "antigravity-acp", "acp_token.json"),
		browser: join(root, "browser.sh"),
		browserUrl: join(root, "browser-url"),
	};
	for (const dir of [
		r.cwd,
		r.home,
		r.tmp,
		join(r.geminiHome, "antigravity-acp"),
	])
		await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(
		join(r.geminiHome, "antigravity-acp", "settings.json"),
		AUTH_SETTINGS,
	);
	if (tokenFile) {
		await copyFile(tokenFile, r.tokenFile);
		await chmod(r.tokenFile, 0o600);
	}
	// The server opens its sign-in page with $BROWSER: the URL is written here, nothing opens.
	await writeFile(
		r.browser,
		`#!/bin/sh\nprintf '%s\\n' "$1" > '${r.browserUrl}.part' && mv '${r.browserUrl}.part' '${r.browserUrl}'\nexit 0\n`,
		{ mode: 0o700 },
	);
	return r;
}

/** Deletes call roots a crash left behind (at start; never while calls may run). */
export async function sweepAntigravityRoots(
	olderThanMs = 10 * 60_000,
	now = Date.now(),
): Promise<number> {
	const base = await realpath(tmpdir());
	let removed = 0;
	for (const name of await readdir(base).catch(() => [] as string[])) {
		if (!name.startsWith(ROOT_PREFIX)) continue;
		const path = join(base, name);
		try {
			const info = await stat(path);
			if (!info.isDirectory() || now - info.mtimeMs < olderThanMs) continue;
			await rm(path, { recursive: true, force: true, maxRetries: 3 });
			removed += 1;
		} catch {}
	}
	return removed;
}

export type SessionMode =
	| { kind: "call"; family: string; level: ThinkingLevel; prompt: string }
	| { kind: "models" }
	| { kind: "signIn"; onUrl: (url: string) => void };

export interface SessionInput {
	runtime: AntigravityInstall;
	/** OfferFinch's sign-in, copied into the call's root; null for the sign-in itself. */
	tokenFile: string | null;
	mode: SessionMode;
	parentEnv?: Record<string, string | undefined>;
	timeoutMs?: number;
	upstream?: string;
	fetch?: typeof fetch;
	/** The model request left the gate (the prompt is sent). */
	onModelCall?: () => void;
	/** Sign-in only: where the new token file is put. */
	saveToken?: (file: string) => Promise<void>;
	/** Tests: inspect the root before it is deleted. */
	inspectRoot?: (root: string) => Promise<void> | void;
}

export interface SessionResult {
	version: string | null;
	tier: string | null;
	families: AntigravityFamily[];
	text: string;
	stopReason: string | null;
	/** The session broke the lockdown: a tool call, a permission or client request, another version. */
	boundary: string | null;
	/** The server wanted a browser sign-in (the token is missing or revoked). */
	loggedOut: boolean;
	/** The session failed for another reason (an RPC error, the process exited, a timeout). */
	failure: string | null;
	gate: GateRecord;
	removedEnv: string[];
}

function serverEnv(
	r: Root,
	runtime: AntigravityInstall,
	gate: Gate,
	parentEnv: Record<string, string | undefined>,
): { env: Record<string, string>; removed: string[] } {
	const { env: allowed, removed } = subscriptionEnv(parentEnv);
	const env: Record<string, string> = {
		PATH: SERVER_PATH,
		HOME: r.home,
		TMPDIR: `${r.tmp}/`,
		GEMINI_HOME: r.geminiHome,
		AGY_ACP_FORCE_FILE_STORAGE: "1",
		AGY_ACP_CCPA_BASE_URL: gate.url,
		ANTIGRAVITY_HARNESS_PATH: runtime.harness,
		PYTHONUNBUFFERED: "1",
		BROWSER: r.browser,
	};
	for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ"])
		if (allowed[key]) env[key] = allowed[key];
	return { env, removed };
}

/**
 * Runs one Antigravity server session: initialize (no fs, no terminal), authenticate, a session
 * with no tools and no MCP servers, then the mode's work. Every permission request is cancelled
 * and every fs or terminal request refused, and any of them, or a tool call, ends the session as
 * a boundary failure. The root is deleted afterwards.
 */
export async function runAntigravitySession(
	input: SessionInput,
): Promise<SessionResult> {
	const r = await makeRoot(input.tokenFile);
	const result: SessionResult = {
		version: null,
		tier: null,
		families: [],
		text: "",
		stopReason: null,
		boundary: null,
		loggedOut: false,
		failure: null,
		gate: {
			forwarded: false,
			violation: null,
			refused: [],
			status: null,
			error: null,
			usage: null,
			modelVersion: null,
			functionCalls: [],
		},
		removedEnv: [],
	};
	let gate: Gate | null = null;
	let session: ServerSession | null = null;
	try {
		gate = await startGate({
			upstream: input.upstream,
			fetch: input.fetch,
			onForward: input.onModelCall,
		});
		result.gate = gate.record;
		session = startSession(r, input, gate, result);
		try {
			await converse(session.ask, r, input, result, gate);
		} catch (error) {
			if (!result.boundary && !result.loggedOut)
				result.failure = error instanceof Error ? error.message : String(error);
		}
		return result;
	} finally {
		await session?.end();
		await gate?.close();
		await rm(r.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 200,
		});
	}
}

interface ServerSession {
	/** A request to the server; rejects when the session is stopped. */
	ask<T>(method: string, params: unknown): Promise<T>;
	/** Kills the process group and waits (bounded) for it to exit. */
	end(): Promise<void>;
}

/** Starts the server and holds it to the session's rules; any breach stops it at once. */
function startSession(
	r: Root,
	input: SessionInput,
	gate: Gate,
	result: SessionResult,
): ServerSession {
	const { env, removed } = serverEnv(
		r,
		input.runtime,
		gate,
		input.parentEnv ?? process.env,
	);
	result.removedEnv = removed;
	let stop: (why: string) => void = () => {};
	const stopped = new Promise<never>((_, reject) => {
		stop = (why) => reject(new Error(why));
	});
	stopped.catch(() => {});
	let usageUpdates = 0;
	const server = startAppServer({
		command: input.runtime.server,
		args: [],
		env,
		cwd: r.cwd,
		jsonrpc: true,
		label: "the Antigravity server",
		onServerRequest: (message: RpcMessage) => {
			if (message.method === "session/request_permission") {
				violation("the server asked for a permission");
				return { result: { outcome: { outcome: "cancelled" } } };
			}
			violation(
				`the server asked the client for ${String(message.method).slice(0, 60)}`,
			);
			return {
				error: { code: -32601, message: "Tools and user input are disabled." },
			};
		},
		onNotification: (message: RpcMessage) => {
			if (message.method !== "session/update") return;
			const update = (message.params as { update?: Record<string, unknown> })
				?.update;
			const kind = update?.sessionUpdate;
			if (kind === "tool_call" || kind === "tool_call_update")
				violation("the server started a tool call");
			else if (kind === "agent_message_chunk") {
				const content = update?.content as
					| { type?: string; text?: string }
					| undefined;
				if (content?.type === "text" && typeof content.text === "string")
					result.text += content.text;
			} else if (kind === "usage_update" && ++usageUpdates > 1)
				violation("the server ran a second model turn");
		},
	});
	function halt(why: string) {
		server.kill();
		stop(why);
	}
	function violation(why: string) {
		result.boundary ??= why;
		halt(why);
	}
	void server.exited.then(() => stop("the Antigravity server exited"));
	// The server opens a sign-in page through $BROWSER: outside a sign-in that means signed out.
	let urlSeen = false;
	const poll = setInterval(() => {
		if (urlSeen || !existsSync(r.browserUrl)) return;
		urlSeen = true;
		const mode = input.mode;
		if (mode.kind !== "signIn") {
			result.loggedOut = true;
			halt("the sign-in is missing or expired");
			return;
		}
		void readFile(r.browserUrl, "utf8").then((url) => {
			if (!isSignInUrl(url.trim())) violation("an unexpected sign-in page");
			else mode.onUrl(url.trim());
		});
	}, 150);
	const timer = setTimeout(() => halt("timed out"), input.timeoutMs ?? 180_000);
	return {
		ask: <T>(method: string, params: unknown) =>
			Promise.race([server.request<T>(method, params), stopped]),
		async end() {
			clearInterval(poll);
			clearTimeout(timer);
			server.kill();
			await Promise.race([
				server.exited,
				new Promise((done) => setTimeout(done, 3000)),
			]);
		},
	};
}

/** The session's steps: initialize, authenticate, a locked session, then the mode's work. */
async function converse(
	ask: ServerSession["ask"],
	r: Root,
	input: SessionInput,
	result: SessionResult,
	gate: Gate,
): Promise<void> {
	const init = await ask<{ agentInfo?: { version?: string } }>("initialize", {
		protocolVersion: 1,
		clientInfo: { name: "offerfinch", version: "0.0.0" },
		clientCapabilities: {
			fs: { readTextFile: false, writeTextFile: false },
			terminal: false,
		},
	});
	result.version = init?.agentInfo?.version ?? null;
	if (result.version !== ANTIGRAVITY_VERSION) {
		result.boundary = `the server is version ${result.version ?? "unknown"}, not the tested ${ANTIGRAVITY_VERSION}`;
		return;
	}
	const auth = await ask<{
		_meta?: { antigravity?: { tier?: { name?: string } } };
	}>("authenticate", { methodId: "oauth-personal" });
	result.tier = auth?._meta?.antigravity?.tier?.name ?? null;
	const mode = input.mode;
	if (mode.kind === "signIn") {
		if (!existsSync(r.tokenFile)) throw new Error("the sign-in did not finish");
		await input.saveToken?.(r.tokenFile);
		return;
	}
	const session = await ask<{ sessionId?: string }>("session/new", {
		cwd: r.cwd,
		mcpServers: [],
		_meta: LOCKDOWN_META,
	});
	result.families = familiesOf(session);
	if (mode.kind === "models") return;
	const sessionId = session?.sessionId;
	const family = result.families.find((f) => f.id === mode.family);
	if (!sessionId || !family) {
		result.failure = `Gemini (Antigravity) does not offer ${mode.family} to this account now. Choose another model in Settings › Models.`;
		return;
	}
	const level = family.levels.includes(mode.level) ? mode.level : "high";
	await ask("session/set_mode", { sessionId, modeId: "default" });
	await ask("session/set_config_option", {
		sessionId,
		configId: "model",
		value: family.id,
	});
	if (family.levels.length)
		await ask("session/set_config_option", {
			sessionId,
			configId: "thinking_level",
			value: level,
		});
	gate.expect(wireModel(family, level));
	const answer = await ask<{ stopReason?: string }>("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: mode.prompt }],
	});
	result.stopReason = answer?.stopReason ?? null;
	await input.inspectRoot?.(r.root);
}

/** Google's own sign-in page, returning to the server's loopback port. */
export function isSignInUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.protocol !== "https:" || u.hostname !== "accounts.google.com")
			return false;
		const back = new URL(u.searchParams.get("redirect_uri") ?? "");
		return (
			back.protocol === "http:" &&
			(back.hostname === "127.0.0.1" || back.hostname === "localhost")
		);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------------------------
// Sign-in and the model list.

/** Where OfferFinch keeps its Google sign-in: only this file and the auth settings. */
export function antigravityTokenFile(geminiHome: string): string {
	return join(geminiHome, "antigravity-acp", "acp_token.json");
}

/**
 * OfferFinch's own Google sign-in: the server's `authenticate oauth-personal` in a private root,
 * the sign-in page handed to `onUrl` (the desktop opens it in the browser), and the token it
 * writes moved into `geminiHome` (mode 600). Throws when it does not finish in time.
 */
export async function signInAntigravity(input: {
	runtime: AntigravityInstall;
	geminiHome: string;
	onUrl: (url: string) => void;
	parentEnv?: Record<string, string | undefined>;
	timeoutMs?: number;
}): Promise<void> {
	const result = await runAntigravitySession({
		runtime: input.runtime,
		tokenFile: null,
		mode: { kind: "signIn", onUrl: input.onUrl },
		parentEnv: input.parentEnv,
		timeoutMs: input.timeoutMs ?? 5 * 60_000,
		saveToken: async (file) => {
			const dir = join(input.geminiHome, "antigravity-acp");
			await mkdir(dir, { recursive: true, mode: 0o700 });
			await writeFile(join(dir, "settings.json"), AUTH_SETTINGS);
			const target = antigravityTokenFile(input.geminiHome);
			const part = `${target}.part`;
			await copyFile(file, part);
			await chmod(part, 0o600);
			await rename(part, target);
		},
	});
	if (result.boundary) throw new Error(`Sign-in stopped: ${result.boundary}.`);
	if (result.failure)
		throw new Error(
			result.failure === "timed out"
				? "The Google sign-in did not finish in time. Try again."
				: `The Google sign-in did not finish: ${result.failure}`,
		);
}

export interface AntigravityProbe {
	login: "logged_in" | "logged_out" | "unknown";
	detail: string;
	version: string | null;
	families: AntigravityFamily[];
}

/** Signed in and the models on offer: a session up to `session/new`, no prompt (~2.6 s). */
export async function probeAntigravity(input: {
	runtime: AntigravityInstall;
	tokenFile: string;
	parentEnv?: Record<string, string | undefined>;
	timeoutMs?: number;
	upstream?: string;
	fetch?: typeof fetch;
}): Promise<AntigravityProbe> {
	if (!existsSync(input.tokenFile))
		return {
			login: "logged_out",
			detail: SIGN_IN,
			version: null,
			families: [],
		};
	const result = await runAntigravitySession({
		runtime: input.runtime,
		tokenFile: input.tokenFile,
		mode: { kind: "models" },
		parentEnv: input.parentEnv,
		timeoutMs: input.timeoutMs ?? 30_000,
		upstream: input.upstream,
		fetch: input.fetch,
	});
	if (result.loggedOut)
		return {
			login: "logged_out",
			detail: `The Google sign-in expired. ${SIGN_IN}`,
			version: result.version,
			families: [],
		};
	if (result.boundary || result.failure || !result.families.length)
		return {
			login: "unknown",
			detail: `Gemini (Antigravity) could not be checked: ${result.boundary ?? result.failure ?? "no models listed"}.`,
			version: result.version,
			families: [],
		};
	return {
		login: "logged_in",
		detail: result.tier
			? `Signed in with Google (${result.tier}).`
			: "Signed in with Google.",
		version: result.version,
		families: result.families,
	};
}

// ---------------------------------------------------------------------------------------------
// The provider.

export interface AntigravityOptions {
	/** The model family, e.g. `gemini-3.8-flash`. */
	model: string;
	effort?: AntigravityEffort;
	ownerUserId: string;
	/** The installed, verified runtime; null when it is not installed. */
	runtime: () => Promise<AntigravityInstall | null>;
	/** OfferFinch's own sign-in (`antigravityTokenFile`), copied into each call. */
	tokenFile: string;
	parentEnv?: Record<string, string | undefined>;
	log?: (message: string, data?: Record<string, unknown>) => void;
	breaker?: Breaker;
	now?: () => Date;
	timeoutMs?: number;
	platform?: NodeJS.Platform;
	/** Tests only: where the gate forwards (a local fake of Google's endpoint). */
	upstream?: string;
	/** Tests only: inspect the call's root before it is deleted. */
	inspectRoot?: (root: string) => Promise<void> | void;
}

/** One process-wide breaker for Google: a limit or a logout stops every caller. */
const ANTIGRAVITY_BREAKER = new Breaker();

/** The model asked for a tool: the posting's doing, not the setup's. The call fails. */
export class AntigravityToolAttemptError extends Error {
	constructor(provider: string, task: string, tools: string[]) {
		super(
			`${provider}: the model tried to use a tool during ${task} (${tools.slice(0, 5).join(", ")}); no tool is offered, the server rejected it, and the answer was discarded.`,
		);
		this.name = "AntigravityToolAttemptError";
	}
}

/**
 * Structured generation on the user's Google plan (Google AI Pro/Ultra) through the pinned
 * Antigravity ACP server. Local only. The answer is prompted as JSON and checked against the
 * schema; an answer that fails it is a failed call, not a pause.
 */
export class AntigravityProvider implements LlmProvider {
	readonly name: string;
	readonly billing = "subscription" as const;
	readonly vendor = ANTIGRAVITY_VENDOR;
	readonly ownerUserId: string;
	private readonly breaker: Breaker;
	private readonly now: () => Date;

	constructor(private readonly options: AntigravityOptions) {
		if (!options.ownerUserId)
			throw new Error("antigravity needs the owner's account id");
		this.name = `${ANTIGRAVITY_SUBSCRIPTION}:${options.model}`;
		this.ownerUserId = options.ownerUserId;
		this.breaker = options.breaker ?? ANTIGRAVITY_BREAKER;
		this.now = options.now ?? (() => new Date());
	}

	private pause(
		kind: SubscriptionPauseKind,
		detail: string,
		resetsAt?: Date,
	): SubscriptionUnavailableError {
		return new SubscriptionUnavailableError(kind, this.name, detail, resetsAt);
	}

	async generateObject<T>(raw: GenerateObjectRequest<T>): Promise<T> {
		const request = redactRequest(raw);
		const open = this.breaker.current(this.now());
		if (open) throw open;
		try {
			return await this.call(request);
		} catch (error) {
			if (error instanceof SubscriptionUnavailableError)
				this.breaker.trip(error, this.now());
			throw error;
		}
	}

	private async call<T>(request: GenerateObjectRequest<T>): Promise<T> {
		if ((this.options.platform ?? process.platform) === "win32")
			throw this.pause("boundary", ANTIGRAVITY_WINDOWS);
		const runtime = await this.options.runtime();
		if (!runtime)
			throw this.pause(
				"logged_out",
				"Gemini (Antigravity) is not installed. Install it in Settings › Models.",
			);
		if (!existsSync(this.options.tokenFile))
			throw this.pause("logged_out", SIGN_IN);
		const level = thinkingLevel(this.options.effort);
		const result = await runAntigravitySession({
			runtime,
			tokenFile: this.options.tokenFile,
			mode: {
				kind: "call",
				family: this.options.model,
				level,
				prompt: antigravityPrompt(request),
			},
			parentEnv: this.options.parentEnv,
			timeoutMs: this.options.timeoutMs,
			upstream: this.options.upstream,
			onModelCall: () => request.onModelCall?.(),
			inspectRoot: this.options.inspectRoot,
		});
		const gate = result.gate;
		this.options.log?.("antigravity session", {
			provider: this.name,
			version: result.version,
			level,
			forwarded: gate.forwarded,
			status: gate.status,
			refused: gate.refused,
			violation: gate.violation,
			boundary: result.boundary,
			loggedOut: result.loggedOut,
			stopReason: result.stopReason,
			cwd: "(empty temp directory, deleted)",
			removedEnv: result.removedEnv,
		});
		if (gate.usage) {
			const usage: LlmUsage = {
				model: gate.modelVersion ?? this.options.model,
				inputTokens: Math.max(
					0,
					gate.usage.promptTokens - gate.usage.cachedTokens,
				),
				outputTokens: gate.usage.outputTokens + gate.usage.thoughtTokens,
				cachedInputTokens: gate.usage.cachedTokens,
				cacheWriteTokens: 0,
			};
			request.onUsage?.(usage);
		}
		const boundary = gate.violation ?? result.boundary;
		if (boundary)
			throw this.pause(
				"boundary",
				`the Antigravity session was not a pure model call (${boundary}); nothing is kept. Re-run \`pnpm --filter @offerfinch/local-llm test\` against Antigravity ${ANTIGRAVITY_VERSION}.`,
			);
		if (result.loggedOut)
			throw this.pause("logged_out", `The Google sign-in expired. ${SIGN_IN}`);
		const pause = errorPause(gate, result.text, this.now());
		if (pause) throw this.pause(pause.kind, pause.detail, pause.resetsAt);
		if (gate.functionCalls.length)
			throw new AntigravityToolAttemptError(
				this.name,
				request.task,
				gate.functionCalls,
			);
		if (gate.error)
			throw new Error(
				`${this.name}: ${request.task} failed: Google answered ${gate.error.status}: ${gate.error.message.slice(0, 200)}`,
			);
		if (result.failure)
			throw new Error(
				`${this.name}: ${request.task} failed: ${result.failure.slice(0, 300)}`,
			);
		if (!gate.forwarded)
			throw new Error(
				`${this.name}: ${request.task} failed before the model was asked: ${result.text.slice(0, 200) || "no answer"}`,
			);
		if (result.stopReason !== "end_turn" || !result.text.trim())
			throw new Error(
				`${this.name}: ${request.task} ended without an answer (${result.stopReason ?? "no stop reason"})`,
			);
		let parsed: unknown;
		try {
			parsed = parseJsonAnswer(result.text);
		} catch {
			throw new Error(
				`${this.name}: no valid structured output for ${request.task}: ${result.text.slice(0, 300)}`,
			);
		}
		return request.schema.parse(parsed);
	}
}

/** What Gemini (Antigravity) is, for Settings › Models. */
export const ANTIGRAVITY_STATUS = [
	`Gemini (Antigravity) runs a step on your Google plan through Google's Antigravity server ${ANTIGRAVITY_VERSION}, which OfferFinch downloads and checks against its pinned hash, on OfferFinch's own Google sign-in.`,
	"Each call is a pure model call: no tools and no MCP servers, a fresh private folder deleted afterwards, and a local gate that lets exactly one model request through after checking it offers no tools.",
].join(" ");
