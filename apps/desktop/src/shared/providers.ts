/**
 * The model providers and how a stored model choice names one (docs/model-providers.md). Pure,
 * so the worker, the renderer and the tests share it.
 */

export const PROVIDER_IDS = [
	"claude",
	"codex",
	"opencode",
	"antigravity",
] as const;
/** A provider that runs on the user's own sign-in. */
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Test runs only: the deterministic test models. Never a real provider. */
export const FAKE_PROVIDER = "fake";
/** The one stored reference to the test models. */
export const FAKE_MODEL_REF = "fake:test" as ModelRef;

/**
 * A stored model choice, `<provider>:<model>`: `claude:claude-opus-5-5`, `codex:gpt-6.1-sol`,
 * `codex:` (the account's default Codex model), `opencode:opencode-go/glm-5.1`,
 * `antigravity:gemini-3.8-flash`, or `fake:test` in test runs.
 */
export type ModelRef = `${ProviderId | typeof FAKE_PROVIDER}:${string}`;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const isEffort = (value: unknown): value is Effort =>
	typeof value === "string" && (EFFORTS as readonly string[]).includes(value);

export const PROVIDER_NAMES: Record<ProviderId, string> = {
	claude: "Claude",
	codex: "Codex",
	opencode: "OpenCode",
	antigravity: "Gemini (Antigravity)",
};

/**
 * Where each provider runs. A reason means it is off on that platform; absent, it is on.
 * Codex is macOS only (#128); OpenCode and Antigravity are unverified on Windows.
 */
export const PROVIDER_PLATFORMS: Record<
	ProviderId,
	Partial<Record<"darwin" | "win32" | "linux", string>>
> = {
	claude: {},
	codex: { win32: "Codex runs only on macOS in this version." },
	opencode: { win32: "OpenCode is not available on Windows yet." },
	antigravity: {
		win32: "Gemini (Antigravity) is not available on Windows yet.",
	},
};

/** Why a provider is off on this platform, or null when it can run here. */
export function providerOff(
	provider: ProviderId,
	platform: string,
): string | null {
	return (
		PROVIDER_PLATFORMS[provider][platform as "darwin" | "win32" | "linux"] ??
		null
	);
}

const isProviderId = (value: unknown): value is ProviderId =>
	typeof value === "string" &&
	(PROVIDER_IDS as readonly string[]).includes(value);

const MAX_MODEL = 200;

/** Why `model` cannot be a model of `provider`, or null. */
function modelProblem(
	provider: ProviderId | typeof FAKE_PROVIDER,
	model: string,
): string | null {
	if (model.length > MAX_MODEL) return "the model name is too long";
	// Printable, no spaces: a model id goes on a command line or into JSON as it is.
	if (model && !/^[\x21-\x7e]+$/.test(model))
		return "the model name has spaces or unusual characters";
	// Only Codex has an account default (the empty model).
	if (!model && provider !== "codex") return "no model named";
	if (provider === "opencode" && !/^[^/]+\/.+$/.test(model))
		return "an OpenCode model is <source>/<model>";
	return null;
}

/** A model reference's provider and model, or null when it is not one. */
export function parseModelRef(
	ref: string,
): { provider: ProviderId | typeof FAKE_PROVIDER; model: string } | null {
	const at = ref.indexOf(":");
	if (at < 0) return null;
	const provider = ref.slice(0, at);
	const model = ref.slice(at + 1);
	if (provider !== FAKE_PROVIDER && !isProviderId(provider)) return null;
	if (modelProblem(provider, model)) return null;
	return { provider, model };
}

export const isModelRef = (value: unknown): value is ModelRef =>
	typeof value === "string" && parseModelRef(value) !== null;

/** `<provider>:<model>`; throws on a model the provider cannot have. */
export function formatModelRef(
	provider: ProviderId | typeof FAKE_PROVIDER,
	model: string,
): ModelRef {
	const problem = modelProblem(provider, model);
	if (problem) throw new Error(`Bad model for ${provider}: ${problem}`);
	return `${provider}:${model}`;
}

export type Role = "scoring" | "tailoring" | "claims";
export const ROLES: readonly Role[] = ["scoring", "tailoring", "claims"];

/**
 * Claude's default per step: Opus finds matches and checks drafts, Sonnet drafts (the largest
 * call). Equal to `DEFAULT_ANTHROPIC_MODEL` and `DEFAULT_TAILOR_MODEL` in core (a test keeps
 * them so); copied here because the renderer cannot import core's Anthropic client.
 */
export const CLAUDE_DEFAULTS: Record<Role, string> = {
	scoring: "claude-opus-5-5",
	tailoring: "claude-sonnet-5-5",
	claims: "claude-opus-5-5",
};

/** One model a provider offers now, for the pickers. */
export interface ModelInfo {
	ref: ModelRef;
	name: string;
	provider: ProviderId;
	/** OpenCode: the billing source (`opencode-go`, `zai-coding-plan`, …). */
	source?: string;
	/** `subscription`: on the user's plan; `api`: pay per use, under the spending cap. */
	billing: "subscription" | "api";
	/** The effort levels the model takes; none when it has no levels. */
	efforts: Effort[];
	/** Pay-per-use only: USD per million tokens. */
	price?: { input: number; output: number };
}

/**
 * What OfferFinch does for a provider itself, from the app (`ai.install`, `ai.signIn`), instead
 * of a command the user runs in Terminal: Antigravity's ACP server is downloaded by OfferFinch
 * and signed in to with OfferFinch's own Google sign-in (docs/model-providers.md).
 */
export const PROVIDER_IN_APP: Record<
	ProviderId,
	{ install: boolean; signIn: boolean }
> = {
	claude: { install: false, signIn: false },
	codex: { install: false, signIn: false },
	opencode: { install: false, signIn: false },
	antigravity: { install: true, signIn: true },
};
