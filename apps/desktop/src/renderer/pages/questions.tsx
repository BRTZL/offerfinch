import type { StoredSuggestion } from "@offerfinch/core/tailor/answer-helper";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowDown,
	ArrowUp,
	Check,
	LoaderCircle,
	MessageCircleQuestion,
	PenLine,
	RefreshCw,
	SkipForward,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	AnswerCard,
	blankProblem,
	HelperResult,
	OwnCard,
	useAnswerHelper,
} from "@/components/pipeline/answer-helper";
import { StateBadge } from "@/components/pipeline/bits";
import {
	ACTION_BAR_SPACE,
	ActionBar,
	ActionBarButton,
	ActionBarDivider,
} from "@/components/system/action-bar";
import { EmptyState, ErrorLine, Kbd } from "@/components/system/bits";
import { PageHeader } from "@/components/system/layout";
import {
	type ListGroup,
	ListRowsSkeleton,
	SelectableList,
} from "@/components/system/list";
import { MasterDetail } from "@/components/system/master-detail";
import { Button } from "@/components/ui/button";
import { client, orpc } from "@/lib/orpc";
import { Link, useParams, useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";
import { keyHint, matches } from "../../shared/shortcuts";

type Question = Awaited<ReturnType<typeof client.questions.list>>[number];

const NO_JOB = "none";
const groupKey = (q: Question) => q.applicationId ?? NO_JOB;

/** The jobs the questions came from, in the list's order; questions with no job last. */
function groupsOf(items: Question[]): ListGroup[] {
	const seen = new Map<string, ListGroup>();
	for (const q of items) {
		const key = groupKey(q);
		if (!seen.has(key))
			seen.set(key, {
				key,
				label:
					key === NO_JOB
						? "Not tied to a job"
						: `${q.companyName ?? "Unknown company"} · ${q.title ?? ""}`,
			});
	}
	const groups = [...seen.values()];
	return [
		...groups.filter((g) => g.key !== NO_JOB),
		...groups.filter((g) => g.key === NO_JOB),
	];
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/**
 * Facts a posting needs that the profile lacks, as a queue. Each question opens with its answers
 * already written (made in the background), as numbered cards with the likeliest picked: 1–4
 * picks, ⌘↩ saves to the profile and opens the next. The list groups questions by the job that
 * asked them, and says which have their answers ready.
 */
export default function QuestionsPage() {
	const router = useRouter();
	const { id: selectedId } = useParams<{ id?: string }>();
	const open = useQuery({
		...orpc.questions.list.queryOptions({ input: { status: "open" } }),
		refetchInterval: 5_000,
	});
	const answered = useQuery(
		orpc.questions.list.queryOptions({ input: { status: "answered" } }),
	);
	const items = open.data ?? [];
	const groups = groupsOf(items);
	// The order the list shows them in: by job, then as listed.
	const ordered = groups.flatMap((g) =>
		items.filter((q) => groupKey(q) === g.key),
	);
	const selected = items.find((q) => q.id === selectedId) ?? null;
	// The first question opens by itself, its answers ready to pick.
	const first = ordered[0]?.id;
	useEffect(() => {
		if (!selectedId && first) router.replace(`/questions/${first}`);
	}, [selectedId, first, router]);
	const at = ordered.findIndex((q) => q.id === selectedId);
	const go = (to: number) => {
		const q = ordered[to];
		if (q) router.replace(`/questions/${q.id}`);
	};
	// After an answer, the next question opens (the one below, else the one above).
	const openNext = (answeredId: string) => {
		const i = ordered.findIndex((q) => q.id === answeredId);
		const next = ordered[i + 1] ?? ordered[i - 1];
		router.replace(next ? `/questions/${next.id}` : "/questions");
	};
	const count = items.length;
	const today = new Date();
	const doneToday = (answered.data ?? []).filter(
		(q) => q.answeredAt && sameDay(new Date(q.answeredAt), today),
	).length;
	const sameJob = selected
		? ordered.filter((q) => groupKey(q) === groupKey(selected))
		: [];
	return (
		<>
			<PageHeader
				title="Questions"
				subtitle={
					open.data && groups.length
						? `for ${groups.length} ${groups.length === 1 ? "job" : "jobs"}`
						: undefined
				}
			/>
			<MasterDetail
				list={
					open.isError ? (
						<div className="px-4 py-3">
							<ErrorLine>
								Could not load questions: {open.error.message}. It retries
								shortly.
							</ErrorLine>
						</div>
					) : open.isLoading ? (
						<ListRowsSkeleton rows={4} />
					) : count === 0 ? (
						<EmptyState
							icon={<MessageCircleQuestion />}
							title="No open questions"
						>
							You are not holding anything up.
						</EmptyState>
					) : (
						<div className="flex min-h-0 flex-1 flex-col">
							<Progress left={count} done={doneToday} />
							<SelectableList
								items={ordered}
								selectedId={selectedId}
								onSelect={(id) => router.replace(`/questions/${id}`)}
								label="Questions"
								detailId="question-detail"
								groupOf={groupKey}
								groups={groups}
								render={(q) => ({
									testId: "question-row",
									title: q.question,
									meta: <ReadyMark ready={Boolean(q.suggestion)} />,
								})}
							/>
						</div>
					)
				}
			>
				<div className="flex min-h-0 min-w-0 flex-1">
					{selected ? (
						<Answer
							key={selected.id}
							q={selected}
							position={{
								n: sameJob.findIndex((q) => q.id === selected.id) + 1,
								of: sameJob.length,
							}}
							onPrevious={at > 0 ? () => go(at - 1) : undefined}
							onNext={at < ordered.length - 1 ? () => go(at + 1) : undefined}
							onAnswered={() => openNext(selected.id)}
						/>
					) : (
						<div className="flex flex-1 items-center justify-center">
							<EmptyState
								icon={<MessageCircleQuestion />}
								title={count > 0 ? "Nothing selected" : "All answered"}
							>
								{count > 0
									? "Choose a question in the list, or press ↓ there."
									: "When a posting needs a fact your profile lacks, OfferFinch asks here and waits, with suggested answers ready."}
							</EmptyState>
						</div>
					)}
				</div>
			</MasterDetail>
		</>
	);
}

/** On top of the list: how many are left, today's progress, and the keys that clear them. */
function Progress({ left, done }: { left: number; done: number }) {
	const total = left + done;
	return (
		<div
			className="border-border flex flex-col gap-2 border-b px-4 pt-3 pb-3"
			data-testid="questions-progress"
		>
			<div className="flex items-center justify-between gap-3">
				<p className="text-foreground text-sm font-semibold tabular-nums">
					{left} left
				</p>
				<p className="text-muted-foreground flex items-center gap-1.5 text-xs">
					<Kbd>1–4</Kbd> pick
					<span className="ml-1.5">
						<Kbd>{keyHint("question-save")}</Kbd>
					</span>{" "}
					save
				</p>
			</div>
			<div className="bg-muted h-1 overflow-hidden rounded-full">
				<div
					className="bg-success ease-standard h-full rounded-full transition-all duration-700"
					style={{ width: `${total ? (done / total) * 100 : 0}%` }}
				/>
			</div>
		</div>
	);
}

/** A row's state: its answers are ready, or still being written. */
function ReadyMark({ ready }: { ready: boolean }) {
	return ready ? (
		<span className="text-muted-foreground flex items-center gap-1.5">
			<span aria-hidden className="bg-success size-1.5 rounded-full" />
			Answers ready
		</span>
	) : (
		<span className="text-muted-foreground flex items-center gap-1.5">
			<LoaderCircle aria-hidden className="size-3 animate-spin" />
			Writing answers…
		</span>
	);
}

const editable = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable ||
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.tagName === "SELECT");

/**
 * One question: its suggested answers as numbered cards, the likeliest picked, and Write my own
 * last. 1–4 picks, E edits the picked answer in its card, ⌘↩ saves it and opens the next. Words
 * the model guessed are underlined. New suggestions asks again. Blanks in [ brackets ] block
 * Save until they are filled in.
 */
function Answer({
	q,
	position,
	onPrevious,
	onNext,
	onAnswered,
}: {
	q: Question;
	position: { n: number; of: number };
	onPrevious?: () => void;
	onNext?: () => void;
	onAnswered: () => void;
}) {
	const queryClient = useQueryClient();
	const [fresh, setFresh] = useState<StoredSuggestion | null>(null);
	const suggestion = fresh ?? q.suggestion;
	const variants = suggestion?.variants ?? [];
	const own = variants.length;
	const [pick, setPick] = useState<number | null>(null);
	const [drafts, setDrafts] = useState<Record<number, string>>({});
	// With no answers yet, Write my own is open and ready to type into.
	const [editing, setEditing] = useState(!variants.length);
	const editor = useRef<HTMLTextAreaElement>(null);
	const helper = useAnswerHelper(q.id, (next) => {
		setFresh(next);
		setDrafts({});
		setPick(0);
		setEditing(false);
	});
	// Answers that arrive while the question is open (the 5-second refresh) pick the first one,
	// unless the user has already chosen.
	const typed = Boolean(drafts[own]?.trim());
	useEffect(() => {
		if (pick !== null || !variants.length || typed) return;
		setPick(0);
		setEditing(false);
	}, [pick, variants.length, typed]);
	const current = pick ?? own;
	const text =
		drafts[current] ?? (current < own ? (variants[current]?.answer ?? "") : "");
	const setText = (value: string) =>
		setDrafts((d) => ({ ...d, [current]: value }));
	const blocked = blankProblem(text);
	const answer = useMutation({
		mutationFn: () =>
			client.questions.answer({ id: q.id, answer: text.trim() }),
		onSuccess: (result) => {
			toast.success(
				result.next === "review"
					? "Saved to your profile and added to the form answers. Review and approve them again."
					: result.resumed
						? "Saved to your profile. Tailoring resumes."
						: "Saved to your profile.",
			);
			onAnswered();
			void queryClient.invalidateQueries();
		},
		onError: (error) => toast.error(error.message),
	});
	const canSave = Boolean(text.trim()) && !blocked && !answer.isPending;
	const submit = () => {
		if (canSave) answer.mutate();
	};
	const choose = (i: number) => {
		setPick(i);
		setEditing(i === own);
		helper.dismiss();
	};
	const edit = () => {
		setPick(current);
		setEditing(true);
	};
	// The editor takes focus as it opens, with the caret at the end.
	// biome-ignore lint/correctness/useExhaustiveDependencies: another card's editor opens on `current`
	useEffect(() => {
		if (!editing) return;
		const el = editor.current;
		el?.focus();
		el?.setSelectionRange(el.value.length, el.value.length);
	}, [editing, current]);
	// Page keys: 1–4 pick, E edits, ⌘↩ saves. Never while typing in a field.
	const keys = useRef<(event: KeyboardEvent) => void>(() => {});
	keys.current = (event) => {
		if (event.defaultPrevented || editable(event.target)) return;
		if (matches(event, "question-save")) {
			event.preventDefault();
			submit();
		} else if (matches(event, "question-pick")) {
			const i = Number(event.key) - 1;
			if (i <= own) {
				event.preventDefault();
				choose(i);
			}
		} else if (matches(event, "question-edit") && current < own) {
			event.preventDefault();
			edit();
		}
	};
	useEffect(() => {
		const listener = (event: KeyboardEvent) => keys.current(event);
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, []);
	const editorKeys = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (matches(event.nativeEvent, "question-save")) {
			event.preventDefault();
			submit();
		} else if (event.key === "Escape" && current < own) {
			event.preventDefault();
			setEditing(false);
		}
	};
	const writing = !suggestion && !helper.help.isPending;
	return (
		<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
			<div className={cn("min-h-0 flex-1 overflow-auto", ACTION_BAR_SPACE)}>
				<section
					id="question-detail"
					tabIndex={-1}
					data-focus="self"
					className="mx-auto flex w-full max-w-180 flex-col gap-5 p-6 outline-none"
					data-testid="question"
				>
					<QuestionHead
						q={q}
						position={position}
						onPrevious={onPrevious}
						onNext={onNext}
					/>
					<SuggestRow
						ready={variants.length > 0}
						writing={writing}
						pending={helper.help.isPending}
						onSuggest={() => helper.help.mutate("")}
					/>
					<div
						role="radiogroup"
						aria-label="Answers"
						className="flex flex-col gap-2"
					>
						{variants.map((v, i) => (
							<AnswerCard
								key={`${i}:${v.answer}`}
								n={i + 1}
								label={v.label}
								answer={v.answer}
								terms={v.unchecked}
								picked={current === i}
								editing={editing}
								value={current === i ? text : v.answer}
								onChange={setText}
								onPick={() => choose(i)}
								onEditorKeyDown={editorKeys}
								editorRef={editor}
							/>
						))}
						{writing ? (
							<div
								className="border-border text-muted-foreground flex items-center gap-2 rounded-xl border border-dashed px-4 py-3 text-sm"
								data-testid="answer-writing"
							>
								<LoaderCircle className="size-4 animate-spin" />
								Suggested answers appear here once they are written.
							</div>
						) : null}
						<OwnCard
							n={own + 1}
							picked={current === own}
							value={current === own ? text : ""}
							onChange={setText}
							onPick={() => choose(own)}
							onEditorKeyDown={editorKeys}
							editorRef={editor}
							helper={helper}
						/>
					</div>
					<HelperResult
						helper={helper}
						text={text}
						onUse={(proposed) => {
							setText(proposed);
							editor.current?.focus();
						}}
					/>
				</section>
			</div>
			<AnswerBar
				blocked={blocked}
				onSkip={onNext}
				onEdit={current < own && !editing ? edit : undefined}
				onSave={canSave ? submit : undefined}
				saving={answer.isPending}
			/>
		</div>
	);
}

/** Where the question sits (its job, its place there, ↑ ↓), the question and why it was asked. */
function QuestionHead({
	q,
	position,
	onPrevious,
	onNext,
}: {
	q: Question;
	position: { n: number; of: number };
	onPrevious?: () => void;
	onNext?: () => void;
}) {
	return (
		<>
			<div className="text-muted-foreground flex items-center gap-2 text-xs">
				<span className="tabular-nums">
					Question {position.n} of {position.of}
				</span>
				{q.applicationId ? (
					<>
						<span aria-hidden>·</span>
						<Link
							href={`/applications/${q.applicationId}?view=all`}
							className="hover:text-foreground truncate"
						>
							{q.companyName} · {q.title}
						</Link>
						{q.applicationState ? (
							<StateBadge state={q.applicationState} />
						) : null}
					</>
				) : null}
				<span className="ml-auto flex gap-1">
					<Button
						size="icon-sm"
						variant="outline"
						disabled={!onPrevious}
						onClick={onPrevious}
						aria-label="Previous question"
					>
						<ArrowUp />
					</Button>
					<Button
						size="icon-sm"
						variant="outline"
						disabled={!onNext}
						onClick={onNext}
						aria-label="Next question"
					>
						<ArrowDown />
					</Button>
				</span>
			</div>
			<div className="flex flex-col gap-2">
				<h2 className="text-foreground text-xl font-semibold text-balance">
					{q.question}
				</h2>
				{q.context ? (
					<p className="text-muted-foreground text-sm">{q.context}</p>
				) : null}
			</div>
		</>
	);
}

/** Skip, Edit and Save & next, floating over the bottom of the pane. */
function AnswerBar({
	blocked,
	onSkip,
	onEdit,
	onSave,
	saving,
}: {
	blocked: string | null;
	onSkip?: () => void;
	onEdit?: () => void;
	onSave?: () => void;
	saving: boolean;
}) {
	return (
		<ActionBar
			label="Answer"
			captionId="question-save-help"
			caption={
				blocked ? (
					<span className="text-warning" data-testid="answer-blank">
						{blocked}
					</span>
				) : (
					"Saves to your profile, then opens the next"
				)
			}
		>
			<ActionBarButton
				onClick={onSkip}
				disabled={!onSkip}
				data-testid="answer-skip"
			>
				<SkipForward />
				Skip
			</ActionBarButton>
			<ActionBarButton
				onClick={onEdit}
				disabled={!onEdit}
				data-testid="answer-edit"
				title={`Edit the picked answer (${keyHint("question-edit")})`}
			>
				<PenLine />
				Edit
			</ActionBarButton>
			<ActionBarDivider />
			<ActionBarButton
				tone="primary"
				onClick={onSave}
				disabled={!onSave}
				pending={saving}
				aria-describedby="question-save-help"
				title={`Save answer (${keyHint("question-save")})`}
			>
				<Check />
				Save &amp; next
			</ActionBarButton>
		</ActionBar>
	);
}

/** How to read the cards, and New suggestions to ask again. */
function SuggestRow({
	ready,
	writing,
	pending,
	onSuggest,
}: {
	ready: boolean;
	writing: boolean;
	pending: boolean;
	onSuggest: () => void;
}) {
	return (
		<div className="flex items-center gap-3">
			<p className="text-muted-foreground min-w-0 flex-1 text-xs">
				{ready ? (
					<>
						Pick the one that's true.{" "}
						<span className="decoration-warning underline decoration-dotted underline-offset-2">
							Underlined
						</span>{" "}
						words are guesses.
					</>
				) : writing ? (
					"Writing suggested answers from your profile…"
				) : null}
			</p>
			<Button
				size="xs"
				variant="ghost"
				pending={pending}
				onClick={onSuggest}
				data-testid="answer-suggest"
				title="Write new answers from your profile"
			>
				<RefreshCw />
				{ready ? "New suggestions" : "Suggest now"}
			</Button>
		</div>
	);
}
