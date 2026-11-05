import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useDemoMode } from "@/components/desktop/demo";
import { PlanUsage } from "@/components/desktop/plan-usage";
import {
	QueryState,
	SettingsPage,
} from "@/components/pipeline/settings/shared";
import { Badge, Notice, type Tone } from "@/components/system/bits";
import { Group, Section } from "@/components/system/layout";
import { Disclosure } from "@/components/system/pane";
import { FormRow } from "@/components/system/rows";
import { RowsSkeleton } from "@/components/system/skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { client, orpc } from "@/lib/orpc";
import {
	FAKE_MODEL_REF,
	type ModelRef,
	parseModelRef,
	type Role,
} from "../../../shared/providers";

const ROLES: { role: Role; label: string; hint: string }[] = [
	{
		role: "scoring",
		label: "Finding matches",
		hint: "Scores how well each job a search finds fits you.",
	},
	{
		role: "tailoring",
		label: "Drafting",
		hint: "Writes the CV, letter and answers when you press Prepare.",
	},
	{
		role: "claims",
		label: "Checking drafts",
		hint: "Checks each line of a draft against your profile.",
	},
];

const LOGIN_TONE: Record<string, Tone> = {
	logged_in: "brand",
	logged_out: "destructive",
	not_subscription: "destructive",
	refused: "quiet",
	unknown: "warning",
};

function _ExternalLink({
	href,
	children,
}: {
	href: string;
	children: React.ReactNode;
}) {
	// Try-it mode opens no link (the default browser holds the real sessions).
	const demo = useDemoMode();
	if (demo) return <span>{children}</span>;
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="text-primary hover:underline"
		>
			{children}
		</a>
	);
}

interface CliStateView {
	path: string | null;
	version: string | null;
	tested: string;
	login: { state: string; detail: string; extraUsage?: string };
	command: string | null;
}

/** One CLI's state: found where, which version, logged in, and what to run if not. */
function CliRow({
	id,
	name,
	state,
}: {
	id: string;
	name: string;
	state: CliStateView;
}) {
	return (
		<FormRow
			data-testid={`cli-${id}`}
			label={name}
			hint={
				<span className="flex flex-col gap-1">
					<span className="break-all">
						{state.path
							? `${state.path} · ${state.version ?? "version unknown"} (tested with ${state.tested})`
							: "Not found on your login shell's PATH."}
					</span>
					<span>{state.login.detail}</span>
					{state.command ? (
						<span className="text-foreground">
							In Terminal, run{" "}
							<code
								className="bg-muted rounded-sm px-1 font-mono"
								data-testid={`cli-${id}-command`}
							>
								{state.command}
							</code>
							, then reopen this page.
						</span>
					) : null}
				</span>
			}
		>
			<Badge
				tone={LOGIN_TONE[state.login.state] ?? "quiet"}
				data-testid={`cli-${id}-state`}
			>
				{state.login.state.replace("_", " ")}
			</Badge>
		</FormRow>
	);
}

/** Claude Code and Codex: login, guards, budget, and the terms, read before turning either on. */
function SubscriptionSection() {
	const subs = useQuery({
		...orpc.ai.subscriptions.queryOptions(),
		staleTime: 30_000,
		meta: { quiet: true },
	});
	const d = subs.data;
	return (
		<div className="flex flex-col gap-3" data-testid="subscriptions">
			{subs.isLoading ? <RowsSkeleton rows={2} twoLine /> : null}
			{d ? (
				<Group>
					<CliRow id="claude" name="Claude Code" state={d.claude} />
					<CliRow id="codex" name="Codex" state={d.codex} />
				</Group>
			) : null}
			<SubscriptionTerms />
			{d ? (
				<Disclosure title="Advanced" data-testid="models-advanced">
					<PlanLimits />
				</Disclosure>
			) : null}
		</div>
	);
}

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
			Your Claude and ChatGPT plans fall under Anthropic's and OpenAI's terms.
			Before each call, OfferFinch checks that it can't be paid for with extra
			usage or credits. If a call is paid anyway, that plan stops until you
			resume it.
		</p>
	);
}

/** What protects the plans: the daily call budget, and Codex's usage headroom. */
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
			<p
				className="text-muted-foreground px-4 text-xs"
				data-testid="codex-guards"
			>
				Codex starts a call only while each usage window of your ChatGPT plan is
				under {d.codexHeadroomPercent}% used.
			</p>
		</div>
	);
}

/**
 * A plan stopped after a paid call: "Claude used paid extra usage on <date>. Calls are stopped."
 * with Resume. Nothing while both plans run.
 */
function PaidStops() {
	const queryClient = useQueryClient();
	const stops = useQuery({
		...orpc.paidStops.list.queryOptions(),
		refetchInterval: 15_000,
	});
	const resume = useMutation({
		mutationFn: (vendor: "anthropic" | "openai") =>
			client.paidStops.resume({ vendor }),
		onSuccess: (_r, vendor) => {
			toast.success(
				`${vendor === "anthropic" ? "Claude" : "Codex"} calls run again.`,
			);
			void queryClient.invalidateQueries({ queryKey: orpc.paidStops.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.ai.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.desktop.key() });
		},
		onError: (e) => toast.error(e.message),
	});
	if (!stops.data?.length) return null;
	return (
		<div className="flex flex-col gap-2" data-testid="paid-stops">
			{stops.data.map((stop) => {
				const name = stop.vendor === "anthropic" ? "Claude" : "Codex";
				const what =
					stop.vendor === "anthropic" ? "paid extra usage" : "paid credits";
				return (
					<Notice
						key={stop.vendor}
						tone="warning"
						data-testid={`stopped-${stop.vendor}`}
						actions={
							<Button
								variant="outline"
								disabled={resume.isPending}
								onClick={() => resume.mutate(stop.vendor)}
								data-testid={`resume-${stop.vendor}`}
							>
								Resume
							</Button>
						}
					>
						{name} used {what} on {new Date(stop.at).toLocaleDateString()}.
						Calls are stopped.{" "}
						<a
							href={stop.usagePage}
							target="_blank"
							rel="noreferrer"
							className="text-primary hover:underline"
						>
							Check usage
						</a>
					</Notice>
				);
			})}
		</div>
	);
}

