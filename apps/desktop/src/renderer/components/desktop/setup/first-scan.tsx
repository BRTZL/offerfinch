import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStepAction } from "@/components/desktop/step-action";
import { Cells } from "@/components/system/bits";
import { Group, GroupBody } from "@/components/system/layout";
import { SparkleBurst } from "@/components/system/sparkle";
import { client, orpc } from "@/lib/orpc";
import { useCelebrate } from "./celebrate";
import { beingChecked, type ShownRow } from "./first-search-beats";
import {
	firstSearchLine,
	firstSearchSettle,
	POLL_MS,
} from "./first-search-line";
import { FirstSearchList, useShownRows } from "./first-search-list";

/**
 * One search run, live: its progress, the jobs it found and where each stands, read every second
 * until it is settled (`firstSearchSettle`), every few seconds while scoring waits on a paused
 * model.
 */
function useFirstSearch(runId: string | null) {
	const pollRef = useRef<number | false>(POLL_MS);
	const poll = () => pollRef.current;
	const progress = useQuery({
		...orpc.desktop.scan.queryOptions({ input: { id: runId ?? "" } }),
		enabled: Boolean(runId),
		refetchInterval: (q) =>
			q.state.data && ["complete", "errored"].includes(q.state.data.status)
				? false
				: POLL_MS,
	});
	const p = progress.data;
	const complete = p?.status === "complete";
	const finished = complete || p?.status === "errored";
	const jobs = useQuery({
		...orpc.desktop.scanJobs.queryOptions({ input: { id: runId ?? "" } }),
		enabled: Boolean(runId),
		refetchInterval: poll,
	});
	const scoring = useQuery({
		...orpc.desktop.scoring.queryOptions(),
		enabled: complete,
		refetchInterval: poll,
	});
	const state = firstSearchSettle({
		status: p?.status,
		pending: scoring.data?.pending,
		paused: jobs.data?.counts.paused,
		jobsAt: jobs.dataUpdatedAt,
		scoringAt: scoring.dataUpdatedAt,
	});
	pollRef.current = state.pollMs;
	return {
		p,
		finished,
		view: jobs.data,
		settled: state.settled,
		paused: state.paused,
	};
}

/**
 * The chirp and burst, once, on the first match. From the totals, so a match past the rows still
 * cheers; a match among the rows waits until it shows its fit (not during its "Found" beat).
 */
function useFirstMatchCheer(
	matches: number,
	rows: ShownRow[],
	celebrate: () => void,
) {
	const firstMatch =
		matches > 0 &&
		(rows.some((r) => r.shown === "scored" && r.match) ||
			!rows.some((r) => r.match));
	const cheered = useRef(false);
	useEffect(() => {
		if (firstMatch && !cheered.current) {
			cheered.current = true;
			celebrate();
		}
	}, [firstMatch, celebrate]);
}

/**
 * Setup's last step: one search now, live (docs/decisions.md, 2026-11-05). Every job it finds
 * joins the list; the ones that break a rule show the rule and leave; the rest get their fit.
 * The first match chirps once (`useCelebrate`).
 */
export function FirstScan({ onDone }: { onDone: () => void }) {
	const queryClient = useQueryClient();
	const [runId, setRunId] = useState<string | null>(null);
	const { burst, celebrate } = useCelebrate();
	const start = useMutation({
		mutationFn: () => client.desktop.scanNow({}),
		onSuccess: (r) => setRunId(r.id),
		onError: (e) => toast.error(e.message),
	});
	const { p, finished, view, settled: polled, paused } = useFirstSearch(runId);
	useEffect(() => {
		if (finished) void queryClient.invalidateQueries();
	}, [finished, queryClient]);
	const rows = useShownRows(view?.rows ?? []);
	useFirstMatchCheer(view?.counts.matches ?? 0, rows, celebrate);
	useStepAction(
		finished
			? {
					label: "Open the Inbox",
					onClick: onDone,
					testId: "onboarding-finish",
				}
			: runId
				? {
						label: "Start the first search",
						onClick: () => {},
						disabled: true,
						busy: true,
					}
				: {
						label: "Start the first search",
						onClick: () => start.mutate(),
						disabled: start.isPending,
						testId: "first-scan-start",
					},
	);
	if (!runId && !start.isPending)
		return (
			<p className="text-muted-foreground text-sm" data-testid="first-scan">
				It takes a minute or two. You can leave this page; it carries on.
			</p>
		);
	const counts = view?.counts ?? {
		read: 0,
		setAside: 0,
		matches: 0,
		paused: 0,
		failed: 0,
	};
	const checking = rows.some(beingChecked);
	// The done line waits for the list's own beats: a new row still held as found, or a set-aside
	// row that has not shown its reason and left. A job the server still has as found (its run
	// never started, stopped or failed) does not hold it.
	const beating = rows.some(
		(r) =>
			(r.shown === "found" && r.state !== "found") ||
			(r.shown === "rejected_by_filter" && !r.gone),
	);
	const settled = polled && !beating;
	const line = firstSearchLine(p, counts, {
		checking,
		settled,
		fitRules: rows.filter((r) => r.shown === "fits" || r.shown === "scored")
			.length,
		paused: paused
			? { count: counts.paused, reason: view?.pausedFor ?? null }
			: null,
	});
	const done = settled && p?.status === "complete";
	return (
		<div
			className="first-search relative flex flex-col gap-3"
			data-testid="first-scan"
		>
			<SparkleBurst burst={burst} />
			<Group>
				<GroupBody className="flex items-center gap-3">
					{p?.total ? (
						<Cells
							total={p.total}
							on={finished ? p.total : p.done}
							tone={done ? "brand" : "ink"}
							label={`${finished ? p.total : p.done} of ${p.total} ${p.unit} read`}
						/>
					) : !settled ? (
						<LoaderCircle
							className="text-muted-foreground size-4 shrink-0 animate-spin"
							aria-hidden
						/>
					) : null}
					<p
						role="status"
						aria-live="polite"
						data-testid="first-scan-progress"
						data-matches={counts.matches}
						data-settled={settled || undefined}
						className="text-foreground min-w-0 text-sm"
					>
						{/* "Starting…" is there on the first paint, as the button is pressed; the lines
						    after it fade in where the last one was. */}
						<span key={line} className={p ? "first-search-line" : undefined}>
							{line}
						</span>
					</p>
				</GroupBody>
			</Group>
			<FirstSearchList rows={rows} hidden={view?.hidden ?? 0} />
		</div>
	);
}
