import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Meter } from "@/components/system/bits";
import { Group } from "@/components/system/layout";
import { FormRow } from "@/components/system/rows";
import { RowsSkeleton } from "@/components/system/skeletons";
import { Button } from "@/components/ui/button";
import { client, orpc } from "@/lib/orpc";

type Views = Awaited<ReturnType<typeof client.ai.planUsage>>;
type View = Views["anthropic"];
type Window = View["windows"][number];

const NAME: Record<View["vendor"], string> = {
	anthropic: "Claude",
	openai: "Codex",
};

/** "in 2 h 10 min", "in 3 d 4 h", "now". */
function untilLabel(iso: string | null, now: number): string | null {
	if (!iso) return null;
	const ms = Date.parse(iso) - now;
	if (!Number.isFinite(ms)) return null;
	if (ms <= 0) return "now";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `in ${Math.max(1, minutes)} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24)
		return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
	const days = Math.floor(hours / 24);
	return `in ${days} d${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

/** "just now", "3 min ago", "2 h ago", "yesterday". */
function agoLabel(iso: string | null, now: number): string {
	if (!iso) return "not read yet";
	const ms = now - Date.parse(iso);
	if (!Number.isFinite(ms)) return "not read yet";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return hours < 48 ? "yesterday" : `${Math.floor(hours / 24)} days ago`;
}

function tokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

function money(amount: number, currency: string | null): string {
	// Anthropic reports extra usage in minor units (cents) when a currency is given.
	const value = currency ? amount / 100 : amount;
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency: currency ?? "USD",
			maximumFractionDigits: 2,
		}).format(value);
	} catch {
		return `${value} ${currency ?? ""}`.trim();
	}
}

function WindowRow({
	vendor,
	item,
	now,
}: {
	vendor: View["vendor"];
	item: Window;
	now: number;
}) {
	const resets = untilLabel(item.resetsAt, now);
	const share =
		item.usedPercent > 0
			? Math.round((item.appPercent / item.usedPercent) * 100)
			: 0;
	const summary = `${item.label}: ${item.leftPercent}% left, ${item.usedPercent}% used, OfferFinch ${item.appPercent}%${resets ? `, resets ${resets}` : ""}`;
	return (
		<div
			className="flex flex-col gap-1 px-4 py-2"
			data-testid={`plan-window-${vendor}-${item.id}`}
			data-used={item.usedPercent}
			data-app={item.appPercent}
		>
			<div className="flex items-baseline gap-2 text-xs">
				<span className="text-foreground font-medium">{item.label}</span>
				<span className="text-muted-foreground">
					{item.ended
						? "The window ended; the next read starts a new one."
						: resets
							? `resets ${resets}`
							: null}
				</span>
				<span
					className="text-foreground ms-auto font-medium tabular-nums"
					data-testid={`plan-window-${vendor}-${item.id}-left`}
				>
					{item.leftPercent}% left
				</span>
			</div>
			<Meter
				used={item.usedPercent}
				app={item.appPercent}
				elapsed={item.elapsedPercent}
				label={summary}
			/>
			<div className="text-muted-foreground text-2xs flex gap-2 tabular-nums">
				<span data-testid={`plan-window-${vendor}-${item.id}-app`}>
					{item.appPercent > 0
						? `OfferFinch: ${item.appPercent}% of the window (${share}% of what is used)`
						: item.usedPercent > 0
							? "OfferFinch: none of it so far"
							: "Nothing used yet"}
				</span>
				{item.calls && item.calls.calls > 0 ? (
					<span
						className="ms-auto"
						data-testid={`plan-window-${vendor}-${item.id}-calls`}
					>
						{item.calls.calls} {item.calls.calls === 1 ? "call" : "calls"}
						{item.calls.inputTokens + item.calls.outputTokens > 0
							? ` · ${tokens(item.calls.inputTokens)} in, ${tokens(item.calls.outputTokens)} out`
							: ""}
					</span>
				) : null}
			</div>
		</div>
	);
}

