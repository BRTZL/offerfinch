import {
	STAGE_LABEL,
	TRACKING_STAGES,
	type TrackingStage,
} from "@offerfinch/core/domain/tracking";
import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useState } from "react";
import { StageChip } from "@/components/pipeline/application/tracking";
import { ApplicationListPage } from "@/components/pipeline/application-list";
import { sourceLabel } from "@/components/pipeline/bits";
import { FilterSelect } from "@/components/pipeline/filter-select";
import { Fit } from "@/components/system/bits";
import { orpc } from "@/lib/orpc";

/**
 * Every application that went out, newest first, beside the one chosen. Each shows its stage
 * after Applied (Heard back, Interviewing, …), and the list filters by stage with its counts.
 */
export default function AppliedPage() {
	const list = useQuery({
		...orpc.submission.applied.queryOptions(),
		refetchInterval: 15_000,
	});
	const stages = useQuery({
		...orpc.tracking.stages.queryOptions(),
		refetchInterval: 15_000,
	});
	const [stage, setStage] = useState("all");
	const all = (list.data ?? []).map((r) => {
		const current = stages.data?.[r.id];
		return {
			...r,
			state: "applied",
			// An application with no stage entry yet is at Applied.
			stage: (current?.stage ?? "applied") as TrackingStage,
			round: current?.round ?? null,
		};
	});
	const counts = new Map<TrackingStage, number>();
	for (const r of all) counts.set(r.stage, (counts.get(r.stage) ?? 0) + 1);
	const rows = stage === "all" ? all : all.filter((r) => r.stage === stage);
	const filtered = stage !== "all";
	return (
		<ApplicationListPage
			base="/applied"
			title="Applied"
			subtitle={
				list.data
					? filtered
						? `${rows.length} of ${all.length} sent`
						: `${all.length} sent`
					: undefined
			}
			label="Applied"
			toolbar={
				<FilterSelect
					label="Stage"
					value={stage}
					onChange={setStage}
					testId="stage-filter"
					options={[
						{ value: "all", label: `All stages · ${all.length}` },
						...TRACKING_STAGES.filter((s) => counts.has(s) || s === stage).map(
							(s) => ({
								value: s,
								label: `${STAGE_LABEL[s]} · ${counts.get(s) ?? 0}`,
							}),
						),
					]}
				/>
			}
			items={rows}
			loading={list.isLoading}
			error={
				list.isError
					? `Could not load applied jobs: ${list.error.message}. It retries shortly.`
					: null
			}
			empty={{
				icon: <Send />,
				title: filtered ? "None at this stage" : "Nothing sent yet",
				body: filtered
					? "No application is at this stage now. Choose All stages to see every one."
					: "After you approve an application and send it on the job board, press I submitted this. It is listed here.",
			}}
			render={(row) => ({
				testId: "applied-row",
				title: row.companyName,
				time: row.appliedAt
					? new Date(row.appliedAt).toLocaleDateString(undefined, {
							month: "short",
							day: "numeric",
						})
					: undefined,
				subtitle: row.title,
				meta: (
					<>
						<Fit value={row.score} />
						<StageChip stage={row.stage} round={row.round} />
						<span className="text-muted-foreground truncate">
							{row.appliedVia === "manual"
								? "Sent by you"
								: "Sent automatically"}
						</span>
						<span className="text-muted-foreground ml-auto shrink-0">
							{sourceLabel("source" in row ? (row.source as string) : null)}
						</span>
					</>
				),
			})}
		/>
	);
}
