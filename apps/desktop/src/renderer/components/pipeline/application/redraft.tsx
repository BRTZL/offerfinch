import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import type { AppDetail, Kind } from "@/components/pipeline/application/types";
import { ToolbarSeparator } from "@/components/system/layout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { client, orpc } from "@/lib/orpc";

/** Kept in step with core `tailor/redraft.ts` (REDRAFT_INSTRUCTION_MAX). */
const INSTRUCTION_MAX = 500;

type Scope = "cv" | "cover_letter" | "form_answers" | "all";

const SCOPES: { value: Scope; label: string; hint: string }[] = [
	{
		value: "cv",
		label: "CV only",
		hint: "The letter and answers stay as they are.",
	},
	{
		value: "cover_letter",
		label: "Letter only",
		hint: "The CV and answers stay as they are.",
	},
	{
		value: "form_answers",
		label: "Answers only",
		hint: "The CV and letter stay as they are.",
	},
	{ value: "all", label: "Everything", hint: "CV, letter and answers." },
];

const NOUN: Record<Scope, string> = {
	cv: "CV",
	cover_letter: "letter",
	form_answers: "answers",
	all: "CV, letter and answers",
};

const REDRAFT_STATES = ["ready_for_review", "approved"];

/** Why Redraft is off right now, in words; null when it can start. */
function blockedReason(app: AppDetail): string | null {
	if (app.job.closedAt) return "This posting looks closed, so Redraft is off";
	if (app.redraft && !app.redraft.problem)
		return "A redraft is already running";
	if (app.state === "ready_for_review" && !app.reviewCurrent && !app.checkError)
		return "The current version is still being checked";
	return null;
}

function useRefresh() {
	const queryClient = useQueryClient();
	return () => {
		void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
		void queryClient.invalidateQueries({ queryKey: ["inbox"] });
	};
}

/**
 * Redraft… in the detail's toolbar, on a prepared application in review or approved: a new
 * version of the chosen documents, written again from the current profile and the posting.
 */
export function RedraftControl({
	app,
	tab,
	hidden,
}: {
	app: AppDetail | undefined;
	tab: Kind;
	hidden: boolean;
}) {
	const [open, setOpen] = useState(false);
	if (
		!app ||
		hidden ||
		!REDRAFT_STATES.includes(app.state) ||
		!app.documents.some((d) => d.kind === "cv" || d.kind === "cover_letter")
	)
		return null;
	const blocked = blockedReason(app);
	return (
		<>
			<ToolbarSeparator />
			<Button
				size="sm"
				variant="ghost"
				onClick={() => setOpen(true)}
				disabled={blocked !== null}
				title={
					blocked ??
					"Write a new version of the CV, letter or answers, with an optional instruction"
				}
				data-testid="redraft"
			>
				<RefreshCw />
				<span className="hidden lg:inline">Redraft…</span>
			</Button>
			{open ? (
				<RedraftDialog
					app={app}
					initial={tab === "notes" ? "cv" : tab}
					onClose={() => setOpen(false)}
				/>
			) : null}
		</>
	);
}

