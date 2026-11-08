import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Toggle } from "@/components/pipeline/settings/shared";
import { Cells, Notice } from "@/components/system/bits";
import { Group, Section } from "@/components/system/layout";
import { FormRow, Row } from "@/components/system/rows";
import { RowsSkeleton } from "@/components/system/skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usd } from "@/lib/money";
import { client, orpc } from "@/lib/orpc";

const STEP_LABEL: Record<string, string> = {
	"fit-score": "Finding matches",
	tailor: "Drafting",
	"claims-check": "Checking drafts",
	"profile-structure": "Reading your resume",
	scrape: "Reading careers pages",
	"chat-application": "Chat about applications",
	"chat-profile": "Profile chat",
	"answer-helper": "Answer helper on Questions",
	// Past calls of the removed Help me remember.
	"answer-choices": "Help me remember on Questions",
	"connection-test": "Test buttons on this page",
};

/** A small label over one of the two lists. */
function ListLabel({ children }: { children: string }) {
	return (
		<p className="text-muted-foreground mt-2 text-xs font-medium">{children}</p>
	);
}

/**
 * Whether money is in play: a step runs on a pay-per-use model, this month has paid calls, or a
 * limit is on (so it can be turned off). Plans and free models cost nothing extra, and then the
 * page shows no dollars and no limit.
 */
function usePaid(): boolean {
	const ai = useQuery(orpc.ai.get.queryOptions());
	const spending = useQuery({
		...orpc.spending.get.queryOptions(),
		retry: false,
	});
	const s = spending.data;
	return Boolean(
		ai.data?.roles.some((r) => r.ready && r.billing === "api") ||
			(s &&
				(s.enabled ||
					s.reached ||
					s.spentMicros + s.reservedMicros > 0 ||
					(s.held?.count ?? 0) > 0)),
	);
}

/** A model's or step's calls, how they were paid (a model's row), and a cost only when paid. */
function UsageMeta({
	calls,
	micros,
	via,
}: {
	calls: number;
	micros: number;
	via?: string[];
}) {
	return (
		<>
			<span>
				{calls} call{calls === 1 ? "" : "s"}
				{via?.length ? ` · ${via.join(" and ")}` : ""}
			</span>
			{micros > 0 ? (
				<span className="text-foreground w-16 text-right font-mono">
					{usd(micros)}
				</span>
			) : null}
		</>
	);
}

/** Spend against the limit: one cell per dollar, or per 1/40 of a limit over $40. */
function SpendCells({
	usedMicros,
	capMicros,
	reached,
}: {
	usedMicros: number;
	capMicros: number;
	reached?: boolean;
}) {
	const capUsd = capMicros / 1_000_000;
	const total = Math.max(1, Math.min(40, Math.round(capUsd)));
	const on =
		capMicros > 0
			? Math.min(total, Math.ceil((usedMicros / capMicros) * total - 1e-9))
			: 0;
	return (
		<Cells
			total={total}
			on={on}
			tone="ink"
			warn={reached ? Array.from({ length: total }, (_, i) => i) : []}
			label={`${Math.round((usedMicros / Math.max(1, capMicros)) * 100)}% of the limit`}
		/>
	);
}

