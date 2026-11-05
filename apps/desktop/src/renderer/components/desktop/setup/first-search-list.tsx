import { type ReactNode, useEffect, useRef, useState } from "react";
import { Badge, Fit, type Tone } from "@/components/system/bits";
import { useReducedMotion } from "@/lib/reduced-motion";
import { Check, Collapse } from "@/vendor/stageshow";
import {
	beingChecked,
	type FoundRow,
	newRowBeats,
	type RowBeats,
	type ShownRow,
	shownRowsAt,
} from "./first-search-beats";

/** Rows shown at once; the rest are counted under the list. */
const VISIBLE_ROWS = 12;

/** `shownRowsAt` across renders: the beats are kept per job, so a poll never restarts one. */
export function useShownRows(rows: FoundRow[]): ShownRow[] {
	const beats = useRef<RowBeats>(newRowBeats());
	const [, tick] = useState(0);
	const { shown, waiting } = shownRowsAt(rows, beats.current);
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
	fits: "To score",
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
	// Its run errored before a score (once its "Found" beat is over): not being scored now.
	if (row.failed && row.shown === row.state)
		return { tone: "warning", label: "Scoring failed" };
	// Waiting on a paused model: not being scored now.
	if (row.shown === "fits" && row.paused)
		return { tone: "warning", label: "Paused" };
	// No row still in its "Found" beat: these are being scored now.
	if (row.shown === "fits" && rulesOver)
		return { tone: "neutral", label: "Scoring" };
	return { tone: "neutral", label: LABEL[row.shown] };
}

function JobRow({ row, rulesOver }: { row: ShownRow; rulesOver: boolean }) {
	const scored = row.shown === "scored";
	const aside = row.shown === "rejected_by_filter";
	const failed = row.failed && row.shown === row.state;
	const scoring = row.shown === "fits" && !row.paused && !failed;
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
					pending={scoring}
					size={14}
					className="first-search-arc"
					data-show={scoring || undefined}
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
			{failed && row.reason ? (
				<span
					className="first-search-reason text-muted-foreground min-w-0 shrink truncate text-xs"
					data-testid="first-search-failed-reason"
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
 * in the order they were found, and how many more under them (`hidden`: jobs still in play past
 * the procedure's row cap). Reduce Motion: rows appear and leave without moving.
 */
export function FirstSearchList({
	rows,
	hidden,
}: {
	rows: ShownRow[];
	hidden: number;
}) {
	const reduced = useReducedMotion();
	const rulesOver = !rows.some(beingChecked);
	let open = 0;
	const items = rows.map((row) => {
		const visible = !row.gone && open < VISIBLE_ROWS;
		if (!row.gone) open++;
		return { row, visible };
	});
	// Active jobs past the rows this view has (the procedure's cap) count with the hidden ones;
	// set-aside jobs it left out would have left the list anyway.
	const more = Math.max(0, open - VISIBLE_ROWS) + hidden;
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
