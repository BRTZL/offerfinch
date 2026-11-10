import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ago, sourceLabel } from "@/components/pipeline/bits";
import {
	QueryState,
	SettingsPage,
} from "@/components/pipeline/settings/shared";
import { StatusDot } from "@/components/system/bits";
import { Group, Section } from "@/components/system/layout";
import { FormRow } from "@/components/system/rows";
import { SiteSheet } from "@/components/system/site-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { client, orpc } from "@/lib/orpc";
import { Link, useSearchParams } from "@/lib/router";
import type { SiteSheetMode, SiteTabId } from "../../../../shared/bridge";
import { fixFor } from "./source-fix";

/** One line for a provider's last run: what it found, or why it stopped. */
function lastRunLine(p: {
	lastRunAt: Date | string | null;
	lastRun: {
		queries: number;
		found: number;
		newJobs: number;
		problem?: string;
	} | null;
}): string {
	if (!p.lastRunAt || !p.lastRun) return "Not run yet";
	const r = p.lastRun;
	if (r.problem) return `Last run ${ago(p.lastRunAt)}: ${r.problem}`;
	const n = (count: number, one: string, many: string) =>
		`${count} ${count === 1 ? one : many}`;
	return `${ago(p.lastRunAt)}: ${n(r.queries, "search", "searches")}, ${n(r.found, "new posting", "new postings")}, ${n(r.newJobs, "new job", "new jobs")}`;
}

/**
 * Job-board search's last run per board: "By board: Greenhouse 3 found, 1 new · Workable 2
 * found, 2 new". Only boards its searches found postings on; null when there are none.
 */
function boardsLine(p: {
	lastRun: {
		problem?: string;
		boards?: { board: string; found: number; new: number }[];
	} | null;
}): string | null {
	const boards = (p.lastRun?.boards ?? []).filter((b) => b.found > 0);
	if (p.lastRun?.problem || boards.length === 0) return null;
	return `By board: ${boards
		.map((b) => `${sourceLabel(b.board)} ${b.found} found, ${b.new} new`)
		.join(" · ")}`;
}

type SourcesData = Awaited<ReturnType<typeof client.sources.list>>;
type TabState = SourcesData["tabs"][SiteTabId];

const SITE_LABEL: Record<SiteTabId, string> = {
	linkedin: "LinkedIn",
	indeed: "Indeed",
	glassdoor: "Glassdoor",
	duckduckgo: "DuckDuckGo",
	web: "Web",
};

/** A site's sign-in, as last seen, in two or three words. */
function signInLine(site: SiteTabId, tab: TabState): string {
	if (tab.signIn === "signed-in") return "Signed in";
	if (tab.signIn === "needed" || site === "linkedin") return "Sign-in needed";
	// Indeed's and Glassdoor's search results read signed out (checked 2026-11-02).
	return "Not signed in (optional)";
}

type Stop = NonNullable<SourcesData["providers"][number]["stop"]>;

const at = (iso: string) =>
	new Date(iso).toLocaleString(undefined, {
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	});

/**
 * A recorded stop in words. A check or sign-in holds the source until you clear it; anything
 * else (a layout change, a refusal) is retried by the scans by themselves, waiting longer each
 * time it happens again.
 */
function stopLine(stop: Stop): string {
	if (stop.held)
		return stop.kind === "login_wall"
			? `Stopped: ${stop.reason}. Sign in to go on.`
			: `Stopped: ${stop.reason}. Check the site, then Retry now.`;
	const again = stop.failures > 1 ? ` (${stop.failures} times in a row)` : "";
	return stop.retryAt
		? `Paused after: ${stop.reason}${again}. Tries again by itself after ${at(stop.retryAt)}.`
		: `Paused after: ${stop.reason}${again}. Tries again with the next scan.`;
}

/** "~4 h", "~35 min" from now. */
function inAbout(iso: string): string {
	const ms = new Date(iso).getTime() - Date.now();
	if (ms < 3_600_000) return `~${Math.max(1, Math.round(ms / 60_000))} min`;
	return `~${Math.round(ms / 3_600_000)} h`;
}

