import { useQuery } from "@tanstack/react-query";
import { ImageOff } from "lucide-react";
import { useState } from "react";
import { sourceLabel } from "@/components/pipeline/bits";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { desktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import type { ProofShot } from "../../../../shared/bridge";
import { outcomeLabel } from "./stop-model";
import type { AppDetail } from "./types";

type Attempt = AppDetail["attempts"][number];

/** An attempt whose button was clicked: its proof is shown in full. */
const CLICKED = new Set(["submitted", "needs_human", "started"]);

const when = (d: Date | string) =>
	new Date(d).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});

function filledOf(attempt: Attempt): { label: string; value: string }[] {
	const filled = attempt.proof?.filled;
	return Array.isArray(filled)
		? filled.filter(
				(f): f is { label: string; value: string } =>
					typeof f?.label === "string" && typeof f?.value === "string",
			)
		: [];
}

const text = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The screenshots of an attempt, in order: each earlier step, then before and after the click. */
function shotsOf(attempt: Attempt): { which: ProofShot; label: string }[] {
	const clicked = CLICKED.has(attempt.status);
	const steps = Array.from({ length: attempt.stepShots }, (_, i) => ({
		which: `step-${i + 1}` as ProofShot,
		label: `Step ${i + 1}`,
	}));
	return [
		...steps,
		...(attempt.hasBefore
			? [
					{
						which: "before" as const,
						label: clicked
							? steps.length > 0
								? `Step ${steps.length + 1}, before submitting`
								: "Before submitting"
							: attempt.status === "dry_run"
								? "Filled, not sent"
								: "Stopped here",
					},
				]
			: []),
		...(attempt.hasAfter
			? [{ which: "after" as const, label: "After submitting" }]
			: []),
	];
}

