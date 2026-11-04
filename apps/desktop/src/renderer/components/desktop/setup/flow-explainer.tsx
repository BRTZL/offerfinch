import {
	ChevronRight,
	House,
	Inbox,
	LoaderCircle,
	type LucideIcon,
	MessageCircleQuestion,
	Send,
} from "lucide-react";
import type { ReactNode } from "react";
import { Cells, fitTone } from "@/components/system/bits";
import { ListRow } from "@/components/system/list";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
	type Act,
	Check,
	Collapse,
	Roll,
	Stage,
	States,
	Window,
} from "@/vendor/stageshow";
import "./flow-explainer.css";

/**
 * The Welcome's picture of the whole loop, as a short looping demo of the Inbox (stageshow kit,
 * drawn with the app's own rows and meters): roles arrive from the job boards, each is scored
 * against the profile, the misfits are set aside with their reason, and the one picked is drafted
 * and checked. It ends on what the user keeps: they apply, nothing is sent.
 *
 * Every company and role is made up. Under reduced motion the stage shows the poster, the loop's
 * finished state. The steps under it are a list for screen readers; the stage is decoration.
 */

const FLOW_STEPS = [
	"Finds roles",
	"Scores them on your CV",
	"Sets aside misfits",
	"Drafts when you ask",
] as const;

type Job = {
	company: string;
	title: string;
	source: string;
	/** The fit once scored; null for a role the job rules set aside before scoring. */
	fit: number | null;
	/** Why a misfit is set aside, in the Inbox's own words. */
	aside?: string;
};

// Top to bottom as the list ends up; they arrive bottom first, so the newest sits on top.
const JOBS: Job[] = [
	{
		company: "Nimbus Labs",
		title: "Senior Frontend Engineer",
		source: "Remotive",
		fit: 94,
	},
	{
		company: "Orbit Freight",
		title: "Product Engineer",
		source: "LinkedIn",
		fit: 86,
	},
	{
		company: "Halcyon Health",
		title: "Frontend Engineer",
		source: "We Work Remotely",
		fit: null,
		aside: "Set aside: on-site in São Paulo",
	},
	{
		company: "Kestrel Bank",
		title: "Backend Engineer",
		source: "LinkedIn",
		fit: 41,
		aside: "Below your minimum fit",
	},
];

const CLAIMS = 12;

/** Older rows under the new ones, as placeholder lines: title, role, meta widths. */
const FILLER = [
	[104, 160, 90],
	[88, 132, 110],
];

type Draft = "none" | "drafting" | "cv" | "letter" | "ready";
type S = {
	scan: "idle" | "searching" | "done";
	/** How many rows have arrived (bottom first). */
	found: number;
	/** Rows scored, by index. */
	scored: boolean[];
	/** Misfits show their reason. */
	reasons: boolean;
	/** Misfits folded away into the set-aside line. */
	folded: boolean;
	selected: boolean;
	prepare: "off" | "on" | "busy";
	draft: Draft;
	claims: number;
	/** The caption's current step, 0 to 3. */
	step: number;
};

const START: S = {
	scan: "idle",
	found: 0,
	scored: [false, false, false, false],
	reasons: false,
	folded: false,
	selected: false,
	prepare: "off",
	draft: "none",
	claims: 0,
	step: 0,
};

const POSTER: S = {
	scan: "done",
	found: 4,
	scored: [true, true, true, true],
	reasons: true,
	folded: true,
	selected: true,
	prepare: "off",
	draft: "ready",
	claims: CLAIMS,
	step: 3,
};

const OFF_STAGE = { x: 700, y: 420 };

async function script(a: Act<S>) {
	await a.wait(700);
	// Find: the search starts, roles land at the top one by one
	a.mark("find");
	await a.set({ scan: "searching", step: 0 });
	await a.wait(500);
	for (let n = 1; n <= JOBS.length; n++) {
		await a.set({ found: n });
		await a.wait(520);
	}
	await a.wait(300);
	// Score: the two that fit get their numbers
	a.mark("score");
	await a.set({ scan: "done", step: 1 });
	await a.wait(250);
	for (const i of [0, 1]) {
		await a.set((s) => ({ scored: s.scored.map((v, k) => v || k === i) }));
		await a.wait(380);
	}
	await a.wait(700);
	// Set aside: the other two say why, then fold away
	a.mark("aside");
	await a.set({
		step: 2,
		reasons: true,
		scored: [true, true, true, true],
	});
	await a.wait(1700);
	await a.set({ folded: true });
	await a.wait(1100);
	// Draft: pick the best match, ask for a draft, watch it written and checked
	a.mark("draft");
	await a.set({ step: 3 });
	await a.enter({ at: "row-0", x: 0.62, y: 0.3 });
	await a.click({ at: "row-0", x: 0.62, y: 0.3 });
	await a.set({ selected: true, prepare: "on" });
	await a.wait(450);
	await a.move({ at: "prepare", x: 0.7, y: 0.6 });
	await a.click({ at: "prepare", x: 0.7, y: 0.6 });
	await a.set({ prepare: "busy", draft: "drafting" });
	await a.wait(900);
	await a.set({ draft: "cv" });
	await a.move({ x: 560, y: 250 });
	await a.wait(500);
	await a.set({ draft: "letter" });
	for (let n = 1; n <= CLAIMS; n++) {
		await a.set({ claims: n });
		await a.wait(70);
	}
	await a.wait(250);
	a.mark("ready");
	await a.set({ draft: "ready", prepare: "off" });
	await a.wait(2400);
	// The next hour's search: what this loop added leaves, the list is as it began
	await a.move(OFF_STAGE, { duration: 600 });
	await a.set({ draft: "none", selected: false });
	await a.wait(500);
	await a.set({ found: 0, folded: false, scan: "idle" });
	await a.wait(700);
	await a.snap({ ...START });
	await a.wait(300);
}

