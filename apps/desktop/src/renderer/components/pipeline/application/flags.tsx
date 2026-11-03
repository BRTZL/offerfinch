import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
	type AppDetail,
	DOC_LABEL,
} from "@/components/pipeline/application/types";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/orpc";
import { cn } from "@/lib/utils";

export type Flag = AppDetail["flags"][number];

/** Flags on one document, numbered in reading order across the application. */
export function flagsOf(app: AppDetail, kind: string): Flag[] {
	return (app.flags ?? []).filter((f) => f.document === kind);
}

function flagNumber(app: AppDetail, flag: Flag): number {
	return (app.flags ?? []).findIndex((f) => f.id === flag.id) + 1;
}

/**
 * The document text with each flagged line marked: an open flag in red with its number, a
 * confirmed one in green. `index` picks the form answer; Markdown documents have one text.
 */
export function MarkedText({
	app,
	text,
	flags,
	index = 0,
}: {
	app: AppDetail;
	text: string;
	flags: Flag[];
	index?: number;
}) {
	const spans = flags
		.filter((f) => f.at && f.at.index === index)
		.sort((a, b) => (a.at?.start ?? 0) - (b.at?.start ?? 0));
	const parts: ReactNode[] = [];
	let at = 0;
	for (const flag of spans) {
		const span = flag.at;
		if (!span || span.start < at) continue;
		parts.push(text.slice(at, span.start));
		const open = flag.state === "open";
		parts.push(
			<a
				key={flag.id}
				href={`#flag-${flag.id}`}
				className={cn(
					"underline decoration-2 underline-offset-2",
					open
						? "bg-destructive-surface text-foreground decoration-destructive"
						: "bg-brand-surface decoration-brand",
				)}
				data-testid="flag-mark"
				title={flag.reasons.map((r) => r.label).join(" · ")}
			>
				<sup
					className={cn(
						"text-2xs text-primary-foreground mr-0.5 rounded-sm px-0.5 font-sans font-semibold",
						open ? "bg-destructive" : "bg-brand",
					)}
				>
					{flagNumber(app, flag)}
				</sup>
				{text.slice(span.start, span.end)}
			</a>,
		);
		at = span.end;
	}
	parts.push(text.slice(at));
	return <>{parts}</>;
}

/**
 * The flags of the shown document, each with its reasons in plain words and what the user can
 * do: edit the line, delete it, or confirm it is true (not for a fixed rule).
 */
export function FlagList({
	app,
	kind,
	onChanged,
}: {
	app: AppDetail;
	kind: string;
	onChanged: () => void;
}) {
	const flags = flagsOf(app, kind);
	const [showSettled, setShowSettled] = useState(false);
	const elsewhere = (app.flags ?? []).filter(
		(f) => f.document !== kind && f.state === "open",
	);
	if (flags.length === 0 && elsewhere.length === 0) return null;
	const open = flags.filter((f) => f.state === "open").length;
	// Nothing open here: the settled lines fold into one quiet line.
	if (open === 0 && !showSettled)
		return (
			<div
				className="text-muted-foreground flex items-center gap-2 text-xs"
				data-testid="flags"
			>
				<Check className="text-brand size-3.5" />
				{flags.length > 0
					? `${flags.length} flagged line${flags.length === 1 ? "" : "s"} settled by you`
					: null}
				{elsewhere.length > 0
					? `${elsewhere.length} open in ${[...new Set(elsewhere.map((f) => DOC_LABEL[f.document]))].join(", ")}`
					: null}
				{flags.length > 0 ? (
					<button
						type="button"
						className="text-primary hover:underline"
						onClick={() => setShowSettled(true)}
					>
						Show
					</button>
				) : null}
			</div>
		);
	return (
		<div className="flex flex-col gap-2 px-3 pb-3" data-testid="flags">
			<div className="flex flex-wrap items-baseline gap-x-3 px-1 text-xs">
				<span className="text-foreground font-medium">
					{open} flagged line{open === 1 ? "" : "s"} in this{" "}
					{(DOC_LABEL[kind] ?? kind).toLowerCase()}
				</span>
				{elsewhere.length > 0 && (
					<span className="text-muted-foreground">
						{elsewhere.length} more in{" "}
						{[...new Set(elsewhere.map((f) => DOC_LABEL[f.document]))].join(
							", ",
						)}
					</span>
				)}
				<span className="text-muted-foreground ml-auto">
					Edit, delete or confirm each. Approve opens when none is open.
				</span>
			</div>
			<ol className="flex flex-col gap-2">
				{flags.map((flag) => (
					<FlagItem key={flag.id} app={app} flag={flag} onChanged={onChanged} />
				))}
			</ol>
		</div>
	);
}

