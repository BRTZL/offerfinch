import {
	keepPreviousData,
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	ChevronRight,
	Inbox as InboxIcon,
	ListFilter,
	Plus,
} from "lucide-react";
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { useDemoMode } from "@/components/desktop/demo";
import {
	AddedActions,
	addedStep,
	linkHost,
	STEP_LABEL,
} from "@/components/pipeline/added";
import { ApplicationDetail } from "@/components/pipeline/application/detail";
import { prepareRefused } from "@/components/pipeline/application/use-application-actions";
import { FilterSelect } from "@/components/pipeline/filter-select";
import {
	inboxStatus,
	lineAfter,
	rowToOpen,
} from "@/components/pipeline/inbox-status";
import {
	CompanySummary,
	SelectionSummary,
} from "@/components/pipeline/inbox-summary";
import {
	type DismissTarget,
	NotInterested,
	useDismiss,
} from "@/components/pipeline/not-interested";
import {
	EmptyState,
	ErrorLine,
	Fit,
	Kbd,
	Notice,
	StatusChip,
} from "@/components/system/bits";
import { PageHeader } from "@/components/system/layout";
import { ListRow, ListRowsSkeleton } from "@/components/system/list";
import { MasterDetail } from "@/components/system/master-detail";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { sendCommand } from "@/lib/commands";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { createReadState } from "@/lib/read-state";
import { Link, useParams, useRouter, useSearchParams } from "@/lib/router";
import { useStoredState } from "@/lib/use-stored-state";
import { cn } from "@/lib/utils";
import { primaryModifier } from "../../shared/platform";
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
 * The status menu's filters, in the order the work flows: decide on matches, drafts are written,
 * review and approve, then applied or closed. All (the default) is one list of everything.
 */
const VIEWS: Record<
	ViewKey,
	{ label: string; emptyTitle: string; empty: string }
> = {
	all: {
		label: "All",
		emptyTitle: "No jobs yet",
		empty:
			"Every hour OfferFinch searches your sources; jobs that reach your minimum fit land here.",
	},
	matches: {
		label: "Matches",
		emptyTitle: "No matches to decide on",
		empty:
			"Jobs that fit your search land here after each scan. Press Interested to draft its CV, letter and answers, or set it aside with Not interested.",
	},
	drafting: {
		label: "Drafting",
		emptyTitle: "Nothing being drafted",
		empty:
			"Press Interested on a match to draft its CV, letter and answers. A draft that needs your answers waits here.",
	},
	review: {
		label: "To review",
		emptyTitle: "Nothing to review",
		empty:
			"A job lands here once its CV, letter and answers are drafted and checked.",
	},
	approved: {
		label: "Approved",
		emptyTitle: "Nothing approved is waiting",
		empty: "Applications you approve wait here until they are submitted.",
	},
	closed: {
		label: "Closed",
		emptyTitle: "Nothing closed yet",
		empty:
			"Applied jobs, the ones you rejected or were not interested in, those that expired and postings that closed end up here.",
	},
};
const STATUS_ORDER: ViewKey[] = [
	"all",
	"matches",
	"drafting",
	"review",
	"approved",
	"closed",
];
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

/**
 * The row's chip, and a note beside it when something needs saying (questions to answer, a link
 * still being read, added by you); otherwise where the job is.
 */
