import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, ExternalLink, LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { ProviderMark } from "@/components/system/provider-mark";
import { Button } from "@/components/ui/button";
import {
	ModelPicker,
	type PickerGroup,
	type PickerSection,
} from "@/components/ui/model-picker";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import {
	type Effort,
	FAKE_MODEL_REF,
	type ModelInfo,
	type ModelRef,
	type ProviderId,
	parseModelRef,
	type Role,
} from "../../../shared/providers";

type Models = Awaited<ReturnType<typeof client.ai.models>>;
export type ProviderView = Models["providers"][number];

/** The steps, as every screen names them. */
export const STEPS: { role: Role; label: string; hint: string }[] = [
	{
		role: "scoring",
		label: "Finding matches",
		hint: "Scores how well each job that passes your rules fits you.",
	},
	{
		role: "tailoring",
		label: "Drafting",
		hint: "Writes the CV, letter and answers when you press Prepare.",
	},
	{
		role: "claims",
		label: "Checking drafts",
		hint: "Checks every line of a draft against your profile.",
	},
];

/** A provider's name in a list of accounts, and in the picker's group header. */
export const ACCOUNT_NAME: Record<ProviderId, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	antigravity: "Gemini",
};
const GROUP_NAME: Record<ProviderId, string> = {
	claude: "Claude",
	codex: "Codex",
	opencode: "OpenCode",
	antigravity: "Gemini",
};
export const PROVIDER_HINT: Partial<Record<ProviderId, string>> = {
	antigravity: "via Antigravity",
};

