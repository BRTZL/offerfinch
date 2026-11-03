import { ENDED_COMPANY_HIDDEN } from "@offerfinch/core/domain/dismissal";
import {
	keepPreviousData,
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Inbox as InboxIcon, Plus } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	AddedActions,
	addedStep,
	linkHost,
	STEP_LABEL,
} from "@/components/pipeline/added";
import {
	ApplicationDetail,
	ToolbarSlot,
} from "@/components/pipeline/application/detail";
import { prepareRefused } from "@/components/pipeline/application/use-application-actions";
import { STATE_LABEL } from "@/components/pipeline/bits";
import { FilterSelect } from "@/components/pipeline/filter-select";
import {
	CompanySummary,
	SelectionSummary,
} from "@/components/pipeline/inbox-summary";
import {
	type DismissTarget,
	NotInterested,
	useDismiss,
} from "@/components/pipeline/not-interested";
import { ScanButton } from "@/components/shell/scan-button";
import { SearchButton } from "@/components/shell/search-button";
import {
	EmptyState,
	ErrorLine,
	Fit,
	Kbd,
	Notice,
	SearchField,
} from "@/components/system/bits";
import { PageHeader } from "@/components/system/layout";
import { ListRow, ListRowsSkeleton } from "@/components/system/list";
import { MasterDetail } from "@/components/system/master-detail";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { sendCommand } from "@/lib/commands";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { Link, useParams, useRouter, useSearchParams } from "@/lib/router";
import { useStoredState } from "@/lib/use-stored-state";
import { cn } from "@/lib/utils";
import { keyHint, matches, type ShortcutId } from "../../shared/shortcuts";

type InboxRow = Awaited<ReturnType<typeof client.inbox.page>>[number];

/** Rows per page; more load as the list scrolls (only visible rows are rendered). */
const PAGE = 100;
/** Matches load whole (up to this many), so a company's roles group together. */
const MATCHES_PAGE = 500;

type ViewKey =
	| "matches"
	| "drafting"
	| "review"
	| "approved"
	| "closed"
	| "all";

/**
 * The Inbox's views, in the order the work flows: decide on matches, drafts are written,
 * review and approve, then applied or closed. Each says what to do there.
 */
const VIEWS: Record<
	ViewKey,
	{ label: string; hint: string; emptyTitle: string; empty: string }
> = {
	matches: {
		label: "Matches",
		hint: "Decide on each match: Prepare to draft an application, or Not interested.",
		emptyTitle: "No matches to decide on",
		empty:
			"Jobs that fit your search land here after each scan. Prepare one to draft its CV, letter and answers, or set it aside with Not interested.",
	},
	drafting: {
		label: "Drafting",
		hint: "Drafts being written and checked. Answer any questions so they can finish.",
		emptyTitle: "Nothing being drafted",
		empty:
			"Press Prepare on a match to draft its CV, letter and answers. A draft that needs your answers waits here.",
	},
	review: {
		label: "To review",
		hint: "Read each draft, then Approve or Reject it. Nothing is sent without your approval.",
		emptyTitle: "Nothing to review",
		empty:
			"A job lands here once its CV, letter and answers are drafted and checked.",
	},
	approved: {
		label: "Approved",
		hint: "Approved applications, waiting to be submitted or handed to you.",
		emptyTitle: "Nothing approved is waiting",
		empty: "Applications you approve wait here until they are submitted.",
	},
	closed: {
		label: "Closed",
		hint: "Applied, rejected, not interested, expired, below your minimum fit, or the posting closed.",
		emptyTitle: "Nothing closed yet",
		empty:
			"Applied jobs, the ones you rejected or were not interested in, those that expired and postings that closed end up here.",
	},
	all: {
		label: "All",
		hint: "Every job the Inbox holds, in every state.",
		emptyTitle: "No jobs yet",
		empty:
			"Every hour OfferFinch searches your sources; jobs that pass your Job search rules and minimum fit land here.",
	},
};
/** The steps that need the user, as segments; the later ones in a pop-up beside them. */
const STEPS: ViewKey[] = ["matches", "drafting", "review"];
const LATER: ViewKey[] = ["approved", "closed", "all"];
/** Views of earlier versions, still in links and saved state. */
const OLD_VIEWS: Record<string, ViewKey> = {
	answers: "drafting",
	working: "drafting",
};
const viewOf = (key: string | null): ViewKey | null =>
	key === null
		? null
		: key in VIEWS
			? (key as ViewKey)
			: (OLD_VIEWS[key] ?? null);

/** "Set aside: needs US citizenship", from the filter's rejecting rule. */
function setAsideText(row: InboxRow): string {
	const reason = (row.filterReason ?? row.filterSummary ?? "").trim();
	if (!reason) return "Set aside by your job search";
	// Lowercase the first letter only when it starts a plain word ("Needs", not "US").
	const plain = /^\p{Lu}\p{Ll}/u.test(reason);
	return `Set aside: ${plain ? reason.charAt(0).toLowerCase() + reason.slice(1) : reason}`;
}