/**
 * Which model each step uses, from the providers signed in on this computer (any model may do
 * any step). Each step can be tested live with one small call.
 */
export function ModelSettings({
	compact = false,
	subscriptions = true,
}: {
	compact?: boolean;
	/** The Subscriptions section; setup shows its own (Connect AI). */
	subscriptions?: boolean;
}) {
	const queryClient = useQueryClient();
	const ai = useQuery(orpc.ai.get.queryOptions());
	const [tests, setTests] = useState<
		Record<string, { ok: boolean; message: string }>
	>({});
	const save = useMutation({
		mutationFn: (next: NonNullable<typeof ai.data>["settings"]) =>
			client.ai.set(next),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.ai.key() }),
		onError: (e) => toast.error(e.message),
	});
	const test = useMutation({
		mutationFn: (role: Role) => client.ai.test({ role }),
		onSuccess: (result, role) => setTests((t) => ({ ...t, [role]: result })),
		onError: (e, role) =>
			setTests((t) => ({ ...t, [role]: { ok: false, message: e.message } })),
	});
	const settings = ai.data?.settings;
	const options = useModelOptions();
	const body = (
		<>
			<QueryState isLoading={ai.isLoading} error={ai.error} what="the models" />
			<PaidStops />
			{settings ? (
				<Section title="Who does each step">
					<Group>
						{ROLES.map(({ role, label, hint }) => {
							const current = settings[role];
							const state = ai.data?.roles.find((r) => r.role === role);
							const result = tests[role];
							return (
								<FormRow
									key={role}
									data-testid={`role-${role}`}
									label={label}
									hint={
										<span className="flex flex-col gap-1">
											<span>{hint}</span>
											<span>
												<Badge
													tone={state?.ready ? "brand" : "warning"}
													data-testid={`role-${role}-state`}
													className="font-mono"
												>
													{state?.ready ? state.provider : "not connected"}
												</Badge>
											</span>
											{state?.problem ? <span>{state.problem}</span> : null}
											{result ? (
												<span
													className={
														result.ok ? "text-brand" : "text-destructive"
													}
													data-testid={`role-${role}-test-result`}
												>
													{result.ok
														? `Works: ${result.message}`
														: result.message}
												</span>
											) : null}
										</span>
									}
								>
									<ModelSelect
										// A choice made elsewhere (setup's Check again) shows at once.
										key={current.model ?? "none"}
										role={role}
										label={label}
										value={current.model}
										options={options}
										disabled={save.isPending}
										onChange={(model) =>
											save.mutate({
												...settings,
												[role]: { ...current, model },
											})
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
			) : null}
			{subscriptions ? (
				<>
					<Section title="Subscriptions">
						<SubscriptionSection />
					</Section>
					<Section
						title="Plan usage"
						description="What each plan has left, and how much OfferFinch used."
					>
						<PlanUsageSection />
					</Section>
				</>
			) : null}
		</>
	);
	if (compact) return body;
	return (
		<SettingsPage
			id="models"
			title="Models"
			description="The AI behind each step and how it is paid for."
		>
			{body}
		</SettingsPage>
	);
}

interface ModelOption {
	ref: ModelRef;
	name: string;
}

/**
 * The models a step can take now: those of the providers on this platform and signed in, and the
 * test models in test runs.
 */
export function useModelOptions(): ModelOption[] {
	const models = useQuery({
		...orpc.ai.models.queryOptions(),
		staleTime: 30_000,
		meta: { quiet: true },
	});
	const d = models.data;
	if (!d) return [];
	return [
		...d.providers
			.filter((p) => p.signedIn)
			.flatMap((p) => p.models.map((m) => ({ ref: m.ref, name: m.name }))),
		...(d.fakeAllowed ? [{ ref: FAKE_MODEL_REF, name: "Test models" }] : []),
	];
}

/** A model's option test id: `role-<role>-fake` for the test models, else its reference. */
const optionId = (role: Role, ref: string) =>
	`role-${role}-${parseModelRef(ref)?.provider === "fake" ? "fake" : ref}`;

/** Who does a step: a pop-up button of the models available now. */
function ModelSelect({
	role,
	label,
	value,
	options,
	disabled,
	onChange,
}: {
	role: Role;
	label: string;
	value: ModelRef | null;
	options: ModelOption[];
	disabled?: boolean;
	onChange: (model: ModelRef) => void;
}) {
	// The stored choice stays listed while its provider is signed out or gone.
	const items = [
		...(value && !options.some((o) => o.ref === value)
			? [{ ref: value, name: `${value} (not available now)` }]
			: []),
		...options,
	];
	return (
		<Select
			value={value ?? ""}
			disabled={disabled}
			onValueChange={(next) => {
				if (next && next !== value) onChange(next as ModelRef);
			}}
			items={items.map((o) => ({ value: o.ref, label: o.name }))}
		>
			<SelectTrigger
				aria-label={`${label}: model`}
				className="w-52"
				data-testid={`role-${role}-mode`}
			>
				<SelectValue placeholder="Choose a model" />
			</SelectTrigger>
			<SelectContent>
				{items.map((o) => (
					<SelectItem
						key={o.ref}
						value={o.ref}
						data-testid={optionId(role, o.ref)}
					>
						{o.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
