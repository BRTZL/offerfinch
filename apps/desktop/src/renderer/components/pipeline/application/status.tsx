import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
	type AppDetail,
	DOC_LABEL,
} from "@/components/pipeline/application/types";
import { ago } from "@/components/pipeline/bits";
import { SubmissionsSettingsLink } from "@/components/pipeline/settings/submissions-link";
import { Button } from "@/components/ui/button";
import { client, orpc } from "@/lib/orpc";
import { Link } from "@/lib/router";
import { redraftNotes } from "./redraft";

/** One line per thing the user should know now, each ending in what to do next. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep approval, handoff, and pause message conditions together and unchanged.
export function StatusStrip({ app }: { app: AppDetail }) {
	const items: {
		tone: "stop" | "warn" | "info" | "ok";
		text: ReactNode;
		testId: string;
	}[] = [];
	const handoffBoard = app.submission?.mode === "handoff";
	items.push(...postingNotes(app));
	items.push(...redraftNotes(app));
	if (app.subscriptionPause)
		items.push({
			tone: "warn",
			text: `Waiting on your AI subscription: ${app.subscriptionPause
				.replace(/^Subscription paused \([a-z_]+, [^)]*\): /, "")
				.replaceAll("`", "")}`,
			testId: "subscription-pause",
		});
	if (app.state === "approved" && handoffBoard)
		items.push({
			tone: "info",
			text: "Approved. Now submit it yourself on the job board: follow the four steps under Submit it yourself, then press I submitted this.",
			testId: "handoff-ready",
		});
	if (app.state === "approved" && app.submissionsPaused && !handoffBoard)
		items.push({
			tone: "warn",
			text: (
				<>
					Automatic submissions are paused, so nothing is sent.{" "}
					<SubmissionsSettingsLink />, or submit it yourself with the steps
					under Submit it yourself.
				</>
			),
			testId: "paused",
		});
	if (app.state === "applying")
		items.push({
			tone: "info",
			text: "Submitting: filling the form from the approved documents.",
			testId: "applying",
		});
	if (app.state === "applied")
		items.push({
			tone: "ok",
			text:
				app.appliedVia === "manual"
					? `Applied by you on ${app.appliedAt ? new Date(app.appliedAt).toISOString().slice(0, 10) : "the day you recorded"}.`
					: `Submitted automatically ${ago(app.appliedAt)} (${app.attempts.find((a) => a.status === "submitted")?.board === "web" ? "the employer's page confirmed" : "board confirmed"}). A confirmation page is not proof the employer received it; their email is.`,
			testId: "applied",
		});
	if (app.state === "needs_human")
		items.push({
			tone: "stop",
			text: app.unresolvedAttempt
				? "Outcome unknown: check your email or the employer's portal. What to do lists your options; it is never clicked again on its own."
				: `Needs you: ${app.attempts[0]?.error ?? app.history.at(-1)?.reason ?? "the submission stopped"} What to do explains it and lists your options.`,
			testId: "needs-human",
		});
	if (app.state === "approved" && app.activeApproval) {
		const versions = Object.keys(app.activeApproval.documentHashes)
			.map((kind) => {
				const doc = app.documents.find((d) => d.kind === kind);
				return `${DOC_LABEL[kind] ?? kind}${doc ? ` v${doc.version}` : ""}`;
			})
			.join(", ");
		items.push({
			tone: "ok",
			text: `Approved ${ago(app.activeApproval.approvedAt)}: ${versions}. Editing any of them withdraws the approval and checks the new version again.`,
			testId: "approval",
		});
	}
	const revoked = app.approvals.find((a) => a.revokedAt);
	if (app.state === "ready_for_review" && revoked && !app.activeApproval)
		items.push({
			tone: "warn",
			text: `Approval withdrawn ${ago(revoked.revokedAt)}: ${revoked.revokedReason}. Review the new version and approve again.`,
			testId: "revoked",
		});
	if (app.state === "ready_for_review") {
		if (!app.reviewCurrent && app.checkError)
			items.push({
				tone: "stop",
				text: (
					<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span>
							The check of this version stopped on an error, so it cannot be
							approved: {app.checkError.message}
						</span>
						<RetryCheck id={app.id} />
					</span>
				),
				testId: "check-error",
			});
		else if (!app.reviewCurrent)
			items.push({
				tone: "info",
				text: "Checking the latest version: claims, rules, PDF export and readability. Approve opens when it passes.",
				testId: "checking",
			});
		else if (app.staleProfile.length > 0)
			items.push({
				tone: "stop",
				text: (
					<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span>
							Your profile changed since this was checked:{" "}
							{app.staleProfile.length} cited fact
							{app.staleProfile.length === 1 ? " was" : "s were"} edited or
							removed, so it cannot be approved until it is checked again.
						</span>
						<RetryCheck id={app.id} label="Check again" />
					</span>
				),
				testId: "stale-profile",
			});
		else if ((app.openFlags ?? 0) > 0)
			items.push({
				tone: "warn",
				text: `${app.openFlags} flagged line${app.openFlags === 1 ? "" : "s"} to resolve: the claims check could not tie ${app.openFlags === 1 ? "it" : "them"} to your profile, or ${app.openFlags === 1 ? "it breaks" : "they break"} a fixed rule. For each line: edit it, delete it, or confirm it is true (saved to your profile). Approve opens when none is open.`,
				testId: "flagged",
			});
		else if (!app.approvable)
			items.push({
				tone: "stop",
				text: "Blocked: this version failed the checks. See Checks for what to fix; edit the document and save, and the new version is checked again.",
				testId: "blocked",
			});
		else
			items.push({
				tone: "ok",
				text: "Ready to approve: every claim traces to your profile, the fixed rules hold, and the PDFs are readable. Compare the posting with the CV and letter, then approve or reject.",
				testId: "passed",
			});
	}
	if (app.state === "needs_answers")
		items.push({
			tone: "warn",
			text: (
				<>
					Waiting for your answers before drafting.{" "}
					<Link href={"/questions"} className="text-primary hover:underline">
						Answer in Questions
					</Link>
					; tailoring resumes once every question is answered.
				</>
			),
			testId: "needs-answers",
		});
	if (
		app.state === "preparing" ||
		(app.state === "scored" && app.prepareRequestedAt)
	)
		items.push({
			tone: "info",
			text: "Drafting the CV, letter and answers. This page updates when they are ready to review.",
			testId: "preparing",
		});
	if (app.state === "rejected")
		items.push({
			tone: "info",
			text: `You rejected it${app.history.at(-1)?.reason ? `: ${app.history.at(-1)?.reason}` : "."}`,
			testId: "rejected",
		});
	if (
		app.job.source === "manual" &&
		app.state === "scored" &&
		!app.prepareRequestedAt
	)
		items.push({
			tone: "info",
			text: <AddedByYou app={app} />,
			testId: "added-by-you",
		});
	if (app.state === "rejected_by_filter")
		items.push({
			tone: "info",
			text: `Your search preferences ruled it out${(app.filter as { summary?: string } | null)?.summary ? `: ${(app.filter as { summary?: string }).summary}` : "."} Details has each rule.`,
			testId: "rejected-by-filter",
		});
	if (app.state === "failed")
		items.push({
			tone: "stop",
			text: `Preparation stopped on an error, so nothing can be approved. ${app.history.at(-1)?.reason ?? ""}`,
			testId: "failed",
		});
	if (items.length === 0) return null;
	// One line: the most urgent thing (a stop, then something that needs you, then news).
	const rank = { stop: 0, warn: 1, info: 2, ok: 3 } as const;
	const sorted = [...items].sort((x, y) => rank[x.tone] - rank[y.tone]);
	return <StatusLine items={sorted} />;
}

/** States past submission: a posting closed after that is expected, and says nothing. */
const SUBMITTED = ["applying", "applied", "needs_human"];
/** States that still lead to applying: where "check before applying" helps. */
const STILL_TO_APPLY = [
	"scored",
	"preparing",
	"needs_answers",
	"ready_for_review",
	"approved",
];

