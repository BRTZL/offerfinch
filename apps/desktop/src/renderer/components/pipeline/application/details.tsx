import { filterRuleLabel } from "@offerfinch/core/filter/rule-labels";
import {
	ruleExplanation,
	ruleLabel,
} from "@offerfinch/core/tailor/rule-labels";
import { Check, Minus, TriangleAlert } from "lucide-react";
import {
	type AppDetail,
	DOC_LABEL,
} from "@/components/pipeline/application/types";
import {
	ago,
	costLabel,
	STATE_LABEL,
	sourceLabel,
} from "@/components/pipeline/bits";
import { Cells, Fit } from "@/components/system/bits";
import { Disclosure, InspectorSection } from "@/components/system/pane";
import { useEvidenceLabel } from "@/lib/evidence";
import { usd } from "@/lib/money";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
	met: "text-brand",
	partial: "text-warning",
	not_met: "text-destructive",
	unknown: "text-muted-foreground",
};

const STATUS_LABEL: Record<string, string> = {
	met: "met",
	partial: "partly",
	not_met: "missing",
	unknown: "unclear",
};

const TASK_LABEL: Record<string, string> = {
	"fit-score": "Fit score",
	tailor: "Drafting",
	"claims-check": "Checking drafts",
	"chat-application": "Chat",
};

const ACTOR_LABEL: Record<string, string> = {
	user: "you",
	system: "pipeline",
	workflow: "pipeline",
};

/** A line with a green tick (or an amber mark): one check, in words. */
function CheckLine({
	ok = true,
	children,
}: {
	ok?: boolean;
	children: React.ReactNode;
}) {
	return (
		<li className="flex items-start gap-2">
			{ok ? (
				<Check className="text-brand mt-0.5 size-3.5" />
			) : (
				<Minus className="text-warning mt-0.5 size-3.5" />
			)}
			<span>{children}</span>
		</li>
	);
}

/**
 * Why a match sits lower in Matches than its score: the biggest ranking penalty ("Ranked lower:
 * location unclear"), with the others in its tooltip.
 */
function RankReason({ app }: { app: AppDetail }) {
	const penalties = app.rankPenalties ?? [];
	const first = penalties[0];
	if (!first || app.state !== "scored") return null;
	return (
		<p
			className="text-warning text-xs"
			data-testid="rank-reason"
			title={penalties.map((p) => p.reason).join("; ")}
		>
			Ranked lower: {first.reason}
			{app.rank !== null && app.rank !== undefined ? ` (rank ${app.rank})` : ""}
		</p>
	);
}

/** Fit: the score as ten cells, requirements met, and the gaps with how to close them. */
export function FitSection({ app }: { app: AppDetail }) {
	const requirements = app.fit?.requirements ?? [];
	const met = requirements.filter((r) => r.status === "met").length;
	const gaps = requirements.filter((r) => r.status !== "met");
	return (
		<InspectorSection title="Fit" data-testid="fit">
			<div className="flex items-center gap-3">
				<Fit value={app.score} size="lg" />
				<div className="flex flex-col gap-1.5">
					<Cells
						total={10}
						on={Math.round((app.score ?? 0) / 10)}
						tone="brand"
						label={`Fit ${app.score ?? 0} of 100`}
					/>
					{requirements.length > 0 ? (
						<span className="text-muted-foreground text-xs">
							{met} of {requirements.length} requirements met
						</span>
					) : null}
				</div>
			</div>
			<RankReason app={app} />
			{gaps.length > 0 ? (
				<ul className="flex flex-col gap-1 text-xs">
					{gaps.slice(0, 4).map((r) => (
						<li key={r.requirement} className="flex gap-2">
							<span className={cn("w-12 shrink-0", STATUS_TONE[r.status])}>
								{STATUS_LABEL[r.status] ?? r.status}
							</span>
							<span className="text-foreground">{r.requirement}</span>
						</li>
					))}
					<li className="text-muted-foreground">
						Not in your profile?{" "}
						<Link href="/profile" className="text-primary hover:underline">
							Add it
						</Link>{" "}
						if you have done it.
					</li>
				</ul>
			) : requirements.length > 0 ? (
				<p className="text-muted-foreground text-xs">
					Every listed requirement is met.
				</p>
			) : null}
		</InspectorSection>
	);
}

