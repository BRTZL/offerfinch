import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Radar, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { ScanButton } from "@/components/shell/scan-button";
import { Badge, EmptyState, ErrorLine, Notice } from "@/components/system/bits";
import {
	Group,
	Page,
	PageHeader,
	Section,
	ToolbarSeparator,
} from "@/components/system/layout";
import { ListRowsSkeleton, SelectableList } from "@/components/system/list";
import { MasterDetail } from "@/components/system/master-detail";
import { Row } from "@/components/system/rows";
import { Button } from "@/components/ui/button";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { Link, useParams, useRouter } from "@/lib/router";

type Run = Awaited<ReturnType<typeof client.scanHistory.get>>;
type ListRun = Awaited<ReturnType<typeof client.scanHistory.list>>[number];
type Source = Run["sources"][number];

const TRIGGER: Record<string, string> = {
	timer: "Hourly",
	start: "At launch",
	manual: "Scan now",
};

const STATUS: Record<
	string,
	{
		label: (retryAt?: string) => string;
		tone: "neutral" | "quiet" | "primary" | "warning" | "destructive";
	}
> = {
	ok: { label: () => "Ran", tone: "primary" },
	waiting: { label: () => "Not due", tone: "quiet" },
	paused_check: { label: () => "Paused for a check", tone: "warning" },
	needs_sign_in: { label: () => "Needs sign-in", tone: "warning" },
	retrying: {
		label: (at) => (at ? `Retrying at ${clock(at)}` : "Retrying later"),
		tone: "warning",
	},
	off: { label: () => "Off", tone: "quiet" },
	not_set_up: { label: () => "Not set up", tone: "quiet" },
	error: { label: () => "Problem", tone: "destructive" },
};

const RETRYABLE = new Set([
	"job-board-search",
	"linkedin",
	"linkedin-top-picks",
	"indeed",
	"glassdoor",
	"web-search",
]);

const clock = (iso: string | Date) =>
	new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const when = (iso: string | Date) =>
	new Date(iso).toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