type ProviderId = SourcesData["providers"][number]["provider"];

/**
 * Each source in the order a scan runs them: the hidden tab it reads in (a check there needs
 * the user; the remote feeds have none, they are plain requests), whether its site has a
 * sign-in, and what it reads (shown on hover over its name, so each row stays two short lines).
 * Nothing to set: every source searches for what Settings › Job search lists.
 */
const SOURCES: {
	id: ProviderId;
	label: string;
	tab?: SiteTabId;
	/** The tab that reads its result pages, when it is another (web search). */
	pagesTab?: SiteTabId;
	signIn: boolean;
	about: string;
}[] = [
	{
		id: "job-board-search",
		label: "Job boards via search",
		tab: "duckduckgo",
		signIn: false,
		about:
			"Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Teamtailor and Personio postings at any company, found with DuckDuckGo and read from the boards' public pages.",
	},
	{
		id: "linkedin",
		label: "LinkedIn",
		tab: "linkedin",
		signIn: true,
		about:
			"Your Top job picks and your searches, read at most every 3 hours, 30 pages a day. LinkedIn's terms ban automated access, even to your own account.",
	},
	{
		id: "indeed",
		label: "Indeed",
		tab: "indeed",
		signIn: true,
		about:
			"Its search pages, in your country's Indeed. Job pages may show a browser check: the run waits for you.",
	},
	{
		id: "glassdoor",
		label: "Glassdoor",
		tab: "glassdoor",
		signIn: true,
		about:
			"Its search pages. Job pages may show a browser check: the run waits for you.",
	},
	{
		id: "remotive",
		label: "Remotive",
		signIn: false,
		about:
			"Remote jobs from Remotive's public API, read at most every 6 hours (Remotive asks for no more than 4 reads a day); up to 25 new matches a read. Jobs link to Remotive.",
	},
	{
		id: "remoteok",
		label: "Remote OK",
		signIn: false,
		about:
			"Remote jobs from Remote OK's public API, read at most every 6 hours; up to 25 new matches a read. Jobs link to Remote OK.",
	},
	{
		id: "weworkremotely",
		label: "We Work Remotely",
		signIn: false,
		about:
			"Remote jobs from We Work Remotely's public RSS feed, read at most every 6 hours; up to 25 new matches a read. Jobs link to We Work Remotely.",
	},
	{
		id: "hn-hiring",
		label: "HN Who is hiring",
		signIn: false,
		about:
			"This month's Hacker News \"Who is hiring?\" thread, read through the public HN Search API at most every 6 hours; each post's first line is read for the company, role and place. Up to 25 new matches a read.",
	},
	{
		id: "web-search",
		label: "Web search",
		tab: "duckduckgo",
		pagesTab: "web",
		signIn: false,
		about:
			"Postings on any other site, found with DuckDuckGo. Up to 50 pages a scan, 3 per site; pages without job data are read by AI (up to 15 a scan).",
	},
];

/**
 * Settings › Sources: where scans look for jobs (PLAN A). One row per source, nothing to set up:
 * on or off, the site's sign-in where it has one, the last run or its problem, and the one
 * action that fixes it (Watch live while it reads or waits on a check, Sign in, Retry now).
 * What every source searches for is the shared plan in Settings › Job search.
 */