/** The review result: claims traced (one cell each), and every problem that blocks approval. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep ordered review issues and evidence presentation together for document inspection.
export function ChecksSection({ app }: { app: AppDetail }) {
	const issues = app.review?.issues ?? [];
	const claims = (app.review?.claims ?? []) as { supported: boolean }[];
	const traced = claims.filter((c) => c.supported).length;
	const flags = app.flags ?? [];
	const end = !app.review
		? "Not checked"
		: flags.length > 0 && (app.openFlags ?? 0) > 0
			? `${app.openFlags} flagged`
			: issues.length > 0
				? `${issues.length} to fix`
				: app.approvable
					? "Passed"
					: undefined;
	return (
		<InspectorSection title="Checks" end={end}>
			{!app.review ? (
				<p className="text-muted-foreground text-xs">
					Not checked yet. The CV, letter and answers are checked against your
					profile once they are drafted.
				</p>
			) : (
				<div className="flex flex-col gap-3 text-xs" data-testid="checks">
					{claims.length > 0 ? (
						<Cells
							total={claims.length}
							on={claims.length}
							warn={claims
								.map((c, i) => (c.supported ? -1 : i))
								.filter((i) => i >= 0)}
							size="sm"
							label={`${traced} of ${claims.length} claims traced`}
						/>
					) : null}
					<ul className="text-foreground flex flex-col gap-1.5">
						<CheckLine ok={traced === claims.length}>
							{traced === claims.length
								? `All ${claims.length} claims trace to your profile`
								: `${traced} of ${claims.length} claims trace to your profile`}
						</CheckLine>
						<CheckLine ok={issues.length === 0}>
							{issues.length === 0
								? "Fixed rules hold: dates, titles, contact"
								: `${issues.length} rule${issues.length === 1 ? "" : "s"} to fix`}
						</CheckLine>
						{app.review.atsChecked ? (
							<CheckLine>PDF text is readable by applicant systems</CheckLine>
						) : null}
					</ul>
					{flags.length > 0 ? (
						<p data-testid="flag-summary" className="text-muted-foreground">
							{app.openFlags} flagged line(s) open,{" "}
							{flags.filter((f) => f.state === "confirmed").length} confirmed by
							you. Each is marked in the document with what to do.
						</p>
					) : issues.length > 0 ? (
						<ul className="flex flex-col gap-2">
							{issues.map((issue) => (
								<li
									key={`${issue.document}:${issue.rule}:${issue.message}:${issue.excerpt ?? ""}`}
									className="border-destructive border-l-2 pl-2"
									data-testid="issue"
								>
									<div
										className="text-2xs text-muted-foreground"
										title={ruleExplanation(issue.rule) ?? undefined}
									>
										{DOC_LABEL[issue.document] ?? issue.document} ·{" "}
										{ruleLabel(issue.rule)}
									</div>
									<div className="text-foreground">{issue.message}</div>
									{issue.excerpt && (
										<div className="text-muted-foreground mt-0.5 italic">
											“{issue.excerpt}”
										</div>
									)}
								</li>
							))}
						</ul>
					) : null}
				</div>
			)}
		</InspectorSection>
	);
}

type FilterResult = {
	decision?: string;
	summary?: string;
	reasons?: { rule: string; outcome: string; message: string }[];
} | null;

/**
 * Flags about the job itself: what the job filter could not settle (hybrid abroad, a language)
 * and why the job was kept anyway.
 */
export function JobFlagsSection({ app }: { app: AppDetail }) {
	const filter = app.filter as FilterResult;
	const unclear = (filter?.reasons ?? []).filter(
		(r) => r.outcome === "unclear",
	);
	if (unclear.length === 0) return null;
	return (
		<InspectorSection title="Flags" end={unclear.length}>
			<div className="flex flex-col gap-2" data-testid="job-flags">
				{unclear.map((r) => (
					<div
						key={`${r.rule}:${r.message}`}
						className="bg-warning-surface flex gap-2 rounded-lg px-3 py-2.5 text-xs"
					>
						<TriangleAlert className="text-warning mt-0.5 size-3.5" />
						<div className="min-w-0">
							<p className="text-foreground font-medium">
								{filterRuleLabel(r.rule)}: {r.message}
							</p>
							{filter?.summary ? (
								<p className="text-muted-foreground mt-0.5">
									Kept for you to check. {filter.summary}
								</p>
							) : null}
						</div>
					</div>
				))}
			</div>
		</InspectorSection>
	);
}

