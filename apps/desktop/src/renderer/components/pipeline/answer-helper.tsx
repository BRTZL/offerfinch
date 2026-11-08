import type { StoredSuggestion } from "@offerfinch/core/tailor/answer-helper";
import { bracketBlanks } from "@offerfinch/core/tailor/blanks";
import { useMutation } from "@tanstack/react-query";
import { Check, PenLine, WandSparkles } from "lucide-react";
import { type ReactNode, type Ref, useState } from "react";
import { DiffView } from "@/components/pipeline/chat/proposal-card";
import { Notice } from "@/components/system/bits";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/orpc";
import { cn } from "@/lib/utils";

type HelpResult = Awaited<ReturnType<typeof client.questions.help>>;
type Proposal = Extract<HelpResult, { status: "ok" }> & {
	/** The box text the proposal was built from. */
	basis: string;
};
type HelperNotice = { tone: "warning" | "destructive"; text: string };

/**
 * Why Save is blocked: blanks the helper left ("[which bundle analyzer?]") must be filled in or
 * removed first, so a placeholder never becomes a profile fact.
 */
export function blankProblem(text: string): string | null {
	return bracketBlanks(text).length ? "Fill in or remove [ … ] first." : null;
}

/**
 * The answer helper's one call. Suggest (empty draft) hands its fresh answers to `onSuggestion`,
 * which the page shows as the answer cards; Improve (a draft) becomes a proposal under the
 * editor. A paused model or an error is said plainly; nothing on the page changes.
 */
