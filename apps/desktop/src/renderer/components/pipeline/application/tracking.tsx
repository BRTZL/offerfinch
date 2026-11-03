import {
	dayLabel,
	GHOST_AFTER_DAYS,
	STAGE_LABEL,
	TRACKING_STAGES,
	type TrackingStage,
} from "@offerfinch/core/domain/tracking";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { FilterSelect } from "@/components/pipeline/filter-select";
import { Badge, ErrorLine, type Tone } from "@/components/system/bits";
import { InspectorSection } from "@/components/system/pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { today } from "./submission";

type Tracking = Awaited<ReturnType<typeof client.tracking.get>>;
type Entry = Tracking["stages"][number];

const STAGE_TONE: Record<TrackingStage, Tone> = {
	applied: "quiet",
	heard_back: "neutral",
	interviewing: "primary",
	offer: "brand",
	company_rejected: "destructive",
	withdrawn: "quiet",
	ghosted: "warning",
};

/** "Interviewing · round 2", or the stage's name. */
function stageText(stage: TrackingStage, round?: number | null) {
	return stage === "interviewing" && round
		? `${STAGE_LABEL[stage]} · round ${round}`
		: STAGE_LABEL[stage];
}

/** An application's stage after Applied, as a small label. */
export function StageChip({
	stage,
	round,
}: {
	stage: TrackingStage;
	round?: number | null;
}) {
	return (
		<Badge tone={STAGE_TONE[stage]} data-testid="stage-chip" data-stage={stage}>
			{stageText(stage, round)}
		</Badge>
	);
}

/** When a note was written: an instant, shown in the user's time zone. */
const day = (date: Date | string) =>
	new Date(date).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
const dateTime = (date: Date | string) =>
	new Date(date).toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});

function useTrackingRefresh(applicationId: string) {
	const queryClient = useQueryClient();
	return () => {
		void queryClient.invalidateQueries({
			queryKey: orpc.tracking.get.queryKey({ input: { id: applicationId } }),
		});
		void queryClient.invalidateQueries({
			queryKey: orpc.tracking.stages.queryKey(),
		});
	};
}

function useTracking(applicationId: string) {
	return useQuery(
		orpc.tracking.get.queryOptions({ input: { id: applicationId } }),
	);
}

/** Pick a stage, then its day (and for an interview, its time), with an optional note. */
function MoveStage({
	applicationId,
	current,
	nextRound,
}: {
	applicationId: string;
	current: TrackingStage;
	nextRound: number;
}) {
	const id = useId();
	const refresh = useTrackingRefresh(applicationId);
	const [stage, setStage] = useState("");
	// Null until the user picks a day: until then it is today whenever it is read (shown at
	// render, sent as of the click), so a form left open past midnight saves the new day; a
	// picked day is kept as picked.
	const [picked, setPicked] = useState<string | null>(null);
	const occurredOn = picked ?? today();
	const [interviewAt, setInterviewAt] = useState("");
	const [note, setNote] = useState("");
	const reset = () => {
		setStage("");
		setPicked(null);
		setInterviewAt("");
		setNote("");
	};
	const move = useMutation({
		mutationFn: () =>
			client.tracking.move({
				id: applicationId,
				stage: stage as TrackingStage,
				occurredOn: picked ?? today(),
				// The picked local time as an instant, so Calendar shows it in any time zone.
				interviewAt: interviewAt ? new Date(interviewAt).toISOString() : null,
				note: note.trim() || undefined,
			}),
		onSuccess: () => {
			toast.success(`Moved to ${STAGE_LABEL[stage as TrackingStage]}`);
			reset();
			refresh();
		},
		onError: (error) => toast.error(error.message),
	});
	const options = TRACKING_STAGES.filter(
		(s) => s !== current || s === "interviewing",
	).map((s) => ({
		value: s,
		label:
			s === "interviewing"
				? `Interviewing (round ${nextRound})`
				: STAGE_LABEL[s],
	}));
	return (
		<form
			className="flex flex-col gap-2"
			data-testid="move-stage"
			onSubmit={(e) => {
				e.preventDefault();
				if (stage) move.mutate();
			}}
		>
			<FilterSelect
				label="Move to"
				value={stage}
				onChange={setStage}
				options={[{ value: "", label: "Move to…" }, ...options]}
				size="default"
				testId="move-stage-select"
			/>
			{stage ? (
				<>
					<label
						htmlFor={`${id}-date`}
						className="text-muted-foreground flex flex-col gap-1 text-xs"
					>
						When it happened
						<Input
							id={`${id}-date`}
							type="date"
							value={occurredOn}
							max={today()}
							onChange={(e) => setPicked(e.target.value)}
							size="sm"
							data-testid="stage-date"
						/>
					</label>
					{stage === "interviewing" ? (
						<label
							htmlFor={`${id}-time`}
							className="text-muted-foreground flex flex-col gap-1 text-xs"
						>
							Interview time (optional)
							<Input
								id={`${id}-time`}
								type="datetime-local"
								value={interviewAt}
								onChange={(e) => setInterviewAt(e.target.value)}
								size="sm"
								data-testid="interview-at"
							/>
						</label>
					) : null}
					<Textarea
						aria-label="Note for this stage"
						placeholder="Note (optional): who wrote, what's next"
						value={note}
						onChange={(e) => setNote(e.target.value)}
						className="text-xs"
						data-testid="stage-note"
					/>
					<div className="flex gap-2">
						<Button
							type="submit"
							size="sm"
							disabled={move.isPending || !occurredOn}
							data-testid="move-stage-save"
						>
							Save
						</Button>
						<Button type="button" size="sm" variant="ghost" onClick={reset}>
							Cancel
						</Button>
					</div>
				</>
			) : null}
		</form>
	);
}

