import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Notice } from "@/components/system/bits";
import { Group, Section } from "@/components/system/layout";
import { FormRow } from "@/components/system/rows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usd } from "@/lib/money";
import { client, orpc } from "@/lib/orpc";

const VENDOR: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
};

const SUBSCRIPTION: Record<string, string> = {
	anthropic: "Claude",
	openai: "Codex",
};

function vendorLabel(vendor: string, subscription: boolean) {
	return subscription
		? `${SUBSCRIPTION[vendor] ?? vendor} subscription`
		: `${VENDOR[vendor] ?? vendor} API`;
}

type Held = Awaited<ReturnType<typeof client.holds.list>>["held"][number];

/** One held call: what it really cost, from the vendor's usage page, or "not charged". */
function HeldRow({ call }: { call: Held }) {
	const queryClient = useQueryClient();
	const [amount, setAmount] = useState("");
	const reconcile = useMutation({
		mutationFn: (value: number | null) =>
			client.holds.reconcile({ id: call.id, usd: value }),
		onSuccess: (_r, value) => {
			toast.success(
				value
					? `Recorded as ${usd(Math.round(value * 1_000_000))}, counted as API spend.`
					: "Recorded as not charged.",
			);
			void queryClient.invalidateQueries({ queryKey: orpc.holds.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.ai.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.spending.key() });
		},
		onError: (e) => toast.error(e.message),
	});
	const value = Number(amount);
	return (
		<div className="flex flex-col gap-2 px-4 py-3" data-testid="held-call">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<span className="text-foreground text-sm font-medium">
					{vendorLabel(call.vendor, call.subscription)} · {call.task}
				</span>
				<span className="text-muted-foreground text-xs tabular-nums">
					{new Date(call.createdAt).toLocaleString()} · held{" "}
					{usd(call.reservationMicros)}
				</span>
			</div>
			{call.confirmedOffBefore && (
				<p className="text-foreground text-sm" data-testid="held-confirmed-off">
					You had confirmed extra usage was off before this call. Billing is
					still unknown; check Claude usage to be sure.
				</p>
			)}
			{call.reason && (
				<p className="text-muted-foreground line-clamp-2 text-xs">
					{call.reason}
				</p>
			)}
			<form
				className="flex flex-wrap items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (amount !== "" && Number.isFinite(value) && value >= 0)
						reconcile.mutate(value);
				}}
			>
				<a
					href={call.usagePage}
					target="_blank"
					rel="noreferrer"
					className="text-primary text-sm hover:underline"
				>
					Open the usage page
				</a>
				<label htmlFor={`held-${call.id}`} className="sr-only">
					What it cost in US dollars
				</label>
				<span className="text-muted-foreground ml-auto text-sm">$</span>
				<Input
					id={`held-${call.id}`}
					type="number"
					min={0}
					step="0.01"
					size="sm"
					className="w-24 tabular-nums"
					placeholder="0.00"
					value={amount}
					onChange={(e) => setAmount(e.target.value)}
					data-testid="held-amount"
				/>
				<Button
					size="sm"
					variant="outline"
					type="submit"
					disabled={amount === "" || reconcile.isPending}
					data-testid="held-save"
				>
					Save what it cost
				</Button>
				<Button
					size="sm"
					variant="ghost"
					type="button"
					disabled={reconcile.isPending}
					onClick={() => reconcile.mutate(null)}
					data-testid="held-not-charged"
				>
					Not charged
				</Button>
			</form>
		</div>
	);
}

/**
 * Calls whose billing is unknown, held at their worst case against the cap, and the
 * subscriptions they stopped. Reconcile each from the vendor's usage page, then resume.
 */
export function HeldCalls() {
	const queryClient = useQueryClient();
	const holds = useQuery({
		...orpc.holds.list.queryOptions(),
		refetchInterval: 15_000,
	});
	const resume = useMutation({
		mutationFn: (vendor: "anthropic" | "openai") =>
			client.holds.resume({ vendor }),
		onSuccess: (_r, vendor) => {
			toast.success(`${SUBSCRIPTION[vendor]} calls resume.`);
			void queryClient.invalidateQueries({ queryKey: orpc.holds.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.ai.key() });
		},
		onError: (e) => toast.error(e.message),
	});
	const data = holds.data;
	if (!data) return null;
	const stopped = (["anthropic", "openai"] as const).filter(
		(v) => data.state[v].blocked,
	);
	if (data.held.length === 0 && stopped.length === 0) return null;
	return (
		<Section
			title={
				data.held.length > 0
					? `${data.held.length} call${data.held.length === 1 ? "" : "s"} with unknown billing`
					: "Subscription calls are stopped"
			}
			data-testid="held-calls"
		>
			<Notice tone="destructive">
				A call that may have been billed is counted at its worst case in
				Spending until you say what it really cost. Check the vendor's usage
				page, then enter the amount (it counts as API spend) or mark it not
				charged. A subscription that was paid, or might have been, stays stopped
				until you resume it, even after a restart.
			</Notice>
			<Group>
				{data.held.map((call) => (
					<HeldRow key={call.id} call={call} />
				))}
				{stopped.map((vendor) => (
					<FormRow
						key={vendor}
						data-testid={`stopped-${vendor}`}
						label={
							vendor === "anthropic" ? "Claude is stopped" : "Codex is stopped"
						}
						hint={
							<span className="text-destructive">
								{data.state[vendor].blocked}
							</span>
						}
					>
						<Button
							variant="outline"
							disabled={data.state[vendor].held > 0 || resume.isPending}
							onClick={() => resume.mutate(vendor)}
							data-testid={`resume-${vendor}`}
						>
							{vendor === "anthropic"
								? "Extra usage is off: resume Claude"
								: "Resume Codex"}
						</Button>
					</FormRow>
				))}
			</Group>
		</Section>
	);
}
