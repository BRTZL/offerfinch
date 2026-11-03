import {
	AfterApproveSection,
	ChecksSection,
	EvidenceDisclosure,
	FitSection,
	HistoryDisclosure,
	JobFlagsSection,
	ModelCallsDisclosure,
	QuestionsSection,
	WhyDisclosure,
} from "@/components/pipeline/application/details";
import { SubmissionPanel } from "@/components/pipeline/application/submission";
import {
	NotesSection,
	TrackingSection,
} from "@/components/pipeline/application/tracking";
import { DocumentPage } from "@/components/system/document";
import { Disclosure, Inspector } from "@/components/system/pane";
import { ResizeHandle } from "@/components/system/resize-handle";
import type { DocumentContext } from "./document-tabs";
export function ApplicationInspector({
	detailsWidth,
	rightMax,
	setDetailsWidth,
	resetDetailsWidth,
	loaded,
	confirmedNotSent,
	setConfirmedNotSent,
	retry,
	markSubmitted,
	dryRun,
	docs,
	notesHtml,
}: DocumentContext) {
	return (
		<Inspector
			aria-label="Details"
			data-testid="inspector"
			className="relative"
			style={{ width: Math.min(detailsWidth, Math.max(240, rightMax)) }}
		>
			<ResizeHandle
				edge="start"
				label="Resize the details"
				width={detailsWidth}
				min={240}
				max={Math.min(520, rightMax)}
				onResize={setDetailsWidth}
				onReset={resetDetailsWidth}
			/>
			<SubmissionPanel
				app={loaded}
				confirmedNotSent={confirmedNotSent}
				setConfirmedNotSent={setConfirmedNotSent}
				onRetry={() => retry.mutate()}
				onMarkSubmitted={(appliedOn) => markSubmitted.mutate(appliedOn)}
				onDryRun={() => dryRun.mutate()}
				busy={retry.isPending || markSubmitted.isPending}
				dryRunning={dryRun.isPending}
			/>
			{loaded.state === "applied" ? (
				<TrackingSection applicationId={loaded.id} />
			) : null}
			<ChecksSection app={loaded} />
			<JobFlagsSection app={loaded} />
			<FitSection app={loaded} />
			<AfterApproveSection app={loaded} />
			<QuestionsSection app={loaded} />
			<NotesSection applicationId={loaded.id} />
			<div className="flex flex-col gap-0.5 px-3 py-3">
				<WhyDisclosure app={loaded} />
				{docs.notes ? (
					<Disclosure title="Fit notes">
						{notesHtml !== null ? (
							<DocumentPage
								html={notesHtml}
								className="ui-prose"
								data-testid="fit-notes"
							/>
						) : (
							<p className="text-muted-foreground text-xs whitespace-pre-wrap">
								{docs.notes.content}
							</p>
						)}
					</Disclosure>
				) : null}
				<EvidenceDisclosure app={loaded} />
				{loaded.cost && <ModelCallsDisclosure cost={loaded.cost} />}
				<HistoryDisclosure app={loaded} />
			</div>
		</Inspector>
	);
}