function AddToCalendar({ stageId }: { stageId: string }) {
	const save = useMutation({
		mutationFn: () => desktop.saveInterviewEvent(stageId),
		onSuccess: (name) => {
			if (name) toast.success(`Saved ${name}. Calendar asks where to add it.`);
		},
		onError: (error) => toast.error(error.message),
	});
	return (
		<Button
			size="xs"
			variant="outline"
			onClick={() => save.mutate()}
			disabled={save.isPending}
			data-testid="add-to-calendar"
		>
			<CalendarPlus aria-hidden />
			Add to Calendar
		</Button>
	);
}

/** One stage entry: what, when, the interview time and the notes made in it. */
function TimelineEntry({
	entry,
	notes,
	last,
}: {
	entry: Entry;
	notes: Tracking["notes"];
	last: boolean;
}) {
	return (
		<li className="relative flex gap-3 pb-3" data-testid="stage-entry">
			<span
				aria-hidden
				className={`mt-1.5 size-2 shrink-0 rounded-full ${last ? "bg-primary" : "bg-border"}`}
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex flex-wrap items-baseline justify-between gap-x-2">
					<span className="text-foreground text-xs font-medium">
						{stageText(entry.stage, entry.interviewRound)}
					</span>
					<span className="text-muted-foreground text-2xs tabular-nums">
						{dayLabel(entry.occurredOn)}
					</span>
				</div>
				{entry.automatic ? (
					<p className="text-muted-foreground text-2xs">
						Set by OfferFinch: no news for {GHOST_AFTER_DAYS} days.
					</p>
				) : null}
				{entry.interviewAt ? (
					<div className="flex flex-wrap items-center gap-2">
						<span
							className="text-foreground text-xs"
							data-testid="interview-time"
						>
							{dateTime(entry.interviewAt)}
						</span>
						<AddToCalendar stageId={entry.id} />
					</div>
				) : null}
				{notes.map((n) => (
					<p
						key={n.id}
						className="text-muted-foreground text-xs break-words whitespace-pre-wrap"
						data-selectable
					>
						{n.body}
					</p>
				))}
			</div>
		</li>
	);
}

/**
 * After Applied: the current stage, a control to move it, and the history with dates and notes.
 * Only for an application that was sent.
 */
