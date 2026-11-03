import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStepAction } from "@/components/desktop/step-action";
import { Cells, Fit } from "@/components/system/bits";
import { Group, GroupBody } from "@/components/system/layout";
import { Row } from "@/components/system/rows";
import { SparkleBurst } from "@/components/system/sparkle";
import { client, orpc } from "@/lib/orpc";
import { useCelebrate } from "./celebrate";

type ScanResult = { jobsFetched?: number; jobsInserted?: number };

type Match = {
	id: string;
	company: string;
	title: string;
	score: number | null;
};

/**
 * After the search: the first scored matches, polled until they arrive or the scoring the search
 * started is over (`settled`: no scan running, no new job still being scored, and none matched).
 * A scan ends before its jobs are scored, so the scan alone never settles it.
 */
function useFirstMatches(enabled: boolean): {
	matches: Match[];
	settled: boolean;
} {
	// Polling stops once there is an answer either way.
	const done = useRef(false);
	const poll = () => (done.current ? false : 2_000);
	const scoring = useQuery({
		...orpc.desktop.scoring.queryOptions(),
		enabled,
		refetchInterval: poll,
	});
	const home = useQuery({
		...orpc.desktop.home.queryOptions(),
		enabled,
		refetchInterval: poll,
	});
	const matches: Match[] = home.data?.recent ?? [];
	// Settled only on a Home read taken after scoring was seen done: the two polls tick apart,
	// and the last scores land just before `pending` reaches 0.
	const settled = Boolean(
		home.data &&
			scoring.data &&
			home.data.scan.state !== "scanning" &&
			scoring.data.pending === 0 &&
			home.dataUpdatedAt > scoring.dataUpdatedAt &&
			matches.length === 0,
	);
	done.current = matches.length > 0 || settled;
	return { matches, settled };
}

/** Up to three of the first matches, as Home lists them: fit, company, title. */
function FirstMatches({ matches }: { matches: Match[] }) {
	return (
		<Group data-testid="first-matches">
			{matches.slice(0, 3).map((m) => (
				<Row
					key={m.id}
					data-testid="first-match"
					leading={
						<span className="w-8 text-right">
							<Fit value={m.score} />
						</span>
					}
					title={
						<>
							<span className="font-medium">{m.company}</span>
							<span className="text-muted-foreground">
								{"  "}
								{m.title}
							</span>
						</>
					}
				/>
			))}
		</Group>
	);
}

function progressLine(
	p: { status: string; error?: string | null } | undefined,
	finished: boolean,
	result: ScanResult | null | undefined,
	matches: number,
	settled: boolean,
): string {
	if (!p) return "Starting…";
	if (p.status === "errored") return `The search stopped: ${p.error}`;
	if (!finished) return "Searching for jobs…";
	const read = `${result?.jobsFetched ?? 0} jobs read, ${result?.jobsInserted ?? 0} new.`;
	if (matches > 0)
		return `Done: ${read} Your first ${matches === 1 ? "match is" : `${matches} matches are`} in.`;
	if (settled)
		return `Done: ${read} No matches this time. OfferFinch keeps looking every hour, and new ones show up in the Inbox.`;
	return `Done: ${read} Scoring the new jobs…`;
}

/**
 * Setup's last step: one search now, with progress. When the first matches are scored, the
 * finch chirps once (`useCelebrate`).
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
	const progress = useQuery({
		...orpc.desktop.scan.queryOptions({ input: { id: runId ?? "" } }),
		enabled: Boolean(runId),
		refetchInterval: (q) =>
			q.state.data && ["complete", "errored"].includes(q.state.data.status)
				? false
				: 1_000,
	});
	const p = progress.data;
	const finished = p?.status === "complete" || p?.status === "errored";
	useEffect(() => {
		if (finished) void queryClient.invalidateQueries();
	}, [finished, queryClient]);
	const { matches, settled } = useFirstMatches(p?.status === "complete");
	const cheered = useRef(false);
	useEffect(() => {
		if (matches.length > 0 && !cheered.current) {
			cheered.current = true;
			celebrate();
		}
	}, [matches.length, celebrate]);
	const result = p?.result as ScanResult | null | undefined;
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
	return (
		<div className="relative flex flex-col gap-4" data-testid="first-scan">
			<SparkleBurst burst={burst} />
			<Group>
				<GroupBody className="flex flex-col gap-3">
					{p?.total ? (
						<Cells
							total={p.total}
							on={finished ? p.total : p.done}
							tone="ink"
							label={`${p.done} of ${p.total} read`}
						/>
					) : null}
					<p
						data-testid="first-scan-progress"
						data-matches={matches.length}
						className="text-foreground flex items-center gap-2 text-sm"
					>
						{!finished ? (
							<LoaderCircle
								className="text-muted-foreground size-4 animate-spin"
								aria-hidden
							/>
						) : null}
						{progressLine(p, finished, result, matches.length, settled)}
					</p>
				</GroupBody>
			</Group>
			{matches.length > 0 ? <FirstMatches matches={matches} /> : null}
		</div>
	);
}