function FitSlot({ job, scored }: { job: Job; scored: boolean }) {
	return (
		<States
			className="ofx-fit"
			align="end"
			value={!scored ? "pending" : job.fit === null ? "none" : "fit"}
			states={{
				pending: (
					<LoaderCircle
						className="text-muted-foreground size-3 animate-spin"
						aria-hidden
					/>
				),
				none: <span className="text-muted-foreground">—</span>,
				fit: (
					<span
						className={cn(
							"font-mono text-xs font-semibold tabular-nums",
							fitTone(job.fit ?? 0),
						)}
					>
						{job.fit}
					</span>
				),
			}}
		/>
	);
}

function statusOf(job: Job, i: number, s: S): string {
	if (!s.scored[i]) return "Scoring…";
	if (job.aside) return s.reasons ? job.aside : "Scoring…";
	if (i === 0 && s.draft === "ready") return "Ready for review";
	if (i === 0 && s.draft !== "none") return "Drafting CV";
	return "Match";
}

function DraftLine({ done, children }: { done: boolean; children: ReactNode }) {
	return (
		<span className="flex items-center gap-2">
			<Check on={done} pending={!done} size={13} className="ofx-check" />
			<span className="text-foreground">{children}</span>
		</span>
	);
}

/** Under the picked match while it is drafted: CV, letter, every claim traced. */
function DraftPanel({ s }: { s: S }) {
	const step = ["none", "drafting", "cv", "letter", "ready"].indexOf(s.draft);
	return (
		<span className="bg-card border-border flex w-full flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs">
			<span className="flex items-center gap-5">
				<DraftLine done={step >= 2}>CV</DraftLine>
				<DraftLine done={step >= 3}>Letter</DraftLine>
				<span className="ml-auto flex items-center gap-2">
					<Cells
						total={CLAIMS}
						on={s.claims}
						size="sm"
						label={`${s.claims} of ${CLAIMS} claims traced`}
					/>
					{/* A figure space pads one digit to two, so the line never shifts at 10. */}
					<span className="text-muted-foreground whitespace-pre tabular-nums">
						{`${String(s.claims).padStart(2, "\u2007")} of ${CLAIMS} claims traced`}
					</span>
				</span>
			</span>
			<span className="text-muted-foreground">
				You read it and apply yourself. Nothing is sent.
			</span>
		</span>
	);
}

function JobRow({ job, i, s }: { job: Job; i: number; s: S }) {
	const arrived = s.found >= JOBS.length - i;
	const open = arrived && !(job.aside && s.folded);
	const status = statusOf(job, i, s);
	const quiet = status !== "Match" && status !== "Ready for review";
	return (
		<Collapse open={open} reveal="drop">
			<div data-target={`row-${i}`} data-cursor="pointer">
				<ListRow
					id={`ofx-row-${i}`}
					selected={i === 0 && s.selected}
					focused
					unread={arrived && !(i === 0 && s.selected)}
					onSelect={() => {}}
					title={job.company}
					time="now"
					subtitle={job.title}
					meta={
						<span className="flex w-full min-w-0 flex-col gap-2">
							<span className="flex min-w-0 items-center gap-2">
								<FitSlot job={job} scored={s.scored[i] ?? false} />
								<Roll
									variant="fade"
									className={cn(
										"truncate",
										quiet ? "text-muted-foreground" : "text-foreground",
									)}
								>
									{status}
								</Roll>
								<span className="text-muted-foreground ml-auto shrink-0">
									{job.source}
								</span>
							</span>
							{i === 0 ? (
								<Collapse open={s.draft !== "none"} reveal="drop">
									<DraftPanel s={s} />
								</Collapse>
							) : null}
						</span>
					}
				/>
			</div>
		</Collapse>
	);
}

