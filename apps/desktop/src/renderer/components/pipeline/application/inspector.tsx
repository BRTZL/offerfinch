import { X } from "lucide-react";
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
import { WhatWillBeSentSection } from "@/components/pipeline/application/form-fields";
import { SubmissionPanel } from "@/components/pipeline/application/submission";
import {
	NotesSection,
	TrackingSection,
} from "@/components/pipeline/application/tracking";
import { DocumentPage } from "@/components/system/document";
import { Disclosure, Inspector } from "@/components/system/pane";
import { ResizeHandle } from "@/components/system/resize-handle";
import { Button } from "@/components/ui/button";
import { keyHint } from "../../../../shared/shortcuts";
import type { DocumentContext } from "./document-tabs";
/** The details sheet, opened from the fit card (or ⌘⌥I); its own button closes it. */
export function ApplicationInspector({
	toggleDetails,
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
			id="application-inspector"
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
			<div className="border-border flex shrink-0 items-center justify-between gap-2 border-b py-2 pr-3 pl-5">
				<h2 className="text-foreground text-sm font-semibold">Details</h2>
				<Button
					size="icon-xs"
					variant="ghost"
					onClick={toggleDetails}
					aria-label="Close the details"
					title={`Close the details (${keyHint("toggle-inspector")})`}
					data-testid="inspector-close"
				>
					<X />
				</Button>
			</div>
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
			<WhatWillBeSentSection app={loaded} />
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
