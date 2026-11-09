import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { useDemoMode } from "@/components/desktop/demo";
import {
	type AppDetail,
	DOC_LABEL,
} from "@/components/pipeline/application/types";
import { FileLink, Section } from "@/components/pipeline/bits";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { AttemptList } from "./proof";
import { isWebSent } from "./stop-model";

/** Today as YYYY-MM-DD in the browser's time zone. */
export function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A label and value with a Copy button; nothing when the value is empty. */
export function CopyRow({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false);
	if (!value) return null;
	return (
		<div className="flex items-start gap-2 py-2" data-testid="copy-row">
			<div className="min-w-0 flex-1">
				<div className="text-2xs text-muted-foreground">{label}</div>
				<div className="text-foreground text-xs break-words whitespace-pre-wrap">
					{value}
				</div>
			</div>
			<Button
				size="xs"
				variant="ghost"
				aria-label={`Copy ${label}`}
				onClick={async () => {
					try {
						await desktop.copyText(value);
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					} catch {
						toast.error("Could not copy. Select the text and copy it instead.");
					}
				}}
			>
				{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
				{copied ? "Copied" : "Copy"}
			</Button>
		</div>
	);
}

function Step({
	n,
	title,
	children,
}: {
	n: number;
	title: ReactNode;
	children?: ReactNode;
}) {
	return (
		<li className="flex gap-2">
			<span
				className="border-border bg-muted text-2xs text-foreground flex size-5 shrink-0 items-center justify-center rounded-sm border font-mono tabular-nums"
				aria-hidden
			>
				{n}
			</span>
			<div className="min-w-0 flex-1">
				<div className="text-foreground text-xs font-medium">{title}</div>
				{children && <div className="mt-1">{children}</div>}
			</div>
		</li>
	);
}

/**
 * As the hand-off opens on an approved application, the posting is checked once (cheap and safe
 * checks only, in the worker); found closed, the page and the Inbox show it closed.
 */
function useHandoffCheck(app: AppDetail) {
	const queryClient = useQueryClient();
	const check = useQuery({
		queryKey: ["posting-check", app.id],
		queryFn: () => client.application.checkPosting({ id: app.id }),
		enabled:
			app.state === "approved" && !app.job.closedAt && !app.job.openConfirmedAt,
		staleTime: 10 * 60_000,
		retry: false,
	});
	const closed = check.data?.closed === true;
	useEffect(() => {
		if (!closed) return;
		void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
		void queryClient.invalidateQueries({ queryKey: ["inbox"] });
	}, [closed, queryClient]);
}

/**
 * Submission: for a hand-off the numbered steps from approval to "I submitted this"; for an
 * automatic board the attempts with their proof, the dry run and the retry, and the same steps
 * while it waits (paused) or after a stop (needs_human).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep hand-off presentation and its mutually exclusive submission states together.
export function SubmissionPanel({
	app,
	confirmedNotSent,
	setConfirmedNotSent,
	onRetry,
	onMarkSubmitted,
	onDryRun,
	busy,
	dryRunning,
}: {
	app: AppDetail;
	confirmedNotSent: boolean;
	setConfirmedNotSent: (value: boolean) => void;
	onRetry: () => void;
	/** `gotEmail`: Got the email, for an employer's form that was sent. */
	onMarkSubmitted: (appliedOn: string, gotEmail?: boolean) => void;
	onDryRun: () => void;
	busy: boolean;
	dryRunning: boolean;
}) {
	const [appliedOn, setAppliedOn] = useState(today);
	// Try-it mode opens no link: the step names the form without one.
	const demo = useDemoMode();
	useHandoffCheck(app);
	const relevant = ["approved", "applying", "applied", "needs_human"].includes(
		app.state,
	);
	if (!relevant && app.attempts.length === 0) return null;
	// An employer's form that was sent waits for the user's email: finishing it by hand opens only
	// once they say it didn't go through (decision 2026-11-09).
	const waitingEmail =
		app.state === "needs_human" &&
		app.attempts.some(
			(a) => a.attempt === app.unresolvedAttempt?.attempt && isWebSent(a),
		);
	const open =
		(app.state === "needs_human" || app.state === "approved") &&
		(!waitingEmail || confirmedNotSent);
	const handoffBoard = app.submission?.mode === "handoff";
	const contact = app.handoff.contact;
	const pdfs = app.exports.filter(
		(e) =>
			e.format === "pdf" &&
			e.sourceVersion === app.documents.find((d) => d.kind === e.kind)?.version,
	);
	const formLink =
		app.job.source === "linkedin"
			? "applyUrl" in app.job && app.job.applyUrl
				? "Open the employer's application page"
				: "Open the LinkedIn posting (apply there yourself; Easy Apply is never used for you)"
			: "Open the application form";

	return (
		<Section
			title={
				waitingEmail && !confirmedNotSent
					? "Sent — check your email"
					: open
						? "Submit it yourself"
						: "Submission"
			}
		>
			<div className="flex flex-col gap-3 text-xs" data-testid="submission">
				{waitingEmail && !confirmedNotSent && (
					<div className="flex flex-col gap-1.5" data-testid="sent-check-email">
						<p className="text-muted-foreground">
							The employer's form was sent once. Their email tells whether it
							arrived; nothing is sent again on its own.
						</p>
						<div>
							<Button
								size="sm"
								onClick={() => onMarkSubmitted(today(), true)}
								disabled={busy}
								data-testid="got-email"
							>
								Got the email
							</Button>
						</div>
					</div>
				)}
				{open && (
					<ol className="flex flex-col gap-4" data-testid="handoff">
						<Step
							n={1}
							title={
								demo ? (
									<span data-testid="handoff-link">{formLink}</span>
								) : (
									<a
										href={app.handoff.formUrl}
										target="_blank"
										rel="noreferrer"
										className="text-primary hover:underline"
										data-testid="handoff-link"
									>
										{formLink} ↗
									</a>
								)
							}
						>
							{app.submission?.reason && (
								<p className="text-muted-foreground">{app.submission.reason}</p>
							)}
						</Step>
						<Step n={2} title="Fill in your details and answers">
							<div className="divide-border flex flex-col divide-y">
								<CopyRow label="Name" value={contact?.name ?? ""} />
								<CopyRow label="Email" value={contact?.email ?? ""} />
								<CopyRow label="Phone" value={contact?.phone ?? ""} />
								<CopyRow label="Location" value={contact?.location ?? ""} />
								<CopyRow label="LinkedIn" value={contact?.linkedin ?? ""} />
								<CopyRow label="GitHub" value={contact?.github ?? ""} />
								<CopyRow label="Website" value={contact?.website ?? ""} />
								{app.formAnswers.map((a) => (
									<CopyRow
										key={a.question}
										label={a.question}
										value={a.answer}
									/>
								))}
							</div>
						</Step>
						<Step n={3} title="Attach the approved PDFs">
							<div className="flex flex-wrap gap-1.5">
								{pdfs.map((e) => (
									<FileLink
										key={e.id}
										documentId={e.id}
										className={buttonVariants({
											variant: "outline",
											size: "sm",
										})}
									>
										{DOC_LABEL[e.kind] ?? e.kind} PDF
									</FileLink>
								))}
								{pdfs.length === 0 && (
									<span className="text-muted-foreground">
										No PDFs for the approved versions.
									</span>
								)}
							</div>
						</Step>
						<Step n={4} title="After you send it, record the day">
							<div className="flex flex-wrap items-center gap-1.5">
								<label htmlFor="applied-on" className="text-muted-foreground">
									Sent on
								</label>
								<Input
									id="applied-on"
									type="date"
									value={appliedOn}
									max={today()}
									onChange={(e) => setAppliedOn(e.target.value)}
									size="sm"
									className="w-36"
									data-testid="applied-on"
								/>
								<Button
									size="sm"
									variant={handoffBoard ? "default" : "outline"}
									onClick={() => onMarkSubmitted(appliedOn)}
									disabled={busy || !appliedOn}
									data-testid="mark-submitted"
								>
									I submitted this
								</Button>
							</div>
							<p className="text-muted-foreground mt-1">
								Moves it to Applied. Nothing is sent from here.
							</p>
						</Step>
					</ol>
				)}
				{open && !handoffBoard && (
					<div className="border-border flex flex-wrap gap-1.5 border-t pt-3">
						<Button
							size="sm"
							variant="outline"
							onClick={onDryRun}
							pending={dryRunning}
							data-testid="dry-run"
							title="Fill the form with the network closed and screenshot it; never clicks submit"
						>
							Dry run
						</Button>
						{app.state === "needs_human" && (
							<Button
								size="sm"
								onClick={onRetry}
								disabled={
									busy || (Boolean(app.unresolvedAttempt) && !confirmedNotSent)
								}
								data-testid="retry"
							>
								Retry automatic submission
							</Button>
						)}
					</div>
				)}
				{app.state === "needs_human" && app.unresolvedAttempt && (
					// biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox inside is the control
					<label className="flex items-start gap-2">
						<Checkbox
							checked={confirmedNotSent}
							onCheckedChange={(value) => setConfirmedNotSent(value === true)}
							className="mt-px"
							data-testid="confirm-not-sent"
						/>
						<span>
							{waitingEmail
								? "It didn't go through: no email came, and the employer's portal does not list it."
								: `I checked the employer's portal or my email: attempt ${app.unresolvedAttempt.attempt} did not go through.`}
						</span>
					</label>
				)}
				<AttemptList attempts={app.attempts} />
			</div>
		</Section>
	);
}
