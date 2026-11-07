import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PlanUsage } from "@/components/desktop/plan-usage";
import {
	ACCOUNT_NAME,
	PROVIDER_HINT,
	ProviderFix,
	type ProviderView,
	providerStatus,
	STEPS,
	StepPicker,
	signedInLine,
	useProviders,
} from "@/components/desktop/step-picker";
import {
	QueryState,
	SettingsPage,
} from "@/components/pipeline/settings/shared";
import { Notice, StatusDot } from "@/components/system/bits";
import { Group, Section } from "@/components/system/layout";
import { Disclosure } from "@/components/system/pane";
import { ProviderTile } from "@/components/system/provider-mark";
import { FormRow, Row } from "@/components/system/rows";
import { RowsSkeleton } from "@/components/system/skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import type { Role } from "../../../shared/providers";

/** The plans' usage, for the CLIs that are signed in (or were read before). */
function PlanUsageSection() {
	const subs = useQuery({
		...orpc.ai.subscriptions.queryOptions(),
		staleTime: 30_000,
		meta: { quiet: true },
	});
	const d = subs.data;
	if (!d) return <RowsSkeleton rows={2} twoLine />;
	return (
		<PlanUsage
			signedIn={{
				anthropic: d.claude.login.state === "logged_in",
				openai: d.codex.login.state === "logged_in",
			}}
		/>
	);
}

/** The plans' terms, shown wherever a subscription can be turned on. */
export function SubscriptionTerms() {
	return (
		<p
			className="text-muted-foreground text-xs"
			data-testid="subscription-terms"
		>
			Your plans fall under their providers' terms (Anthropic, OpenAI, OpenCode,
			Google). Whether a plan may use extra usage or credits is your account's
			own setting with each provider.
		</p>
	);
}

/** What protects the plans: the daily call budget. */
export function PlanLimits() {
	const queryClient = useQueryClient();
	const subs = useQuery({
		...orpc.ai.subscriptions.queryOptions(),
		staleTime: 30_000,
		meta: { quiet: true },
	});
	const [calls, setCalls] = useState<string | null>(null);
	const budget = useMutation({
		mutationFn: (dailyCalls: number | null) =>
			client.models.setCallBudget({ dailyCalls }),
		onSuccess: () => {
			setCalls(null);
			void queryClient.invalidateQueries({ queryKey: orpc.ai.key() });
		},
		onError: (e) => toast.error(e.message),
	});
	const d = subs.data;
	if (!d) return <RowsSkeleton rows={1} twoLine />;
	return (
		<div className="flex flex-col gap-3 pt-1">
			<FormRow
				label="Subscription calls per 24 hours"
				htmlFor="call-budget"
				hint={
					<span data-testid="call-budget-used">
						{d.callBudget.used} used in the last 24 hours, Claude and Codex
						together. Leaves room in the plans you also work with; jobs past it
						wait and are scored when there is room.
					</span>
				}
			>
				<form
					className="flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						budget.mutate(
							calls === "" || calls === null ? null : Number(calls),
						);
					}}
				>
					<Input
						id="call-budget"
						type="number"
						min={0}
						max={1000}
						className="w-20 tabular-nums"
						value={calls ?? String(d.callBudget.budget)}
						onChange={(e) => setCalls(e.target.value)}
					/>
					<Button variant="outline" type="submit" disabled={calls === null}>
						Save
					</Button>
				</form>
			</FormRow>
		</div>
	);
}

type Ai = Awaited<ReturnType<typeof client.ai.get>>;

const STEP_LABEL: Record<Role, string> = {
	scoring: "Finding matches",
	tailoring: "Drafting",
	claims: "Checking drafts",
};

/** Once, after an upgrade: API keys are gone, and which steps had one. */
function KeysRemovedNotice({ steps }: { steps: Role[] }) {
	const queryClient = useQueryClient();
	const dismiss = useMutation({
		mutationFn: () => client.ai.dismissKeysNotice(),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.ai.key() }),
		onError: (e) => toast.error(e.message),
	});
	const names = steps.map((r) => STEP_LABEL[r]);
	const list =
		names.length > 1
			? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
			: (names[0] ?? "");
	return (
		<Notice
			tone="info"
			title="API keys were removed"
			data-testid="keys-removed"
			actions={
				<Button
					variant="outline"
					size="sm"
					pending={dismiss.isPending}
					onClick={() => dismiss.mutate()}
					data-testid="keys-removed-dismiss"
				>
					Got it
				</Button>
			}
		>
			OfferFinch now runs only on accounts you sign in to; the keys you saved
			were deleted without being read. {list} used a key: each got a model from
			your accounts, or waits until you pick one below.
		</Notice>
	);
}

/** A copyable Terminal command. */
function CommandLine({ id, command }: { id: string; command: string }) {
	return (
		<span className="mt-1 flex items-center gap-2">
			<code
				className="bg-muted text-foreground rounded-sm px-1.5 py-0.5 font-mono text-xs break-all"
				data-testid={`account-${id}-command`}
			>
				{command}
			</code>
			<Button
				variant="ghost"
				size="xs"
				aria-label={`Copy ${command}`}
				onClick={() =>
					void desktop
						.copyText(command)
						.then(() => toast.success("Copied. Paste it in Terminal."))
				}
			>
				<Copy />
				Copy
			</Button>
		</span>
	);
}

