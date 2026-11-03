import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	Check,
	FilePenLine,
	RefreshCw,
	TriangleAlert,
	UserRoundPlus,
} from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
	FIELDS,
	KIND_NOUN,
	type RecordKind,
} from "@/components/pipeline/profile/record-dialog";
import { Badge } from "@/components/system/bits";
import { Button } from "@/components/ui/button";
import { client, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

type Thread = Awaited<ReturnType<typeof client.chat.thread>>;
export type ChatMessage = Thread["messages"][number];
export type Proposal = ChatMessage["proposals"][number];
type DocumentProposal = Extract<Proposal, { type: "document" }>;
type FactProposal = Extract<Proposal, { type: "fact" }>;
type RecordProposal = Extract<Proposal, { type: "record" }>;

const DOC_NOUN: Record<string, string> = {
	cv: "CV",
	cover_letter: "letter",
	form_answers: "answer",
	notes: "fit notes",
};

const STATUS: Record<
	string,
	{ label: string; tone: "primary" | "quiet" | "warning" }
> = {
	applying: { label: "Saving", tone: "quiet" },
	accepted: { label: "Accepted", tone: "primary" },
	dismissed: { label: "Dismissed", tone: "quiet" },
	conflict: { label: "Out of date", tone: "warning" },
};

/** Unchanged lines kept around each change; longer runs fold into one line. */
const CONTEXT = 2;

/** Removed and added lines, with a +/− gutter; long unchanged runs folded. */
export function DiffView({
	lines,
}: {
	lines: { op: "same" | "add" | "del"; text: string }[];
}) {
	// Runs of unchanged lines: the first keeps its tail, the last its head, others both.
	const runs: { op: "same" | "add" | "del"; texts: string[] }[] = [];
	for (const line of lines) {
		const last = runs.at(-1);
		if (last && last.op === "same" && line.op === "same")
			last.texts.push(line.text);
		else runs.push({ op: line.op, texts: [line.text] });
	}
	const shown: ReactNode[] = [];
	runs.forEach((run, i) => {
		if (run.op !== "same") {
			for (const text of run.texts)
				shown.push(<DiffLine key={shown.length} op={run.op} text={text} />);
			return;
		}
		const head = i === 0 ? [] : run.texts.slice(0, CONTEXT);
		const rest = run.texts.slice(head.length);
		const tail = i === runs.length - 1 ? [] : rest.slice(-CONTEXT);
		const hidden = rest.length - tail.length;
		const visible = hidden <= 1 ? run.texts : [...head, null, ...tail];
		for (const text of visible)
			shown.push(
				text === null ? (
					<div
						key={shown.length}
						className="text-muted-foreground text-2xs px-2 py-0.5"
					>
						{hidden} unchanged lines
					</div>
				) : (
					<DiffLine key={shown.length} op="same" text={text} />
				),
			);
	});
	return (
		<div
			className="border-border bg-background overflow-hidden rounded-lg border py-1 font-mono text-xs"
			data-testid="chat-diff"
			data-selectable
		>
			{shown}
		</div>
	);
}

function DiffLine({ op, text }: { op: "same" | "add" | "del"; text: string }) {
	return (
		<div
			className={cn(
				"flex gap-2 px-2",
				op === "add" && "bg-primary-surface text-foreground",
				op === "del" && "bg-destructive-surface text-muted-foreground",
				op === "same" && "text-muted-foreground",
			)}
			data-op={op}
		>
			<span aria-hidden className="w-2 shrink-0 select-none">
				{op === "add" ? "+" : op === "del" ? "−" : ""}
			</span>
			<span className="sr-only">
				{op === "add" ? "Added: " : op === "del" ? "Removed: " : ""}
			</span>
			<span
				className={cn(
					"min-w-0 flex-1 break-words whitespace-pre-wrap",
					op === "del" && "line-through",
				)}
			>
				{text || " "}
			</span>
		</div>
	);
}

/** One suggestion the model attached: what it changes, and Accept or Dismiss. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep proposal variants and their accept or dismiss controls together.
export function ProposalCard({
	messageId,
	proposal,
	editable,
	onRegenerate,
	busy,
}: {
	messageId: string;
	proposal: Proposal;
	/** Whether documents can be edited now (in review or after approval). */
	editable: boolean;
	/** Asks the model again, for a suggestion written for an older version. */
	onRegenerate: (text: string) => void;
	/** A reply is being written: no regeneration until it lands. */
	busy: boolean;
}) {
	const queryClient = useQueryClient();
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: orpc.chat.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.application.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.profile.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.questions.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.inbox.key() }),
		]);
	const accept = useMutation({
		mutationFn: () =>
			client.chat.accept({ messageId, proposalId: proposal.id }),
		onSuccess: (result) => {
			if (result.status === "conflict")
				toast.warning(result.note ?? "This suggestion is out of date.");
			else if (result.type === "document")
				toast.success(
					result.revoked
						? `Saved version ${result.appliedVersion}. The approval was withdrawn; review again.`
						: `Saved version ${result.appliedVersion}. Checking claims…`,
				);
			else if (result.type === "fact")
				toast.success("Saved to your profile. Drafts may cite it.");
			else
				toast.success(
					result.action === "create"
						? "Added to your profile."
						: "Saved to your profile.",
				);
			void refresh();
		},
		onError: (error) => {
			toast.error(error.message.replace(/^Refusing: /, ""));
			void refresh();
		},
	});
	const dismiss = useMutation({
		mutationFn: () =>
			client.chat.dismiss({ messageId, proposalId: proposal.id }),
		onSuccess: () => void refresh(),
		onError: (error) => toast.error(error.message.replace(/^Refusing: /, "")),
	});
	const pending = proposal.status === "pending";
	const working = accept.isPending || dismiss.isPending;
	const blocked = proposal.type === "document" && !editable;
	const status = STATUS[proposal.status];

	const head =
		proposal.type === "document"
			? { icon: <FilePenLine className="size-4" />, title: proposal.title }
			: proposal.type === "fact"
				? {
						icon: <UserRoundPlus className="size-4" />,
						title: "Save to your profile",
					}
				: {
						icon: <UserRoundPlus className="size-4" />,
						title:
							proposal.action === "create"
								? `New ${KIND_NOUN[proposal.kind as RecordKind]}`
								: `Change ${KIND_NOUN[proposal.kind as RecordKind]}`,
					};

	return (
		<div
			className="border-border bg-card flex flex-col gap-3 rounded-xl border p-3"
			data-testid={`chat-proposal-${proposal.type}`}
			data-status={proposal.status}
		>
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground">{head.icon}</span>
				<p className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
					{head.title}
				</p>
				{status ? <Badge tone={status.tone}>{status.label}</Badge> : null}
			</div>
			{"summary" in proposal && proposal.summary ? (
				<p className="text-muted-foreground text-xs">{proposal.summary}</p>
			) : null}
			{proposal.type === "document" ? (
				<DocumentBody proposal={proposal} />
			) : proposal.type === "fact" ? (
				<FactBody proposal={proposal} />
			) : (
				<RecordBody proposal={proposal} />
			)}
			<Outcome proposal={proposal} />
			{pending ? (
				<div className="flex flex-wrap items-center gap-2">
					<Button
						size="xs"
						onClick={() => accept.mutate()}
						disabled={working || blocked}
						data-testid="chat-accept"
						title={
							blocked
								? "Documents can be changed in review or after approval"
								: undefined
						}
					>
						<Check />
						{proposal.type === "fact"
							? "Save"
							: proposal.type === "record" && proposal.action === "create"
								? "Add"
								: "Accept"}
					</Button>
					<Button
						size="xs"
						variant="ghost"
						onClick={() => dismiss.mutate()}
						disabled={working}
						data-testid="chat-dismiss"
					>
						Dismiss
					</Button>
					{blocked ? (
						<span className="text-muted-foreground text-xs">
							Edits open in review or after approval.
						</span>
					) : null}
				</div>
			) : proposal.status === "conflict" && proposal.type === "document" ? (
				<div className="flex flex-wrap items-center gap-2">
					<Button
						size="xs"
						variant="outline"
						disabled={busy}
						onClick={() =>
							onRegenerate(
								`Write that suggestion again for the current ${DOC_NOUN[proposal.document] ?? "document"}${proposal.question ? ` ("${proposal.question}")` : ""}: ${proposal.summary}`,
							)
						}
						data-testid="chat-regenerate"
					>
						<RefreshCw />
						Regenerate
					</Button>
					<Button
						size="xs"
						variant="ghost"
						onClick={() => dismiss.mutate()}
						disabled={working}
					>
						Dismiss
					</Button>
				</div>
			) : null}
		</div>
	);
}

