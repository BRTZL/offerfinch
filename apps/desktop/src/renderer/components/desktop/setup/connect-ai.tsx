import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ProviderState, SubscriptionTerms } from "@/components/desktop/models";
import { useStepAction } from "@/components/desktop/step-action";
import {
	ACCOUNT_NAME,
	anyModelAvailable,
	PROVIDER_HINT,
	ProviderFix,
	type ProviderView,
	providerStatus,
	STEPS,
	StepPicker,
	signedInLine,
} from "@/components/desktop/step-picker";
import { Group, Section } from "@/components/system/layout";
import { ProviderTile } from "@/components/system/provider-mark";
import { Row } from "@/components/system/rows";
import { RowsSkeleton } from "@/components/system/skeletons";
import { SparkleBurst } from "@/components/system/sparkle";
import { Button } from "@/components/ui/button";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { readyNow } from "../../../../shared/auto-connect";
import { useCelebrate } from "./celebrate";

type Detected = Awaited<ReturnType<typeof client.ai.autoConnect>>;

/** "Max plan · 3 models", "Installed. Sign in to use its models.", "Not installed." */
function detectedLine(view: ProviderView): string {
	const status = providerStatus(view);
	if (status.kind === "off") return view.off ?? "Not available here.";
	if (status.kind === "signed-in") return signedInLine(view);
	if (status.kind === "missing") return "Not installed.";
	return view.state.login.state === "not_subscription"
		? "Signed in with an API account, not a plan."
		: "Installed. Sign in to use its models.";
}

/** One provider found (or not): mark, name, what it offers, and its state or fix. */
function DetectedRow({ view }: { view: ProviderView }) {
	const status = providerStatus(view);
	const fix = view.state.fix;
	const inApp = view.inApp[status.kind === "missing" ? "install" : "signIn"];
	const command = fix && !inApp && status.kind !== "signed-in";
	return (
		<Row
			data-testid={`setup-cli-${view.provider}`}
			data-state={status.kind}
			leading={<ProviderTile provider={view.provider} />}
			title={
				<span className="flex items-center gap-2">
					{ACCOUNT_NAME[view.provider]}
					{PROVIDER_HINT[view.provider] ? (
						<span className="text-muted-foreground text-xs">
							{PROVIDER_HINT[view.provider]}
						</span>
					) : null}
				</span>
			}
			subtitle={
				<span title={view.state.login.detail}>{detectedLine(view)}</span>
			}
			detail={
				command ? (
					<span className="flex flex-col gap-1">
						<span className="mt-1 flex items-center gap-2">
							<code
								className="bg-muted text-foreground rounded-sm px-1.5 py-0.5 font-mono text-xs break-all"
								data-testid={`setup-cli-${view.provider}-command`}
							>
								{fix.command}
							</code>
							<Button
								variant="ghost"
								size="xs"
								aria-label={`Copy ${fix.command}`}
								onClick={() =>
									void desktop
										.copyText(fix.command)
										.then(() => toast.success("Copied. Paste it in Terminal."))
								}
								data-testid={`setup-cli-${view.provider}-copy`}
							>
								<Copy />
								Copy
							</Button>
						</span>
						{fix.after ? <span>{fix.after}</span> : null}
					</span>
				) : undefined
			}
			trailing={
				inApp && status.kind !== "signed-in" && status.kind !== "off" ? (
					<ProviderFix view={view} size="sm" />
				) : (
					<ProviderState view={view} />
				)
			}
		/>
	);
}

/** The starting model of each step, side by side; filled from what was found. */
function StartingModels({ detected }: { detected: Detected }) {
	const queryClient = useQueryClient();
	const ai = useQuery(orpc.ai.get.queryOptions());
	const models = useQuery({
		...orpc.ai.models.queryOptions(),
		initialData: {
			providers: detected.providers,
			fakeAllowed: detected.fakeAllowed,
		},
		staleTime: 30_000,
	});
	const save = useMutation({
		mutationFn: (next: NonNullable<typeof ai.data>["settings"]) =>
			client.ai.set(next),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.ai.key() }),
		onError: (e) => toast.error(e.message),
	});
	const settings = ai.data?.settings;
	return (
		<Section title="Starting models" data-testid="setup-starting-models">
			<Group className="divide-border grid grid-cols-3 divide-x divide-y-0">
				{STEPS.map(({ role, label }) => (
					<div
						key={role}
						className="flex min-w-0 flex-col gap-2 px-4 py-3"
						data-testid={`role-${role}`}
					>
						<span className="text-muted-foreground text-xs">{label}</span>
						{settings ? (
							<StepPicker
								role={role}
								label={label}
								value={settings[role].model}
								effort={settings[role].effort}
								providers={models.data.providers}
								fakeAllowed={models.data.fakeAllowed}
								disabled={save.isPending}
								onChange={(next) => save.mutate({ ...settings, [role]: next })}
							/>
						) : null}
					</div>
				))}
			</Group>
		</Section>
	);
}

