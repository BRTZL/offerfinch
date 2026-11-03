import { bracketBlanks } from "@offerfinch/core/tailor/blanks";
import { useMutation } from "@tanstack/react-query";
import { Check, Sparkles, WandSparkles } from "lucide-react";
import { useState } from "react";
import { DiffView } from "@/components/pipeline/chat/proposal-card";
import { Notice } from "@/components/system/bits";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/orpc";

type HelpResult = Awaited<ReturnType<typeof client.questions.help>>;
type Proposal = Extract<HelpResult, { status: "ok" }> & {
	/** The box text the proposal was built from. */
	basis: string;
};

/**
 * Why Save is blocked: blanks the helper left ("[which bundle analyzer?]") must be filled in or
 * removed first, so a placeholder never becomes a profile fact.
 */
export function blankProblem(text: string): string | null {
	return bracketBlanks(text).length ? "Fill in or remove [ … ] first." : null;
}

/**
 * The answer helper beside Save answer. Suggest (empty box) drafts from the profile; Improve
 * rewrites what the user typed. Either shows a proposal under the box with what is still
 * missing; Use this puts it in the box, still editable, and nothing is saved until Save answer.
 * A paused model, an error or a proposal the guard dropped is said plainly; the box is untouched.
 */
export function useAnswerHelper(questionId: string) {
	const [proposal, setProposal] = useState<Proposal | null>(null);
	const [notice, setNotice] = useState<{
		tone: "warning" | "destructive";
		text: string;
	} | null>(null);
	const help = useMutation({
		mutationFn: (draft: string) =>
			client.questions.help({ id: questionId, draft }),
		onMutate: () => {
			setProposal(null);
			setNotice(null);
		},
		onSuccess: (result, draft) => {
			if (result.status === "ok") setProposal({ ...result, basis: draft });
			else if (result.status === "rejected")
				setNotice({
					tone: "warning",
					text: "The suggestion added something you didn't say; not shown.",
				});
			else if (result.status === "empty")
				setNotice({
					tone: "warning",
					text: "The model had nothing to suggest.",
				});
			else
				setNotice({
					tone: result.status === "paused" ? "warning" : "destructive",
					text: result.message,
				});
		},
		onError: (error) => setNotice({ tone: "destructive", text: error.message }),
	});
	const dismiss = () => {
		setProposal(null);
		setNotice(null);
	};
	return { help, proposal, notice, dismiss };
}

type Helper = ReturnType<typeof useAnswerHelper>;

/** Suggest when the box is empty, Improve when it has text. */
export function HelperButton({
	helper,
	text,
	disabled,
}: {
	helper: Helper;
	text: string;
	disabled?: boolean;
}) {
	const improve = Boolean(text.trim());
	const pending = helper.help.isPending;
	return (
		<Button
			variant="outline"
			onClick={() => helper.help.mutate(text)}
			disabled={pending || disabled}
			data-testid={improve ? "answer-improve" : "answer-suggest"}
			title={
				improve
					? "Rewrite your answer clearly, keeping only what you said"
					: "Draft an answer from your profile, with blanks where it has nothing"
			}
		>
			{improve ? <WandSparkles /> : <Sparkles />}
			{pending
				? improve
					? "Improving…"
					: "Suggesting…"
				: improve
					? "Improve"
					: "Suggest"}
		</Button>
	);
}

/**
 * The proposal under the box: the change, what's missing, Use this and Dismiss. If the box was
 * edited after the proposal was made, Use this is off, so it never overwrites the newer text.
 */
export function HelperResult({
	helper,
	text,
	onUse,
}: {
	helper: Helper;
	text: string;
	onUse: (answer: string) => void;
}) {
	const { proposal, notice } = helper;
	if (notice)
		return (
			<Notice
				tone={notice.tone}
				data-testid="answer-helper-notice"
				actions={
					<Button size="xs" variant="ghost" onClick={helper.dismiss}>
						Dismiss
					</Button>
				}
			>
				{notice.text}
			</Notice>
		);
	if (!proposal) return null;
	const stale = proposal.basis.trim() !== text.trim();
	// A suggestion replaces an empty box: its "removed" side is one empty line, not worth showing.
	const lines =
		proposal.mode === "suggest"
			? proposal.diff.filter((l) => l.op !== "del")
			: proposal.diff;
	return (
		<div
			className="border-border bg-card flex flex-col gap-3 rounded-xl border p-3"
			data-testid="answer-proposal"
		>
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground">
					{proposal.mode === "suggest" ? (
						<Sparkles className="size-4" />
					) : (
						<WandSparkles className="size-4" />
					)}
				</span>
				<p className="text-foreground min-w-0 flex-1 text-sm font-medium">
					{proposal.mode === "suggest"
						? "Suggested from your profile"
						: "Your answer, rewritten"}
				</p>
			</div>
			<p className="text-muted-foreground text-xs">
				Only your words and your profile's facts. Check it before you save; fill
				in anything in [ brackets ].
			</p>
			<DiffView lines={lines} />
			<div className="flex flex-col gap-1" data-testid="answer-missing">
				<p className="text-foreground text-xs font-medium">What's missing</p>
				{proposal.missing.length ? (
					<ul className="text-muted-foreground list-disc pl-5 text-xs">
						{proposal.missing.map((m) => (
							<li key={m} data-selectable>
								{m}
							</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-xs">
						Nothing: it answers every part of the question.
					</p>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					size="xs"
					disabled={stale}
					onClick={() => {
						onUse(proposal.answer);
						helper.dismiss();
					}}
					data-testid="answer-use"
				>
					<Check />
					Use this
				</Button>
				<Button
					size="xs"
					variant="ghost"
					onClick={helper.dismiss}
					data-testid="answer-dismiss"
				>
					Dismiss
				</Button>
				{stale ? (
					<p
						className="text-muted-foreground text-xs"
						data-testid="answer-proposal-stale"
					>
						You changed your answer since.{" "}
						{proposal.mode === "suggest" ? "Suggest" : "Improve"} again to
						include it.
					</p>
				) : null}
			</div>
		</div>
	);
}
