import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, RotateCw, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	ModelSettings,
	PlanLimits,
	SubscriptionTerms,
	useModelOptions,
} from "@/components/desktop/models";
import { useStepAction } from "@/components/desktop/step-action";
import { IconTile, Notice } from "@/components/system/bits";
import { Group } from "@/components/system/layout";
import { Disclosure } from "@/components/system/pane";
import { Row } from "@/components/system/rows";
import { RowsSkeleton } from "@/components/system/skeletons";
import { SparkleBurst } from "@/components/system/sparkle";
import { Button } from "@/components/ui/button";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { providerOfRef, readyNow } from "../../../../shared/auto-connect";
import type { ProviderId, Role } from "../../../../shared/providers";
import { useCelebrate } from "./celebrate";

type Detected = Awaited<ReturnType<typeof client.ai.autoConnect>>;
type Cli = Detected["claude"];
type RoleState = Detected["roles"][number];

const DOES: Record<Role, string> = {
	scoring: "scores",
	tailoring: "drafts",
	claims: "checks drafts",
};

/** "drafts, scores and checks drafts", from the roles set to a provider (signed in or not). */
function doesText(roles: RoleState[], provider: ProviderId): string | null {
	const mine = roles.filter((r) => providerOfRef(r.model) === provider);
	if (!mine.length) return null;
	const words = (["tailoring", "scoring", "claims"] as const)
		.filter((role) => mine.some((r) => r.role === role))
		.map((role) => DOES[role]);
	const last = words.pop();
	return words.length ? `${words.join(", ")} and ${last}` : (last ?? null);
}

/** A command to paste in Terminal, with Copy. */
function CommandLine({ id, command }: { id: string; command: string }) {
	return (
		<span className="mt-1 flex items-center gap-2">
			<code
				className="bg-muted text-foreground rounded-sm px-1.5 py-0.5 font-mono text-xs break-all"
				data-testid={`setup-cli-${id}-command`}
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
				data-testid={`setup-cli-${id}-copy`}
			>
				<Copy />
				Copy
			</Button>
		</span>
	);
}

/** A CLI's state in a word, and the line saying it. */
function cliText(
	name: string,
	cli: Cli,
	does: string | null,
	needFor: string,
): { state: string; title: string; subtitle: string } {
	if (cli.login.state === "logged_in")
		return {
			state: "ready",
			title: `${name}, signed in`,
			subtitle: does
				? does.charAt(0).toUpperCase() + does.slice(1)
				: "Not used: you chose another way below",
		};
	// Chosen for a role but gone or signed out: the choice stays, and waits for the CLI.
	const subtitle = does
		? `${does.charAt(0).toUpperCase() + does.slice(1)} once it's back and signed in`
		: `Needed to ${needFor} with your plan`;
	if (!cli.path)
		return {
			state: "missing",
			title: `${name} isn't on this computer`,
			subtitle,
		};
	if (cli.login.state === "logged_out")
		return { state: "signed-out", title: `${name} isn't signed in`, subtitle };
	if (cli.login.state === "not_subscription")
		return {
			state: "not_subscription",
			title: `${name} is signed in with an API account, not a plan`,
			subtitle,
		};
	return {
		state: cli.login.state,
		title: `${name}: ${cli.login.detail}`,
		subtitle,
	};
}

/** One CLI: signed in and what it does, or exactly what is missing and the command for it. */
function CliLine({
	id,
	name,
	cli,
	does,
	needFor,
}: {
	id: "claude" | "codex";
	name: string;
	cli: Cli;
	does: string | null;
	needFor: string;
}) {
	const text = cliText(name, cli, does, needFor);
	const ready = text.state === "ready";
	return (
		<Row
			data-testid={`setup-cli-${id}`}
			data-state={text.state}
			leading={
				<IconTile tone={ready ? "brand" : "warning"}>
					{ready ? <Check /> : <SquareTerminal />}
				</IconTile>
			}
			title={text.title}
			subtitle={text.subtitle}
			detail={
				cli.fix ? (
					<span className="flex flex-col gap-1">
						<span>
							{cli.fix.kind === "install"
								? "In Terminal, install it:"
								: "In Terminal, run:"}
						</span>
						<CommandLine id={id} command={cli.fix.command} />
						{cli.fix.after ? <span>{cli.fix.after}</span> : null}
					</span>
				) : undefined
			}
		/>
	);
}

const STEP_NAME: Record<Role, string> = {
	scoring: "Finding matches",
	tailoring: "Drafting",
	claims: "Checking drafts",
};

/** What the step says on top: all set, or what is still missing. */
function summaryOf(
	roles: RoleState[],
	available: boolean,
): {
	tone: "success" | "warning" | "info";
	title: string;
	body: string;
	allSet: boolean;
} {
	const missing = (["scoring", "tailoring", "claims"] as const).filter(
		(role) => !roles.some((r) => r.role === role && r.ready),
	);
	if (missing.length === 0)
		return {
			tone: "success",
			title: "You're all set",
			body: "Your AI is connected and does every step.",
			allSet: true,
		};
	if (available)
		return {
			tone: "warning",
			title: "Choose a model for every step",
			body: `Still without a model that can run: ${missing.map((r) => STEP_NAME[r]).join(", ")}. Choose one below.`,
			allSet: false,
		};
	return {
		tone: "info",
		title: "Connect an AI",
		body: "Claude Code and Codex aren't signed in on this computer yet. Set one up below to use your plan.",
		allSet: false,
	};
}