function DocumentBody({ proposal }: { proposal: DocumentProposal }) {
	return (
		<>
			<DiffView lines={proposal.diff} />
			{proposal.issues.length > 0 && proposal.status === "pending" ? (
				<div className="text-warning flex items-start gap-1.5 text-xs">
					<TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
					<span>
						The check will flag this: {proposal.issues.slice(0, 3).join(" ")}
					</span>
				</div>
			) : null}
		</>
	);
}

function FactBody({ proposal }: { proposal: FactProposal }) {
	return (
		<div className="flex flex-col gap-1">
			<p className="text-muted-foreground text-xs">{proposal.question}</p>
			<p
				className="text-foreground border-border border-l-2 pl-2 text-sm"
				data-selectable
			>
				{proposal.answer}
			</p>
		</div>
	);
}

const fieldLabel = (kind: string, key: string) =>
	FIELDS[kind as RecordKind]?.find((f) => f.key === key)?.label ?? key;

function RecordBody({ proposal }: { proposal: RecordProposal }) {
	if (proposal.action === "create") {
		const data = proposal.after.data as Record<string, unknown>;
		const shown = (FIELDS[proposal.kind as RecordKind] ?? []).filter((f) => {
			const v = data[f.key];
			return Array.isArray(v) ? v.length > 0 : String(v ?? "").trim();
		});
		return (
			<dl className="flex flex-col gap-2" data-selectable>
				{shown.map((f) => {
					const v = data[f.key];
					return (
						<div key={f.key} className="flex flex-col gap-0.5">
							<dt className="text-muted-foreground text-xs">{f.label}</dt>
							<dd className="text-foreground text-sm">
								{Array.isArray(v) ? (
									<ul className="flex list-disc flex-col gap-0.5 pl-4">
										{v.map((item) => (
											<li key={String(item)}>{String(item)}</li>
										))}
									</ul>
								) : (
									<span className="whitespace-pre-wrap">{String(v)}</span>
								)}
							</dd>
						</div>
					);
				})}
			</dl>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			{proposal.fields.map((f) => (
				<div key={f.key} className="flex flex-col gap-1">
					<p className="text-muted-foreground text-xs">
						{fieldLabel(proposal.kind, f.key)}
					</p>
					<DiffView
						lines={[
							...(f.before
								? f.before
										.split("\n")
										.map((text) => ({ op: "del" as const, text }))
								: []),
							...(f.after
								? f.after
										.split("\n")
										.map((text) => ({ op: "add" as const, text }))
								: []),
						]}
					/>
				</div>
			))}
		</div>
	);
}

/** What happened after Accept: the version saved, an approval withdrawn, or why it is stale. */
function Outcome({ proposal }: { proposal: Proposal }) {
	if (proposal.status === "conflict")
		return (
			<p className="text-warning text-xs" data-testid="chat-conflict">
				{proposal.note ?? "This suggestion is out of date."} Nothing was
				changed.
			</p>
		);
	if (proposal.status !== "accepted") return null;
	if (proposal.type === "document")
		return (
			<p className="text-muted-foreground text-xs" data-testid="chat-outcome">
				Saved as version {proposal.appliedVersion}; its claims are checked
				again.
				{proposal.revoked
					? " The approval was withdrawn: review it again."
					: ""}
			</p>
		);
	if (proposal.type === "fact")
		return (
			<p className="text-muted-foreground text-xs" data-testid="chat-outcome">
				Saved to Profile › Answers. Drafts may cite it.
			</p>
		);
	return (
		<p className="text-muted-foreground text-xs" data-testid="chat-outcome">
			Saved to your profile.
		</p>
	);
}