const EFFORT_LABEL: Record<Effort, string> = {
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

/** OpenCode's billing sources by name; an unknown one shows as its id. */
const SOURCE_NAME: Record<string, string> = {
	"opencode-go": "Go plan",
	"zai-coding-plan": "Z.ai Coding Plan",
	opencode: "OpenCode Zen, free models",
	openrouter: "OpenRouter",
	anthropic: "Anthropic",
	openai: "OpenAI",
};

/** Every provider and its models, as the worker last read them. */
export function useProviders() {
	return useQuery({
		...orpc.ai.models.queryOptions(),
		staleTime: 30_000,
		meta: { quiet: true },
	});
}

export type ProviderStatus = {
	kind: "signed-in" | "signed-out" | "missing" | "off";
	label: string;
};

/** Where a provider stands, in a word: Signed in, Signed out, Not installed, macOS only. */
export function providerStatus(view: ProviderView): ProviderStatus {
	if (view.off) return { kind: "off", label: "macOS only" };
	if (view.signedIn) return { kind: "signed-in", label: "Signed in" };
	if (!view.state.path) return { kind: "missing", label: "Not installed" };
	return { kind: "signed-out", label: "Signed out" };
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * The plan in a few words, from a login's detail when it names one ("Max plan", "ChatGPT
 * Plus"); null otherwise (the full detail is the line's tooltip).
 */
function planOf(view: ProviderView): string | null {
	const detail = view.state.login.detail;
	const chatgpt = /ChatGPT plan ([a-z]+)/i.exec(detail)?.[1];
	if (chatgpt && chatgpt !== "unknown") return `ChatGPT ${cap(chatgpt)}`;
	const claude = /\bplan ([a-z]+)/i.exec(detail)?.[1];
	if (view.provider === "claude" && claude) return `${cap(claude)} plan`;
	return null;
}

/** A signed-in account in one short line: "Max plan · 3 models". */
export function signedInLine(view: ProviderView): string {
	const n = view.models.length;
	const models = `${n} model${n === 1 ? "" : "s"}`;
	const plan = planOf(view);
	return plan ? `${plan} · ${models}` : models;
}

/** A model's name inside its provider's group: "Opus 5.5", not "Claude Opus 5.5". */
function shortName(model: Pick<ModelInfo, "name" | "provider">): string {
	const prefix = `${GROUP_NAME[model.provider]} `;
	const short = model.name.startsWith(prefix)
		? model.name.slice(prefix.length)
		: model.name;
	return short.charAt(0).toUpperCase() + short.slice(1);
}

const usd = (n: number) => `$${n.toFixed(2)}`;
/** Pay per use: USD per million tokens in and out. */
const price = (m: ModelInfo) =>
	m.price ? `${usd(m.price.input)} / ${usd(m.price.output)} per M` : undefined;

/** A model's option test id: `role-<role>-fake` for the test models, else its reference. */
const optionId = (role: Role, ref: string) =>
	`role-${role}-${parseModelRef(ref)?.provider === "fake" ? "fake" : ref}`;

/** OpenCode by billing source: plan sources first, then the pay-per-use ones, labelled. */
function sections(role: Role, view: ProviderView): PickerSection[] {
	const bySource = new Map<string, ModelInfo[]>();
	for (const m of view.models) {
		// A pay-per-use model without a known price is not offered.
		if (m.billing === "api" && !m.price) continue;
		const key = view.provider === "opencode" ? (m.source ?? "") : "";
		bySource.set(key, [...(bySource.get(key) ?? []), m]);
	}
	const paid = (models: ModelInfo[]) => models.some((m) => m.billing === "api");
	return [...bySource.entries()]
		.sort(([, a], [, b]) => Number(paid(a)) - Number(paid(b)))
		.map(([source, models]) => ({
			id: source || view.provider,
			label: source
				? `${SOURCE_NAME[source] ?? source}${paid(models) ? " · Pay per use" : ""}`
				: undefined,
			items: models.map((m) => ({
				value: m.ref,
				label: shortName(m),
				hint: price(m),
				keywords: `${view.name} ${source}`,
				testId: optionId(role, m.ref),
			})),
		}));
}

/** Installs or signs in from the app, or copies the Terminal command that does it. */
function useProviderAction() {
	const queryClient = useQueryClient();
	const run = useMutation({
		mutationFn: ({
			provider,
			kind,
		}: {
			provider: ProviderId;
			kind: "install" | "signIn";
		}) =>
			kind === "install"
				? client.ai.install({ provider })
				: client.ai.signIn({ provider }),
		onSuccess: (result) => {
			if (result.ok) toast.success(result.message);
			else toast.error(result.message);
			void queryClient.invalidateQueries({ queryKey: orpc.ai.key() });
		},
		onError: (e) => toast.error(e.message),
	});
	return {
		pending: run.isPending,
		/** A sign-in from the app is waiting for the browser (it can take minutes). */
		signingIn: run.isPending && run.variables?.kind === "signIn",
		/** Opens the same sign-in page again; the waiting sign-in finishes either way. */
		reopen: (view: ProviderView) =>
			void client.ai.signIn({ provider: view.provider }).catch(() => {}),
		run: (view: ProviderView) => {
			const kind = view.state.path ? "signIn" : "install";
			if (view.inApp[kind])
				return run.mutate({ provider: view.provider, kind });
			const fix = view.state.fix;
			if (fix)
				void desktop
					.copyText(fix.command)
					.then(() =>
						toast.success(
							`Copied ${fix.command}. Paste it in Terminal.${fix.after ? ` ${fix.after}` : ""}`,
						),
					);
		},
	};
}

/** Whether the app or a Terminal command can fix a provider that is not available. */
function fixable(view: ProviderView): boolean {
	const status = providerStatus(view);
	if (status.kind === "off" || status.kind === "signed-in") return false;
	return (
		view.inApp[status.kind === "missing" ? "install" : "signIn"] ||
		Boolean(view.state.fix)
	);
}

/** What fixes a provider that is not available: Install or Sign in; nothing when neither can. */
export function ProviderFix({
	view,
	size = "xs",
	variant = "outline",
}: {
	view: ProviderView;
	size?: "xs" | "sm";
	variant?: "outline" | "link";
}) {
	const action = useProviderAction();
	if (!fixable(view)) return null;
	const install = providerStatus(view).kind === "missing";
	const inApp = view.inApp[install ? "install" : "signIn"];
	if (action.signingIn)
		return (
			<span
				className="flex items-center gap-2"
				data-testid={`fix-${view.provider}-waiting`}
			>
				<span className="text-muted-foreground text-xs">
					Finish signing in in your browser
				</span>
				<Button
					variant={variant}
					size={size}
					onClick={() => action.reopen(view)}
					data-testid={`fix-${view.provider}-reopen`}
				>
					<ExternalLink />
					Open again
				</Button>
			</span>
		);
	return (
		<Button
			variant={variant}
			size={size}
			pending={action.pending}
			onClick={() => action.run(view)}
			data-testid={`fix-${view.provider}`}
			title={
				inApp
					? undefined
					: `Copies ${view.state.fix?.command} to paste in Terminal`
			}
		>
			{inApp ? install ? <Download /> : <LogIn /> : <Copy />}
			{install ? "Install" : "Sign in"}
		</Button>
	);
}

/** The picker's groups: each provider (dimmed with its fix when not available), then the test models. */
function groupsFor(
	role: Role,
	providers: ProviderView[],
	fakeAllowed: boolean,
): PickerGroup[] {
	const groups: PickerGroup[] = providers.map((view) => {
		const status = providerStatus(view);
		return {
			id: view.provider,
			mark: <ProviderMark provider={view.provider} />,
			label: GROUP_NAME[view.provider],
			hint: PROVIDER_HINT[view.provider],
			unavailable:
				status.kind === "signed-in"
					? undefined
					: {
							reason: status.label,
							action: fixable(view) ? (
								<ProviderFix view={view} variant="link" />
							) : undefined,
						},
			sections: sections(role, view),
		};
	});
	// A signed-in provider that offers nothing (no priced model) is left out.
	const shown = groups.filter((g) => g.unavailable || g.sections.length > 0);
	if (fakeAllowed)
		shown.push({
			id: "fake",
			label: "Test models",
			sections: [
				{
					id: "fake",
					items: [
						{
							value: FAKE_MODEL_REF,
							label: "Test models",
							testId: optionId(role, FAKE_MODEL_REF),
						},
					],
				},
			],
		});
	return shown;
}

/** A stored model as it reads now: its info when a provider lists it, and why it can't run. */
function describeChoice(
	model: ModelRef | null,
	providers: ProviderView[],
): {
	info: ModelInfo | null;
	provider: ProviderId | null;
	name: string;
	/** Null when it can run now. */
	unavailable: string | null;
} {
	if (!model)
		return { info: null, provider: null, name: "", unavailable: null };
	const parsed = parseModelRef(model);
	if (parsed?.provider === "fake")
		return {
			info: null,
			provider: null,
			name: "Test models",
			unavailable: null,
		};
	const provider = parsed?.provider ?? null;
	const view = providers.find((p) => p.provider === provider);
	const info = view?.models.find((m) => m.ref === model) ?? null;
	const name = info ? shortName(info) : (parsed?.model ?? model);
	if (!view) return { info, provider, name, unavailable: null };
	const status = providerStatus(view);
	const who = ACCOUNT_NAME[view.provider];
	const unavailable =
		status.kind === "off"
			? (view.off ?? `${who} does not run on this computer.`)
			: status.kind === "missing"
				? `${who} is not installed.`
				: status.kind === "signed-out"
					? `${who} is signed out.`
					: info
						? null
						: `${who} no longer offers this model.`;
	return { info, provider, name, unavailable };
}

/** One step's model and effort: the picker, with the stored choice shown as it reads now. */
export function StepPicker({
	role,
	label,
	value,
	effort,
	providers,
	fakeAllowed,
	disabled,
	onChange,
}: {
	role: Role;
	label: string;
	value: ModelRef | null;
	effort: Effort | undefined;
	providers: ProviderView[];
	fakeAllowed: boolean;
	disabled?: boolean;
	onChange: (next: { model: ModelRef; effort?: Effort }) => void;
}) {
	const choice = describeChoice(value, providers);
	const efforts = choice.info?.efforts ?? [];
	const shownEffort = effort && efforts.includes(effort) ? effort : undefined;
	let trigger: ReactNode = (
		<span className="text-muted-foreground">Choose a model</span>
	);
	if (value)
		trigger = (
			<>
				{choice.provider ? <ProviderMark provider={choice.provider} /> : null}
				<span className="truncate">
					{choice.name}
					{choice.unavailable ? " (not available now)" : ""}
				</span>
				{shownEffort ? (
					<span className="text-muted-foreground">
						· {EFFORT_LABEL[shownEffort]}
					</span>
				) : null}
			</>
		);
	return (
		<ModelPicker
			label={`${label}: model`}
			value={value}
			groups={groupsFor(role, providers, fakeAllowed)}
			trigger={trigger}
			efforts={efforts}
			effort={shownEffort}
			effortLabels={EFFORT_LABEL}
			disabled={disabled}
			data-testid={`role-${role}-mode`}
			onChange={(next) => {
				const ref = next as ModelRef;
				const info = describeChoice(ref, providers).info;
				onChange({
					model: ref,
					...(effort && info?.efforts.includes(effort) ? { effort } : {}),
				});
			}}
			onEffort={(next) => {
				if (value) onChange({ model: value, effort: next as Effort });
			}}
		/>
	);
}

/**
 * Whether a step can be given a model now: a provider on and signed in that offers one, or the
 * test models in test runs.
 */
export function anyModelAvailable(
	providers: ProviderView[],
	fakeAllowed: boolean,
): boolean {
	return (
		fakeAllowed ||
		providers.some(
			(p) =>
				p.signedIn &&
				p.models.some((m) => m.billing === "subscription" || m.price),
		)
	);
}