/**
 * The posting found closed (how and when, with It's still open), or for a LinkedIn, Indeed or
 * Glassdoor posting, which is never re-read, its age past two weeks.
 */
function postingNotes(app: AppDetail): {
	tone: "stop" | "warn";
	text: ReactNode;
	testId: string;
}[] {
	if (SUBMITTED.includes(app.state)) return [];
	if (app.job.closedAt)
		return [
			{
				tone: "stop",
				text: <PostingClosed app={app} />,
				testId: "posting-closed",
			},
		];
	const age = app.postingAge;
	if (
		age.mayBeClosed &&
		!app.job.openConfirmedAt &&
		STILL_TO_APPLY.includes(app.state)
	)
		return [
			{
				tone: "warn",
				text: `Posted ${age.days} days ago: it may be closed. Check the posting before applying.`,
				testId: "posting-age",
			},
		];
	return [];
}

/** Closed: why, when, and the way back when the check was wrong. */
function PostingClosed({ app }: { app: AppDetail }) {
	const queryClient = useQueryClient();
	const reopen = useMutation({
		mutationFn: () => client.application.reopenPosting({ id: app.id }),
		onSuccess: () => {
			toast.success("Marked open. Checks won't close it again.");
			void queryClient.invalidateQueries({
				queryKey: orpc.application.key(),
			});
			void queryClient.invalidateQueries({ queryKey: ["inbox"] });
		},
		onError: (error) => toast.error(error.message),
	});
	return (
		<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
			<span>
				This posting looks closed: {app.job.closedReason ?? "found closed"},
				found {ago(app.job.closedAt)}. Interested is off for it.
			</span>
			<Button
				size="sm"
				variant="outline"
				onClick={() => reopen.mutate()}
				disabled={reopen.isPending}
				data-testid="reopen-posting"
			>
				It's still open
			</Button>
		</span>
	);
}