export function SourcesSettings() {
	const queryClient = useQueryClient();
	const list = useQuery({
		...orpc.sources.list.queryOptions(),
		// A run may be going: its status updates while this page is open, faster while it reads.
		refetchInterval: (query) =>
			Object.values(query.state.data?.tabs ?? {}).some((t) => t.running)
				? 1_000
				: 5_000,
	});
	const [sheet, setSheet] = useState<{
		site: SiteTabId;
		mode: SiteSheetMode;
	} | null>(null);
	const [sheetOpen, setSheetOpen] = useState(false);
	const openSheet = (site: SiteTabId, mode: SiteSheetMode) => {
		setSheet({ site, mode });
		setSheetOpen(true);
	};
	// A "needs you" notification opens this page with ?live=<site>.
	const params = useSearchParams();
	const live = params.get("live");
	const opened = useRef<string | null>(null);
	useEffect(() => {
		if (!live || opened.current === live || !list.data) return;
		if (
			live !== "linkedin" &&
			live !== "indeed" &&
			live !== "glassdoor" &&
			live !== "duckduckgo"
		)
			return;
		opened.current = live;
		setSheet({ site: live, mode: "live" });
		setSheetOpen(true);
	}, [live, list.data]);

	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: orpc.sources.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.desktop.key() }),
		]);
	const afterSignIn = async (site: SiteTabId) => {
		const result = await client.sources
			.checkSignIn({ site })
			.catch(() => ({ signedIn: null }));
		if (result.signedIn === true)
			toast.success(`Signed in to ${SITE_LABEL[site]}.`);
		else if (result.signedIn === false)
			toast.message(
				`Not signed in to ${SITE_LABEL[site]}: the page still asks to sign in.`,
			);
		await refresh();
	};

	const data = list.data;
	return (
		<SettingsPage
			id="sources"
			title="Sources"
			description={
				<>
					Every source searches for what{" "}
					<Link
						href="/settings/job-filter"
						className="text-primary hover:underline"
					>
						Job search
					</Link>{" "}
					lists, reading at a human pace. Approved applications on Ashby,
					Greenhouse and Lever are submitted for you; elsewhere you apply
					yourself.
				</>
			}
		>
			<QueryState isLoading={list.isLoading} error={null} what="sources" />
			{data && (
				<Section title="Sources">
					<Group data-testid="sources-list">
						{SOURCES.map((source) => (
							<SourceRow
								key={source.id}
								source={source}
								data={data}
								onChange={refresh}
								onSheet={openSheet}
							/>
						))}
					</Group>
				</Section>
			)}
			{sheet && (
				<SiteSheet
					key={`${sheet.site}-${sheet.mode}`}
					site={sheet.site}
					label={SITE_LABEL[sheet.site]}
					mode={sheet.mode}
					open={sheetOpen}
					onOpenChange={setSheetOpen}
					onClosed={() => {
						if (sheet.mode === "sign-in") void afterSignIn(sheet.site);
						else void refresh();
					}}
					note={
						data?.tabs[sheet.site].check ? (
							<span
								className="text-warning text-sm"
								data-testid="site-sheet-check"
							>
								{SITE_LABEL[sheet.site]} shows a check (
								{data.tabs[sheet.site].check?.reason}). Solve it in the page
								below; the run goes on by itself once it's cleared.
							</span>
						) : undefined
					}
				/>
			)}
		</SettingsPage>
	);
}

/** The status light and lines under a source's name. */
function SourceHint({
	tone,
	lines,
	testId,
}: {
	tone: "brand" | "warning" | "busy" | "destructive";
	lines: (string | null)[];
	testId: string;
}) {
	const [first, ...rest] = lines.filter((l): l is string => Boolean(l));
	return (
		<span className="flex flex-col gap-0.5">
			<span className="flex items-center gap-2">
				<StatusDot tone={tone} />
				<span data-testid={testId}>{first}</span>
			</span>
			{rest.map((line) => (
				<span key={line}>{line}</span>
			))}
		</span>
	);
}

/** The run line of a site: a check it waits on, reading now, or how the last run ended. */
function runLine(tab: TabState, last: string): string {
	if (tab.check)
		return `Needs you: ${tab.check.reason}. The run waits for you.`;
	if (tab.running) return "Reading now";
	if (tab.lastCheck?.outcome === "timeout" && !tab.running)
		return `${last} The last check wasn't solved in time.`;
	return last;
}

type Provider = SourcesData["providers"][number];

/** A source without a site tab (a remote feed): never reading in a tab, never signed in. */
const NO_TAB: TabState = {
	signIn: "never",
	signedInAt: null,
	legacyProfile: false,
	running: false,
	check: null,
	lastCheck: null,
};