/** A match nobody acted on: the user decides (Prepare or Not interested). */
const isOpenMatch = (row: InboxRow) =>
	row.state === "scored" &&
	!row.endedReason &&
	!row.prepareRequestedAt &&
	!row.closedAt;

/** Found closed before it was submitted (a closed posting after that is expected). */
const postingClosed = (row: InboxRow) =>
	Boolean(row.closedAt) &&
	!["applying", "applied", "needs_human"].includes(row.state);

/** Rows the user has opened, so new ones carry a dot (as unread mail does). */
const SEEN_KEY = "offerfinch.inbox.seen";
function useSeen() {
	const [seen, setSeen] = useState<Set<string>>(() => {
		try {
			return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]"));
		} catch {
			return new Set();
		}
	});
	const mark = useCallback((id: string) => {
		setSeen((prev) => {
			if (prev.has(id)) return prev;
			const next = new Set(prev).add(id);
			try {
				localStorage.setItem(SEEN_KEY, JSON.stringify([...next].slice(-2000)));
			} catch {}
			return next;
		});
	}, []);
	return { seen, mark };
}

function when(date: string | Date): string {
	const d = new Date(date);
	const days = (Date.now() - d.getTime()) / 86_400_000;
	if (days < 1) {
		const hours = Math.round(days * 24);
		return hours < 1 ? "Now" : `${hours}h`;
	}
	if (days < 2) return "Yesterday";
	if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function rowStatus(row: InboxRow): {
	text: string;
	tone?: "warning" | "muted";
} {
	if (row.openQuestions > 0)
		return {
			text: `${row.openQuestions} question${row.openQuestions === 1 ? "" : "s"} to answer`,
			tone: "warning",
		};
	if (postingClosed(row)) return { text: "Posting closed", tone: "muted" };
	const step = addedStep(row);
	if (step === "failed")
		return {
			text: `Couldn't read: ${row.readError ?? "the page could not be read"}`,
			tone: "warning",
		};
	if (step) return { text: STEP_LABEL[step], tone: "muted" };
	if (row.source === "manual" && ["found", "scored"].includes(row.state))
		return {
			text:
				row.filterDecision === "reject"
					? "Added by you · outside your search"
					: "Added by you",
			tone: "muted",
		};
	if (row.state === "dismissed")
		return {
			text:
				row.endedReason === ENDED_COMPANY_HIDDEN
					? "Company hidden"
					: "Not interested",
			tone: "muted",
		};
	if (row.state === "scored" && row.endedReason)
		return { text: "Below your minimum fit", tone: "muted" };
	if (row.state === "scored" && row.prepareRequestedAt)
		return { text: "Drafting soon", tone: "muted" };
	if (row.state === "scored") return { text: "Match", tone: "muted" };
	if (row.state === "preparing") return { text: "Drafting CV", tone: "muted" };
	return { text: STATE_LABEL[row.state] ?? row.state };
}

/* --------------------------------------------------------------- grouping */

type Item =
	| {
			kind: "group";
			key: string;
			name: string;
			companyId: string;
			rows: InboxRow[];
			best: number | null;
			open: boolean;
	  }
	| { kind: "row"; row: InboxRow; group: string | null };

const companyOf = (row: InboxRow) => row.companyKey || row.companyId;
const itemId = (item: Item) =>
	item.kind === "group" ? `group-${item.key}` : `row-${item.row.id}`;

/** Rows that group under their company: open matches the scans found (not ones added by link). */
const groupable = (row: InboxRow) =>
	isOpenMatch(row) && row.source !== "manual";

/**
 * The list's lines. In Matches, a company with two or more open matches is one line that opens
 * to its roles, placed where its best role sorts; single matches stay plain rows.
 */
function buildItems(
	rows: InboxRow[],
	grouped: boolean,
	expanded: Set<string>,
): Item[] {
	if (!grouped) return rows.map((row) => ({ kind: "row", row, group: null }));
	const byCompany = new Map<string, InboxRow[]>();
	for (const row of rows) {
		if (!groupable(row)) continue;
		const key = companyOf(row);
		byCompany.set(key, [...(byCompany.get(key) ?? []), row]);
	}
	const items: Item[] = [];
	const placed = new Set<string>();
	for (const row of rows) {
		const key = companyOf(row);
		const members = groupable(row) ? (byCompany.get(key) ?? [row]) : [row];
		if (members.length < 2) {
			items.push({ kind: "row", row, group: null });
			continue;
		}
		if (placed.has(key)) continue;
		placed.add(key);
		const scores = members
			.map((m) => m.score)
			.filter((s): s is number => s !== null);
		const open = expanded.has(key);
		items.push({
			kind: "group",
			key,
			name: row.companyName,
			companyId: row.companyId,
			rows: members,
			best: scores.length ? Math.max(...scores) : null,
			open,
		});
		if (open)
			for (const member of members)
				items.push({ kind: "row", row: member, group: key });
	}
	return items;
}

/** The rows an item stands for: a group's roles, or the row itself. */
const rowsOf = (item: Item) => (item.kind === "group" ? item.rows : [item.row]);

/* ------------------------------------------------------------------- page */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep Inbox selection, navigation, and action ordering explicit; splitting state across closures hides dependencies.
export default function InboxPage() {
	const router = useRouter();
	const params = useSearchParams();
	const queryClient = useQueryClient();
	const { id: selectedId } = useParams<{ id?: string }>();
	const counts = useQuery({
		...orpc.dismissals.views.queryOptions(),
		refetchInterval: 5_000,
		refetchOnMount: "always",
	});
	// The view in the link; otherwise the one that needs the user, picked once when the counts
	// arrive and kept (dismissing the last match shows its empty state, not another view).
	const asked = params.get("all") === "1" ? "all" : viewOf(params.get("view"));
	const [picked, setPicked] = useState<ViewKey | null>(null);
	useEffect(() => {
		// Counts read now, not the ones prefetched before the last scan.
		if (picked || asked || !counts.data || !counts.isFetchedAfterMount) return;
		setPicked(
			counts.data.matches > 0
				? "matches"
				: counts.data.review > 0
					? "review"
					: "all",
		);
	}, [picked, asked, counts.data, counts.isFetchedAfterMount]);
	// A deep link to one application (the tray, a notification) opens it in All.
	const view: ViewKey | null = asked ?? (selectedId ? "all" : picked);
	const groupKey = params.get("company");
	const open = (id: string | null, key: ViewKey | null = view) =>
		router.replace(
			id
				? `/applications/${id}?view=${key ?? "all"}`
				: `/inbox?view=${key ?? "all"}`,
		);
	const openGroup = (key: string) =>
		router.replace(
			`/inbox?view=${view ?? "matches"}&company=${encodeURIComponent(key)}`,
		);

	const [search, setSearch] = useState("");
	// Per view: matches sort by fit, the rest newest first, unless the user picks otherwise.
	const [orders, setOrders] = useStoredState<Record<string, string>>(
		"offerfinch.inbox.orders",
		{},
	);
	const order =
		orders[view ?? "all"] ?? (view === "matches" ? "fit" : "recent");
	const setOrder = (value: string) =>
		setOrders({ ...orders, [view ?? "all"]: value });
	const minScore = order === "fit85" ? 85 : order === "fit75" ? 75 : undefined;
	const sort: "recent" | "fit" = order === "recent" ? "recent" : "fit";
	const profile = useQuery({
		...orpc.profile.get.queryOptions(),
		retry: false,
		meta: { quiet: true },
	});
	const pageSize = view === "matches" ? MATCHES_PAGE : PAGE;
	const input = {
		view: view ?? "all",
		search: search || undefined,
		minScore,
		sort,
		// Jobs added by link show at once, while they are read, checked and scored.
		includeAdded: view === "matches" || view === "all",
	};
	const list = useInfiniteQuery({
		queryKey: ["inbox", "page", input],
		queryFn: ({ pageParam }) =>
			client.inbox.page({ ...input, offset: pageParam, limit: pageSize }),
		initialPageParam: 0,
		enabled: view !== null,
		getNextPageParam: (last, all) =>
			last.length < pageSize ? undefined : all.length * pageSize,
		placeholderData: keepPreviousData,
		// Live while a job added by link is being read, checked or scored.
		refetchInterval: (q) =>
			q.state.data?.pages.some((page) =>
				page.some((r) => {
					const step = addedStep(r);
					return step !== null && step !== "failed";
				}),
			)
				? 1_000
				: 5_000,
	});
	// Set aside or prepared from here: gone at once, before the list reloads.
	const [gone, setGone] = useState<Set<string>>(new Set());
	const rows = useMemo(
		() => (list.data?.pages.flat() ?? []).filter((r) => !gone.has(r.id)),
		[list.data, gone],
	);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const items = useMemo(
		() => buildItems(rows, view === "matches", expanded),
		[rows, view, expanded],
	);
	const toggleGroup = (key: string, to?: boolean) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (to ?? !next.has(key)) next.add(key);
			else next.delete(key);
			return next;
		});
	// Open the company of the selected row (a link, or a role chosen in its summary), once per
	// selection: the user may close it again.
	const selectedRow = rows.find((r) => r.id === selectedId);
	const selectedCompany = selectedRow ? companyOf(selectedRow) : null;
	const [openedFor, setOpenedFor] = useState<string | null>(null);
	if (selectedId && selectedCompany && openedFor !== selectedId) {
		setOpenedFor(selectedId);
		if (
			view === "matches" &&
			!expanded.has(selectedCompany) &&
			rows.filter((r) => groupable(r) && companyOf(r) === selectedCompany)
				.length > 1
		)
			setExpanded(new Set(expanded).add(selectedCompany));
	}

	// Several rows chosen with ⌘ or ⇧ click.
	const [multi, setMulti] = useState<string[]>([]);
	const anchor = useRef<string | null>(null);
	const [viewFor, setViewFor] = useState(view);
	if (viewFor !== view) {
		setViewFor(view);
		setMulti([]);
		setGone(new Set());
	}
	const multiRows = rows.filter((r) => multi.includes(r.id));
	const group =
		multiRows.length < 2 && groupKey && !selectedId
			? items.find(
					(i): i is Extract<Item, { kind: "group" }> =>
						i.kind === "group" && i.key === groupKey,
				)
			: undefined;
	const current =
		multiRows.length >= 2
			? null
			: group
				? itemId(group)
				: selectedId
					? `row-${selectedId}`
					: null;

	/** What Not interested acts on now: the selection, the company, or the one match. */
	const target: DismissTarget | null = (() => {
		const of = (list: InboxRow[], label: string): DismissTarget | null => {
			const open = list.filter(isOpenMatch);
			if (open.length === 0) return null;
			const companies = new Set(open.map(companyOf));
			const first = open[0];
			return {
				ids: open.map((r) => r.id),
				company:
					companies.size === 1 && first
						? { id: first.companyId, name: first.companyName }
						: null,
				label,
			};
		};
		if (multiRows.length >= 2)
			return of(multiRows, `${multiRows.filter(isOpenMatch).length} matches`);
		if (group)
			return of(
				group.rows,
				`${group.rows.filter(isOpenMatch).length} roles at ${group.name}`,
			);
		if (selectedRow) return of([selectedRow], selectedRow.title);
		return null;
	})();
	const [dismissOpen, setDismissOpen] = useState(false);
	// A new selection closes the popover: it belongs to what was selected.
	const selectionKey = `${current}|${multi.join(",")}`;
	const [dismissFor, setDismissFor] = useState(selectionKey);
	if (dismissFor !== selectionKey) {
		setDismissFor(selectionKey);
		if (dismissOpen) setDismissOpen(false);
	}

	/** The line to select after `ids` leave the list: the next one, else the one before. */
	const nextAfter = (ids: string[]): Item | null => {
		const leaving = new Set(ids);
		const stays = (item: Item) => rowsOf(item).some((r) => !leaving.has(r.id));
		const at = items.findIndex((item) =>
			rowsOf(item).some((r) => leaving.has(r.id)),
		);
		if (at < 0) return null;
		const after = items.slice(at + 1).find(stays);
		if (after) return after;
		return [...items.slice(0, at)].reverse().find(stays) ?? null;
	};
	const select = (item: Item | null) => {
		setMulti([]);
		if (!item) open(null);
		else if (item.kind === "group") openGroup(item.key);
		else open(item.row.id);
	};
	const leave = (ids: string[]) => {
		const next = nextAfter(ids);
		setGone((prev) => new Set([...prev, ...ids]));
		select(next);
	};

	const dismiss = useDismiss({
		onDismissed: (result) =>
			leave([...result.dismissed, ...result.autoDismissed]),
		onUndone: (ids) =>
			setGone((prev) => new Set([...prev].filter((id) => !ids.includes(id)))),
	});

	const prepare = async (row: InboxRow) => {
		try {
			await client.application.prepare({ id: row.id });
			toast.success(`Drafting ${row.title}. It moves to Drafting.`);
			leave([row.id]);
			void queryClient.invalidateQueries({ queryKey: ["inbox"] });
			void queryClient.invalidateQueries({ queryKey: orpc.dismissals.key() });
		} catch (error) {
			prepareRefused(queryClient, error);
		}
	};

	/** The user disagrees with the job filter: back to Matches, never set aside again. */
	const showInMatches = async (row: InboxRow) => {
		try {
			const { state } = await client.dismissals.showInMatches({ id: row.id });
			toast.success(
				state === "scored"
					? `${row.title} is back in Matches. Your job search won't set it aside again.`
					: `${row.title} is being scored, then listed in Matches. Your job search won't set it aside again.`,
			);
			leave([row.id]);
			void queryClient.invalidateQueries({ queryKey: ["inbox"] });
			void queryClient.invalidateQueries({ queryKey: orpc.dismissals.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
		} catch (error) {
			toast.error((error as Error).message);
		}
	};

	const { seen, mark } = useSeen();
	useEffect(() => {
		if (selectedId) mark(selectedId);
	}, [selectedId, mark]);

	const [slot, setSlot] = useState<HTMLElement | null>(null);
	const [rejectRequest, setRejectRequest] = useState(0);
	const filtered = Boolean(search || minScore !== undefined);
	const count = (key: ViewKey) => counts.data?.[key] ?? 0;
	const meta = view ? VIEWS[view] : null;

	const notInterested = (label?: string) => (
		<NotInterested
			target={target}
			open={dismissOpen}
			onOpenChange={setDismissOpen}
			dismiss={dismiss}
			label={label}
			returnFocus={() =>
				document.querySelector<HTMLElement>("[data-testid=inbox-scroll]")
			}
		/>
	);
	return (
		<ToolbarSlot.Provider value={slot}>
			<PageHeader
				title="Inbox"
				subtitle={
					counts.data
						? `${count("matches")} to decide · ${count("review")} to review`
						: undefined
				}
			>
				<SearchButton />
				<Button
					size="icon-sm"
					variant="ghost"
					onClick={() => sendCommand("add-job")}
					aria-label="Add job from link"
					title={`Add job from link (${keyHint("add-job")})`}
					data-testid="add-job-button"
				>
					<Plus />
				</Button>
				<ScanButton compact />
				<div ref={setSlot} className="flex items-center gap-1" />
			</PageHeader>
			{profile.isSuccess && profile.data === null && (
				<div className="border-border border-b px-5 py-3">
					<Notice
						tone="warning"
						data-testid="onboarding-prompt"
						actions={
							<Link
								href="/onboarding"
								className="text-primary text-sm hover:underline"
							>
								Set up your profile
							</Link>
						}
					>
						No profile yet: jobs cannot be scored or prepared without one.
					</Notice>
				</div>
			)}
			<MasterDetail
				list={
					<>
						<div className="flex shrink-0 flex-col gap-2 px-3 pt-3 pb-2">
							<ViewSwitch
								view={view}
								count={count}
								onChange={(key) => {
									setPicked(key);
									open(null, key);
								}}
							/>
							{meta ? (
								<p
									className="text-muted-foreground px-1 text-xs"
									data-testid="inbox-hint"
								>
									{meta.hint}
								</p>
							) : null}
							<div className="flex items-center gap-2">
								<SearchField
									label="Search title or company"
									placeholder="Filter"
									value={search}
									onChange={setSearch}
									className="w-auto min-w-0 flex-1"
								/>
								<FilterSelect
									label="Order and fit"
									testId="inbox-order"
									value={order}
									onChange={(v) => setOrder(v || "recent")}
									options={[
										{ value: "recent", label: "Newest" },
										{ value: "fit", label: "Best fit" },
										{ value: "fit75", label: "Fit 75+" },
										{ value: "fit85", label: "Fit 85+" },
									]}
								/>
							</div>
						</div>
						<InboxList
							items={items}
							current={current}
							multi={multi}
							seen={seen}
							onToggle={toggleGroup}
							onSelect={
								// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep Inbox selection, navigation, and action ordering explicit; splitting state across closures hides dependencies.
								(item, event) => {
									const ids = rowsOf(item).map((r) => r.id);
									if (event?.metaKey) {
										const base =
											multi.length > 0
												? multi
												: selectedId
													? [selectedId]
													: group
														? group.rows.map((r) => r.id)
														: [];
										const on = ids.every((id) => base.includes(id));
										setMulti(
											on
												? base.filter((id) => !ids.includes(id))
												: [...new Set([...base, ...ids])],
										);
										return;
									}
									if (event?.shiftKey && anchor.current) {
										const from = items.findIndex(
											(i) => itemId(i) === anchor.current,
										);
										const to = items.indexOf(item);
										if (from >= 0 && to >= 0) {
											const [a, b] = from < to ? [from, to] : [to, from];
											setMulti([
												...new Set(
													items
														.slice(a, b + 1)
														.flatMap(rowsOf)
														.map((r) => r.id),
												),
											]);
											return;
										}
									}
									anchor.current = itemId(item);
									if (item.kind === "group" && event)
										toggleGroup(item.key, true);
									select(item);
								}
							}
							onPrepare={(row) => void prepare(row)}
							onShowInMatches={(row) => void showInMatches(row)}
							onDismiss={() => {
								if (target) setDismissOpen(true);
							}}
							onReject={(id) => {
								open(id);
								setRejectRequest((n) => n + 1);
							}}
							fetchMore={() => {
								if (list.hasNextPage && !list.isFetchingNextPage)
									void list.fetchNextPage();
							}}
							loading={view === null || list.isLoading}
							error={list.isError ? list.error.message : null}
							empty={
								filtered ? (
									<EmptyState title="Nothing matches this filter">
										<div className="mt-3">
											<Button
												size="sm"
												variant="outline"
												onClick={() => {
													setSearch("");
													setOrder(view === "matches" ? "fit" : "recent");
												}}
											>
												Clear filters
											</Button>
										</div>
									</EmptyState>
								) : (
									<EmptyState
										title={meta?.emptyTitle ?? "Nothing here"}
										data-testid="inbox-empty"
									>
										{meta?.empty}
										{view === "review" && count("drafting") > 0 ? (
											<span className="mt-2 block">
												{count("drafting")} still drafting:{" "}
												<Link
													href="/inbox?view=drafting"
													className="text-primary hover:underline"
												>
													see Drafting
												</Link>
												.
											</span>
										) : null}
									</EmptyState>
								)
							}
						/>
					</>
				}
			>
				<div className="flex min-h-0 min-w-0 flex-1">
					{multiRows.length >= 2 ? (
						<SelectionSummary
							rows={multiRows}
							onOpen={(id) => {
								setMulti([]);
								open(id);
							}}
							action={notInterested}
							matchIds={target?.ids ?? []}
							onPrepared={leave}
						/>
					) : group ? (
						<CompanySummary
							key={group.key}
							name={group.name}
							rows={group.rows}
							best={group.best}
							onOpen={(id) => {
								toggleGroup(group.key, true);
								open(id);
							}}
							action={notInterested("Not interested in all")}
						/>
					) : selectedId ? (
						<ApplicationDetail
							key={selectedId}
							id={selectedId}
							listState={selectedRow?.state}
							rejectRequest={rejectRequest}
							matchActions={
								selectedRow && isOpenMatch(selectedRow)
									? notInterested()
									: undefined
							}
							setAsideActions={
								selectedRow?.state === "rejected_by_filter" ? (
									<Button
										size="sm"
										variant="outline"
										onClick={() => void showInMatches(selectedRow)}
										data-testid="show-in-matches"
										title="Your job search set this aside. Show it in Matches, and never set it aside again."
									>
										Show in Matches
									</Button>
								) : undefined
							}
						/>
					) : (
						<div className="flex flex-1 items-center justify-center">
							<EmptyState icon={<InboxIcon />} title="Nothing selected">
								{items.length > 0 ? (
									view === "matches" ? (
										<span>
											Choose a match in the list, or press <Kbd>↓</Kbd> there.
											Then <Kbd>P</Kbd> prepares it and <Kbd>X</Kbd> sets it
											aside.
										</span>
									) : (
										"Choose one in the list, or press ↓ there."
									)
								) : (
									meta?.hint
								)}
							</EmptyState>
						</div>
					)}
				</div>
			</MasterDetail>
		</ToolbarSlot.Provider>
	);
}

/**
 * The pipeline in its order: the steps that need the user as segments with their counts
 * (Matches, Drafting, To review), then the later ones in a quieter row (Approved, Closed, All).
 */
function ViewSwitch({
	view,
	count,
	onChange,
}: {
	view: ViewKey | null;
	count: (key: ViewKey) => number;
	onChange: (key: ViewKey) => void;
}) {
	const row = (keys: ViewKey[], label: string, quiet: boolean) => (
		<Tabs
			value={view !== null && keys.includes(view) ? view : null}
			onValueChange={(v) => onChange(v as ViewKey)}
		>
			<TabsList
				size="sm"
				aria-label={label}
				className={cn("w-full", quiet && "bg-transparent shadow-none")}
			>
				{keys.map((key) => (
					<TabsTrigger
						key={key}
						value={key}
						className="min-w-0 flex-1"
						data-testid={`inbox-view-${key}`}
					>
						<span className="truncate">{VIEWS[key].label}</span>
						<span className="text-muted-foreground tabular-nums">
							{count(key)}
						</span>
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
	return (
		<div className="flex flex-col gap-1">
			{row(STEPS, "Inbox view", false)}
			{row(LATER, "Later steps", true)}
		</div>
	);
}

/**
 * The list: virtualized, Mail-style selection. ↑ ↓ (or J K) move, Home and End jump, → and ←
 * open and close a company, ↩ moves focus into the application. P prepares the selected match
 * and X (or Delete) sets it aside; no key approves anything.
 */
function InboxList({
	items,
	current,
	multi,
	seen,
	onSelect,
	onToggle,
	onPrepare,
	onShowInMatches,
	onDismiss,
	onReject,
	fetchMore,
	loading,
	error,
	empty,
}: {
	items: Item[];
	current: string | null;
	multi: string[];
	seen: Set<string>;
	onSelect: (item: Item, event?: React.MouseEvent) => void;
	onToggle: (key: string, open?: boolean) => void;
	onPrepare: (row: InboxRow) => void;
	onShowInMatches: (row: InboxRow) => void;
	onDismiss: () => void;
	onReject: (id: string) => void;
	fetchMore: () => void;
	loading: boolean;
	error: string | null;
	empty: ReactNode;
}) {
	const router = useRouter();
	const scrollRef = useRef<HTMLDivElement>(null);
	const [focused, setFocused] = useState(false);
	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => 84,
		// Heights by line, not position: rows are added at the top and grow (a failed read's
		// actions, an opened company), so a size kept by index would overlap the next line.
		getItemKey: (i) => {
			const item = items[i];
			return item ? itemId(item) : i;
		},
		overscan: 8,
	});
	const visible = virtualizer.getVirtualItems();
	const lastIndex = visible.at(-1)?.index ?? 0;
	const rowCount = items.length;
	useEffect(() => {
		if (rowCount && lastIndex >= rowCount - 20) fetchMore();
	}, [lastIndex, rowCount, fetchMore]);
	const index = items.findIndex((item) => itemId(item) === current);
	useEffect(() => {
		if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
	}, [index, virtualizer]);
	const at = items[index];

	const move = (to: number) => {
		const item = items[Math.max(0, Math.min(items.length - 1, to))];
		if (item) onSelect(item);
	};
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep Inbox selection, navigation, and action ordering explicit; splitting state across closures hides dependencies.
	const onKeyDown = (event: React.KeyboardEvent) => {
		// Keys from shared/shortcuts.ts; none with ⌘, ⌥ or ⌃, which belong to the menu bar.
		const is = (id: ShortcutId) => matches(event, id);
		if (is("inbox-next")) move(index < 0 ? 0 : index + 1);
		else if (is("inbox-previous")) move(index < 0 ? 0 : index - 1);
		else if (is("inbox-first")) move(0);
		else if (is("inbox-last")) move(items.length - 1);
		else if (is("inbox-expand") && at?.kind === "group" && !at.open)
			onToggle(at.key, true);
		else if (is("inbox-collapse") && at?.kind === "group" && at.open)
			onToggle(at.key, false);
		else if (is("inbox-collapse") && at?.kind === "row" && at.group) {
			const parent = items.find(
				(i) => i.kind === "group" && i.key === at.group,
			);
			if (parent) onSelect(parent);
		} else if (is("inbox-enter") && at?.kind === "group") onToggle(at.key);
		else if (is("inbox-enter") && at)
			document.getElementById("application-detail")?.focus();
		else if (is("inbox-prepare")) {
			// One match at a time, never a selection of several, and never on a held key.
			if (event.repeat || multi.length > 1) return;
			if (at?.kind === "row" && isOpenMatch(at.row)) onPrepare(at.row);
		} else if (is("inbox-dismiss")) {
			if (event.repeat) return;
			onDismiss();
		} else return;
		event.preventDefault();
	};
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep Inbox selection, navigation, and action ordering explicit; splitting state across closures hides dependencies.
	const onContextMenu = async (event: React.MouseEvent, item: Item) => {
		event.preventDefault();
		const inSelection =
			item.kind === "row" && multi.length > 1 && multi.includes(item.row.id);
		if (!inSelection) onSelect(item);
		if (item.kind === "group" || inSelection) {
			const open = rowsOf(item).some(isOpenMatch);
			const choice = await desktop.contextMenu([
				{
					id: "dismiss",
					label:
						item.kind === "group"
							? `Not Interested in All at ${item.name}…`
							: `Not Interested in ${multi.length}…`,
					enabled: open || inSelection,
				},
			]);
			if (choice === "dismiss") onDismiss();
			return;
		}
		const row = item.row;
		const choice = await desktop.contextMenu([
			{ id: "open-posting", label: "Open Posting" },
			{ id: "copy-link", label: "Copy Posting Link" },
			...(isOpenMatch(row)
				? [
						{ id: "separator" as const },
						{ id: "prepare" as const, label: "Prepare" },
						{ id: "dismiss" as const, label: "Not Interested…" },
					]
				: []),
			...(row.state === "rejected_by_filter"
				? [
						{ id: "separator" as const },
						{ id: "show-in-matches" as const, label: "Show in Matches" },
					]
				: []),
			...(row.state === "needs_answers" || row.openQuestions > 0
				? [
						{ id: "separator" as const },
						{ id: "answer" as const, label: "Answer Questions" },
					]
				: []),
			...(row.state === "ready_for_review"
				? [
						{ id: "separator" as const },
						{ id: "reject" as const, label: "Reject…" },
					]
				: []),
		]);
		if (choice === "open-posting")
			desktop.openExternal(row.url).catch((e: Error) => toast.error(e.message));
		else if (choice === "copy-link") {
			await desktop.copyText(row.url);
			toast.success("Posting link copied.");
		} else if (choice === "answer") router.push("/questions");
		else if (choice === "reject") onReject(row.id);
		else if (choice === "prepare") onPrepare(row);
		else if (choice === "show-in-matches") onShowInMatches(row);
		// After the menu closes, so the popover opens on the toolbar's button.
		else if (choice === "dismiss") requestAnimationFrame(onDismiss);
	};

	if (error)
		return (
			<div className="px-4 py-3">
				<ErrorLine>
					Could not load the inbox: {error}. It retries every few seconds.
				</ErrorLine>
			</div>
		);
	if (loading) return <ListRowsSkeleton rows={8} />;
	if (items.length === 0) return <div className="min-h-0 flex-1">{empty}</div>;
	return (
		<div
			ref={scrollRef}
			role="listbox"
			data-focus="self"
			aria-label="Applications"
			aria-multiselectable
			aria-activedescendant={current ?? undefined}
			tabIndex={0}
			onKeyDown={onKeyDown}
			onFocus={() => setFocused(true)}
			onBlur={() => setFocused(false)}
			className="min-h-0 flex-1 overflow-auto px-2 pb-2 outline-none"
			data-testid="inbox-scroll"
		>
			<div
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{visible.map((v) => {
					const item = items[v.index];
					if (!item) return null;
					const id = itemId(item);
					const selected =
						id === current ||
						(multi.length > 1 &&
							rowsOf(item).every((r) => multi.includes(r.id)));
					return (
						<div
							key={id}
							ref={virtualizer.measureElement}
							data-index={v.index}
							className="absolute top-0 left-0 w-full"
							style={{ transform: `translateY(${v.start}px)` }}
						>
							{item.kind === "group" ? (
								<GroupLine
									item={item}
									selected={selected}
									focused={focused}
									onSelect={(e) => onSelect(item, e)}
									onToggle={() => onToggle(item.key)}
									onContextMenu={(e) => void onContextMenu(e, item)}
								/>
							) : (
								<RowLine
									row={item.row}
									child={item.group !== null}
									selected={selected}
									focused={focused}
									unread={
										item.row.state === "ready_for_review" &&
										!seen.has(item.row.id)
									}
									onSelect={(e) => onSelect(item, e)}
									onContextMenu={(e) => void onContextMenu(e, item)}
								/>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** A company with several matches: its name, how many roles, the best fit; opens in place. */
function GroupLine({
	item,
	selected,
	focused,
	onSelect,
	onToggle,
	onContextMenu,
}: {
	item: Extract<Item, { kind: "group" }>;
	selected: boolean;
	focused: boolean;
	onSelect: (event: React.MouseEvent) => void;
	onToggle: () => void;
	onContextMenu: (event: React.MouseEvent) => void;
}) {
	return (
		<ListRow
			id={itemId(item)}
			selected={selected}
			focused={focused}
			onSelect={onSelect}
			onContextMenu={onContextMenu}
			aria-expanded={item.open}
			data-testid="inbox-group"
			data-company={item.name}
			title={
				<span className="flex min-w-0 items-center gap-1">
					<button
						type="button"
						tabIndex={-1}
						aria-label={item.open ? "Close the company" : "Open the company"}
						onMouseDown={(e) => {
							// The chevron only opens or closes; the rest of the line selects.
							e.preventDefault();
							e.stopPropagation();
							onToggle();
						}}
						className="text-muted-foreground hover:text-foreground -ml-1 grid size-4 shrink-0 place-items-center rounded-sm"
						data-testid="inbox-group-toggle"
					>
						<ChevronRight
							className={cn(
								"ease-standard size-3.5 transition-transform duration-150",
								item.open && "rotate-90",
							)}
						/>
					</button>
					<span className="truncate">{item.name}</span>
				</span>
			}
			subtitle={`${item.rows.length} roles`}
			meta={
				<>
					<Fit value={item.best} />
					<span className="text-muted-foreground truncate">best fit</span>
				</>
			}
		/>
	);
}

function RowLine({
	row,
	child,
	selected,
	focused,
	unread,
	onSelect,
	onContextMenu,
}: {
	row: InboxRow;
	/** A role under its company: the title leads, the place under it. */
	child: boolean;
	selected: boolean;
	focused: boolean;
	unread: boolean;
	onSelect: (event: React.MouseEvent) => void;
	onContextMenu: (event: React.MouseEvent) => void;
}) {
	const status = rowStatus(row);
	const step = addedStep(row);
	const reading = step !== null && step !== "checking" && step !== "scoring";
	// Set aside by the job filter: its reason under the company, the role on the meta line.
	const setAside = row.state === "rejected_by_filter" && !child;
	return (
		<div className={child ? "pl-4" : undefined}>
			<ListRow
				id={`row-${row.id}`}
				selected={selected}
				focused={focused}
				unread={unread}
				onSelect={onSelect}
				onContextMenu={onContextMenu}
				data-testid="inbox-row"
				data-state={row.state}
				data-step={step ?? undefined}
				data-child={child ? "" : undefined}
				title={
					child ? row.title : reading ? linkHost(row.url) : row.companyName
				}
				time={when(row.stateChangedAt)}
				subtitle={
					child
						? row.locations.slice(0, 2).join(" · ") || "Location not given"
						: setAside
							? setAsideText(row)
							: row.title
				}
				meta={
					step === "failed" ? (
						<div className="flex w-full min-w-0 flex-col items-start gap-1.5">
							<span className="text-warning w-full truncate">
								{status.text}
							</span>
							<AddedActions
								job={{
									applicationId: row.id,
									url: row.url,
									title: row.title,
								}}
							/>
						</div>
					) : (
						<>
							{step ? null : <Fit value={row.score} />}
							{setAside ? (
								<span
									className="text-muted-foreground truncate"
									data-testid="set-aside-title"
								>
									{row.title}
								</span>
							) : (
								<span
									className={
										status.tone === "warning"
											? "text-warning truncate"
											: status.tone === "muted"
												? "text-muted-foreground truncate"
												: "text-foreground truncate"
									}
								>
									{status.text}
								</span>
							)}
						</>
					)
				}
			/>
		</div>
	);
}
