import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { orpc } from "@/lib/orpc";
import { estimateText } from "@/lib/prepare-estimate";

/**
 * Prepare's likely cost, read fresh each time it is shown: a preparation that just finished
 * moves the figure, and the models may have changed in Settings since.
 */
function useEstimate(jobs: number) {
	const query = useQuery({
		...orpc.application.prepareEstimate.queryOptions(),
		refetchOnMount: "always",
	});
	return query.isPending
		? null
		: estimateText(query.data?.estimate, jobs, query.data?.connected ?? true);
}

/** The estimate as two lines: the figure, then what it rests on. */
export function PrepareEstimate({
	jobs = 1,
	"data-testid": testId = "prepare-estimate",
}: {
	jobs?: number;
	"data-testid"?: string;
}) {
	const text = useEstimate(jobs);
	return (
		<span className="flex flex-col gap-0.5" data-testid={testId}>
			<span className="text-foreground font-medium">
				{text?.headline ?? "Estimating the cost…"}
			</span>
			{text ? (
				<span className="text-muted-foreground">{text.basis}</span>
			) : null}
		</span>
	);
}

/** Prepare's button with its likely cost on hover (issue #66). */
export function PrepareTip({
	jobs = 1,
	children,
}: {
	jobs?: number;
	children: ReactElement;
}) {
	return (
		<Tooltip
			data-testid="prepare-tip"
			content={
				<span className="flex flex-col gap-1.5">
					<span className="text-muted-foreground">
						Drafts a CV, letter and answers
						{jobs > 1 ? ` for each of the ${jobs} jobs` : " for this job"}, then
						checks them against your profile.
					</span>
					<PrepareEstimate jobs={jobs} data-testid="prepare-tip-estimate" />
				</span>
			}
		>
			{children}
		</Tooltip>
	);
}
