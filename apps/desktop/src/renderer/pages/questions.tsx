import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircleQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	blankProblem,
	HelperButton,
	HelperResult,
	useAnswerHelper,
} from "@/components/pipeline/answer-helper";
import { ago, StateBadge } from "@/components/pipeline/bits";
import { EmptyState, ErrorLine, Kbd } from "@/components/system/bits";
import { Page, PageHeader, PageIntro } from "@/components/system/layout";
import { ListRowsSkeleton, SelectableList } from "@/components/system/list";
import { MasterDetail } from "@/components/system/master-detail";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { client, orpc } from "@/lib/orpc";
import { Link, useParams, useRouter } from "@/lib/router";
import { keyHint } from "../../shared/shortcuts";

type Question = Awaited<ReturnType<typeof client.questions.list>>[number];

/**
 * Facts a posting needs that the profile lacks, listed beside the one being answered (laid out
 * as the Inbox is). Each answer is saved to the profile with its date.
 */
export default function QuestionsPage() {
	const router = useRouter();
	const { id: selectedId } = useParams<{ id?: string }>();
	const open = useQuery({
		...orpc.questions.list.queryOptions({ input: { status: "open" } }),
		refetchInterval: 5_000,
	});
	const items = open.data ?? [];
	const selected = items.find((q) => q.id === selectedId) ?? null;
	// The first question opens by itself: the answer field is ready to type into.
	const first = items[0]?.id;
	useEffect(() => {
		if (!selectedId && first) router.replace(`/questions/${first}`);
	}, [selectedId, first, router]);
	// After an answer, the next question opens (the one below, else the one above), so the
	// user keeps answering instead of facing an empty pane.
	const openNext = (answeredId: string) => {
		const at = items.findIndex((q) => q.id === answeredId);
		const next = items[at + 1] ?? items[at - 1];
		router.replace(next ? `/questions/${next.id}` : "/questions");
	};
	const count = items.length;
	return (
		<>
			<PageHeader
				title="Questions"
				subtitle={open.data ? `${count} waiting for you` : undefined}
			>
				<Link href="/profile" className="text-primary text-sm hover:underline">
					Saved answers are in Profile
				</Link>
			</PageHeader>
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
						<SelectableList
							items={items}
							selectedId={selectedId}
							onSelect={(id) => router.replace(`/questions/${id}`)}
							label="Questions"
							detailId="question-detail"
							render={(q) => ({
								testId: "question-row",
								title: q.question,
								time: ago(q.createdAt),
								subtitle: q.companyName
									? `${q.companyName} · ${q.title}`
									: undefined,
							})}
						/>
					)
				}
			>
				<div className="flex min-h-0 min-w-0 flex-1">
					{selected ? (
						<Answer
							key={selected.id}
							q={selected}
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
									: "OfferFinch never guesses a fact. When a posting needs one your profile lacks, it asks here and waits."}
							</EmptyState>
						</div>
					)}
				</div>
			</MasterDetail>
		</>
	);
}

/**
 * One question: what it is for, the answer box, and the answer helper (Suggest or Improve) beside
 * Save. ⌘↩ saves. Blanks the helper left in [ brackets ] block Save until they are filled in.
 */
function Answer({ q, onAnswered }: { q: Question; onAnswered: () => void }) {
	const queryClient = useQueryClient();
	const [text, setText] = useState("");
	const box = useRef<HTMLTextAreaElement>(null);
	const helper = useAnswerHelper(q.id);
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
	const submit = () => {
		if (text.trim() && !blocked && !answer.isPending) answer.mutate();
	};
	return (
		<Page width="form">
			<section
				id="question-detail"
				tabIndex={-1}
				data-focus="self"
				className="flex flex-col gap-6 outline-none"
				data-testid="question"
			>
				<PageIntro title={q.question} description={q.context ?? undefined} />
				{q.applicationId ? (
					<p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
						For{" "}
						<Link
							href={`/applications/${q.applicationId}?view=all`}
							className="text-primary hover:underline"
						>
							{q.companyName} · {q.title}
						</Link>
						{q.applicationState ? (
							<StateBadge state={q.applicationState} />
						) : null}
					</p>
				) : null}
				<div className="flex flex-col gap-3">
					<label htmlFor={`answer-${q.id}`} className="sr-only">
						{q.question}
					</label>
					<Textarea
						ref={box}
						id={`answer-${q.id}`}
						autoFocus
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								submit();
							}
						}}
						placeholder="Your answer, in your words. Only what is true."
						className="min-h-28"
					/>
					<div className="flex items-center justify-end gap-3">
						{blocked ? (
							<p
								className="text-warning mr-auto text-sm"
								role="status"
								data-testid="answer-blank"
							>
								{blocked}
							</p>
						) : null}
						<span className="text-muted-foreground flex items-center gap-1 text-xs">
							<Kbd>{keyHint("question-save")}</Kbd>
						</span>
						<HelperButton
							helper={helper}
							text={text}
							disabled={answer.isPending}
						/>
						<Button
							onClick={submit}
							disabled={!text.trim() || Boolean(blocked) || answer.isPending}
							title={`Save answer (${keyHint("question-save")})`}
						>
							Save answer
						</Button>
					</div>
					<HelperResult
						helper={helper}
						onUse={(proposed) => {
							setText(proposed);
							box.current?.focus();
						}}
					/>
				</div>
			</section>
		</Page>
	);
}