function RedraftDialog({
	app,
	initial,
	onClose,
}: {
	app: AppDetail;
	initial: Scope;
	onClose: () => void;
}) {
	const refresh = useRefresh();
	const [scope, setScope] = useState<Scope>(initial);
	const [instruction, setInstruction] = useState("");
	const [rewriteOwn, setRewriteOwn] = useState(false);
	const ids = useId();
	const own = app.ownAnswers.length;
	const answers = scope === "form_answers" || scope === "all";
	const start = useMutation({
		mutationFn: () =>
			client.application.redraft({
				id: app.id,
				scope,
				instruction: instruction.trim() || undefined,
				rewriteOwnAnswers: answers && own > 0 ? rewriteOwn : undefined,
			}),
		onSuccess: (result) => {
			toast.success(
				`Redrafting the ${NOUN[scope]}.${result.revoked ? " Approval withdrawn." : ""} The new version is checked before you can approve it.`,
			);
			refresh();
			onClose();
		},
		onError: (error) => {
			toast.error(error.message);
			refresh();
		},
	});
	return (
		<Dialog open onOpenChange={(o) => !o && !start.isPending && onClose()}>
			<DialogContent data-testid="redraft-dialog">
				<DialogHeader>
					<DialogTitle>Redraft</DialogTitle>
					<DialogDescription>
						Writes a new version from your current profile and the posting. What
						you don't choose stays exactly as it is, and the new version is
						checked before you can approve it.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<form
						id={`${ids}-form`}
						className="flex flex-col gap-4 pb-1"
						onSubmit={(e) => {
							e.preventDefault();
							if (!start.isPending) start.mutate();
						}}
					>
						<fieldset className="flex flex-col gap-1.5">
							<legend className="text-foreground mb-1.5 text-sm font-medium">
								What to redraft
							</legend>
							{SCOPES.map((option) => (
								<label
									key={option.value}
									className="hover:bg-muted/60 flex items-start gap-2.5 rounded-md px-2 py-1.5 text-sm"
								>
									<input
										type="radio"
										name={`${ids}-scope`}
										value={option.value}
										checked={scope === option.value}
										onChange={() => setScope(option.value)}
										className="accent-primary mt-0.5"
										data-testid={`redraft-scope-${option.value}`}
									/>
									<span className="flex flex-col">
										<span className="text-foreground">{option.label}</span>
										<span className="text-muted-foreground text-xs">
											{option.hint}
										</span>
									</span>
								</label>
							))}
						</fieldset>
						<div className="flex flex-col gap-1.5">
							<label
								htmlFor={`${ids}-instruction`}
								className="text-foreground text-sm font-medium"
							>
								Instruction{" "}
								<span className="text-muted-foreground font-normal">
									(optional)
								</span>
							</label>
							<Textarea
								id={`${ids}-instruction`}
								value={instruction}
								onChange={(e) => setInstruction(e.target.value)}
								maxLength={INSTRUCTION_MAX}
								rows={3}
								placeholder="Shorter, and mention my Go work"
								className="min-h-20 resize-none"
								data-testid="redraft-instruction"
							/>
							<span className="text-muted-foreground flex justify-between gap-3 text-xs">
								<span>
									A preference for length, tone and focus. Facts still come only
									from your profile.
								</span>
								<span className="tabular-nums">
									{instruction.length}/{INSTRUCTION_MAX}
								</span>
							</span>
						</div>
						{answers && own > 0 ? (
							<label
								htmlFor={`${ids}-own`}
								className="text-foreground flex items-start gap-2 text-sm"
							>
								<Checkbox
									id={`${ids}-own`}
									checked={rewriteOwn}
									onCheckedChange={(checked) => setRewriteOwn(Boolean(checked))}
									data-testid="redraft-rewrite-own"
								/>
								<span>
									Also rewrite the {own} answer{own === 1 ? "" : "s"} you wrote
									yourself
									<span className="text-muted-foreground block text-xs">
										Off: {own === 1 ? "it stays" : "they stay"} word for word.
									</span>
								</span>
							</label>
						) : null}
						{app.state === "approved" ? (
							<p
								className="text-warning text-sm"
								data-testid="redraft-withdraws"
							>
								This application is approved. Redrafting withdraws the approval;
								approve the new version after its check.
							</p>
						) : null}
					</form>
				</DialogBody>
				<DialogFooter>
					<DialogClose disabled={start.isPending}>Cancel</DialogClose>
					<Button
						type="submit"
						form={`${ids}-form`}
						disabled={start.isPending}
						data-testid="redraft-confirm"
					>
						{start.isPending ? "Starting…" : `Redraft ${NOUN[scope]}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Lines for the status strip: a redraft running, paused, stopped or not applied. */
export function redraftNotes(app: AppDetail): {
	tone: "stop" | "warn" | "info";
	text: ReactNode;
	testId: string;
}[] {
	const request = app.redraft;
	if (!request || app.state !== "ready_for_review") return [];
	const what = `the ${NOUN[request.scope]}`;
	const problem = request.problem;
	if (!problem)
		return [
			{
				tone: "info",
				text: (
					<Actions app={app} cancel>
						Redrafting {what}
						{request.instruction ? ` (“${request.instruction}”)` : ""}. This
						page updates when the new version is ready; it is checked before you
						can approve it.
					</Actions>
				),
				testId: "redrafting",
			},
		];
	if (problem.kind === "conflict")
		return [
			{
				tone: "warn",
				text: (
					<Actions app={app} cancel>
						Redraft of {what} not applied: {problem.message}
					</Actions>
				),
				testId: "redraft-conflict",
			},
		];
	return [
		{
			tone: problem.kind === "paused" ? "warn" : "stop",
			text: (
				<Actions app={app} retry cancel>
					{problem.kind === "paused"
						? `Redraft of ${what} is waiting: ${problem.message}`
						: `Redraft of ${what} stopped on an error: ${problem.message}`}{" "}
					The documents are unchanged.
				</Actions>
			),
			testId: problem.kind === "paused" ? "redraft-paused" : "redraft-error",
		},
	];
}

function Actions({
	app,
	retry,
	cancel,
	children,
}: {
	app: AppDetail;
	retry?: boolean;
	cancel?: boolean;
	children: ReactNode;
}) {
	const refresh = useRefresh();
	const again = useMutation({
		mutationFn: () => client.application.retryRedraft({ id: app.id }),
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	const stop = useMutation({
		mutationFn: () => client.application.cancelRedraft({ id: app.id }),
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	return (
		<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
			<span>{children}</span>
			{retry ? (
				<Button
					size="sm"
					variant="outline"
					onClick={() => again.mutate()}
					disabled={again.isPending}
					data-testid="redraft-retry"
				>
					Try again
				</Button>
			) : null}
			{cancel ? (
				<Button
					size="sm"
					variant="ghost"
					onClick={() => stop.mutate()}
					disabled={stop.isPending}
					data-testid="redraft-cancel"
				>
					{app.redraft?.problem ? "Dismiss" : "Cancel redraft"}
				</Button>
			) : null}
		</span>
	);
}
