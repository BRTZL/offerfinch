import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	FileCheck2,
	MessageCircleQuestion,
	Send,
	TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { Redirect } from "wouter";
import { AnimatedMark } from "@/components/animated-mark";
import { useNotificationState } from "@/components/desktop/notifications";
import { ago } from "@/components/pipeline/bits";
import { useScanProgress } from "@/components/shell/sidebar";
import { Fit, IconTile, Notice } from "@/components/system/bits";
import {
	Group,
	GroupBody,
	Page,
	PageHeader,
	PageIntro,
	Section,
} from "@/components/system/layout";
import { LoadingShape } from "@/components/system/loading";
import { Row } from "@/components/system/rows";
import { RowsSkeleton } from "@/components/system/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { desktop } from "@/lib/desktop";
import { type client, orpc } from "@/lib/orpc";
import { Link } from "@/lib/router";
import { openSteps, openStepsLine } from "../../shared/setup-steps";

type HomeData = Awaited<ReturnType<typeof client.desktop.home>>;
type Waiting = HomeData["waiting"][number];

/** What each waiting state asks of the user, and where that is done. */
const ASK: Record<
	string,
	{
		verb: string;
		tone: "primary" | "warning" | "destructive" | "brand";
		icon: ReactNode;
		href: (a: Waiting) => string;
	}
> = {
	needs_human: {
		verb: "Finish",
		tone: "destructive",
		icon: <TriangleAlert />,
		href: (a) => `/applications/${a.id}`,
	},
	ready_for_review: {
		verb: "Review",
		tone: "primary",
		icon: <FileCheck2 />,
		href: (a) => `/applications/${a.id}`,
	},
	needs_answers: {
		verb: "Answer",
		tone: "warning",
		icon: <MessageCircleQuestion />,
		href: () => "/questions",
	},
	approved: {
		verb: "Submit",
		tone: "brand",
		icon: <Send />,
		href: (a) => `/applications/${a.id}`,
	},
};

function detail(a: Waiting): string {
	if (a.state === "needs_answers")
		return `${a.questions || "A"} question${a.questions === 1 ? "" : "s"} before it can be drafted`;
	if (a.state === "approved")
		return "Approved: submit it on the posting's form, then record it";
	if (a.state === "needs_human") return "Stopped on the form: finish it there";
	return "CV and letter drafted and checked";
}