/**
 * Setup's first step (docs/design/models/connect-ai.png): every provider looked for at once,
 * with its state or its fix; "Missing one?" with Check again; the starting model of each step,
 * filled from what was found (Claude for all three when it is signed in, else the first plan
 * model). Continue needs at least one model available; there is no Skip.
 */
export function ConnectAi({ onDone }: { onDone: () => void }) {
	const queryClient = useQueryClient();
	const { burst, celebrate } = useCelebrate();
	// The last answer stays on screen while Check again runs (a new run clears `data`).
	const [d, setDetected] = useState<Detected | null>(null);
	const detect = useMutation({
		mutationFn: (refresh: boolean) => client.ai.autoConnect({ refresh }),
		onSuccess: (result) => {
			setDetected(result);
			queryClient.setQueryData(orpc.ai.models.queryKey(), {
				providers: result.providers,
				fakeAllowed: result.fakeAllowed,
			});
			return Promise.all([
				queryClient.invalidateQueries({ queryKey: orpc.ai.get.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.desktop.key() }),
			]);
		},
		onError: (e) => toast.error(e.message),
	});
	const detectNow = detect.mutate;
	useEffect(() => detectNow(false), [detectNow]);
	const ai = useQuery(orpc.ai.get.queryOptions());
	// The rows follow the live model list: a sign-in or install from a row refreshes it.
	const live = useQuery({
		...orpc.ai.models.queryOptions(),
		enabled: d !== null,
	});
	const providers = live.data?.providers ?? d?.providers ?? [];
	const signedIn = Object.fromEntries(
		providers.map((p) => [p.provider, p.signedIn]),
	);
	// A step is ready only while its provider is signed in, whatever the settings say.
	const roles = readyNow(ai.data?.roles ?? d?.roles ?? [], signedIn);
	const allSet = roles.length === 3 && roles.every((r) => r.ready);
	const available = d ? anyModelAvailable(providers, d.fakeAllowed) : false;
	useStepAction({
		label: "Continue",
		onClick: onDone,
		disabled: !available,
		testId: "step-continue",
		title: available
			? undefined
			: "Sign in to one of these first: setup needs at least one model",
	});
	// The moment the AI is connected: once, when this visit connected it (found it, or chosen
	// by hand), not on reopening a finished step.
	const before = useRef<boolean | null>(null);
	useEffect(() => {
		if (!d || !ai.data) return;
		const was = before.current;
		before.current = allSet;
		if (allSet && (was === false || (was === null && d.filled.length)))
			celebrate();
	}, [d, ai.data, allSet, celebrate]);

	const found = providers
		.filter((p) => p.signedIn)
		.map((p) => ACCOUNT_NAME[p.provider]);
	// Read out as it changes: one region, there from the first frame, so every change is said.
	const status = (
		<p
			className="sr-only"
			role="status"
			aria-live="polite"
			data-testid="setup-ai-live"
		>
			{!d
				? "Looking for your AI accounts."
				: allSet
					? "You're all set: every step has a model."
					: found.length
						? `Signed in: ${found.join(", ")}. Choose a model for every step.`
						: "No AI account is signed in yet."}
		</p>
	);
	if (!d)
		return (
			<div className="flex flex-col gap-3" data-testid="setup-ai-detecting">
				{status}
				<RowsSkeleton rows={4} twoLine />
			</div>
		);
	return (
		<div
			className="flex flex-col gap-8"
			data-testid="setup-ai"
			data-all-set={allSet || undefined}
		>
			{status}
			<div className="relative">
				<SparkleBurst burst={burst} />
				<Group>
					{providers.map((view) => (
						<DetectedRow key={view.provider} view={view} />
					))}
					<Row
						leading={
							<Download className="text-muted-foreground size-4 shrink-0" />
						}
						title={
							<span className="text-muted-foreground">
								Missing one? Install Claude Code, Codex, OpenCode or Gemini,
								then{" "}
								<Button
									variant="link"
									className="text-sm"
									pending={detect.isPending}
									onClick={() => detect.mutate(true)}
									data-testid="setup-ai-check"
								>
									Check again
								</Button>
							</span>
						}
					/>
				</Group>
			</div>
			<StartingModels detected={d} />
			<SubscriptionTerms />
		</div>
	);
}