/**
 * Setup's first step. Claude Code and Codex are looked for at once (prefetched on the welcome);
 * signed in to a plan, they take the steps still without a model: Claude all three when it is
 * signed in, else Codex. What is missing shows with the command that fixes it, Check again, and
 * the models to choose by hand, folded away. Continue needs at least one model available.
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
			return Promise.all([
				queryClient.invalidateQueries({ queryKey: orpc.ai.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.desktop.key() }),
			]);
		},
		onError: (e) => toast.error(e.message),
	});
	const detectNow = detect.mutate;
	useEffect(() => detectNow(false), [detectNow]);
	// Roles as they are now: a choice made below changes them.
	const ai = useQuery(orpc.ai.get.queryOptions());
	// A plan's role is ready only while its CLI is signed in, whatever the settings say.
	const roles = readyNow(ai.data?.roles ?? d?.roles ?? [], {
		claude: d?.claude.login.state === "logged_in",
		codex: d?.codex.login.state === "logged_in",
	});
	const options = useModelOptions();
	// Continue needs a model to choose: a signed-in provider's, or the test models in test runs.
	const available = options.length > 0;
	const summary = summaryOf(
		roles,
		options.some((o) => providerOfRef(o.ref) !== null),
	);
	useStepAction({
		label: "Continue",
		onClick: onDone,
		disabled: !available,
		testId: "step-continue",
		title: available
			? undefined
			: "Connect Claude Code or Codex first: setup needs at least one model",
	});
	// The moment the AI is connected: once, when this visit connected it (found it, or set by
	// hand below), not on reopening a finished step.
	const before = useRef<boolean | null>(null);
	useEffect(() => {
		if (!d || !ai.data) return;
		const was = before.current;
		before.current = summary.allSet;
		if (summary.allSet && (was === false || (was === null && d.filled.length)))
			celebrate();
	}, [d, ai.data, summary.allSet, celebrate]);
	const [tests, setTests] = useState<{ ok: boolean; message: string } | null>(
		null,
	);
	const test = useMutation({
		mutationFn: async () => {
			for (const r of ["scoring", "tailoring", "claims"] as const) {
				const result = await client.ai.test({ role: r });
				if (!result.ok) return result;
			}
			return { ok: true, message: "every step answered" };
		},
		onSuccess: setTests,
		onError: (e) => setTests({ ok: false, message: e.message }),
	});

	// Read out as it changes: what was found, then each Check again and test. One region, the
	// same element from the first frame on, so screen readers announce every change.
	const live = (
		<p
			className="sr-only"
			role="status"
			aria-live="polite"
			data-testid="setup-ai-live"
		>
			{!d
				? "Looking for Claude Code and Codex."
				: tests?.ok
					? `${summary.title}. Works: ${tests.message}`
					: `${summary.title}. ${summary.body}`}
		</p>
	);
	if (!d)
		return (
			<div className="flex flex-col gap-3" data-testid="setup-ai-detecting">
				{live}
				<p className="text-muted-foreground text-sm">
					Looking for Claude Code and Codex on this computer…
				</p>
				<RowsSkeleton rows={2} twoLine />
			</div>
		);
	return (
		<div className="flex flex-col gap-4" data-testid="setup-ai">
			{live}
			<div className="relative">
				<SparkleBurst burst={burst} />
				<Notice
					tone={summary.tone}
					title={summary.title}
					data-testid="setup-ai-summary"
					data-all-set={summary.allSet || undefined}
				>
					{summary.body}
				</Notice>
			</div>
			<Group>
				<CliLine
					id="claude"
					name="Claude Code"
					cli={d.claude}
					does={doesText(roles, "claude")}
					needFor="find matches, draft and check drafts"
				/>
				<CliLine
					id="codex"
					name="Codex"
					cli={d.codex}
					does={doesText(roles, "codex")}
					needFor="find matches, draft and check drafts"
				/>
			</Group>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					onClick={() => {
						setTests(null);
						detect.mutate(true);
					}}
					pending={detect.isPending}
					data-testid="setup-ai-check"
				>
					<RotateCw />
					Check again
				</Button>
				{summary.allSet ? (
					<Button
						variant="ghost"
						onClick={() => test.mutate()}
						pending={test.isPending}
						data-testid="setup-ai-test"
					>
						Test the connection
					</Button>
				) : null}
				{tests ? (
					<span
						className={
							tests.ok ? "text-brand text-sm" : "text-destructive text-sm"
						}
						data-testid="setup-ai-test-result"
						// A failure is said at once; a success goes through the status region.
						role={tests.ok ? undefined : "alert"}
					>
						{tests.ok ? `Works: ${tests.message}` : tests.message}
					</span>
				) : null}
			</div>
			<SubscriptionTerms />
			<div className="flex flex-col gap-1">
				<Disclosure title="Plan limits" data-testid="setup-plan-limits">
					<PlanLimits />
				</Disclosure>
				<Disclosure title="Choose models yourself" data-testid="models-manual">
					<div className="flex flex-col gap-8 pt-2">
						<ModelSettings compact subscriptions={false} />
					</div>
				</Disclosure>
			</div>
		</div>
	);
}
