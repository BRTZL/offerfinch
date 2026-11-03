import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { HeldCalls } from "@/components/desktop/held-calls";
import {
	QueryState,
	SettingsPage,
} from "@/components/pipeline/settings/shared";
import { Badge, type Tone } from "@/components/system/bits";
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
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";

type Role = "scoring" | "tailoring" | "claims";
type Mode = "api" | "claude-subscription" | "codex-subscription" | "fake";

const ROLES: {
	role: Role;
	label: string;
	hint: string;
	vendor: "anthropic" | "openai";
}[] = [
	{
		role: "scoring",
		label: "Finding matches",
		hint: "Scores how well each job that passes your rules fits you.",
		vendor: "anthropic",
	},
	{
		role: "tailoring",
		label: "Drafting",
		hint: "Writes the CV, letter and answers when you press Prepare.",
		vendor: "anthropic",
	},
	{
		role: "claims",
		label: "Checking drafts",
		hint: "An AI from another company checks every line against your profile.",
		vendor: "openai",
	},
];

const MODE_LABEL: Record<Mode, string> = {
	api: "API key",
	"claude-subscription": "Claude subscription",
	"codex-subscription": "Codex subscription",
	fake: "Test models",
};

/** Which choices a role can take: the claims check stays on another vendor than tailoring. */
function unavailable(role: Role, mode: Mode): string | null {
	if (role === "claims" && mode === "claude-subscription")
		return "Drafting uses Claude, so Claude cannot check its drafts";
	if (role !== "claims" && mode === "codex-subscription")
		return "Codex only checks drafts";
	return null;
}

function useKeys() {
	return useQuery({
		queryKey: ["desktop", "secrets"],
		queryFn: () => desktop.secrets.status(),
	});
}

/** One API key: stored encrypted in the macOS Keychain; never shown again. */
export function KeyField({
	name,
	label,
	placeholder,
}: {
	name: "anthropic" | "openai";
	label: string;
	placeholder: string;
}) {
	const queryClient = useQueryClient();
	const keys = useKeys();
	const [value, setValue] = useState("");
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["desktop", "secrets"] }),
			queryClient.invalidateQueries({ queryKey: orpc.ai.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.desktop.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.sources.key() }),
		]);
	const save = useMutation({
		mutationFn: () => desktop.secrets.set(name, value),
		onSuccess: async () => {
			setValue("");
			toast.success(`${label} saved in the Keychain.`);
			await refresh();
		},
		onError: (e) => toast.error(e.message),
	});
	const remove = useMutation({
		mutationFn: () => desktop.secrets.remove(name),
		onSuccess: refresh,
		onError: (e) => toast.error(e.message),
	});
	const stored = keys.data?.[name];
	// Saved, but encrypted under another Keychain item (a differently signed build's).
	const unreadable = useQuery({
		queryKey: ["desktop", "secrets", "unreadable"],
		queryFn: () => desktop.secrets.unreadable(),
	});
	const locked = !stored && Boolean(unreadable.data?.includes(name));
	const [editing, setEditing] = useState(false);
	const showField = !stored || editing;
	return (
		<FormRow
			label={label}
			htmlFor={`key-${name}`}
			hint={
				locked ? (
					<span className="text-warning" data-testid={`key-${name}-locked`}>
						Enter it again: this copy of the app can't read the stored key
					</span>
				) : stored ? (
					"Stored in your macOS Keychain"
				) : (
					"Not set"
				)
			}
		>
			{showField ? (
				<form
					className="flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (value.trim())
							save.mutate(undefined, { onSuccess: () => setEditing(false) });
					}}
				>
					<Input
						id={`key-${name}`}
						type="password"
						autoComplete="off"
						spellCheck={false}
						className="w-56 font-mono"
						placeholder={stored ? "New key" : placeholder}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						data-testid={`key-${name}`}
					/>
					<Button type="submit" disabled={!value.trim() || save.isPending}>
						Save
					</Button>
					{editing ? (
						<Button
							type="button"
							variant="ghost"
							onClick={() => setEditing(false)}
						>
							Cancel
						</Button>
					) : null}
				</form>
			) : (
				<>
					<Button variant="outline" onClick={() => setEditing(true)}>
						Change…
					</Button>
					<Button
						variant="ghost"
						onClick={() => remove.mutate()}
						disabled={remove.isPending}
					>
						Remove
					</Button>
				</>
			)}
		</FormRow>
	);
}

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
	return (
		<div className="flex flex-col gap-3" data-testid="subscriptions">
			{subs.isLoading ? <RowsSkeleton rows={2} twoLine /> : null}
			{d ? (
				<Group>
					<CliRow id="claude" name="Claude Code" state={d.claude} />
					<CliRow id="codex" name="Codex" state={d.codex} />
				</Group>
			) : null}
			<p
				className="text-muted-foreground text-xs"
				data-testid="subscription-terms"
			>
				Using a Claude or ChatGPT subscription here is subject to Anthropic's
				and OpenAI's terms. OfferFinch checks before each call that it cannot be
				billed as extra usage or credits, and pauses if it could.
			</p>
			{d ? (
				<Disclosure title="Advanced" data-testid="models-advanced">
					<div className="flex flex-col gap-3 pt-1">
						<FormRow
							label="Subscription calls per 24 hours"
							htmlFor="call-budget"
							hint={
								<span data-testid="call-budget-used">
									{d.callBudget.used} used in the last 24 hours, Claude and
									Codex together. It protects the plans you also work with.
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
								<Button
									variant="outline"
									type="submit"
									disabled={calls === null}
								>
									Save
								</Button>
							</form>
						</FormRow>
						<p
							className="text-muted-foreground px-4 text-xs"
							data-testid="codex-guards"
						>
							A Codex call starts only while every usage window of your ChatGPT
							plan is below {d.codexHeadroomPercent}% used; one that spent
							credits is recorded as paid and pauses Codex.
						</p>
					</div>
				</Disclosure>
			) : null}
		</div>
	);
}

