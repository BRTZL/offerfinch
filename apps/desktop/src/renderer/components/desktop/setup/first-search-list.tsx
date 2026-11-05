import { type ReactNode, useEffect, useRef, useState } from "react";
import { Badge, Fit, type Tone } from "@/components/system/bits";
import { useReducedMotion } from "@/lib/reduced-motion";
import { Check, Collapse } from "@/vendor/stageshow";

/** One job the first search found, as `desktop.scanJobs` returns it. */
export interface FoundRow {
	jobId: string;
	company: string;
	title: string;
	state: "found" | "fits" | "rejected_by_filter" | "scored";
	reason: string | null;
	score: number | null;
	match: boolean;
}

export type ShownRow = FoundRow & {
	/** What the row shows now: a new row reads as found for a beat before its real state. */
	shown: FoundRow["state"];
	/** A set-aside row that has shown its reason and left the list. */
	gone: boolean;
};

/** A new row reads "Found" this long, so the rules pass is seen even when it beat the poll. */
const FOUND_MS = 700;
/** A set-aside row shows its reason at least this long, then leaves with the others… */
const ASIDE_MIN_MS = 1_200;
/** …or on its own after this, if the rules pass is still going. */
const ASIDE_MAX_MS = 3_000;
/** Rows shown at once; the rest are counted under the list. */
export const VISIBLE_ROWS = 12;

/**
 * The rows with the beats of the prototype: each arrives as found, a set-aside row holds its
 * reason and the set-aside rows leave together once no row is still being checked (or each on
 * its own after a few seconds). Times are kept per job, so a poll never restarts a beat.
 */
export function useShownRows(rows: FoundRow[]): ShownRow[] {
	const seen = useRef(new Map<string, number>());
	const asideAt = useRef(new Map<string, number>());
	const [, tick] = useState(0);
	const now = Date.now();
	for (const r of rows)
		if (!seen.current.has(r.jobId)) seen.current.set(r.jobId, now);
	const first = rows.map((r) => {
		const fresh = now - (seen.current.get(r.jobId) ?? now) < FOUND_MS;
		return { ...r, shown: fresh ? ("found" as const) : r.state };
	});
	const checking = first.some((r) => r.shown === "found");
	let waiting = first.some((r) => r.shown === "found");
	const shown = first.map((r) => {
		if (r.shown !== "rejected_by_filter") return { ...r, gone: false };
		if (!asideAt.current.has(r.jobId)) asideAt.current.set(r.jobId, now);
		const held = now - (asideAt.current.get(r.jobId) ?? now);
		const gone = held >= ASIDE_MAX_MS || (held >= ASIDE_MIN_MS && !checking);
		if (!gone) waiting = true;
		return { ...r, gone };
	});
	// A beat is still running: look again shortly. Polls re-render on their own as well.
	useEffect(() => {
		if (!waiting) return;
		const id = setTimeout(() => tick((n) => n + 1), 200);
		return () => clearTimeout(id);
	});
	return shown;
}

/** Collapse opened on the frame after it mounts, so a new row opens instead of popping in. */
function Arriving({ open, children }: { open: boolean; children: ReactNode }) {
	const [mounted, setMounted] = useState(false);
	useEffect(() => {
		const id = requestAnimationFrame(() => setMounted(true));
		return () => cancelAnimationFrame(id);
	}, []);
	const shown = open && mounted;
	return (
		<li aria-hidden={!shown || undefined}>
			<Collapse open={shown}>{children}</Collapse>
		</li>
	);
}

const LABEL: Record<FoundRow["state"], string> = {
	found: "Found",
	fits: "Fits your rules",
	rejected_by_filter: "Set aside",
	scored: "Low fit",
};

function badgeOf(
	row: ShownRow,
	rulesOver: boolean,
): { tone: Tone; label: string } {
	if (row.shown === "rejected_by_filter")
		return { tone: "warning", label: LABEL.rejected_by_filter };
	if (row.shown === "scored")
		return row.match
			? { tone: "brand", label: "Match" }
			: { tone: "neutral", label: LABEL.scored };
	// Past the rules and no row still being checked: these are being scored now.
	if (row.shown === "fits" && rulesOver)
		return { tone: "neutral", label: "Scoring" };
	return { tone: "neutral", label: LABEL[row.shown] };
}

function JobRow({ row, rulesOver }: { row: ShownRow; rulesOver: boolean }) {
	const scored = row.shown === "scored";
	const aside = row.shown === "rejected_by_filter";
	const badge = badgeOf(row, rulesOver);
	return (
		<div
			data-testid={scored && row.match ? "first-match" : "first-search-row"}
			data-state={row.shown}
			className="first-search-row flex min-h-10 items-center gap-3 px-4 py-2 text-sm"
		>
			<span className="first-search-slot w-8 shrink-0">
				<Check
					on={false}
					pending={row.shown === "fits"}
					size={14}
					className="first-search-arc"
					data-show={row.shown === "fits" || undefined}
				/>
				<span className="first-search-fit" data-on={scored || undefined}>
					{scored ? (
						<>
							<span className="sr-only">Fit </span>
							<Fit value={row.score} />
						</>
					) : null}
				</span>
			</span>
			<span className="first-search-job min-w-0 flex-1 truncate">
				<span className="text-foreground font-medium">{row.company}</span>
				<span className="text-muted-foreground">
					{"  "}
					{row.title}
				</span>
			</span>
			{aside && row.reason ? (
				<span
					className="first-search-reason text-muted-foreground min-w-0 shrink truncate text-xs"
					data-testid="first-search-reason"
				>
					{row.reason}
				</span>
			) : null}
			<Badge tone={badge.tone}>{badge.label}</Badge>
		</div>
	);
}

/**
 * The jobs the first search found, as they arrive: the first `VISIBLE_ROWS` still in the list,
 * in the order they were found, and how many more under them. Reduce Motion: rows appear and
 * leave without moving.
 */
export function FirstSearchList({
	rows,
	total,
}: {
	rows: ShownRow[];
	total: number;
}) {
	const reduced = useReducedMotion();
	const rulesOver = !rows.some((r) => r.shown === "found");
	let open = 0;
	const items = rows.map((row) => {
		const visible = !row.gone && open < VISIBLE_ROWS;
		if (!row.gone) open++;
		return { row, visible };
	});
	// Jobs past the rows this view has (the procedure's cap) count with the hidden ones.
	const more =
		Math.max(0, open - VISIBLE_ROWS) + Math.max(0, total - rows.length);
	if (rows.length === 0) return null;
	return (
		<div
			className="border-border bg-card overflow-hidden rounded-xl border"
			data-testid="first-search-list"
		>
			<ul className="first-search-rows" aria-label="Jobs found">
				{items.map(({ row, visible }) =>
					reduced ? (
						visible ? (
							<li key={row.jobId}>
								<JobRow row={row} rulesOver={rulesOver} />
							</li>
						) : null
					) : (
						<Arriving key={row.jobId} open={visible}>
							<JobRow row={row} rulesOver={rulesOver} />
						</Arriving>
					),
				)}
			</ul>
			{more > 0 ? (
				<p
					className="first-search-row text-muted-foreground px-4 py-2 text-xs"
					data-testid="first-search-more"
				>
					and {more} more
				</p>
			) : null}
		</div>
	);
}