/** The row's light: off, needs you, busy, stopped, a problem, or fine. */
function toneOf(
	p: Provider,
	tab: TabState,
	reading: boolean,
): "brand" | "warning" | "busy" | "destructive" {
	if (!p.enabled || tab.check) return "warning";
	if (tab.running || reading) return "busy";
	if (p.stop?.held) return "destructive";
	return p.stop || p.lastRun?.problem ? "warning" : "brand";
}

/** The first line: off, reading, a check, a stop, or the last run. */
function statusLine(p: Provider, tab: TabState, reading: boolean): string {
	if (!p.enabled) return "Off";
	if (reading) return "Reading pages now";
	return runLine(tab, p.stop ? stopLine(p.stop) : lastRunLine(p));
}

/** The second line, the same facts for every source: its sign-in, and LinkedIn's next read. */
function detailLine(
	source: (typeof SOURCES)[number],
	p: Provider,
	tab: TabState,
): string | null {
	const next =
		p.enabled &&
		p.nextReadAt &&
		!p.stop &&
		!tab.running &&
		new Date(p.nextReadAt).getTime() > Date.now()
			? `Next read in ${inAbout(p.nextReadAt)}`
			: null;
	const parts = [
		source.signIn && source.tab ? signInLine(source.tab, tab) : null,
		next,
	];
	return parts.filter(Boolean).join(" · ") || null;
}

function SourceRow({
	source,
	data,
	onChange,
	onSheet,
}: {
	source: (typeof SOURCES)[number];
	data: SourcesData;
	onChange: () => void;
	onSheet: (site: SiteTabId, mode: SiteSheetMode) => void;
}) {
	const p = data.providers.find((x) => x.provider === source.id);
	const site = source.tab;
	const tab = site ? data.tabs[site] : NO_TAB;
	const reading = source.pagesTab ? data.tabs[source.pagesTab].running : false;
	const update = useMutation({
		mutationFn: (enabled: boolean) =>
			client.sources.update({ provider: source.id, enabled }),
		onSuccess: onChange,
		onError: (e) => toast.error(e.message),
	});
	const retry = useMutation({
		mutationFn: () => client.sources.retry({ provider: source.id }),
		onSuccess: (r) => {
			toast.success(
				r.started
					? "Trying again now: a scan started."
					: "Cleared. The next scan reads it again.",
			);
			onChange();
		},
		onError: (e) => toast.error(e.message),
	});
	if (!p) return null;
	const fix = fixFor(source, p, tab, reading);
	const id = source.id;
	return (
		<FormRow
			label={<span title={source.about}>{source.label}</span>}
			data-testid={`source-${id}`}
			hint={
				<SourceHint
					testId={`source-${id}-status`}
					tone={toneOf(p, tab, reading)}
					lines={[
						statusLine(p, tab, reading),
						detailLine(source, p, tab),
						p.enabled && !p.stop && !reading ? boardsLine(p) : null,
					]}
				/>
			}
		>
			{fix === "watch" && site ? (
				<Button
					variant={tab.check ? "default" : "outline"}
					size="sm"
					onClick={() =>
						onSheet(
							reading && !tab.check ? (source.pagesTab ?? site) : site,
							"live",
						)
					}
					data-testid={`source-${id}-${tab.check ? "needs-you" : "watch"}`}
				>
					{tab.check ? "Needs you" : "Watch live"}
				</Button>
			) : fix === "sign-in" && site ? (
				<Button
					variant="outline"
					size="sm"
					onClick={() => onSheet(site, "sign-in")}
					data-testid={`source-${id}-sign-in`}
				>
					Sign in…
				</Button>
			) : fix === "retry" ? (
				<Button
					variant="outline"
					size="sm"
					onClick={() => retry.mutate()}
					disabled={retry.isPending}
					data-testid={`source-${id}-retry`}
				>
					Retry now
				</Button>
			) : null}
			<Switch
				checked={p.enabled}
				onCheckedChange={(on) => update.mutate(on)}
				aria-label={source.label}
				data-testid={`source-${id}-enabled`}
			/>
		</FormRow>
	);
}
