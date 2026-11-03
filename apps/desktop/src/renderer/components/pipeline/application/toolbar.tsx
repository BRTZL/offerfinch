import {
	MessageSquareText,
	PanelLeft,
	PanelRight,
	TriangleAlert,
} from "lucide-react";
import { createContext } from "react";
import { createPortal } from "react-dom";
import { PrepareTip } from "@/components/pipeline/prepare-tip";
import { ToolbarSeparator } from "@/components/system/layout";
import { Button } from "@/components/ui/button";
import { keyHint } from "../../../../shared/shortcuts";
import type {
	ApplicationActions,
	ApplicationDetailProps,
} from "./use-application-actions";

/** Where the detail puts its Reject… and Approve: the window toolbar (a portal target). */
export const ToolbarSlot = createContext<HTMLElement | null>(null);
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep action availability and labels together so each application state has one visible set of actions.
export function ApplicationToolbar({
	slot,
	loaded,
	postingOpen,
	setPostingOpen,
	chatOpen,
	toggleChat,
	detailsOpen,
	toggleDetails,
	setAsideActions,
	matchActions,
	prepare,
	inReview,
	rejecting,
	openFlags,
	jumpToFlag,
	setRejecting,
	approve,
	approvable,
}: ApplicationActions &
	Pick<ApplicationDetailProps, "matchActions" | "setAsideActions">) {
	return slot
		? createPortal(
				<>
					<ToolbarSeparator />
					{loaded?.documents.some(
						(d) => d.kind === "cv" || d.kind === "cover_letter",
					) ? (
						<Button
							size="sm"
							variant="ghost"
							aria-pressed={postingOpen}
							onClick={() => setPostingOpen(!postingOpen)}
							data-testid="posting-toggle"
							aria-label="Posting"
							title="Show the posting beside the document"
						>
							<PanelLeft />
							<span className="hidden xl:inline">Posting</span>
						</Button>
					) : null}
					<Button
						size="sm"
						variant="ghost"
						aria-pressed={chatOpen}
						onClick={toggleChat}
						data-testid="chat-toggle"
						aria-label="Chat"
						title="Ask for changes to the CV, letter or answers"
					>
						<MessageSquareText />
						<span className="hidden xl:inline">Chat</span>
					</Button>
					<Button
						size="sm"
						variant="ghost"
						aria-pressed={detailsOpen}
						onClick={toggleDetails}
						data-testid="inspector-toggle"
						aria-label="Details"
						title={`Fit, checks, flags and what happens next (${keyHint("toggle-inspector")})`}
					>
						<PanelRight />
						<span className="hidden xl:inline">Details</span>
					</Button>
					{loaded?.state === "rejected_by_filter" && setAsideActions ? (
						<>
							<ToolbarSeparator />
							{setAsideActions}
						</>
					) : null}
					{loaded?.state === "scored" &&
					!loaded.prepareRequestedAt &&
					!loaded.endedReason &&
					!loaded.job.closedAt ? (
						<>
							<ToolbarSeparator />
							{matchActions}
							<PrepareTip>
								<Button
									size="sm"
									onClick={() => prepare.mutate()}
									disabled={prepare.isPending}
									data-testid="prepare"
								>
									{prepare.isPending ? "Starting…" : "Prepare"}
								</Button>
							</PrepareTip>
						</>
					) : null}
					{inReview && !rejecting ? (
						<>
							<ToolbarSeparator />
							{openFlags > 0 ? (
								<Button
									size="sm"
									variant="ghost"
									className="text-warning"
									onClick={jumpToFlag}
									data-testid="jump-to-flag"
								>
									<TriangleAlert />
									{openFlags} to resolve
								</Button>
							) : null}
							<Button
								size="sm"
								variant="outline"
								onClick={() => setRejecting(true)}
								disabled={!loaded}
							>
								Reject…
							</Button>
							<Button
								size="sm"
								onClick={() => loaded && approve.mutate(loaded)}
								disabled={!approvable}
								data-testid="approve"
								aria-describedby="decision-help"
								title={
									!loaded
										? "Loading the documents and checks"
										: loaded.approvable
											? "Approve these exact documents"
											: openFlags > 0
												? `Resolve the ${openFlags} flagged line${openFlags === 1 ? "" : "s"} first: edit, delete or confirm each`
												: loaded.staleProfile.length > 0
													? "Your profile changed since the check: check again first"
													: "Only documents that passed every check can be approved"
								}
							>
								Approve
							</Button>
						</>
					) : null}
				</>,
				slot,
			)
		: null;
}