/** A screenshot thumbnail; a click opens it full size in the app. */
function ProofThumb({
	attemptId,
	which,
	label,
}: {
	attemptId: string;
	which: ProofShot;
	label: string;
}) {
	const [open, setOpen] = useState(false);
	const thumb = useQuery({
		queryKey: ["proof-image", attemptId, which, "thumb"],
		queryFn: () => desktop.proofImage(attemptId, which, "thumb"),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="group border-border bg-muted/40 hover:border-ring focus-visible:ring-ring/50 flex w-24 flex-col overflow-hidden rounded-lg border text-left outline-none focus-visible:ring-2"
				aria-label={`${label}: open full size`}
				data-testid="proof-thumb"
				data-which={which}
			>
				<span className="bg-background flex h-20 w-full items-start justify-center overflow-hidden">
					{thumb.data ? (
						<img
							src={thumb.data}
							alt=""
							className="w-full object-cover object-top"
							data-testid="proof-thumb-image"
						/>
					) : thumb.isError ? (
						<ImageOff className="text-muted-foreground m-auto size-4" />
					) : (
						<Skeleton className="h-full w-full" />
					)}
				</span>
				<span className="text-2xs text-muted-foreground group-hover:text-foreground truncate px-1.5 py-1">
					{label}
				</span>
			</button>
			{open ? (
				<ProofLightbox
					attemptId={attemptId}
					which={which}
					label={label}
					onClose={() => setOpen(false)}
				/>
			) : null}
		</>
	);
}

function ProofLightbox({
	attemptId,
	which,
	label,
	onClose,
}: {
	attemptId: string;
	which: ProofShot;
	label: string;
	onClose: () => void;
}) {
	const full = useQuery({
		queryKey: ["proof-image", attemptId, which, "full"],
		queryFn: () => desktop.proofImage(attemptId, which, "full"),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-4xl" data-testid="proof-full">
				<DialogHeader>
					<DialogTitle>{label}</DialogTitle>
				</DialogHeader>
				<DialogBody>
					{full.data ? (
						<img
							src={full.data}
							alt={`Screenshot: ${label}`}
							className="border-border w-full rounded-lg border"
							data-testid="proof-full-image"
						/>
					) : full.isError ? (
						<p className="text-muted-foreground text-sm">
							The screenshot could not be opened.
						</p>
					) : (
						<Skeleton className="h-96 w-full" />
					)}
				</DialogBody>
				<DialogFooter>
					<DialogClose
						variant="ghost"
						onClick={() =>
							void desktop.openProof(attemptId, which).catch(() => {})
						}
					>
						Open in Preview
					</DialogClose>
					<DialogClose>Close</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** The screenshots of one attempt as a row of thumbnails. */
export function ProofShots({ attempt }: { attempt: Attempt }) {
	const shots = shotsOf(attempt);
	if (shots.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5" data-testid="proof-shots">
			{shots.map((s) => (
				<ProofThumb
					key={s.which}
					attemptId={attempt.id}
					which={s.which}
					label={s.label}
				/>
			))}
		</div>
	);
}

/**
 * One attempt with its proof. A clicked one shows when, where, the final URL, the board's
 * confirmation or "outcome unknown", every filled field with its value and the screenshots of
 * each step; a stop or a dry run shows its reason and where it stopped.
 */
function AttemptProof({ attempt }: { attempt: Attempt }) {
	const clicked = CLICKED.has(attempt.status);
	const finalUrl =
		text(attempt.proof?.finalUrl) ?? (clicked ? attempt.url : null);
	const confirmation = text(attempt.proof?.confirmation);
	const filled = clicked ? filledOf(attempt) : [];
	const by =
		attempt.mode === "manual"
			? "By you"
			: attempt.board === "web"
				? "Employer's site"
				: sourceLabel(attempt.board);
	return (
		<li
			className="border-border flex flex-col gap-2 border-l-2 pl-2.5"
			data-testid="attempt"
			data-status={attempt.status}
		>
			<div className="flex flex-col gap-0.5">
				<div className="flex items-baseline gap-2">
					<span className="text-muted-foreground font-mono tabular-nums">
						#{attempt.attempt}
					</span>
					<span
						className={cn(
							"font-medium",
							attempt.status === "submitted" && "text-brand",
							(attempt.status === "needs_human" ||
								attempt.status === "started") &&
								"text-destructive",
						)}
						data-testid="attempt-status"
					>
						{outcomeLabel(attempt)}
					</span>
				</div>
				<div className="text-2xs text-muted-foreground">
					{[by, when(attempt.startedAt)].filter(Boolean).join(" · ")}
				</div>
			</div>
			{confirmation ? (
				<blockquote
					className="border-border text-foreground border-l pl-2 italic"
					data-testid="proof-confirmation"
				>
					“{confirmation}”
				</blockquote>
			) : null}
			{(attempt.error || attempt.resolution) && !confirmation ? (
				<p className="text-muted-foreground">
					{attempt.resolution ?? attempt.error}
				</p>
			) : null}
			{finalUrl ? (
				<div>
					<div className="text-2xs text-muted-foreground">Final page</div>
					<div
						className="text-foreground text-2xs font-mono break-all"
						data-testid="proof-final-url"
					>
						{finalUrl}
					</div>
				</div>
			) : null}
			{filled.length > 0 ? (
				<div>
					<div className="text-2xs text-muted-foreground mb-1">
						Filled ({filled.length})
					</div>
					<dl className="divide-border flex flex-col divide-y">
						{filled.map((f, i) => (
							<div
								key={`${f.label}-${i}`}
								className="flex gap-2 py-1"
								data-testid="proof-field"
							>
								<dt className="text-muted-foreground w-2/5 shrink-0 break-words">
									{f.label}
								</dt>
								<dd className="text-foreground min-w-0 flex-1 break-words whitespace-pre-wrap">
									{f.value || "—"}
								</dd>
							</div>
						))}
					</dl>
				</div>
			) : null}
			<ProofShots attempt={attempt} />
		</li>
	);
}

/** Every attempt, newest first, with its proof (application page and Applied). */
export function AttemptList({ attempts }: { attempts: Attempt[] }) {
	if (attempts.length === 0) return null;
	return (
		<ol className="flex flex-col gap-4" data-testid="attempts">
			{attempts.map((a) => (
				<AttemptProof key={a.id} attempt={a} />
			))}
		</ol>
	);
}