export function TrackingSection({ applicationId }: { applicationId: string }) {
	const query = useTracking(applicationId);
	const refresh = useTrackingRefresh(applicationId);
	const data = query.data;
	const current = data?.stages.at(-1);
	const before = data?.stages.at(-2);
	const undoGhost = useMutation({
		mutationFn: () =>
			client.tracking.move({
				id: applicationId,
				stage: before?.stage ?? "applied",
			}),
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	if (query.isError)
		return (
			<InspectorSection title="Progress">
				<ErrorLine>
					Could not load its progress: {query.error.message}
				</ErrorLine>
			</InspectorSection>
		);
	if (!data?.applied || !current) return null;
	const nextRound =
		Math.max(
			0,
			...data.stages.map((s) =>
				s.stage === "interviewing" ? (s.interviewRound ?? 1) : 0,
			),
		) + 1;
	return (
		<InspectorSection
			title="Progress"
			end={<StageChip stage={current.stage} round={current.interviewRound} />}
			data-testid="tracking"
		>
			{current.stage === "ghosted" && current.automatic ? (
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<span className="text-muted-foreground">
						No news for {GHOST_AFTER_DAYS} days, so it was marked ghosted.
					</span>
					<Button
						size="xs"
						variant="outline"
						onClick={() => undoGhost.mutate()}
						disabled={undoGhost.isPending}
						data-testid="undo-ghosted"
					>
						Not ghosted
					</Button>
				</div>
			) : null}
			<MoveStage
				key={current.id}
				applicationId={applicationId}
				current={current.stage}
				nextRound={nextRound}
			/>
			<ol aria-label="Stage history" className="flex flex-col">
				{[...data.stages].reverse().map((entry, i) => (
					<TimelineEntry
						key={entry.id}
						entry={entry}
						last={i === 0}
						notes={data.notes.filter((n) => n.stageId === entry.id)}
					/>
				))}
			</ol>
		</InspectorSection>
	);
}

function NoteRow({
	applicationId,
	note,
	stageLabel,
}: {
	applicationId: string;
	note: Tracking["notes"][number];
	stageLabel: string | null;
}) {
	const refresh = useTrackingRefresh(applicationId);
	const [editing, setEditing] = useState(false);
	const [body, setBody] = useState(note.body);
	const save = useMutation({
		mutationFn: () =>
			client.tracking.updateNote({ noteId: note.id, body: body.trim() }),
		onSuccess: () => {
			setEditing(false);
			refresh();
		},
		onError: (error) => toast.error(error.message),
	});
	const remove = useMutation({
		mutationFn: () => client.tracking.deleteNote({ noteId: note.id }),
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	return (
		<li className="flex flex-col gap-1" data-testid="note">
			<div className="text-muted-foreground text-2xs flex items-center gap-2 tabular-nums">
				<span>{day(note.createdAt)}</span>
				{stageLabel ? <span>· {stageLabel}</span> : null}
				{editing ? null : (
					<span className="ml-auto flex gap-1">
						<Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
							Edit
						</Button>
						<Button
							size="xs"
							variant="ghost"
							onClick={() => remove.mutate()}
							disabled={remove.isPending}
						>
							Delete
						</Button>
					</span>
				)}
			</div>
			{editing ? (
				<form
					className="flex flex-col gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (body.trim()) save.mutate();
					}}
				>
					<Textarea
						aria-label="Edit note"
						value={body}
						onChange={(e) => setBody(e.target.value)}
						className="text-xs"
					/>
					<div className="flex gap-2">
						<Button type="submit" size="xs" disabled={save.isPending}>
							Save
						</Button>
						<Button
							type="button"
							size="xs"
							variant="ghost"
							onClick={() => {
								setBody(note.body);
								setEditing(false);
							}}
						>
							Cancel
						</Button>
					</div>
				</form>
			) : (
				<p
					className="text-foreground text-xs break-words whitespace-pre-wrap"
					data-selectable
				>
					{note.body}
				</p>
			)}
		</li>
	);
}

/** Private notes on any job: dated, the user's own, never sent to a model. */
export function NotesSection({ applicationId }: { applicationId: string }) {
	const query = useTracking(applicationId);
	const refresh = useTrackingRefresh(applicationId);
	const [body, setBody] = useState("");
	const add = useMutation({
		mutationFn: () =>
			client.tracking.addNote({ id: applicationId, body: body.trim() }),
		onSuccess: () => {
			setBody("");
			refresh();
		},
		onError: (error) => toast.error(error.message),
	});
	const notes = query.data?.notes ?? [];
	const stageOf = new Map(query.data?.stages.map((s) => [s.id, s]) ?? []);
	return (
		<InspectorSection title="Notes" data-testid="notes">
			<p className="text-muted-foreground text-2xs">
				Only for you. Notes are never sent to an AI model.
			</p>
			<form
				className="flex flex-col gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (body.trim()) add.mutate();
				}}
			>
				<Textarea
					aria-label="New note"
					placeholder="Recruiter's name, a referral, what was said"
					value={body}
					onChange={(e) => setBody(e.target.value)}
					className="text-xs"
					data-testid="note-input"
				/>
				{body.trim() ? (
					<Button
						type="submit"
						size="xs"
						className="self-start"
						disabled={add.isPending}
						data-testid="note-add"
					>
						Add note
					</Button>
				) : null}
			</form>
			{notes.length > 0 ? (
				<ul className="flex flex-col gap-3">
					{notes.map((n) => {
						const stage = n.stageId ? stageOf.get(n.stageId) : undefined;
						return (
							<NoteRow
								key={n.id}
								applicationId={applicationId}
								note={n}
								stageLabel={
									stage ? stageText(stage.stage, stage.interviewRound) : null
								}
							/>
						);
					})}
				</ul>
			) : null}
		</InspectorSection>
	);
}