const ICON = {
	stop: CircleAlert,
	warn: TriangleAlert,
	info: Info,
	ok: CircleCheck,
} as const;
const INK = {
	stop: "text-destructive",
	warn: "text-warning",
	info: "text-muted-foreground",
	ok: "text-brand",
} as const;

/** The next step in one line; anything else waiting folds behind "more". */
function StatusLine({
	items,
}: {
	items: { tone: keyof typeof ICON; text: ReactNode; testId: string }[];
}) {
	const [open, setOpen] = useState(false);
	const shown = open ? items : items.slice(0, 1);
	return (
		<div className="flex flex-col gap-1.5" role="status">
			{shown.map((item, i) => {
				const Icon = ICON[item.tone];
				return (
					<div
						key={item.testId}
						className="text-foreground flex items-start gap-2 text-sm"
						data-testid={item.testId}
					>
						<Icon className={`mt-0.5 size-4 shrink-0 ${INK[item.tone]}`} />
						<span className="min-w-0">
							{item.text}
							{i === 0 && items.length > 1 && !open ? (
								<button
									type="button"
									onClick={() => setOpen(true)}
									className="text-muted-foreground hover:text-foreground ml-2 text-xs"
								>
									{items.length - 1} more
								</button>
							) : null}
						</span>
					</div>
				);
			})}
		</div>
	);
}

/** Checks the same version again: no new draft, no other change. */
function RetryCheck({
	id,
	label = "Retry the check",
}: {
	id: string;
	label?: string;
}) {
	const queryClient = useQueryClient();
	const retry = useMutation({
		mutationFn: () => client.application.retryCheck({ id }),
		onSuccess: () => {
			toast.success("Checking this version again.");
			void queryClient.invalidateQueries({
				queryKey: orpc.application.get.key(),
			});
		},
		onError: (error) => toast.error(error.message),
	});
	return (
		<Button
			size="sm"
			variant="outline"
			onClick={() => retry.mutate()}
			disabled={retry.isPending}
			data-testid="retry-check"
		>
			{label}
		</Button>
	);
}

type FilterNote = {
	decision?: string;
	reasons?: {
		rule: string;
		outcome: string;
		message: string;
		evidence?: string;
	}[];
};

/**
 * A job the user added by link: it stays in the Inbox whatever its fit score says. What blocks
 * it (the fit score's blockers, or the reasons an older version's job filter gave) is a note.
 */
function AddedByYou({ app }: { app: AppDetail }) {
	const filter = app.filter as FilterNote | null;
	const misses = (filter?.reasons ?? [])
		.filter((r) => r.outcome === "reject")
		.map((r) => ({
			key: r.rule,
			text: `${r.message}${r.evidence ? ` The posting says: “${r.evidence}”.` : ""}`,
		}));
	const blockers = (
		(app.fit as { blockers?: string[] } | null)?.blockers ?? []
	).map((text) => ({ key: text, text }));
	const notes = filter?.decision === "reject" ? misses : blockers;
	if (notes.length === 0)
		return (
			<span>
				Added by you. Interested drafts a tailored CV, letter and answers from
				your profile, using your models.
			</span>
		);
	return (
		<span className="flex flex-col gap-1">
			<span>
				Added by you. It doesn't match your job search; it stays here because
				you picked it, and Interested still drafts it:
			</span>
			<ul className="text-muted-foreground flex list-disc flex-col gap-0.5 pl-4">
				{notes.map((n) => (
					<li key={n.key}>{n.text}</li>
				))}
			</ul>
		</span>
	);
}