function duration(start: string | Date, end: string | Date | null): string {
	if (!end) return "";
	const s = Math.max(0, Math.round((+new Date(end) - +new Date(start)) / 1000));
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** "Reading Indeed: frontend engineer" while a scan runs. */
function progressLine(progress: Run["progress"]): string | null {
	if (!progress) return null;
	const label = progress.label ?? progress.source;
	return progress.query
		? `Reading ${label}: ${progress.query}`
		: `Reading ${label}…`;
}

/**
 * Scan history: every scan's outcome in the list (what it found, or the biggest reason it found
 * nothing new), and beside it each source of the chosen scan: what it searched, a small funnel,
 * what it set aside and why, and what to do about a problem.
 */
export default function ScansPage() {
	const router = useRouter();
	const { id: selectedId } = useParams<{ id?: string }>();
	const list = useQuery({
		...orpc.scanHistory.list.queryOptions(),
		refetchInterval: (q) =>
			q.state.data?.some((r) => r.status === "running" || r.status === "queued")
				? 2_000
				: 15_000,
	});
	const runs = list.data ?? [];
	const chosen = selectedId ?? runs[0]?.id;
	return (
		<>
			<PageHeader
				title="Scans"
				subtitle={list.data ? plural(runs.length, "scan") : undefined}
			>
				<Link
					href="/settings/sources"
					className="text-primary text-xs hover:underline"
				>
					Sources
				</Link>
				<ToolbarSeparator />
				<ScanButton />
			</PageHeader>
			<MasterDetail
				list={
					list.isError ? (
						<div className="px-4 py-3">
							<ErrorLine>
								Could not load scans: {list.error.message}. It retries shortly.
							</ErrorLine>
						</div>
					) : list.isLoading ? (
						<ListRowsSkeleton rows={6} />
					) : runs.length === 0 ? (
						<NoScans />
					) : (
						<SelectableList
							items={runs}
							selectedId={chosen}
							onSelect={(id) => router.replace(`/scans/${id}`)}
							label="Scans"
							detailId="scan-detail"
							render={(run: ListRun) => ({
								testId: "scan-row",
								title: run.outcome,
								time: when(run.startedAt),
								subtitle:
									run.status === "running"
										? (progressLine(run.progress) ?? "Starting…")
										: `${TRIGGER[run.trigger] ?? run.trigger} · ${plural(run.totals.searches, "search", "searches")} · ${plural(run.totals.read, "job")} read`,
								meta: (
									<>
										<span className="text-foreground tabular-nums">
											{plural(run.totals.newJobs, "new job")}
										</span>
										{run.totals.listed > 0 ? (
											<Badge tone="primary">{run.totals.listed} listed</Badge>
										) : null}
										{run.status === "errored" ? (
											<Badge tone="destructive">Stopped</Badge>
										) : null}
										{run.status === "interrupted" ? (
											<Badge tone="warning">Interrupted</Badge>
										) : null}
									</>
								),
							})}
						/>
					)
				}
			>
				{chosen ? (
					<ScanDetail key={chosen} id={chosen} />
				) : (
					<div className="flex flex-1 items-center justify-center">
						<NoScans />
					</div>
				)}
			</MasterDetail>
		</>
	);
}

function NoScans() {
	return (
		<EmptyState
			icon={<Radar />}
			title="No scans yet"
			actions={
				<>
					<ScanButton />
					<Link
						href="/settings/sources"
						className="text-primary text-sm hover:underline"
					>
						Open Sources
					</Link>
				</>
			}
		>
			A scan searches the sources you turn on in Settings › Sources for the
			titles in Job search, every hour while the Mac is awake. Each scan is
			listed here with what it found and why it set jobs aside.
		</EmptyState>
	);
}

function ScanDetail({ id }: { id: string }) {
	const run = useQuery({
		...orpc.scanHistory.get.queryOptions({ input: { id } }),
		refetchInterval: (q) =>
			q.state.data?.status === "running" || q.state.data?.status === "queued"
				? 2_000
				: 15_000,
	});
	if (run.isError)
		return (
			<div className="p-6">
				<ErrorLine>Could not open this scan: {run.error.message}</ErrorLine>
			</div>
		);
	const r = run.data;
	if (!r) return <div className="flex-1" />;
	const progress = r.status === "running" ? progressLine(r.progress) : null;
	return (
		<Page
			width="reading"
			id="scan-detail"
			data-testid="scan-detail"
			tabIndex={-1}
			className="outline-none"
		>
			<header className="flex flex-col gap-1">
				<h2
					className="text-foreground text-xl font-semibold"
					data-testid="scan-outcome"
				>
					{r.outcome}
				</h2>
				<p className="text-muted-foreground text-sm">
					{[
						TRIGGER[r.trigger] ?? r.trigger,
						when(r.startedAt),
						duration(r.startedAt, r.endedAt),
						plural(r.totals.searches, "search", "searches"),
						`${plural(r.totals.read, "job")} read`,
						plural(r.totals.newJobs, "new job"),
					]
						.filter(Boolean)
						.join(" · ")}
				</p>
			</header>
			{progress ? (
				<Notice tone="info" data-testid="scan-progress">
					{progress}
				</Notice>
			) : null}
			{r.status === "errored" && r.error ? (
				<Notice tone="destructive" title="The scan stopped">
					{r.error.split("\n")[0]}
				</Notice>
			) : null}
			{r.sources.map((s) => (
				<SourceSection key={s.report.id} source={s} />
			))}
		</Page>
	);
}

function SourceSection({ source }: { source: Source }) {
	const { report, found, drops } = source;
	const status = STATUS[report.status] ?? STATUS.error;
	// Off, not set up, or stopped before reading anything: no funnel of zeros.
	const idle =
		report.status === "off" ||
		report.status === "not_set_up" ||
		report.status === "waiting" ||
		(report.status !== "ok" && report.read === 0 && found.length === 0);
	const listed = found.filter((f) => f.fate.kind === "listed").length;
	return (
		<Section
			title={
				<span className="flex items-center gap-2">
					{report.label}
					<Badge tone={status?.tone ?? "neutral"}>
						{status?.label(report.retryAt)}
					</Badge>
				</span>
			}
			data-testid={`scan-source-${report.id}`}
		>
			{report.problem || report.status !== "ok" ? (
				<SourceProblem source={source} />
			) : null}
			{idle ? null : (
				<>
					<Funnel
						steps={[
							report.results !== null
								? { label: "results", value: report.results }
								: null,
							{ label: "read", value: report.read },
							{ label: "new", value: found.length },
							{ label: "listed", value: listed },
						]}
					/>
					{report.searches.length > 0 ? (
						<p className="text-muted-foreground text-xs" data-selectable>
							Searched: {report.searches.join(" · ")}
						</p>
					) : report.queries > 0 ? (
						<p className="text-muted-foreground text-xs">
							{plural(report.queries, "search", "searches")} run
						</p>
					) : null}
					{found.length > 0 ? (
						<Group data-testid="scan-found">
							{found.map((f) => (
								<Row
									key={f.jobId}
									title={f.title}
									subtitle={[f.company, fateLabel(f.fate)]
										.filter(Boolean)
										.join(" · ")}
									href={
										f.applicationId
											? `/applications/${f.applicationId}`
											: undefined
									}
									chevron={Boolean(f.applicationId)}
								/>
							))}
						</Group>
					) : null}
					{drops.length > 0 ? (
						<Group data-testid="scan-dropped">
							{drops.map((d) => (
								<Row
									key={d.key}
									title={capitalize(d.label)}
									meta={<span className="tabular-nums">{d.count}</span>}
									detail={
										d.examples.length > 0
											? d.examples
													.map((e) =>
														[e.title, e.company].filter(Boolean).join(", "),
													)
													.join("; ")
											: undefined
									}
									data-testid="scan-drop"
								/>
							))}
						</Group>
					) : null}
				</>
			)}
		</Section>
	);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function fateLabel(fate: Source["found"][number]["fate"]): string {
	switch (fate.kind) {
		case "checking":
			return "Being checked";
		case "listed":
			return "Listed in Inbox";
		case "filtered":
			return `Set aside: ${fate.message}`;
		case "below_score":
			return fate.message;
		case "hidden_company":
			return "Set aside: from a company you hid";
	}
}

/** read → new → listed, as small numbers with arrows between them. */
function Funnel({
	steps,
}: {
	steps: ({ label: string; value: number } | null)[];
}) {
	const shown = steps.filter((s): s is { label: string; value: number } =>
		Boolean(s),
	);
	return (
		<div className="flex items-center gap-2" data-testid="scan-funnel">
			{shown.map((s, i) => (
				<span key={s.label} className="flex items-center gap-2">
					{i > 0 ? (
						<ChevronRight className="text-muted-foreground size-3.5" />
					) : null}
					<span className="flex items-baseline gap-1">
						<span className="text-foreground font-mono text-sm tabular-nums">
							{s.value}
						</span>
						<span className="text-muted-foreground text-xs">{s.label}</span>
					</span>
				</span>
			))}
		</div>
	);
}

/** What stopped a source, and the one action that fixes it. */
function SourceProblem({ source }: { source: Source }) {
	const queryClient = useQueryClient();
	const { report } = source;
	const retry = useMutation({
		mutationFn: () =>
			client.sources.retry({
				// Top picks are part of LinkedIn's read.
				provider: (report.id === "linkedin-top-picks"
					? "linkedin"
					: report.id) as "indeed",
			}),
		onSuccess: () => {
			toast.success("Trying again now.");
			void queryClient.invalidateQueries({ queryKey: orpc.scanHistory.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.desktop.key() });
		},
		onError: (e) => toast.error(e.message),
	});
	const sources = (label: string) => (
		<Link
			href="/settings/sources"
			className="text-primary text-sm whitespace-nowrap hover:underline"
		>
			{label}
		</Link>
	);
	let action: ReactNode = null;
	let tone: "info" | "warning" | "destructive" = "warning";
	let text = report.problem ?? "";
	switch (report.status) {
		case "paused_check":
			action = sources("Watch live in Sources");
			text ||= "The site showed a check for a person to solve.";
			break;
		case "needs_sign_in":
			action = sources("Sign in in Sources");
			text ||= "The site asked to sign in.";
			break;
		case "retrying":
		case "error":
			action = RETRYABLE.has(report.id) ? (
				<Button
					size="sm"
					variant="outline"
					onClick={() => retry.mutate()}
					disabled={retry.isPending}
					data-testid="scan-retry"
				>
					<RefreshCw />
					Retry now
				</Button>
			) : null;
			tone = report.status === "error" ? "destructive" : "warning";
			break;
		case "waiting":
			// LinkedIn between reads: "Next LinkedIn read in ~4 h."
			tone = "info";
			text ||= "Not due in this scan.";
			break;
		case "off":
		case "not_set_up":
			tone = "info";
			action = sources("Open Sources");
			text ||=
				report.status === "off"
					? "Turned off: scans don't search it."
					: "Needs setting up before scans can search it.";
			break;
	}
	return (
		<Notice tone={tone} actions={action} data-testid="scan-problem">
			<span className="flex flex-col gap-1">
				<span>{text}</span>
				{report.debugSnapshot ? (
					<span className="flex items-center gap-2 text-xs">
						<span className="truncate">
							Page kept for diagnosis: {report.debugSnapshot.split("/").pop()}
						</span>
						<Button
							size="xs"
							variant="ghost"
							onClick={() =>
								void desktop
									.copyText(report.debugSnapshot ?? "")
									.then(() => toast.success("Path copied."))
							}
						>
							Copy path
						</Button>
					</span>
				) : null}
			</span>
		</Notice>
	);
}