function NavItem({
	icon: Icon,
	label,
	active,
	count,
}: {
	icon: LucideIcon;
	label: string;
	active?: boolean;
	count?: ReactNode;
}) {
	return (
		<span
			className={cn(
				"text-foreground flex h-7 items-center gap-2 rounded-lg px-2 text-xs",
				active && "bg-selected font-medium",
			)}
		>
			<Icon className="text-primary size-3.5" aria-hidden />
			<span className="flex-1">{label}</span>
			<span
				className="ofx-count text-muted-foreground tabular-nums"
				data-on={count ? true : undefined}
			>
				{count}
			</span>
		</span>
	);
}

function Sidebar({ s }: { s: S }) {
	const matches = s.found === 0 ? 0 : s.folded ? 2 : s.found;
	return (
		<div className="flex flex-col px-2 pt-1">
			<span className="flex flex-col gap-0.5">
				<NavItem icon={House} label="Home" />
				<NavItem
					icon={Inbox}
					label="Inbox"
					active
					count={matches ? <Roll variant="fade">{String(matches)}</Roll> : null}
				/>
				<NavItem icon={MessageCircleQuestion} label="Questions" />
				<NavItem icon={Send} label="Applied" />
			</span>
		</div>
	);
}

/** Beside the heading, as the Inbox says how many wait: here, the search and what it left. */
function ScanStatus({ s }: { s: S }) {
	const text =
		s.scan === "searching"
			? "Searching 9 job boards"
			: s.scan === "idle"
				? "Checks every hour"
				: s.folded
					? "2 to review"
					: `${s.found} new`;
	return (
		<span className="text-muted-foreground -ml-1 flex items-center gap-1.5 text-xs">
			<span className="ofx-spin" data-on={s.scan === "searching" || undefined}>
				<LoaderCircle className="size-3 animate-spin" aria-hidden />
			</span>
			<Roll variant="fade">{text}</Roll>
		</span>
	);
}

function PrepareButton({ s }: { s: S }) {
	return (
		<span
			data-target="prepare"
			data-cursor="pointer"
			data-state={s.prepare}
			className={cn(
				buttonVariants({ size: "xs" }),
				"ofx-prepare",
				s.prepare === "off" && "opacity-64",
			)}
		>
			<span className="ofx-prepare__label">Prepare</span>
			<LoaderCircle
				className="ofx-prepare__spin absolute size-3.5 animate-spin"
				aria-hidden
			/>
		</span>
	);
}

function Caption({ step }: { step: number }) {
	return (
		<div className="ofx-caption" aria-hidden>
			{FLOW_STEPS.map((label, i) => (
				<span
					key={label}
					className={cn(
						"ofx-caption__item",
						i <= step ? "text-foreground" : "text-muted-foreground",
					)}
					data-now={i === step || undefined}
				>
					<span className="ofx-caption__num">{i + 1}</span>
					{label}
				</span>
			))}
		</div>
	);
}

export function FlowExplainer() {
	return (
		<div className="ofx w-full" data-testid="flow-explainer">
			<ol className="sr-only">
				{FLOW_STEPS.map((step) => (
					<li key={step}>{step}</li>
				))}
			</ol>
			<div aria-hidden>
				<Stage<S>
					width={640}
					height={484}
					initial={START}
					poster={POSTER}
					script={script}
					cursor={{ at: OFF_STAGE, style: "real" }}
					className="ofx-stage"
				>
					{(s) => (
						<>
							<div className="ofx-frame">
								<Window
									className="ofx-window"
									title="Inbox"
									sidebar={<Sidebar s={s} />}
									sidebarWidth={140}
									lead={<ScanStatus s={s} />}
									toolbar={<PrepareButton s={s} />}
								>
									<div className="ofx-list">
										{JOBS.map((job, i) => (
											<JobRow key={job.company} job={job} i={i} s={s} />
										))}
										<Collapse open={s.folded && s.found > 0}>
											<div className="text-muted-foreground flex items-center gap-1 px-5 py-2 text-xs">
												<ChevronRight className="size-3.5" aria-hidden />2 set
												aside
											</div>
										</Collapse>
										{FILLER.map((w, k) => (
											<ListRow
												key={w.join("-")}
												id={`ofx-old-${k}`}
												selected={false}
												focused={false}
												onSelect={() => {}}
												title={
													<span className="ofx-bar" style={{ width: w[0] }} />
												}
												subtitle={
													<span
														className="ofx-bar ofx-bar--faint"
														style={{ width: w[1] }}
													/>
												}
												meta={
													<span
														className="ofx-bar ofx-bar--faint"
														style={{ width: w[2] }}
													/>
												}
											/>
										))}
									</div>
								</Window>
							</div>
							<Caption step={s.step} />
						</>
					)}
				</Stage>
			</div>
		</div>
	);
}
