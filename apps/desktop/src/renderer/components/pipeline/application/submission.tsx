import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type AppDetail,
	DOC_LABEL,
} from "@/components/pipeline/application/types";
import { ago, FileLink, Section } from "@/components/pipeline/bits";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const ATTEMPT_LABEL: Record<string, string> = {
	started: "clicked, outcome pending",
	submitted: "submitted",
	needs_human: "outcome unknown",
	not_sent: "not sent",
	dry_run: "dry run",
	failed: "failed",
};

/** Today as YYYY-MM-DD in the browser's time zone. */
export function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function CopyRow({ label, value }: { label: string; value: string }) {
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
 * Submission: for a hand-off (every board today) the numbered steps from approval to
 * "I submitted this"; for an automatic board the attempts, dry run and retry.
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
	onMarkSubmitted: (appliedOn: string) => void;
	onDryRun: () => void;
	busy: boolean;
	dryRunning: boolean;
}) {
	const [appliedOn, setAppliedOn] = useState(today);
	useHandoffCheck(app);
	const relevant = ["approved", "applying", "applied", "needs_human"].includes(
		app.state,
	);
	if (!relevant && app.attempts.length === 0) return null;
	const open = app.state === "needs_human" || app.state === "approved";
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
		<Section title={open ? "Submit it yourself" : "Submission"}>
			<div className="flex flex-col gap-3 text-xs" data-testid="submission">
				{open && (
					<ol className="flex flex-col gap-4" data-testid="handoff">
						<Step
							n={1}
							title={
								<a
									href={app.handoff.formUrl}
									target="_blank"
									rel="noreferrer"
									className="text-primary hover:underline"
									data-testid="handoff-link"
								>
									{formLink} ↗
								</a>
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
							disabled={dryRunning}
							data-testid="dry-run"
							title="Fill the form with the network closed and screenshot it; never clicks submit"
						>
							{dryRunning ? "Dry run…" : "Dry run"}
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
							I checked the employer's portal or my email: attempt{" "}
							{app.unresolvedAttempt.attempt} did not go through.
						</span>
					</label>
				)}
				{app.attempts.length > 0 && (
					<ol className="flex flex-col gap-2">
						{app.attempts.map((a) => (
							<li
								key={a.id}
								className="border-border border-l-2 pl-2"
								data-testid="attempt"
							>
								<div className="flex items-center gap-2">
									<span className="font-mono tabular-nums">#{a.attempt}</span>
									<span
										className={cn(
											"font-medium",
											a.status === "submitted" && "text-brand",
											a.status === "needs_human" && "text-destructive",
										)}
										data-testid="attempt-status"
									>
										{ATTEMPT_LABEL[a.status] ?? a.status}
									</span>
									<span className="text-muted-foreground">
										{a.mode === "manual" ? "by you" : a.board} ·{" "}
										{ago(a.startedAt)}
									</span>
								</div>
								{(a.error || a.resolution) && (
									<div className="text-muted-foreground mt-0.5">
										{a.resolution ?? a.error}
									</div>
								)}
								{(a.hasBefore || a.hasAfter) && (
									<div className="mt-1 flex gap-1.5">
										{(["before", "after"] as const)
											.filter((w) =>
												w === "before" ? a.hasBefore : a.hasAfter,
											)
											.map((w) => (
												<button
													key={w}
													type="button"
													className={buttonVariants({
														variant: "outline",
														size: "xs",
													})}
													data-testid={`proof-${w}`}
													onClick={() => void desktop.openProof(a.id, w)}
												>
													Screenshot{" "}
													{w === "before"
														? "before submitting"
														: "after submitting"}
												</button>
											))}
									</div>
								)}
							</li>
						))}
					</ol>
				)}
			</div>
		</Section>
	);
}
