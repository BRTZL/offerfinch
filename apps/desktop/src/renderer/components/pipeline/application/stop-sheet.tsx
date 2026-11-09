import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CircleHelp } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useDemoMode } from "@/components/desktop/demo";
import { FileLink } from "@/components/pipeline/bits";
import { SubmissionsSettingsLink } from "@/components/pipeline/settings/submissions-link";
import { ActionBarButton } from "@/components/system/action-bar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { useRouter } from "@/lib/router";
import { ProofShots } from "./proof";
import { type StopAction, type StopView, stopView } from "./stop-model";
import { CopyRow, today } from "./submission";
import { type AppDetail, DOC_LABEL } from "./types";
import type { ApplicationActions } from "./use-application-actions";

/** Every approved value, ready to copy: the reviewed list when the form was read, else the documents. */
function ApprovedValues({ app }: { app: AppDetail }) {
	const contact = app.handoff.contact;
	const read = app.form?.status === "read" ? app.form : null;
	return (
		<div
			className="divide-border flex flex-col divide-y"
			data-testid="finish-values"
		>
			{read
				? read.fields
						.filter((f) => f.value !== null && f.kind !== "file")
						.map((f) => (
							<CopyRow key={f.key} label={f.label} value={f.value ?? ""} />
						))
				: [
						["Name", contact?.name],
						["Email", contact?.email],
						["Phone", contact?.phone],
						["Location", contact?.location],
						["LinkedIn", contact?.linkedin],
						["GitHub", contact?.github],
						["Website", contact?.website],
						...app.formAnswers.map((a) => [a.question, a.answer]),
					].map(([label, value]) => (
						<CopyRow key={label} label={label ?? ""} value={value ?? ""} />
					))}
		</div>
	);
}

/** The approved PDFs, each opening in its default app. */
function ApprovedFiles({ app }: { app: AppDetail }) {
	const pdfs = app.exports.filter(
		(e) =>
			e.format === "pdf" &&
			e.sourceVersion === app.documents.find((d) => d.kind === e.kind)?.version,
	);
	if (pdfs.length === 0)
		return (
			<p className="text-muted-foreground text-xs">
				No PDFs for the approved versions.
			</p>
		);
	return (
		<div className="flex flex-wrap gap-1.5" data-testid="finish-files">
			{pdfs.map((e) => (
				<FileLink
					key={e.id}
					documentId={e.id}
					className={buttonVariants({ variant: "outline", size: "sm" })}
				>
					{DOC_LABEL[e.kind] ?? e.kind} PDF
				</FileLink>
			))}
		</div>
	);
}

/** Finish it yourself: the form is open in the browser; the answers and files are here. */
function FinishPanel({
	app,
	formUrl,
	actions,
}: {
	app: AppDetail;
	formUrl: string;
	actions: ApplicationActions;
}) {
	const [appliedOn, setAppliedOn] = useState(today);
	return (
		<div className="flex flex-col gap-4 text-xs" data-testid="finish-panel">
			<p className="text-muted-foreground">
				The form is open in your browser
				<span className="text-foreground font-mono break-all">
					{" "}
					({formUrl})
				</span>
				. Fill it with the approved answers below, attach the PDFs, and send it
				there. Nothing is sent from here.
			</p>
			<section className="flex flex-col gap-1">
				<h3 className="text-foreground text-xs font-medium">
					Approved answers
				</h3>
				<ApprovedValues app={app} />
			</section>
			<section className="flex flex-col gap-1.5">
				<h3 className="text-foreground text-xs font-medium">Approved files</h3>
				<ApprovedFiles app={app} />
			</section>
			<section className="border-border flex flex-wrap items-center gap-1.5 border-t pt-3">
				<label htmlFor="stop-applied-on" className="text-muted-foreground">
					Sent on
				</label>
				<Input
					id="stop-applied-on"
					type="date"
					value={appliedOn}
					max={today()}
					onChange={(e) => setAppliedOn(e.target.value)}
					size="sm"
					className="w-36"
				/>
				<Button
					size="sm"
					onClick={() => actions.markSubmitted.mutate({ appliedOn })}
					pending={actions.markSubmitted.isPending}
					disabled={!appliedOn}
					data-testid="stop-mark-submitted"
				>
					I submitted this
				</Button>
			</section>
		</div>
	);
}

const LABEL: Record<StopAction, string> = {
	got_email: "Got the email",
	finish: "Finish it yourself",
	finish_confirmed: "Finish it yourself",
	answer: "Answer and retry",
	reread: "Read the form again",
	mark: "I submitted this",
	retry: "Retry",
	retry_confirmed: "Retry",
};