function rowStatus(row: InboxRow): {
	chip: ReturnType<typeof inboxStatus>;
	note: string;
	tone?: "warning" | "muted";
} {
	const chip = inboxStatus(row);
	const step = addedStep(row);
	if (step === "failed")
		return {
			chip,
			note: `Couldn't read: ${row.readError ?? "the page could not be read"}`,
			tone: "warning",
		};
	if (step) return { chip, note: STEP_LABEL[step], tone: "muted" };
	if (row.openQuestions > 0)
		return {
			chip,
			note: `${row.openQuestions} question${row.openQuestions === 1 ? "" : "s"} to answer`,
			tone: "warning",
		};
	if (row.source === "manual" && ["found", "scored"].includes(row.state))
		return {
			chip,
			note:
				row.filterDecision === "reject"
					? "Added by you · outside your search"
					: "Added by you",
			tone: "muted",
		};
	return {
		chip,
		note: row.locations.slice(0, 2).join(" · "),
		tone: "muted",
	};
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

/** Not interested's target for some rows: their open matches, and the one company they share. */
function dismissTargetOf(
	list: InboxRow[],
	label: string,
): DismissTarget | null {
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
}

/* ------------------------------------------------------------------- page */

/** Rows leave with a short fade before the list closes the gap (and slides the rest up). */
const LEAVE_MS = 180;

/**
 * Read state (the unread dot): kept in localStorage, a row read as soon as it opens. A layout
 * effect marks it before paint, so the dot and the selected line never show together. One
 * store for the window; `version` re-renders the list when a row turns read.
 */
function useReadState(selectedId: string | undefined, several: boolean) {
	const [state] = useState(() => createReadState(localStorage));
	const [, setVersion] = useState(0);
	useLayoutEffect(() => {
		// Several rows chosen: none is being read.
		if (!selectedId || several || !state.markRead(selectedId)) return;
		setVersion((v) => v + 1);
	}, [selectedId, several, state]);
	return state;
}

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
	// One list of everything unless the status menu (or a link) asks for one status.
	const view: ViewKey =
		params.get("all") === "1" ? "all" : (viewOf(params.get("view")) ?? "all");
	const groupKey = params.get("company");
	const open = (id: string | null, key: ViewKey = view) =>
		router.replace(
			id ? `/applications/${id}?view=${key}` : `/inbox?view=${key}`,
		);
	const openGroup = (key: string) =>
		router.replace(`/inbox?view=${view}&company=${encodeURIComponent(key)}`);

	// Best fit first, as the user decides by fit; kept per status when the user picks another.
	const [orders, setOrders] = useStoredState<Record<string, string>>(
		"offerfinch.inbox.orders",
		{},
	);
	const order = orders[view] ?? "fit";
	const setOrder = (value: string) => setOrders({ ...orders, [view]: value });
	const minScore = order === "fit85" ? 85 : order === "fit75" ? 75 : undefined;
	const sort: "recent" | "fit" = order === "recent" ? "recent" : "fit";
	const profile = useQuery({
		...orpc.profile.get.queryOptions(),
		retry: false,
		meta: { quiet: true },
	});
	const pageSize = view === "matches" ? MATCHES_PAGE : PAGE;
	const input = {
		view,
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
	// Set aside from here: gone at once, before the list reloads.
	const [gone, setGone] = useState<Set<string>>(new Set());
	// Leaving now: faded out for a moment, then gone.
	const [leaving, setLeaving] = useState<Set<string>>(new Set());
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
		setLeaving(new Set());
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

	// Nothing open: the first row opens, so the detail is never empty. Also after a status is
	// picked, once its rows are in (not the last status' rows, shown while they load).
	const firstLine = rowToOpen({
		items,
		selected: Boolean(selectedId || groupKey || multi.length > 0),
		settled: list.isSuccess && !list.isPlaceholderData,
		// A row fading out is gone already: the last one leaving leaves the detail empty.
		leaving: (item) => rowsOf(item).every((r) => leaving.has(r.id)),
	});
	const firstId = firstLine ? itemId(firstLine) : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: Opens the first line when it changes; `firstLine` is the same line by id.
	useEffect(() => {
		if (!firstLine) return;
		if (firstLine.kind === "group") openGroup(firstLine.key);
		else open(firstLine.row.id);
	}, [firstId]);

	/** What Not interested acts on now: the selection, the company, or the one match. */
	const target: DismissTarget | null = (() => {
		const of = dismissTargetOf;
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
	const nextAfter = (ids: string[]): Item | null =>
		lineAfter(items, ids, (item) => rowsOf(item).map((r) => r.id), leaving);
	const select = (item: Item | null) => {
		setMulti([]);
		if (!item) open(null);
		else if (item.kind === "group") openGroup(item.key);
		else open(item.row.id);
	};
	const leave = (ids: string[]) => {
		const next = nextAfter(ids);
		setLeaving((prev) => new Set([...prev, ...ids]));
		window.setTimeout(() => {
			setGone((prev) => new Set([...prev, ...ids]));
			setLeaving(
				(prev) => new Set([...prev].filter((id) => !ids.includes(id))),
			);
		}, LEAVE_MS);
		select(next);
	};

	const dismiss = useDismiss({
		onDismissed: (result) =>
			leave([...result.dismissed, ...result.autoDismissed]),
		onUndone: (ids) =>
			setGone((prev) => new Set([...prev].filter((id) => !ids.includes(id)))),
	});

	/**
	 * Interested (the bar's button, P, the context menu): drafts it, then the next row opens. In
	 * Matches the row leaves (it is drafting now); in the other lists it stays, as Drafting.
	 */
	const interested = async (row: InboxRow) => {
		try {
			await client.application.prepare({ id: row.id });
			toast.success(`Drafting ${row.title}.`);
			if (view === "matches") leave([row.id]);
			else {
				const next = nextAfter([row.id]);
				if (next) select(next);
			}
			void queryClient.invalidateQueries({ queryKey: ["inbox"] });
			void queryClient.invalidateQueries({ queryKey: orpc.dismissals.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
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

	const reads = useReadState(selectedId, multi.length > 1);

	const [rejectRequest, setRejectRequest] = useState(0);
	const filtered = minScore !== undefined;
	const count = (key: ViewKey) => counts.data?.[key] ?? 0;
	const meta = VIEWS[view];

	const notInterested = (label?: string, bar = false) => (
		<NotInterested
			target={target}
			open={dismissOpen}
			onOpenChange={setDismissOpen}
			dismiss={dismiss}
			label={label}
			bar={bar}
			returnFocus={() =>
				document.querySelector<HTMLElement>("[data-testid=inbox-scroll]")
			}
		/>
	);
	return (
		<>
			<PageHeader
				title="Inbox"
				subtitle={
					counts.data
						? `${count("matches")} to decide · ${count("review")} to review`
						: undefined
				}
			>
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
						<div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2">
							<StatusMenu
								view={view}
								count={count}
								onChange={(key) => open(null, key)}
							/>
							<FilterSelect
								label="Sort"
								testId="inbox-order"
								value={order}
								onChange={(v) => setOrder(v || "recent")}
								className="min-w-0"
								options={[
									{ value: "recent", label: "Newest" },
									{ value: "fit", label: "Best fit" },
									{ value: "fit75", label: "Fit 75+" },
									{ value: "fit85", label: "Fit 85+" },
								]}
							/>
						</div>
						<InboxList
							items={items}
							motionKey={`${view}|${order}`}
							leaving={leaving}
							current={current}
							multi={multi}
							isUnread={(row) => reads.isUnread(row)}
							onToggle={toggleGroup}
							onSelect={
								// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep Inbox selection, navigation, and action ordering explicit; splitting state across closures hides dependencies.
								(item, event) => {
									const ids = rowsOf(item).map((r) => r.id);
									if (event && primaryModifier(event)) {
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
							onInterested={(row) => void interested(row)}
							onShowInMatches={(row) => void showInMatches(row)}
							onDismiss={() => {
								if (target) setDismissOpen(true);
							}}
							onDismissNow={(picked, label) => {
								const now = dismissTargetOf(picked, label);
								if (now && !dismiss.isPending)
									dismiss.mutate({
										target: now,
										reasons: [],
										note: "",
										hide: false,
									});
							}}
							onReject={(id) => {
								open(id);
								setRejectRequest((n) => n + 1);
							}}
							fetchMore={() => {
								if (list.hasNextPage && !list.isFetchingNextPage)
									void list.fetchNextPage();
							}}
							loading={list.isLoading}
							error={list.isError ? list.error.message : null}
							empty={
								filtered ? (
									<EmptyState title="Nothing matches this filter">
										<div className="mt-3">
											<Button
												size="sm"
												variant="outline"
												onClick={() => setOrder("fit")}
											>
												Clear filters
											</Button>
										</div>
									</EmptyState>
								) : (
									<EmptyState title={meta.emptyTitle} data-testid="inbox-empty">
										{meta.empty}
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
									? notInterested(undefined, true)
									: undefined
							}
							onInterested={
								selectedRow && isOpenMatch(selectedRow)
									? () => void interested(selectedRow)
									: undefined
							}
							setAsideActions={
								selectedRow?.state === "rejected_by_filter" ? (
									<Button
										size="lg"
										variant="outline"
										className="rounded-xl"
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
									<span>
										Choose one in the list, or press <Kbd>↓</Kbd> there. On a
										match, <Kbd>P</Kbd> is Interested and <Kbd>X</Kbd> Not
										interested.
									</span>
								) : (
									meta.empty
								)}
							</EmptyState>
						</div>
					)}
				</div>
			</MasterDetail>
		</>
	);
}

/** The status filter: All, or one step of the work, each with its count. */
function StatusMenu({
	view,
	count,
	onChange,
}: {
	view: ViewKey;
	count: (key: ViewKey) => number;
	onChange: (key: ViewKey) => void;
}) {
	return (
		<Select
			items={STATUS_ORDER.map((key) => ({
				value: key,
				label: VIEWS[key].label,
			}))}
			value={view}
			onValueChange={(next) => {
				if (next) onChange(next as ViewKey);
			}}
		>
			<SelectTrigger
				size="sm"
				aria-label="Status"
				data-testid="inbox-status"
				className="min-w-0"
			>
				<ListFilter className="text-muted-foreground size-3.5" />
				<SelectValue>
					{(value: ViewKey) => (
						<>
							{VIEWS[value]?.label}
							<span className="text-muted-foreground tabular-nums">
								{count(value)}
							</span>
						</>
					)}
				</SelectValue>
			</SelectTrigger>
			<SelectContent align="start" alignItemWithTrigger={false}>
				{STATUS_ORDER.map((key) => (
					<SelectItem key={key} value={key} data-testid={`inbox-status-${key}`}>
						{VIEWS[key].label}
						<span className="text-muted-foreground ml-auto tabular-nums">
							{count(key)}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * How the list moves when rows come and go: rows new since the last change fade and slide in,
 * and for a moment every row glides to its new place (a virtualized FLIP: the rows sit at
 * `translateY`, so a transition on it is enough). Nothing moves while the list scrolls or a
 * row is selected, and nothing on the first load or a new filter.
 */
function useListMotion(ids: string[], key: string) {
	const known = useRef<{ key: string; ids: Set<string> } | null>(null);
	const timer = useRef<number | undefined>(undefined);
	const [entering, setEntering] = useState<Set<string>>(new Set());
	const [moving, setMoving] = useState(false);
	const joined = ids.join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `joined` stands for `ids`.
	useLayoutEffect(() => {
		const before = known.current;
		const now = new Set(ids);
		known.current = { key, ids: now };
		if (!before || before.key !== key || before.ids.size === 0) return;
		const added = ids.filter((id) => !before.ids.has(id));
		const removed = [...before.ids].some((id) => !now.has(id));
		if (added.length === 0 && !removed) return;
		setEntering(new Set(added));
		setMoving(true);
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => {
			setEntering(new Set());
			setMoving(false);
		}, 320);
	}, [joined, key]);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	return { entering, moving };
}

/**
 * The list: virtualized, Mail-style selection. ↑ ↓ (or J K) move, Home and End jump, → and ←
 * open and close a company, ↩ moves focus into the application. P is Interested on the selected
 * match and X (or Delete) Not interested; no key approves anything.
 */
function InboxList({
	items,
	motionKey,
	leaving,
	current,
	multi,
	isUnread,
	onSelect,
	onToggle,
	onInterested,
	onShowInMatches,
	onDismiss,
	onDismissNow,
	onReject,
	fetchMore,
	loading,
	error,
	empty,
}: {
	items: Item[];
	/** The filter and order: a new one swaps the rows without motion. */
	motionKey: string;
	/** Rows fading out before they leave. */
	leaving: Set<string>;
	current: string | null;
	multi: string[];
	isUnread: (row: InboxRow) => boolean;
	onSelect: (item: Item, event?: React.MouseEvent) => void;
	onToggle: (key: string, open?: boolean) => void;
	onInterested: (row: InboxRow) => void;
	onShowInMatches: (row: InboxRow) => void;
	/** Keyboard X: opens Not interested's form on the selection. */
	onDismiss: () => void;
	/** The context menu's Not Interested: sets these rows aside at once, no form (Undo in the toast). */
	onDismissNow: (rows: InboxRow[], label: string) => void;
	onReject: (id: string) => void;
	fetchMore: () => void;
	loading: boolean;
	error: string | null;
	empty: ReactNode;
}) {
	const router = useRouter();
	// Try-it mode opens no link (the default browser holds the real sessions).
	const demo = useDemoMode();
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
	const { entering, moving } = useListMotion(items.map(itemId), motionKey);
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
			if (at?.kind === "row" && isOpenMatch(at.row)) onInterested(at.row);
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
							? `Not Interested in All at ${item.name}`
							: `Not Interested in ${multi.length}`,
					enabled: open || inSelection,
				},
			]);
			if (choice === "dismiss") {
				const rows =
					item.kind === "group"
						? item.rows
						: [
								// An open company is its line and its rows: each role once.
								...new Map(
									items
										.flatMap(rowsOf)
										.filter((r) => multi.includes(r.id))
										.map((r) => [r.id, r]),
								).values(),
							];
				const openCount = rows.filter(isOpenMatch).length;
				onDismissNow(
					rows,
					item.kind === "group"
						? `${openCount} roles at ${item.name}`
						: `${openCount} matches`,
				);
			}
			return;
		}
		const row = item.row;
		const choice = await desktop.contextMenu([
			...(demo ? [] : [{ id: "open-posting" as const, label: "Open Posting" }]),
			{ id: "copy-link", label: "Copy Posting Link" },
			...(isOpenMatch(row)
				? [
						{ id: "separator" as const },
						{ id: "prepare" as const, label: "Interested" },
						{ id: "dismiss" as const, label: "Not Interested" },
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
						{ id: "reject" as const, label: "Reject" },
					]
				: []),
		]);
		if (choice === "open-posting")
			desktop.openPosting(row.id).catch((e: Error) => toast.error(e.message));
		else if (choice === "copy-link") {
			await desktop.copyText(row.url);
			toast.success("Posting link copied.");
		} else if (choice === "answer") router.push("/questions");
		else if (choice === "reject") onReject(row.id);
		else if (choice === "prepare") onInterested(row);
		else if (choice === "show-in-matches") onShowInMatches(row);
		else if (choice === "dismiss") onDismissNow([row], row.title);
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
					const out = rowsOf(item).every((r) => leaving.has(r.id));
					const selected =
						id === current ||
						(multi.length > 1 &&
							rowsOf(item).every((r) => multi.includes(r.id)));
					return (
						<div
							key={id}
							ref={virtualizer.measureElement}
							data-index={v.index}
							data-leaving={out ? "" : undefined}
							className={cn(
								"absolute top-0 left-0 w-full",
								moving && "ease-standard transition-transform duration-200",
								entering.has(id) &&
									"animate-in fade-in-0 slide-in-from-top-2 duration-200",
								out &&
									"animate-out fade-out-0 slide-out-to-left-4 fill-mode-forwards pointer-events-none duration-200",
							)}
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
									unread={isUnread(item.row)}
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
				data-working={!step && status.chip.tone === "drafting" ? "" : undefined}
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
								{status.note}
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
						<RowMeta
							row={row}
							status={status}
							step={step}
							setAside={setAside}
						/>
					)
				}
			/>
		</div>
	);
}

/** The meta line: the fit, the status chip, and the note (or the place). */
function RowMeta({
	row,
	status,
	step,
	setAside,
}: {
	row: InboxRow;
	status: ReturnType<typeof rowStatus>;
	step: ReturnType<typeof addedStep>;
	setAside: boolean;
}) {
	return (
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
				<>
					{step ? null : (
						<StatusChip
							tone={status.chip.tone}
							data-testid="status-chip"
							data-status={status.chip.bucket ?? undefined}
						>
							{status.chip.label}
						</StatusChip>
					)}
					<span
						className={cn(
							"min-w-0 truncate",
							step ? null : "ml-auto",
							status.tone === "warning"
								? "text-warning"
								: "text-muted-foreground",
						)}
						data-testid="row-note"
					>
						{status.note}
					</span>
				</>
			)}
		</>
	);
}