function FlagItem({
	app,
	flag,
	onChanged,
}: {
	app: AppDetail;
	flag: Flag;
	onChanged: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(flag.text ?? "");
	const open = flag.state === "open";
	const fixed = flag.reasons.filter((r) => r.fixed);
	const resolve = useMutation({
		mutationFn: (
			input: { action: "edit"; text: string } | { action: "delete" },
		) =>
			client.application.resolveFlag({ id: app.id, flagId: flag.id, ...input }),
		onSuccess: (_result, input) => {
			setEditing(false);
			toast.success(
				input.action === "edit"
					? "Line saved as a new version. Checking that line…"
					: "Line deleted in a new version. Checking the rules…",
			);
			onChanged();
		},
		onError: (error) => toast.error(error.message),
	});
	const confirm = useMutation({
		mutationFn: () =>
			client.application.confirmFlag({ id: app.id, flagId: flag.id }),
		onSuccess: (result) => {
			toast.success(
				result.open === 0
					? "Saved to your profile. Every flag is resolved; exporting the PDFs…"
					: `Saved to your profile. ${result.open} flag(s) still open.`,
			);
			onChanged();
		},
		onError: (error) => toast.error(error.message),
	});
	const busy = resolve.isPending || confirm.isPending;
	return (
		<li
			id={`flag-${flag.id}`}
			className={cn(
				"border-border bg-card rounded-lg border px-3 py-2.5 text-xs",
				open
					? "border-l-destructive border-l-2"
					: "border-l-brand border-l-2 opacity-80",
			)}
			data-testid="flag"
			data-state={flag.state}
		>
			<div className="flex flex-wrap items-baseline gap-x-2">
				<span
					className={cn(
						"text-2xs text-primary-foreground rounded-sm px-1 font-semibold",
						open ? "bg-destructive" : "bg-brand",
					)}
				>
					{flagNumber(app, flag)}
				</span>
				<span className="text-muted-foreground">
					{DOC_LABEL[flag.document] ?? flag.document}
				</span>
				<span
					className="text-foreground font-medium"
					title={flag.reasons
						.map((r) => r.explanation)
						.filter(Boolean)
						.join(" ")}
				>
					{flag.reasons.map((r) => r.label).join(" · ")}
				</span>
				{!open && (
					<span className="text-brand">Confirmed true {flag.confirmedAt}</span>
				)}
			</div>
			{flag.at && flag.marked === false && (
				<p className="text-muted-foreground mt-1" data-testid="flag-unmarked">
					Its mark could not be placed in the rendered view (it overlaps another
					flagged line); find it in Source.
				</p>
			)}
			{flag.text && !editing && (
				<p className="text-foreground mt-1 font-mono text-xs">“{flag.text}”</p>
			)}
			<ul className="text-muted-foreground mt-1 flex flex-col gap-0.5">
				{flag.reasons.map((r) => (
					<li key={`${r.rule}:${r.message}`}>{r.message}</li>
				))}
			</ul>
			{open && editing && (
				<form
					className="mt-1.5 flex flex-col gap-1.5"
					onSubmit={(e) => {
						e.preventDefault();
						resolve.mutate({ action: "edit", text });
					}}
				>
					<Textarea
						autoFocus
						aria-label={`Edit flagged line ${flagNumber(app, flag)}`}
						value={text}
						onChange={(e) => setText(e.target.value)}
						className="min-h-16 font-mono text-xs"
						data-testid="flag-editor"
					/>
					<div className="flex gap-1.5">
						<Button
							size="sm"
							type="submit"
							disabled={busy || !text.trim() || text === flag.text}
							data-testid="flag-save"
						>
							Save line
						</Button>
						<Button
							size="sm"
							variant="ghost"
							type="button"
							onClick={() => {
								setEditing(false);
								setText(flag.text ?? "");
							}}
						>
							Cancel
						</Button>
					</div>
				</form>
			)}
			{open && !editing && (
				<div className="mt-2 flex flex-wrap items-center gap-1.5">
					{flag.at ? (
						<>
							<Button
								size="sm"
								variant="outline"
								onClick={() => setEditing(true)}
								disabled={busy}
								data-testid="flag-edit"
							>
								Edit line
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => resolve.mutate({ action: "delete" })}
								disabled={busy}
								data-testid="flag-delete"
							>
								Delete line
							</Button>
						</>
					) : (
						<span className="text-muted-foreground" data-testid="flag-unplaced">
							{flag.text
								? "Could not place this line in the document, so it has no mark in the rendered view: find it in Source and use Edit on the document."
								: "About the whole document: use Edit on the document."}
						</span>
					)}
					{flag.confirmable ? (
						<AlertDialog>
							<AlertDialogTrigger
								render={
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										data-testid="flag-confirm"
									/>
								}
							>
								This is true
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>
										Confirm this line is true?
									</AlertDialogTitle>
									<AlertDialogDescription>
										“{flag.text}” is saved to your profile as your own
										statement, dated today, with source “user confirmation”.
										Later drafts and checks may use it as evidence. You can
										remove it in Profile.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>Cancel</AlertDialogCancel>
									<AlertDialogAction
										onClick={() => confirm.mutate()}
										data-testid="flag-confirm-yes"
									>
										It is true
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					) : (
						<span className="text-muted-foreground" data-testid="flag-fixed">
							{fixed.length > 0
								? "Fixed rule: cannot be confirmed, only edited or deleted."
								: "Cannot be confirmed."}
						</span>
					)}
				</div>
			)}
		</li>
	);
}