export function useAnswerHelper(
	questionId: string,
	onSuggestion: (suggestion: StoredSuggestion) => void,
) {
	const [proposal, setProposal] = useState<Proposal | null>(null);
	const [notice, setNotice] = useState<HelperNotice | null>(null);
	const help = useMutation({
		mutationFn: (draft: string) =>
			client.questions.help({ id: questionId, draft }),
		onMutate: () => {
			setProposal(null);
			setNotice(null);
		},
		onSuccess: (result, draft) => {
			if (result.status === "ok") {
				if (result.mode === "suggest") onSuggestion(result);
				else setProposal({ ...result, basis: draft });
			} else if (result.status === "empty")
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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text with every guessed term underlined, so a guess is seen where it stands. */
function Guessed({ text, terms }: { text: string; terms: string[] }) {
	const words = terms.filter(Boolean);
	if (!words.length) return <>{text}</>;
	const pattern = new RegExp(
		`(?<![\\p{L}\\p{N}])(${words.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`,
		"giu",
	);
	const parts: ReactNode[] = [];
	let at = 0;
	for (const m of text.matchAll(pattern)) {
		const i = m.index ?? 0;
		if (i > at) parts.push(text.slice(at, i));
		parts.push(
			<span
				key={i}
				className="decoration-warning underline decoration-dotted decoration-2 underline-offset-2"
				data-testid="answer-guess"
				title="Guessed: not in your profile"
			>
				{m[0]}
			</span>,
		);
		at = i + m[0].length;
	}
	parts.push(text.slice(at));
	return <>{parts}</>;
}

/** The number key on a card: filled when the card is picked. */
function KeyCap({ n, on }: { n: number; on: boolean }) {
	return (
		<span
			aria-hidden
			className={cn(
				"ease-standard text-2xs grid size-5 shrink-0 place-items-center rounded-sm border font-semibold transition-colors duration-200",
				on
					? "bg-primary text-primary-foreground border-transparent"
					: "border-border bg-muted text-muted-foreground",
			)}
		>
			{n}
		</span>
	);
}

/**
 * One suggested answer as a card: its number key, a short label and the full answer, guesses
 * underlined. Picked, it carries the primary ring; editing, its answer becomes the text box.
 */
export function AnswerCard({
	n,
	label,
	answer,
	terms,
	picked,
	editing,
	value,
	onChange,
	onPick,
	onEditorKeyDown,
	editorRef,
}: {
	n: number;
	label: string;
	answer: string;
	terms: string[];
	picked: boolean;
	editing: boolean;
	value: string;
	onChange: (text: string) => void;
	onPick: () => void;
	onEditorKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	editorRef: Ref<HTMLTextAreaElement>;
}) {
	// A label with its own radio, so a click or the arrow keys pick it; editing, the box is the
	// card's only control.
	const Shell = picked && editing ? "div" : "label";
	return (
		<Shell
			data-testid="answer-card"
			data-picked={picked || undefined}
			className={cn(
				"bg-card ease-standard flex cursor-default items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors duration-200",
				picked
					? "border-primary bg-primary-surface/50"
					: "border-border hover:bg-hover",
			)}
		>
			{Shell === "label" ? (
				<input
					type="radio"
					name="answer"
					className="sr-only"
					checked={picked}
					onChange={onPick}
					aria-label={label}
				/>
			) : null}
			<KeyCap n={n} on={picked} />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="text-foreground text-sm font-semibold">{label}</p>
				{picked && editing ? (
					<Textarea
						ref={editorRef}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						onKeyDown={onEditorKeyDown}
						aria-label={`Answer ${n}, editing`}
						className="bg-background min-h-24 text-sm"
						data-testid="answer-editor"
					/>
				) : (
					<p
						className="text-foreground/80 text-sm whitespace-pre-wrap"
						data-selectable
					>
						<Guessed text={picked ? value : answer} terms={terms} />
					</p>
				)}
			</div>
		</Shell>
	);
}

/** "Write my own": the last card. Picked, it is an empty text box. */
export function OwnCard({
	n,
	picked,
	value,
	onChange,
	onPick,
	onEditorKeyDown,
	editorRef,
	helper,
}: {
	n: number;
	picked: boolean;
	value: string;
	onChange: (text: string) => void;
	onPick: () => void;
	onEditorKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	editorRef: Ref<HTMLTextAreaElement>;
	helper: Helper;
}) {
	const Shell = picked ? "div" : "label";
	return (
		<Shell
			data-testid="answer-own"
			data-picked={picked || undefined}
			className={cn(
				"ease-standard flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors duration-200",
				picked
					? "border-primary bg-primary-surface/50"
					: "border-border text-muted-foreground hover:bg-hover",
			)}
		>
			{picked ? null : (
				<input
					type="radio"
					name="answer"
					className="sr-only"
					checked={false}
					onChange={onPick}
					aria-label="Write my own"
				/>
			)}
			<KeyCap n={n} on={picked} />
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<p
					className={cn(
						"flex items-center gap-2 text-sm",
						picked && "text-foreground font-semibold",
					)}
				>
					<PenLine className="size-4" />
					Write my own
				</p>
				{picked ? (
					<>
						<Textarea
							ref={editorRef}
							value={value}
							onChange={(e) => onChange(e.target.value)}
							onKeyDown={onEditorKeyDown}
							placeholder="Your answer, in your words. Only what is true."
							aria-label="Your own answer"
							className="bg-background min-h-24 text-sm"
							data-testid="answer-editor"
						/>
						<div className="flex justify-end">
							<Button
								size="xs"
								variant="outline"
								disabled={!value.trim()}
								pending={helper.help.isPending}
								onClick={() => helper.help.mutate(value)}
								data-testid="answer-improve"
								title="Rewrite your answer clearly, keeping only what you said"
							>
								<WandSparkles />
								Improve
							</Button>
						</div>
					</>
				) : null}
			</div>
		</Shell>
	);
}

/** "Prometheus", "Prometheus and Loki", "A, B, C, D, E and 2 more". */
function listTerms(terms: string[]): string {
	const shown = terms.slice(0, 5).map((t) => `"${t}"`);
	if (terms.length > 5) shown.push(`${terms.length - 5} more`);
	return shown.length > 1
		? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
		: (shown[0] ?? "something");
}

/**
 * A notice from the helper, or Improve's proposal: the change, what's missing, Use this and
 * Dismiss. If the text was edited after the proposal was made, Use this is off, so it never
 * overwrites the newer text.
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
	return (
		<div
			className="border-border bg-card flex flex-col gap-3 rounded-xl border p-3"
			data-testid="answer-proposal"
		>
			<div className="flex items-center gap-2">
				<WandSparkles className="text-muted-foreground size-4" />
				<p className="text-foreground min-w-0 flex-1 text-sm font-medium">
					Your answer, rewritten
				</p>
			</div>
			{proposal.unchecked.length ? (
				<p className="text-warning text-xs" data-testid="answer-unchecked">
					Not in your words or profile: {listTerms(proposal.unchecked)}. Keep
					them only if they are true.
				</p>
			) : (
				<p className="text-muted-foreground text-xs">
					Only your words and your profile's facts. Check it before you save;
					fill in anything in [ brackets ].
				</p>
			)}
			<DiffView lines={proposal.diff} />
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
						You changed your answer since. Improve again to include it.
					</p>
				) : null}
			</div>
		</div>
	);
}
