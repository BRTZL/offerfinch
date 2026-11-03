import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
	QueryState,
	SettingsPage,
	Toggle,
} from "@/components/pipeline/settings/shared";
import { Cells, Notice } from "@/components/system/bits";
import { Group, GroupBody, Section } from "@/components/system/layout";
import { FormRow, Row } from "@/components/system/rows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usd } from "@/lib/money";

const STEP_LABEL: Record<string, string> = {
	"fit-score": "Finding matches",
	tailor: "Drafting",
	"claims-check": "Checking drafts",
	"profile-structure": "Reading your resume",
	scrape: "Reading careers pages",
	"chat-application": "Chat about applications",
	"chat-profile": "Profile chat",
	"answer-helper": "Answer helper on Questions",
	"answer-choices": "Help me remember on Questions",
};

/** A model's or step's share: its cost, and its subscription calls. */
function SpendMeta({
	calls,
	micros,
	subscription,
}: {
	calls: number;
	micros: number;
	subscription: number;
}) {
	return (
		<>
			<span>
				{calls} call{calls === 1 ? "" : "s"}
				{subscription > 0 ? `, ${subscription} on a subscription` : ""}
			</span>
			<span className="text-foreground w-16 text-right font-mono">
				{usd(micros)}
			</span>
		</>
	);
}

/** Spend against the cap: one cell per dollar, or per 1/40 of a cap over $40. */
export function SpendCells({
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
			label={`${Math.round((usedMicros / Math.max(1, capMicros)) * 100)}% of the cap`}
		/>
	);
}

import { client, orpc } from "@/lib/orpc";
import { Link } from "@/lib/router";

/** The monthly cap on model spend and this month's estimated spend. */
export function SpendingSettings() {
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
			toast.success("Spending cap saved.");
			setCapUsd(null);
			void queryClient.invalidateQueries({ queryKey: orpc.spending.get.key() });
		},
		onError: (error) => toast.error(error.message),
	});
	const breakdown = useQuery(orpc.spendingBreakdown.get.queryOptions());
	const data = spending.data;
	const used = data ? data.spentMicros + data.reservedMicros : 0;

	return (
		<SettingsPage
			id="spending"
			title="Spending"
			description="What model calls cost this month, by model and by step. Estimated from list prices; your provider's invoice is the real figure. Subscription calls are counted, not priced."
		>
			<QueryState
				isLoading={spending.isLoading}
				error={spending.error}
				what="spending"
			/>
			{data && (
				<>
					<Section title="This month">
						<Group data-testid="spend-month">
							<GroupBody className="flex flex-col gap-1">
								<div className="flex items-baseline gap-2">
									<span className="text-foreground font-mono text-xl font-semibold tabular-nums">
										{usd(used)}
									</span>
									<span className="text-muted-foreground text-xs">
										{data.enabled
											? `of a ${usd(data.capMicros)} limit`
											: "estimated from list prices"}
									</span>
								</div>
								{data.enabled ? (
									<SpendCells
										usedMicros={used}
										capMicros={data.capMicros}
										reached={data.reached}
									/>
								) : null}
								{data.reached && (
									<p
										className="text-destructive text-xs"
										data-testid="cap-reached"
										role="status"
									>
										The limit is reached: new preparation waits until next month
										or a higher limit.
									</p>
								)}
							</GroupBody>
						</Group>
					</Section>
					{breakdown.data && breakdown.data.byModel.length > 0 ? (
						<>
							<Section title="By model">
								<Group data-testid="spend-by-model">
									{breakdown.data.byModel.map((m) => (
										<Row
											key={m.name}
											title={<span className="font-mono">{m.name}</span>}
											meta={<SpendMeta {...m} />}
										/>
									))}
								</Group>
							</Section>
							<Section title="By step">
								<Group data-testid="spend-by-step">
									{breakdown.data.byStep.map((t) => (
										<Row
											key={t.name}
											title={STEP_LABEL[t.name] ?? t.name}
											meta={<SpendMeta {...t} />}
										/>
									))}
								</Group>
							</Section>
						</>
					) : null}
					<Section title="Monthly limit">
						<Group>
							<Toggle
								label="Stop new preparation at a monthly limit"
								hint="Off by default. When on, the AI waits before a call that would pass the limit."
								checked={data.enabled}
								onChange={(enabled) =>
									setCap.mutate({
										enabled,
										monthlyUsd: data.capMicros / 1_000_000,
									})
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
					</Section>
					{(data.held?.count ?? 0) > 0 && (
						<Notice tone="warning" title="Calls with an unknown cost">
							<span data-testid="held-spend">
								{data.held?.count} call(s) may still be billed, so{" "}
								{usd(data.held?.micros ?? 0)} is held aside until you settle
								each in{" "}
								<Link
									href="/settings/models"
									className="text-primary hover:underline"
								>
									Settings › Models
								</Link>
								.
							</span>
						</Notice>
					)}
				</>
			)}
		</SettingsPage>
	);
}