/** Before approval: what happens once you approve, so the hand-off is no surprise. */
export function AfterApproveSection({ app }: { app: AppDetail }) {
	if (app.state !== "ready_for_review") return null;
	const handoff = app.submission?.mode !== "auto";
	const board =
		app.job.source === "linkedin"
			? "LinkedIn posting"
			: app.job.source === "scrape"
				? "careers page"
				: `${sourceLabel(app.job.source)} form`;
	const steps = handoff
		? [
				`You open the ${board} from here`,
				"You paste the answers and attach the PDFs",
				"You record the day with I submitted this",
			]
		: [
				`OfferFinch fills the ${board} once, from these exact documents`,
				"It keeps a screenshot before and after",
				"It moves to Applied when the board confirms",
			];
	return (
		<InspectorSection title="After you approve" data-testid="after-approve">
			<ol className="flex flex-col gap-2 text-xs">
				{steps.map((step, i) => (
					<li key={step} className="flex gap-2">
						<span
							aria-hidden
							className="border-border bg-muted text-2xs text-foreground flex size-5 shrink-0 items-center justify-center rounded-sm border font-mono"
						>
							{i + 1}
						</span>
						<span className="text-foreground pt-0.5">{step}</span>
					</li>
				))}
			</ol>
			{handoff ? (
				<p className="text-muted-foreground text-xs">
					Nothing is sent from OfferFinch: this board is always yours to submit.
				</p>
			) : null}
		</InspectorSection>
	);
}

/** Why the job is in the inbox: the job filter, the fit summary. Folded. */
export function WhyDisclosure({ app }: { app: AppDetail }) {
	const filter = app.filter as FilterResult;
	return (
		<Disclosure title="Why this job" data-testid="why">
			<div className="flex flex-col gap-2 text-xs">
				{filter?.summary && (
					<div>
						<div className="text-2xs text-muted-foreground">
							Job filter:{" "}
							{filter.decision === "reject"
								? "rejected"
								: filter.decision === "unclear"
									? "kept for you to check"
									: "passed"}
						</div>
						<p className="text-foreground">{filter.summary}</p>
						{filter.reasons && filter.reasons.length > 0 && (
							<ul className="text-muted-foreground mt-1 flex flex-col gap-0.5">
								{filter.reasons.map((r) => (
									<li key={`${r.rule}:${r.message}`} className="flex gap-2">
										<span className="w-20 shrink-0">
											{filterRuleLabel(r.rule)}
										</span>
										<span
											className={
												r.outcome === "unclear" ? "text-warning" : undefined
											}
										>
											{r.message}
										</span>
									</li>
								))}
							</ul>
						)}
					</div>
				)}
				{app.fit?.summary && (
					<div>
						<div className="text-2xs text-muted-foreground">Fit</div>
						<p className="text-foreground">{app.fit.summary}</p>
					</div>
				)}
			</div>
		</Disclosure>
	);
}

