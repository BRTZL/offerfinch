import {
	STAGE_LABEL,
	TRACKING_STAGES,
	type TrackingStage,
} from "@offerfinch/core/domain/tracking";
import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { StageMenu } from "@/components/pipeline/application/tracking";
import { ApplicationListPage } from "@/components/pipeline/application-list";
import { sourceLabel } from "@/components/pipeline/bits";
import { Fit } from "@/components/system/bits";
import { orpc } from "@/lib/orpc";

/** The list's groups: the live ones first (where something can still happen), then the ends. */
const GROUP_ORDER: TrackingStage[] = [
	"offer",
	"interviewing",
	"heard_back",
	"applied",
	"ghosted",
	"company_rejected",
	"withdrawn",
];

/**
 * Every application that went out, grouped by its stage after Applied (Interviewing, Heard
 * back, …), each group with its count and closable. A row's stage chip moves it to another stage.
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
	const rows = (list.data ?? []).map((r) => {
		const current = stages.data?.[r.id];
		return {
			...r,
			state: "applied",
			// An application with no stage entry yet is at Applied.
			stage: (current?.stage ?? "applied") as TrackingStage,
			round: current?.round ?? null,
		};
	});
	return (
		<ApplicationListPage
			base="/applied"
			title="Applied"
			subtitle={list.data ? `${rows.length} sent` : undefined}
			label="Applied"
			items={rows}
			groupOf={(r) => r.stage}
			groups={[
				...GROUP_ORDER,
				...TRACKING_STAGES.filter((s) => !GROUP_ORDER.includes(s)),
			].map((s) => ({ key: s, label: STAGE_LABEL[s] }))}
			loading={list.isLoading}
			error={
				list.isError
					? `Could not load applied jobs: ${list.error.message}. It retries shortly.`
					: null
			}
			empty={{
				icon: <Send />,
				title: "Nothing sent yet",
				body: "After you approve an application and send it on the job board, press I submitted this. It is listed here.",
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
						<StageMenu
							applicationId={row.id}
							stage={row.stage}
							round={row.round}
						/>
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
