import {
	type ChoiceGroup,
	type ChoicePicks,
	composeChoices,
	NONE,
	NOT_SURE,
	togglePick,
} from "@offerfinch/core/tailor/answer-compose";
import { bracketBlanks } from "@offerfinch/core/tailor/blanks";
import { useMutation } from "@tanstack/react-query";
import { Check, ListChecks, Sparkles, WandSparkles } from "lucide-react";
import { useState } from "react";
import { DiffView } from "@/components/pipeline/chat/proposal-card";
import { Notice } from "@/components/system/bits";
import { Button, SwapLabel } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
	return (
		<Button
			variant="outline"
			onClick={() => helper.help.mutate(text)}
			disabled={disabled}
			pending={helper.help.isPending}
			data-testid={improve ? "answer-improve" : "answer-suggest"}
			title={
				improve
					? "Rewrite your answer clearly, keeping only what you said"
					: "Draft an answer from your profile, with blanks where it has nothing"
			}
		>
			{improve ? <WandSparkles /> : <Sparkles />}
			<SwapLabel
				labels={["Suggest", "Improve"]}
				show={improve ? "Improve" : "Suggest"}
			/>
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

/* ------------------------------------------------------- help me remember */

type HelperNotice = { tone: "warning" | "destructive"; text: string };

/**
 * Help me remember: the question as a few multiple-choice asks, for when the answer is hard to
 * recall from a blank box. The options only jog memory; what the user ticks is composed into the
 * box (answer-compose), and nothing is saved until Save answer.
 */
export function useAnswerChoices(questionId: string) {
	const [groups, setGroups] = useState<ChoiceGroup[] | null>(null);
	const [notice, setNotice] = useState<HelperNotice | null>(null);
	const load = useMutation({
		mutationFn: () => client.questions.choices({ id: questionId }),
		onMutate: () => {
			setGroups(null);
			setNotice(null);
		},
		onSuccess: (result) => {
			if (result.status === "ok") setGroups(result.groups);
			else if (result.status === "empty")
				setNotice({
					tone: "warning",
					text: "The model had no choices to offer for this question.",
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
		setGroups(null);
		setNotice(null);
	};
	return { load, groups, notice, dismiss };
}

type Choices = ReturnType<typeof useAnswerChoices>;

export function ChoicesButton({
	choices,
	disabled,
}: {
	choices: Choices;
	disabled?: boolean;
}) {
	return (
		<Button
			variant="outline"
			onClick={() => choices.load.mutate()}
			disabled={disabled}
			pending={choices.load.isPending}
			data-testid="answer-choices"
			title="Answer by picking from a few options, to help you remember"
		>
			<ListChecks />
			Help me remember
		</Button>
	);
}

/** One option chip: a toggle, marked when the profile already names it. */
function Chip({
	label,
	on,
	inProfile,
	onToggle,
	testId,
}: {
	label: string;
	on: boolean;
	inProfile?: boolean;
	onToggle: () => void;
	testId: string;
}) {
	return (
		<Button
			size="xs"
			variant={on ? "secondary" : "outline"}
			aria-pressed={on}
			className="aria-pressed:border-primary aria-pressed:text-primary"
			onClick={onToggle}
			data-testid={testId}
			title={inProfile ? "Your profile already mentions this" : undefined}
		>
			{/* Always laid out, so ticking never changes the chip's width. */}
			<Check className={on ? undefined : "invisible"} />
			{label}
			{inProfile ? (
				<span className="text-muted-foreground font-normal">in profile</span>
			) : null}
		</Button>
	);
}

/**
 * The asks with their options, None of these, Not sure and Other, and "Write my answer", which
 * puts the picks in the box (after what is there) for the user to edit, Improve or save.
 */
export function ChoicesCard({
	choices,
	onCompose,
}: {
	choices: Choices;
	onCompose: (draft: string) => void;
}) {
	const { groups, notice } = choices;
	const [picks, setPicks] = useState<ChoicePicks[]>([]);
	if (notice)
		return (
			<Notice
				tone={notice.tone}
				data-testid="answer-choices-notice"
				actions={
					<Button size="xs" variant="ghost" onClick={choices.dismiss}>
						Dismiss
					</Button>
				}
			>
				{notice.text}
			</Notice>
		);
	if (!groups) return null;
	const at = (i: number): ChoicePicks => picks[i] ?? { picked: [], other: "" };
	const update = (i: number, next: Partial<ChoicePicks>) =>
		setPicks((all) => {
			const copy = groups.map((_, j) => all[j] ?? { picked: [], other: "" });
			copy[i] = { ...copy[i], ...next } as ChoicePicks;
			return copy;
		});
	const draft = composeChoices(groups, picks);
	const close = () => {
		setPicks([]);
		choices.dismiss();
	};
	return (
		<div
			className="border-border bg-card flex flex-col gap-4 rounded-xl border p-3"
			data-testid="answer-choices-card"
		>
			<div className="flex flex-col gap-1">
				<div className="flex items-center gap-2">
					<ListChecks className="text-muted-foreground size-4" />
					<p className="text-foreground text-sm font-medium">
						Help me remember
					</p>
				</div>
				<p className="text-muted-foreground text-xs">
					Options are reminders, not facts about you. Tick only what is true;
					skip or pick Not sure for anything you can't recall.
				</p>
			</div>
			{groups.map((group, i) => {
				const p = at(i);
				const toggle = (label: string) =>
					update(i, { picked: togglePick(group, p.picked, label) });
				return (
					<fieldset
						key={i}
						className="flex flex-col gap-2"
						data-testid="answer-choice-group"
					>
						<legend className="text-foreground mb-2 text-xs font-medium">
							{group.ask}
							<span className="text-muted-foreground font-normal">
								{group.multi ? " · pick any" : " · pick one"}
							</span>
						</legend>
						<div className="flex flex-wrap gap-1.5">
							{group.options.map((o) => (
								<Chip
									key={o.label}
									label={o.label}
									inProfile={o.inProfile}
									on={p.picked.includes(o.label)}
									onToggle={() => toggle(o.label)}
									testId="answer-choice"
								/>
							))}
							{group.multi ? (
								<Chip
									label={NONE}
									on={p.picked.includes(NONE)}
									onToggle={() => toggle(NONE)}
									testId="answer-choice-none"
								/>
							) : null}
							<Chip
								label={NOT_SURE}
								on={p.picked.includes(NOT_SURE)}
								onToggle={() => toggle(NOT_SURE)}
								testId="answer-choice-not-sure"
							/>
						</div>
						<Input
							value={p.other}
							onChange={(e) => update(i, { other: e.target.value })}
							placeholder="Other, in your words (optional)"
							aria-label={`${group.ask} Other`}
							maxLength={300}
							className="h-7 text-xs"
							data-testid="answer-choice-other"
						/>
					</fieldset>
				);
			})}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					size="xs"
					disabled={!draft}
					onClick={() => {
						onCompose(draft);
						close();
					}}
					data-testid="answer-choices-use"
					title="Put your picks in the answer box, then improve them into sentences"
				>
					<Check />
					Write my answer
				</Button>
				<Button
					size="xs"
					variant="ghost"
					onClick={close}
					data-testid="answer-choices-dismiss"
				>
					Dismiss
				</Button>
			</div>
		</div>
	);
}