/** The sheet's buttons, the first one primary. */
function StopActions({
	app,
	view,
	actions,
	onFinish,
	onClose,
}: {
	app: AppDetail;
	view: StopView<AppDetail["attempts"][number]>;
	actions: ApplicationActions;
	onFinish: () => void;
	onClose: () => void;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const key = useRef(crypto.randomUUID());
	const reread = useMutation({
		mutationFn: () =>
			client.submission.readFormAgain({
				id: app.id,
				idempotencyKey: key.current,
			}),
		onSuccess: (result) => {
			key.current = crypto.randomUUID();
			toast.success(
				result.asked > 0
					? `Read again: ${result.asked} new question(s) to answer in Questions first.`
					: `Read again: ${result.fields} field(s). Review what will be sent and approve again.`,
			);
			void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
			void queryClient.invalidateQueries({ queryKey: ["inbox"] });
			onClose();
		},
		onError: (error) => toast.error(error.message),
	});
	const confirmed = actions.confirmedNotSent;
	const run = (action: StopAction) => {
		if (action === "finish" || action === "finish_confirmed") onFinish();
		else if (action === "answer" && view.question)
			router.push(`/questions/${view.question.id}`);
		else if (action === "reread") reread.mutate();
		else if (action === "mark" || action === "got_email")
			actions.markSubmitted.mutate({
				appliedOn: today(),
				gotEmail: action === "got_email",
			});
		else actions.retry.mutate();
	};
	return (
		<div className="flex flex-col items-end gap-2">
			{view.actions.includes("retry_confirmed") ? (
				// biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox inside is the control
				<label className="flex items-start gap-2 self-stretch text-xs">
					<Checkbox
						checked={confirmed}
						onCheckedChange={(v) => actions.setConfirmedNotSent(v === true)}
						className="mt-px"
						data-testid="stop-confirm-not-sent"
					/>
					<span>
						{view.case === "web_sent" ? (
							<>
								It didn't go through: no email came, and the employer's portal
								does not list attempt {app.unresolvedAttempt?.attempt}.
							</>
						) : (
							<>
								I checked the employer's portal or my email: the click in
								attempt {app.unresolvedAttempt?.attempt} did not send the
								application.
							</>
						)}
					</span>
				</label>
			) : null}
			<div className="flex flex-wrap justify-end gap-2">
				{[...view.actions].reverse().map((action) => {
					const main = action === view.actions[0];
					return (
						<Button
							key={action}
							size="sm"
							variant={main ? "default" : "outline"}
							onClick={() => run(action)}
							pending={
								(action === "reread" && reread.isPending) ||
								((action === "mark" || action === "got_email") &&
									actions.markSubmitted.isPending) ||
								(action.startsWith("retry") && actions.retry.isPending)
							}
							disabled={
								(action === "retry_confirmed" ||
									action === "finish_confirmed") &&
								!confirmed
							}
							data-testid={`stop-${action}`}
						>
							{action === "finish" || action === "finish_confirmed" ? (
								<ArrowUpRight />
							) : null}
							{LABEL[action]}
						</Button>
					);
				})}
			</div>
		</div>
	);
}

/**
 * Why an automatic submission stopped and what to do now (docs/auto-apply-plan.md, step 7): the
 * reason in plain words, the screenshot where it stopped, and only the actions that fit. Finish it
 * yourself opens the form in the user's own browser and lists every approved answer to copy.
 */
function StopSheet({
	app,
	view,
	actions,
	onClose,
}: {
	app: AppDetail;
	view: StopView<AppDetail["attempts"][number]>;
	actions: ApplicationActions;
	onClose: () => void;
}) {
	const [finishing, setFinishing] = useState(false);
	const demo = useDemoMode();
	const formUrl = view.attempt?.url || app.handoff.formUrl;
	const finish = () => {
		setFinishing(true);
		if (!demo)
			desktop
				.openExternal(formUrl)
				.catch((error: Error) => toast.error(error.message));
	};
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent data-testid="stop-sheet" data-case={view.case}>
				<DialogHeader>
					<DialogTitle>
						{finishing ? "Finish it yourself" : view.title}
					</DialogTitle>
					<DialogDescription>
						{finishing
							? "Every value you approved, ready to copy into the form."
							: view.body}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{finishing ? (
						<FinishPanel app={app} formUrl={formUrl} actions={actions} />
					) : (
						<div className="flex flex-col gap-3 text-xs">
							{view.reason ? (
								<div
									className="border-border bg-muted/40 text-muted-foreground rounded-lg border px-3 py-2"
									data-testid="stop-reason"
								>
									<div className="text-2xs mb-0.5 font-medium">
										What the run recorded
									</div>
									{view.reason}
								</div>
							) : null}
							{view.attempt ? <ProofShots attempt={view.attempt} /> : null}
							{view.note ? (
								<p className="text-muted-foreground">{view.note}</p>
							) : null}
							{view.case === "paused" ? (
								<p
									className="text-muted-foreground"
									data-testid="stop-submissions-state"
								>
									{app.submissionsPaused ? (
										<>
											Automatic submissions are still off.{" "}
											<SubmissionsSettingsLink onClick={onClose} />; Retry
											appears once they are on.
										</>
									) : (
										"Automatic submissions are on again, so Retry sends it."
									)}
								</p>
							) : null}
						</div>
					)}
				</DialogBody>
				<DialogFooter>
					{finishing ? (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setFinishing(false)}
						>
							Back
						</Button>
					) : (
						<StopActions
							app={app}
							view={view}
							actions={actions}
							onFinish={finish}
							onClose={onClose}
						/>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** "What to do", in the action bar of an application that stopped; opens the stop sheet. */
export function StopSheetButton({ actions }: { actions: ApplicationActions }) {
	const [open, setOpen] = useState(false);
	const app = actions.loaded;
	const view = app ? stopView(app) : null;
	if (!app || !view) return null;
	return (
		<>
			<ActionBarButton
				tone="primary"
				onClick={() => setOpen(true)}
				data-testid="stop-sheet-open"
				title={view.title}
			>
				<CircleHelp />
				What to do
			</ActionBarButton>
			{open ? (
				<StopSheet
					app={app}
					view={view}
					actions={actions}
					onClose={() => setOpen(false)}
				/>
			) : null}
		</>
	);
}
