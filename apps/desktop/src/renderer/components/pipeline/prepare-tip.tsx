import type { ReactElement } from "react";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Prepare's button with what it does on hover. No cost is shown (the owner mostly uses
 * subscriptions; 2026-11-03).
 */
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
				<span className="text-muted-foreground">
					Drafts a CV, letter and answers
					{jobs > 1 ? ` for each of the ${jobs} jobs` : " for this job"}, then
					checks them against your profile.
				</span>
			}
		>
			{children}
		</Tooltip>
	);
}