const time = (iso: string) =>
	new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const greeting = () => {
	const h = new Date().getHours();
	return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

/** The first name from the profile's personal file ("- **Name:** Sam Rivera"). */
function firstName(
	files: { path: string; content: string }[] | undefined,
): string | null {
	const personal = files?.find((f) => /personal/i.test(f.path))?.content;
	const name = personal?.match(/\*\*Name:\*\*\s*([^\n]+)/)?.[1]?.trim();
	return name ? (name.split(/\s+/)[0] ?? null) : null;
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** Home before its data: the header and the shapes of the sections, so nothing jumps. */
function HomeSkeleton() {
	return (
		<Page width="reading" data-testid="home-loading">
			<div className="flex items-center gap-4">
				<Skeleton className="size-10" />
				<div className="flex flex-col gap-2">
					<Skeleton className="h-5 w-56" />
					<Skeleton className="h-4 w-80" />
				</div>
			</div>
			<Section title="Needs you">
				<RowsSkeleton rows={3} twoLine />
			</Section>
			<Section title="New matches">
				<RowsSkeleton rows={4} />
			</Section>
		</Page>
	);
}

/** "Reading LinkedIn: frontend engineer (2 of 5 sources)" while a scan runs. */
function scanningLine(
	p:
		| { total: number | null; done: number; unit: string; line: string | null }
		| undefined,
): string {
	if (!p?.total) return "Scanning…";
	const of =
		p.unit === "sources"
			? plural(p.total, "source")
			: plural(p.total, "company", "companies");
	return `${p.line ?? "Scanning"} (${Math.min(p.done + 1, p.total)} of ${of})`;
}

/** Steps skipped or not done yet, by name; Continue setup opens the first of them. */
function SetupNotice({
	o,
	aiReady,
}: {
	o: { completedAt: string | null; hasProfile: boolean } & Parameters<
		typeof openSteps
	>[0];
	aiReady: boolean;
}) {
	const open = openSteps(o);
	if (o.completedAt || open.length === 0) return null;
	return (
		<Notice
			data-testid="home-setup"
			actions={
				<Link
					href={`/onboarding?step=${open[0]}`}
					className="text-primary text-sm hover:underline"
					data-testid="resume-setup"
				>
					Continue setup
				</Link>
			}
		>
			{openStepsLine(open, { aiReady, hasProfile: o.hasProfile })}
		</Notice>
	);
}

/** Where the app opens: what needs you now, new matches, the scans and the spend. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stateful home orchestration stays unchanged; current e2e does not cover every scan and resume state.
export default function HomePage() {
	const _queryClient = useQueryClient();
	const onboarding = useQuery(orpc.onboarding.get.queryOptions());
	const status = useQuery({
		...orpc.desktop.status.queryOptions(),
		refetchInterval: (q) =>
			q.state.data?.state === "scanning" ? 2_000 : 10_000,
	});
	const home = useQuery({
		...orpc.desktop.home.queryOptions(),
		refetchInterval: (q) =>
			q.state.data?.scan.state === "scanning" ? 3_000 : 15_000,
	});
	const profile = useQuery({
		...orpc.profile.get.queryOptions(),
		retry: false,
		meta: { quiet: true },
	});
	const progress = useScanProgress(
		status.data?.state === "scanning" ? status.data.scanId : null,
	);
	const notify = useNotificationState();
	const unreadable = useQuery({
		queryKey: ["desktop", "secrets", "unreadable"],
		queryFn: () => desktop.secrets.unreadable(),
	});

	const header = <PageHeader title="Home" />;
	if (!onboarding.data || !status.data || !home.data)
		return (
			<>
				{header}
				<HomeSkeleton />
			</>
		);
	const o = onboarding.data;
	// First start: straight into setup.
	if (o.done.length === 0 && !o.dismissed && !o.hasProfile)
		return <Redirect to="/onboarding" replace />;
	const s = status.data;
	const h = home.data;
	const lockedKeys = unreadable.data ?? [];
	const unready = s.roles.filter((r) => !r.ready);
	const name = firstName(profile.data?.files);

	const system: ReactNode[] = [];
	const fix = (
		key: string,
		href: string,
		title: string,
		sub: ReactNode,
		testId: string,
	) =>
		system.push(
			<Row
				key={key}
				href={href}
				data-testid={testId}
				leading={
					<IconTile tone="warning">
						<TriangleAlert />
					</IconTile>
				}
				title={title}
				subtitle={sub}
			/>,
		);
	if (lockedKeys.length > 0)
		fix(
			"keys",
			"/settings/models",
			`Enter your ${lockedKeys.map((k) => (k === "anthropic" ? "Anthropic" : "OpenAI")).join(" and ")} API key${lockedKeys.length > 1 ? "s" : ""} again`,
			"A stored key can't be read by this copy of the app",
			"home-needs-keys",
		);
	if (unready.length > 0)
		fix(
			"models",
			"/settings/models",
			unready.length === 3
				? "Connect your AI"
				: `Connect your AI: ${unready.map((r) => r.role).join(", ")} cannot run`,
			unready.length === 1
				? unready[0]?.problem
				: "Scoring, tailoring and the claims check each need an API key or a subscription",
			"home-needs-model",
		);
	if (h.spend.reached)
		fix(
			"cap",
			"/settings/spending",
			"This month's cap is reached: new preparation is paused",
			"Raise the cap in Spending, or wait for next month",
			"home-needs-cap",
		);
	if (h.spend.paidStops.length > 0)
		fix(
			"paid-stop",
			"/settings/models",
			`${h.spend.paidStops.join(" and ")} stopped after a paid call`,
			"Check your plan's usage, then resume it in Models",
			"home-needs-paid-stop",
		);
	if (h.scan.unset.length > 0)
		fix(
			"sources",
			"/settings/sources",
			"Set up where to search",
			`${h.scan.unset.join(", ")} needs a search backend before scans find jobs`,
			"home-needs-sources",
		);
	for (const p of h.scan.stopped)
		fix(
			`stopped-${p.id}`,
			"/settings/sources",
			`${p.name}: the last search stopped`,
			p.reason ?? "It did not answer as expected",
			"home-needs-board",
		);
	if (notify.data?.status === "blocked" || notify.data?.status === "failed")
		fix(
			"notifications",
			"/settings/notifications",
			"Notifications are blocked",
			notify.data.missed > 0
				? `${notify.data.missed} could not be shown. Allow OfferFinch in System Settings › Notifications`
				: "Allow OfferFinch in System Settings › Notifications",
			"home-needs-notifications",
		);
	// Setup no longer waits for a test notification: one never shown reads here instead, once the
	// Stay in the loop step was passed (done or skipped).
	if (notify.data?.status === "unknown" && o.done.includes("loop"))
		fix(
			"notifications-untested",
			"/settings/notifications",
			"Notifications are not tested yet",
			"Send a test so you hear about new matches. Your system may ask to allow OfferFinch",
			"home-needs-notify-test",
		);
	if (!s.chrome)
		fix(
			"chrome",
			"/settings/general",
			"Install Google Chrome",
			"Careers pages and PDF export need it (Chromium, Edge or Brave also work)",
			"home-needs-chrome",
		);

	const reviewCount = h.waiting.filter(
		(a) => a.state === "ready_for_review" || a.state === "needs_human",
	).length;
	const questionCount = s.counts.questions;
	const nothingWaits = h.waiting.length === 0 && system.length === 0;
	const last = h.scan.last;
	const lastResult = last?.result;
	const failed = lastResult?.failedCompanies?.length ?? 0;
	const scanning = h.scan.state === "scanning";
	const p = progress.data;

	const summary =
		reviewCount === 0 && questionCount === 0
			? "Nothing needs you right now."
			: [
					reviewCount > 0
						? `${plural(reviewCount, "application")} ${reviewCount === 1 ? "is" : "are"} ready for review`
						: null,
					questionCount > 0
						? `${plural(questionCount, "question")} ${questionCount === 1 ? "needs" : "need"} your answer`
						: null,
				]
					.filter(Boolean)
					.join(" and ")
					.concat(".");

	return (
		<>
			{header}
			<Page width="reading" data-testid="home">
				<PageIntro
					size="xl"
					leading={<AnimatedMark size={40} />}
					title={name ? `${greeting()}, ${name}` : greeting()}
					description={summary}
				/>
				<SetupNotice o={o} aiReady={unready.length === 0} />

				<Section
					title="Needs you"
					end={
						<>
							<Link
								href="/inbox?view=review"
								className="text-primary hover:underline"
								data-testid="home-review"
							>
								{reviewCount} to review
							</Link>
							{questionCount > 0 ? (
								<Link
									href="/questions"
									className="text-primary hover:underline"
									data-testid="home-questions"
								>
									{plural(questionCount, "question")}
								</Link>
							) : null}
						</>
					}
				>
					{nothingWaits ? (
						<Group data-testid="home-calm">
							<GroupBody className="text-muted-foreground">
								{h.scan.watching > 0
									? "OfferFinch searches the internet for jobs that fit you every hour and tells you when a match is worth a look."
									: "Set up where to search in Settings › Sources and OfferFinch starts looking."}
							</GroupBody>
						</Group>
					) : (
						<Group data-testid="home-needs">
							{system}
							{h.waiting.map((a) => {
								const ask = ASK[a.state];
								if (!ask) return null;
								return (
									<Row
										key={a.id}
										href={ask.href(a)}
										data-testid="home-needs-row"
										leading={<IconTile tone={ask.tone}>{ask.icon}</IconTile>}
										title={
											<>
												<span className="font-medium">{ask.verb}</span>{" "}
												{a.title} at {a.company}
											</>
										}
										subtitle={detail(a)}
										meta={
											<>
												<span className="w-8 text-right">
													<Fit value={a.score} />
												</span>
												<span className="w-16 text-right">{ago(a.since)}</span>
											</>
										}
									/>
								);
							})}
						</Group>
					)}
				</Section>

				<Section
					title="New matches"
					end={
						scanning ? (
							<span className="text-muted-foreground">Reading boards…</span>
						) : (
							<Link
								href="/inbox?view=matches"
								className="text-primary hover:underline"
							>
								See all
							</Link>
						)
					}
				>
					{h.recent.length ? (
						<Group data-testid="home-matches">
							{h.recent.map((a) => (
								<Row
									key={a.id}
									href={`/applications/${a.id}`}
									chevron={false}
									leading={
										<span className="w-8 text-right">
											<Fit value={a.score} />
										</span>
									}
									title={
										<>
											<span className="font-medium">{a.company}</span>
											<span className="text-muted-foreground">
												{"  "}
												{a.title}
											</span>
										</>
									}
									meta={<span>{ago(a.scoredAt)}</span>}
								/>
							))}
							{scanning ? <ScanningRows /> : null}
						</Group>
					) : (
						<Group>
							{scanning ? (
								<ScanningRows />
							) : (
								<GroupBody className="text-muted-foreground">
									No new matches this week. Matches appear here with their fit
									score once a scan finds jobs that fit you.
								</GroupBody>
							)}
						</Group>
					)}
				</Section>

				<p className="text-muted-foreground text-xs" data-testid="home-scans">
					{scanning
						? scanningLine(p)
						: h.scan.paused
							? "Scans are paused"
							: last
								? `Scanned ${ago(last.at)}`
								: "No scans yet"}
					<span data-testid="home-next-scan">
						{h.scan.next.at ? ` · next at ${time(h.scan.next.at)}` : ""}
					</span>
					{" · "}
					<Link
						href="/scans"
						className="text-primary hover:underline"
						data-testid="home-scan-history"
					>
						Scan history
					</Link>
					{(last?.status === "errored" || failed > 0) && (
						<span className="text-warning" data-testid="home-scan-stops">
							{last?.status === "errored"
								? ` · last scan stopped: ${last.error}`
								: ` · ${plural(failed, "board")} failed to load`}
						</span>
					)}
				</p>
			</Page>
		</>
	);
}

/** Matches being read during a scan: real rows with sample text, drawn as bones. */
function ScanningRows() {
	return (
		<LoadingShape label="Reading boards">
			{[
				"Wren Analytics  Senior Frontend Engineer",
				"Saltmarsh Games  UI Engineer",
			].map((title) => (
				<Row
					key={title}
					chevron={false}
					leading={
						<span className="w-8 text-right">
							<Fit value={88} />
						</span>
					}
					title={title}
					meta={<span>just now</span>}
				/>
			))}
		</LoadingShape>
	);
}