/**
 * Which model each role uses and how it is paid for. API keys live in the macOS Keychain; the
 * pipeline gets them in memory only. Each role can be tested live with one small call.
 */
export function ModelSettings({ compact = false }: { compact?: boolean }) {
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
	const modes: Mode[] = [
		"api",
		"claude-subscription",
		"codex-subscription",
		...(ai.data?.fakeAllowed ? (["fake"] as const) : []),
	];
	const body = (
		<>
			<QueryState isLoading={ai.isLoading} error={ai.error} what="the models" />
			<HeldCalls />
			<Section
				title="API keys"
				description="Encrypted with your macOS Keychain. Never shown, logged or sent anywhere but the vendor."
			>
				<Group>
					<KeyField
						name="anthropic"
						label="Anthropic API key"
						placeholder="sk-ant-…"
					/>
					<KeyField name="openai" label="OpenAI API key" placeholder="sk-…" />
				</Group>
			</Section>
			{settings ? (
				<Section
					title="Who does each step"
					description={
						ai.data ? (
							<span data-testid="vendor-rule">{ai.data.vendorRule}</span>
						) : undefined
					}
				>
					<Group>
						{ROLES.map(
							// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep each model role’s controls and connection states together so their settings dependencies stay visible.
							({ role, label, hint }) => {
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
												{role === "claims" &&
												(current.mode === "api" ||
													current.mode === "codex-subscription") ? (
													<ModelInput
														value={current.model ?? ""}
														placeholder={
															current.mode === "api"
																? "OpenAI model, e.g. gpt-6.1-terra"
																: "Codex model (empty: your account's default)"
														}
														onSave={(model) =>
															save.mutate({
																...settings,
																claims: { ...current, model },
															})
														}
													/>
												) : null}
											</span>
										}
									>
										<ModeSelect
											role={role}
											label={label}
											value={current.mode as Mode}
											modes={modes}
											disabled={save.isPending}
											onChange={(mode) =>
												save.mutate({
													...settings,
													[role]: { ...current, mode },
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
							},
						)}
					</Group>
				</Section>
			) : null}
			<Section title="Subscriptions">
				<SubscriptionSection />
			</Section>
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

function ModelInput({
	value,
	placeholder,
	onSave,
}: {
	value: string;
	placeholder: string;
	onSave: (model: string) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<form
			className="mt-1 flex items-center gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (draft !== null) onSave(draft.trim());
				setDraft(null);
			}}
		>
			<Input
				size="sm"
				className="w-64 font-mono"
				placeholder={placeholder}
				value={draft ?? value}
				onChange={(e) => setDraft(e.target.value)}
				data-testid="claims-model"
			/>
			<Button
				type="submit"
				size="sm"
				variant="outline"
				disabled={draft === null}
			>
				Save model
			</Button>
		</form>
	);
}

/** Who does a step: a pop-up button of the ways it can be paid for. */
function ModeSelect({
	role,
	label,
	value,
	modes,
	disabled,
	onChange,
}: {
	role: Role;
	label: string;
	value: Mode;
	modes: Mode[];
	disabled?: boolean;
	onChange: (mode: Mode) => void;
}) {
	return (
		<Select
			value={value}
			disabled={disabled}
			onValueChange={(next) => {
				if (next && next !== value) onChange(next as Mode);
			}}
			items={modes.map((mode) => ({ value: mode, label: MODE_LABEL[mode] }))}
		>
			<SelectTrigger
				aria-label={`${label}: paid with`}
				className="w-52"
				data-testid={`role-${role}-mode`}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{modes.map((mode) => {
					const why = unavailable(role, mode);
					return (
						<SelectItem
							key={mode}
							value={mode}
							disabled={Boolean(why)}
							title={why ?? undefined}
							data-testid={`role-${role}-${mode}`}
						>
							{MODE_LABEL[mode]}
						</SelectItem>
					);
				})}
			</SelectContent>
		</Select>
	);
}