/** Each requirement of the posting with the profile quotes behind it. */
export function EvidenceDisclosure({ app }: { app: AppDetail }) {
	const label = useEvidenceLabel();
	const requirements = app.fit?.requirements ?? [];
	if (requirements.length === 0) return null;
	return (
		<Disclosure
			title="Requirement evidence"
			value={`${requirements.filter((r) => r.status === "met").length}/${requirements.length} met`}
		>
			<ul className="flex flex-col gap-2.5 text-xs">
				{requirements.map((r) => (
					<li key={r.requirement}>
						<div className="flex gap-2">
							<span className={cn("w-12 shrink-0", STATUS_TONE[r.status])}>
								{STATUS_LABEL[r.status] ?? r.status}
							</span>
							<span className="text-foreground font-medium">
								{r.requirement}
							</span>
						</div>
						{r.evidence.map((e, i) => (
							<blockquote
								// The same quote can back a requirement twice.
								key={`${i}-${e.file}`}
								className="border-border text-muted-foreground mt-1 ml-12 border-l pl-2"
							>
								“{e.quote.replace(/\*\*|`/g, "")}”
								<span className="text-2xs ml-1">{label(e.file, e.quote)}</span>
							</blockquote>
						))}
					</li>
				))}
			</ul>
		</Disclosure>
	);
}

/** Questions asked for this application, answered or waiting. */
export function QuestionsSection({ app }: { app: AppDetail }) {
	if (app.questions.length === 0) return null;
	return (
		<InspectorSection title="Questions" end={app.questions.length}>
			<ul className="flex flex-col gap-2 text-xs">
				{app.questions.map((q) => (
					<li key={q.id}>
						<div className="text-foreground font-medium">{q.question}</div>
						<div className="text-muted-foreground">
							{q.answer ?? (
								<Link
									href="/questions"
									className="text-warning hover:underline"
								>
									Answer it in Questions
								</Link>
							)}
						</div>
					</li>
				))}
			</ul>
		</InspectorSection>
	);
}

/** Model calls made for this application and their estimated cost. */
export function CostDisclosure({
	cost,
}: {
	cost: NonNullable<AppDetail["cost"]>;
}) {
	return (
		<Disclosure
			title="Cost"
			value={
				<span data-testid="app-cost">
					{cost.subscriptionCalls > 0 && cost.apiCalls === 0
						? "Subscription"
						: `${costLabel(cost.totalMicros, cost.subscriptionCalls, cost.apiCalls)} est.`}
				</span>
			}
		>
			<div className="flex flex-col gap-1 text-xs" data-testid="cost-calls">
				{cost.calls.length === 0 && (
					<div className="text-muted-foreground">No model calls yet.</div>
				)}
				{cost.calls.map((c, i) => (
					<div
						// Calls in the same second (a step's quick retries) share task and time.
						key={`${i}-${c.task}-${String(c.createdAt)}`}
						className="flex gap-2"
						title={c.priceBasis ?? undefined}
					>
						<span className="text-foreground w-20 shrink-0">
							{TASK_LABEL[c.task] ?? c.task}
						</span>
						<span className="text-muted-foreground min-w-0 flex-1 truncate">
							{c.status === "reserved"
								? "running…"
								: `${c.model ?? c.provider} · ${c.inputTokens + c.cachedInputTokens} in / ${c.outputTokens} out${c.error ? " · failed" : ""}`}
						</span>
						<span
							className="text-foreground tabular-nums"
							data-testid="cost-call-price"
						>
							{c.billing === "subscription"
								? "Subscription"
								: usd(c.status === "settled" ? c.costMicros : c.estimateMicros)}
						</span>
					</div>
				))}
				<div className="text-2xs text-muted-foreground pt-1">
					Estimated from list prices per model; the provider's invoice is the
					real cost.
					{cost.subscriptionCalls > 0 &&
						" Subscription calls ran on your own plan: their tokens are shown, not priced, and a monthly limit does not count them."}
				</div>
			</div>
		</Disclosure>
	);
}

/** Every state change, newest last, in words. */
export function HistoryDisclosure({ app }: { app: AppDetail }) {
	return (
		<Disclosure
			title="History"
			value={`${app.history.length} event${app.history.length === 1 ? "" : "s"}`}
		>
			<ol className="flex flex-col gap-1 text-xs">
				{app.history.map((h) => (
					<li key={h.id} className="flex gap-2">
						<span className="text-muted-foreground w-14 shrink-0 tabular-nums">
							{ago(h.createdAt)}
						</span>
						<span>
							<span className="text-foreground font-medium">
								{STATE_LABEL[h.toState] ?? h.toState.replace(/_/g, " ")}
							</span>
							<span className="text-muted-foreground">
								{" "}
								· {ACTOR_LABEL[h.actor] ?? h.actor}
								{h.reason ? ` · ${h.reason}` : ""}
							</span>
						</span>
					</li>
				))}
			</ol>
		</Disclosure>
	);
}