/** This month's model calls by model and by step; dollars only for paid calls. */
export function UsageSection() {
	const paid = usePaid();
	const breakdown = useQuery(orpc.spendingBreakdown.get.queryOptions());
	const spending = useQuery({
		...orpc.spending.get.queryOptions(),
		retry: false,
	});
	const s = spending.data;
	const used = s ? s.spentMicros + s.reservedMicros : 0;
	const b = breakdown.data;
	return (
		<Section
			title="This month"
			description="OfferFinch's model calls since the 1st, by model and by step."
			data-testid="usage"
		>
			{paid && s ? (
				<div className="flex flex-col gap-1" data-testid="spend-month">
					<div className="flex items-baseline gap-2">
						<span className="text-foreground font-mono text-xl font-semibold tabular-nums">
							{usd(used)}
						</span>
						<span className="text-muted-foreground text-xs">
							{s.enabled
								? `of a ${usd(s.capMicros)} limit`
								: "on paid models, estimated from list prices"}
						</span>
					</div>
					{s.enabled ? (
						<SpendCells
							usedMicros={used}
							capMicros={s.capMicros}
							reached={s.reached}
						/>
					) : null}
					{s.reached ? (
						<p
							className="text-destructive text-xs"
							data-testid="cap-reached"
							role="status"
						>
							The limit is reached: new preparation waits until next month or a
							higher limit (under Limits below).
						</p>
					) : null}
				</div>
			) : null}
			{!b ? (
				<RowsSkeleton rows={2} />
			) : b.byModel.length === 0 ? (
				<p className="text-muted-foreground text-sm" data-testid="usage-empty">
					No model calls yet this month.
				</p>
			) : (
				<>
					<ListLabel>By model</ListLabel>
					<Group data-testid="usage-by-model">
						{b.byModel.map((m) => (
							<Row key={m.name} title={m.label} meta={<UsageMeta {...m} />} />
						))}
					</Group>
					<ListLabel>By step</ListLabel>
					<Group data-testid="usage-by-step">
						{b.byStep.map((t) => (
							<Row
								key={t.name}
								title={STEP_LABEL[t.name] ?? t.name}
								meta={<UsageMeta calls={t.calls} micros={t.micros} />}
							/>
						))}
					</Group>
				</>
			)}
			{(s?.held?.count ?? 0) > 0 && (
				<Notice tone="warning" title="Paid calls with an unknown cost">
					<span data-testid="held-spend">
						{s?.held?.count} paid call(s) failed without saying what they cost.
						This month's limit counts them at their most:{" "}
						{usd(s?.held?.micros ?? 0)}.
					</span>
				</Notice>
			)}
		</Section>
	);
}

/** The monthly dollar limit on paid models; shown only while money is in play. */
export function SpendingLimit() {
	const paid = usePaid();
	const queryClient = useQueryClient();
	const spending = useQuery({
		...orpc.spending.get.queryOptions(),
		retry: false,
	});
	const [capUsd, setCapUsd] = useState<string | null>(null);
	const setCap = useMutation({
		mutationFn: (input: { enabled: boolean; monthlyUsd: number }) =>
			client.spending.set(input),
		onSuccess: () => {
			toast.success("Monthly limit saved.");
			setCapUsd(null);
			void queryClient.invalidateQueries({ queryKey: orpc.spending.get.key() });
		},
		onError: (error) => toast.error(error.message),
	});
	const data = spending.data;
	if (!paid || !data) return null;
	return (
		<Group data-testid="spending-limit">
			<Toggle
				label="Stop new preparation at a monthly limit"
				hint="For paid models only; plans and free models never count. When on, the AI waits before a call that would pass the limit."
				checked={data.enabled}
				onChange={(enabled) =>
					setCap.mutate({ enabled, monthlyUsd: data.capMicros / 1_000_000 })
				}
				disabled={setCap.isPending}
				testId="spending-cap-on"
			/>
			{data.enabled ? (
				<FormRow
					label="Limit per month"
					htmlFor="cap-usd"
					hint="In US dollars, at most $2,000."
				>
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							setCap.mutate({
								enabled: data.enabled,
								monthlyUsd: Number(capUsd),
							});
						}}
					>
						<Input
							id="cap-usd"
							type="number"
							min={0}
							max={2000}
							step="1"
							className="w-24 tabular-nums"
							value={capUsd ?? String(data.capMicros / 1_000_000)}
							onChange={(e) => setCapUsd(e.target.value)}
							data-testid="cap-usd"
						/>
						<Button
							type="submit"
							variant="outline"
							disabled={capUsd === null || setCap.isPending}
							data-testid="cap-save"
						>
							Save
						</Button>
					</form>
				</FormRow>
			) : null}
		</Group>
	);
}
