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
import { firstSearchLine } from "./first-search-line";
import { FirstSearchList, useShownRows } from "./first-search-list";

/**
 * One search run, live: its progress, the jobs it found and where each stands, polled every
 * second until it is settled. A scan ends before its jobs are scored, so the scan alone never
 * settles it: settled is the scan done, no scoring it started still pending, and a read of the
 * jobs taken after scoring was seen done (the polls tick apart, and the last scores land just
 * before `pending` reaches 0). An errored scan is settled at once.
 */
function useFirstSearch(runId: string | null) {
	const settledRef = useRef(false);
	const poll = () => (settledRef.current ? false : 1_000);
	const progress = useQuery({
		...orpc.desktop.scan.queryOptions({ input: { id: runId ?? "" } }),
		enabled: Boolean(runId),
		refetchInterval: (q) =>
			q.state.data && ["complete", "errored"].includes(q.state.data.status)
				? false
				: 1_000,
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
	const settled =
		p?.status === "errored" ||
		Boolean(
			complete &&
				jobs.data &&
				scoring.data &&
				scoring.data.pending === 0 &&
				jobs.dataUpdatedAt > scoring.dataUpdatedAt,
		);
	settledRef.current = settled;
	return { p, finished, view: jobs.data, settled };
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
	const { p, finished, view, settled: polled } = useFirstSearch(runId);
	useEffect(() => {
		if (finished) void queryClient.invalidateQueries();
	}, [finished, queryClient]);
	const rows = useShownRows(view?.rows ?? []);
	const firstMatch = rows.some((r) => r.shown === "scored" && r.match);
	const cheered = useRef(false);
	useEffect(() => {
		if (firstMatch && !cheered.current) {
			cheered.current = true;
			celebrate();
		}
	}, [firstMatch, celebrate]);
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
	if (!runId)
		return (
			<p className="text-muted-foreground text-sm" data-testid="first-scan">
				It takes a minute or two. You can leave this page; it carries on.
			</p>
		);
	const counts = view?.counts ?? { read: 0, setAside: 0, matches: 0 };
	const checking = rows.some((r) => r.shown === "found");
	// The done line waits for the list's own beats: a new row still held as found, or a set-aside
	// row that has not shown its reason and left. A job the server still has as found (its run
	// never started or stopped) does not hold it.
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
						<span key={line} className="first-search-line">
							{line}
						</span>
					</p>
				</GroupBody>
			</Group>
			<FirstSearchList rows={rows} total={counts.read} />
		</div>
	);
}