const STATUS_TONE = {
	"signed-in": "brand",
	"signed-out": "warning",
	missing: "busy",
	off: "busy",
} as const;

/** A provider's state in a word, with its light. */
export function ProviderState({ view }: { view: ProviderView }) {
	const status = providerStatus(view);
	return (
		<span
			className="text-foreground flex items-center gap-2 text-sm whitespace-nowrap"
			data-testid={`account-${view.provider}-state`}
			data-state={status.kind}
		>
			<StatusDot tone={STATUS_TONE[status.kind]} />
			{status.label}
		</span>
	);
}

/** One account: mark, name, plan or what is missing, its state and its fix. */
function AccountRow({ view }: { view: ProviderView }) {
	const status = providerStatus(view);
	const fix = view.state.fix;
	const inApp = view.inApp[status.kind === "missing" ? "install" : "signIn"];
	return (
		<Row
			data-testid={`account-${view.provider}`}
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
				<span title={view.state.login.detail}>
					{status.kind === "off"
						? view.off
						: status.kind === "signed-in"
							? signedInLine(view)
							: view.state.login.detail}
				</span>
			}
			detail={
				fix && !inApp && status.kind !== "signed-in" ? (
					<span className="flex flex-col gap-1">
						<CommandLine id={view.provider} command={fix.command} />
						{fix.after ? <span>{fix.after}</span> : null}
					</span>
				) : undefined
			}
			trailing={
				<>
					{inApp ? <ProviderFix view={view} size="sm" /> : null}
					<ProviderState view={view} />
				</>
			}
		/>
	);
}

/** Every provider on this computer, signed in or not, and how to fix it. */
function AccountsSection() {
	const models = useProviders();
	return (
		<Section title="Accounts" data-testid="accounts">
			{models.data ? (
				<Group>
					{models.data.providers.map((view) => (
						<AccountRow key={view.provider} view={view} />
					))}
				</Group>
			) : (
				<RowsSkeleton rows={4} twoLine />
			)}
		</Section>
	);
}

/** One picker per step, any model for any step; each step can be tested with one small call. */
function StepsSection({ ai }: { ai: Ai }) {
	const queryClient = useQueryClient();
	const models = useProviders();
	const [tests, setTests] = useState<
		Record<string, { ok: boolean; message: string }>
	>({});
	const save = useMutation({
		mutationFn: (next: Ai["settings"]) => client.ai.set(next),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.ai.key() }),
		onError: (e) => toast.error(e.message),
	});
	const test = useMutation({
		mutationFn: (role: Role) => client.ai.test({ role }),
		onSuccess: (result, role) => setTests((t) => ({ ...t, [role]: result })),
		onError: (e, role) =>
			setTests((t) => ({ ...t, [role]: { ok: false, message: e.message } })),
	});
	const providers = models.data?.providers ?? [];
	return (
		<Section title="Steps" data-testid="steps">
			<Group>
				{STEPS.map(({ role, label, hint }) => {
					const current = ai.settings[role];
					const state = ai.roles.find((r) => r.role === role);
					const result = tests[role];
					return (
						<FormRow
							key={role}
							data-testid={`role-${role}`}
							data-ready={state?.ready || undefined}
							label={label}
							hint={
								<span className="flex flex-col gap-1">
									<span>{hint}</span>
									{state?.problem ? (
										<span data-testid={`role-${role}-problem`}>
											{state.problem}
										</span>
									) : null}
									{result ? (
										<span
											className={result.ok ? "text-brand" : "text-destructive"}
											data-testid={`role-${role}-test-result`}
										>
											{result.ok ? `Works: ${result.message}` : result.message}
										</span>
									) : null}
								</span>
							}
						>
							<StepPicker
								role={role}
								label={label}
								value={current.model}
								effort={current.effort}
								providers={providers}
								fakeAllowed={Boolean(models.data?.fakeAllowed)}
								disabled={save.isPending || !models.data}
								onChange={(next) =>
									save.mutate({ ...ai.settings, [role]: next })
								}
							/>
							<Button
								variant="ghost"
								disabled={!state?.ready || test.isPending}
								pending={test.isPending && test.variables === role}
								onClick={() => test.mutate(role)}
								data-testid={`role-${role}-test`}
							>
								Test
							</Button>
						</FormRow>
					);
				})}
			</Group>
		</Section>
	);
}

/**
 * Settings › Models (docs/design/models/, version A): the model of each step, the accounts on
 * this computer, then the plans' usage and limits.
 */
export function ModelSettings() {
	const ai = useQuery(orpc.ai.get.queryOptions());
	return (
		<SettingsPage
			id="models"
			title="Models"
			description="Pick a model for each step. Any model from an account you're signed in to."
		>
			<QueryState isLoading={ai.isLoading} error={ai.error} what="the models" />
			{ai.data?.keysRemoved ? (
				<KeysRemovedNotice steps={ai.data.keysRemoved.steps} />
			) : null}
			{ai.data ? <StepsSection ai={ai.data} /> : null}
			<AccountsSection />
			<Section
				title="Plan usage"
				description="What each plan has left, and how much OfferFinch used."
			>
				<PlanUsageSection />
				<SubscriptionTerms />
				<Disclosure title="Limits" data-testid="models-advanced">
					<PlanLimits />
				</Disclosure>
			</Section>
		</SettingsPage>
	);
}