function AccountLine({ view }: { view: View }) {
	const account = view.account;
	if (!account) return null;
	const parts: string[] = [];
	if (account.plan) parts.push(`plan ${account.plan}`);
	if (account.extraUsage)
		parts.push(
			account.extraUsage.enabled
				? `extra usage on${
						account.extraUsage.used !== null &&
						account.extraUsage.limit !== null
							? ` (${money(account.extraUsage.used, account.extraUsage.currency)} of ${money(account.extraUsage.limit, account.extraUsage.currency)} this month)`
							: ""
					}`
				: "extra usage off",
		);
	if (account.credits)
		parts.push(
			account.credits.unlimited
				? "unlimited credits"
				: account.credits.balance !== null
					? `${account.credits.balance} credits`
					: "credits unknown",
		);
	if (!parts.length) return null;
	return (
		<span data-testid={`plan-account-${view.vendor}`}>{parts.join(" · ")}</span>
	);
}

/** One plan: its windows as bars, with when it was last read. */
function PlanRows({ view, now }: { view: View; now: number }) {
	return (
		<div className="flex flex-col" data-testid={`plan-usage-${view.vendor}`}>
			<FormRow
				label={NAME[view.vendor]}
				hint={
					<span className="flex flex-col gap-1">
						<AccountLine view={view} />
						<span data-testid={`plan-checked-${view.vendor}`}>
							{view.checkedAt
								? `Read ${agoLabel(view.checkedAt, now)}`
								: "Not read yet: it is read with each call, and by Refresh."}
						</span>
					</span>
				}
			>
				<span className="text-muted-foreground text-xs tabular-nums">
					{view.windows.length
						? `${Math.min(...view.windows.map((w) => w.leftPercent))}% left`
						: null}
				</span>
			</FormRow>
			{view.windows.map((item) => (
				<WindowRow key={item.id} vendor={view.vendor} item={item} now={now} />
			))}
		</div>
	);
}

/**
 * What each plan has used of its windows (as the vendor reports it), what is left and when it
 * resets, and OfferFinch's share of it. Shown for a plan the app has read at least once.
 */
export function PlanUsage({
	signedIn,
}: {
	/** Which CLIs are signed in: a plan that is not is left out. */
	signedIn: { anthropic: boolean; openai: boolean };
}) {
	const queryClient = useQueryClient();
	const usage = useQuery({
		...orpc.ai.planUsage.queryOptions(),
		staleTime: 15_000,
		refetchInterval: 60_000,
		meta: { quiet: true },
	});
	const refresh = useMutation({
		mutationFn: () => client.ai.refreshUsage(),
		onSuccess: (fresh) => {
			queryClient.setQueryData(orpc.ai.planUsage.queryKey(), fresh);
			void queryClient.invalidateQueries({ queryKey: orpc.ai.key() });
		},
		onError: (e) => toast.error(e.message),
	});
	const now = Date.now();
	const views = usage.data
		? (["anthropic", "openai"] as const)
				.filter((vendor) => signedIn[vendor] || usage.data[vendor].checkedAt)
				.map((vendor) => usage.data[vendor])
		: [];
	return (
		<div className="flex flex-col gap-3" data-testid="plan-usage">
			{usage.isLoading ? <RowsSkeleton rows={2} twoLine /> : null}
			{usage.data && !views.length ? (
				<p className="text-muted-foreground text-xs">
					Sign in to Claude Code or Codex above to see what your plan has left.
				</p>
			) : null}
			{views.length ? (
				<Group>
					{views.map((view) => (
						<PlanRows key={view.vendor} view={view} now={now} />
					))}
				</Group>
			) : null}
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					onClick={() => refresh.mutate()}
					pending={refresh.isPending}
					data-testid="plan-usage-refresh"
				>
					Refresh
				</Button>
				<span className="text-muted-foreground text-xs">
					Reads each plan again, without sending a prompt.
				</span>
			</div>
			<p className="text-muted-foreground text-xs">
				OfferFinch's share is measured: the plan's use is read around its own
				calls, and the increase is counted as OfferFinch's. Work you do with the
				same plan at the same moment counts too; work done while OfferFinch is
				idle does not. The tick marks how far the window has run.
			</p>
		</div>
	);
}
