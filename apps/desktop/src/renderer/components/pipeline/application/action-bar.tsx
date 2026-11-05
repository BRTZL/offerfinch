import {
	ArrowUpRight,
	Check,
	Copy,
	Ellipsis,
	FileDown,
	FileText,
	Link2,
	MessageCircle,
	PanelRight,
	RotateCcw,
	ThumbsUp,
	TriangleAlert,
	X,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { useDemoMode } from "@/components/desktop/demo";
import {
	ActionBar,
	ActionBarButton,
	ActionBarDivider,
} from "@/components/system/action-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Menu,
	MenuContent,
	MenuGroup,
	MenuGroupLabel,
	MenuItem,
	MenuItemHint,
	MenuSeparator,
	MenuTrigger,
} from "@/components/ui/menu";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import { desktop } from "@/lib/desktop";
import { keyHint } from "../../../../shared/shortcuts";
import { approveBlocked, barKind, type MoreItem, moreItems } from "./bar-model";
import { RedraftDialog } from "./redraft";
import type {
	ApplicationActions,
	ApplicationDetailProps,
} from "./use-application-actions";

/** The open document's exports, for the More menu's document section. */
export type DocumentExports = {
	/** "CV", "Letter"; null when the open tab has no document. */
	label: string | null;
	content: string | null;
	pdfId: string | null;
	docxId: string | null;
	hasDocuments: boolean;
};

const MORE_ICON: Record<MoreItem["id"], ReactNode> = {
	redraft: <RotateCcw />,
	"open-posting": <ArrowUpRight />,
	"copy-link": <Link2 />,
	"save-pdf": <FileDown />,
	"open-docx": <FileText />,
	"copy-text": <Copy />,
};

/**
 * The detail's actions, floating at the bottom of the pane. A match: Chat, Not interested and
 * Interested. A draft in review: Resolve, Chat, More, Reject and Approve (off, with the reason
 * under the bar, while a flag is open). Anything else: its own actions, Chat, Details and More.
 */
export function DetailActionBar({
	actions,
	listState,
	matchActions,
	setAsideActions,
	onInterested,
	exports,
}: {
	actions: ApplicationActions;
	exports: DocumentExports | null;
} & Pick<
	ApplicationDetailProps,
	"listState" | "matchActions" | "setAsideActions" | "onInterested"
>) {
	const {
		loaded,
		chatOpen,
		toggleChat,
		detailsOpen,
		toggleDetails,
		prepare,
		openFlags,
		jumpToFlag,
		approve,
		approvable,
		tab,
	} = actions;
	const captionId = useId();
	const [redrafting, setRedrafting] = useState(false);
	const kind = barKind(loaded, listState);
	const demo = useDemoMode();

	const chat = (
		<ActionBarButton
			aria-pressed={chatOpen}
			onClick={toggleChat}
			data-testid="chat-toggle"
			title="Ask for changes to the CV, letter or answers"
		>
			<MessageCircle />
			Chat
		</ActionBarButton>
	);

	const items =
		loaded && exports
			? moreItems({
					app: loaded,
					hasDocuments: exports.hasDocuments,
					document: exports.label,
					pdf: Boolean(exports.pdfId),
					docx: Boolean(exports.docxId),
					demo,
				})
			: [];
	const pick = (id: MoreItem["id"]) => {
		if (!loaded) return;
		const fail = (e: Error) => toast.error(e.message);
		if (id === "redraft") setRedrafting(true);
		else if (id === "open-posting")
			desktop.openExternal(loaded.job.url).catch(fail);
		else if (id === "copy-link")
			desktop
				.copyText(loaded.job.url)
				.then(() => toast.success("Posting link copied."))
				.catch(fail);
		else if (id === "save-pdf" && exports?.pdfId)
			desktop.saveDocument(exports.pdfId).catch(fail);
		else if (id === "open-docx" && exports?.docxId)
			desktop.openDocument(exports.docxId).catch(fail);
		else if (id === "copy-text" && exports?.content)
			desktop
				.copyText(exports.content)
				.then(() => toast.success("Text copied."))
				.catch(fail);
	};
	const more =
		items.length > 0 ? <MoreMenu items={items} onPick={pick} /> : null;
	const redraft =
		redrafting && loaded ? (
			<RedraftDialog
				app={loaded}
				initial={tab}
				onClose={() => setRedrafting(false)}
			/>
		) : null;

	if (kind === "match")
		return (
			<ActionBar
				label="Decide on this match"
				caption="Interested drafts your CV and letter"
				captionId={captionId}
				data-testid="action-bar"
				data-kind="match"
			>
				{chat}
				<ActionBarDivider />
				{matchActions}
				<ActionBarButton
					tone="primary"
					decision
					onClick={() => (onInterested ? onInterested() : prepare.mutate())}
					pending={prepare.isPending}
					disabled={!loaded}
					aria-describedby={captionId}
					data-testid="interested"
					title={`Interested (${keyHint("inbox-prepare")}): drafts a CV, letter and answers, then checks them against your profile`}
				>
					<ThumbsUp />
					Interested
				</ActionBarButton>
			</ActionBar>
		);

	if (kind === "review") {
		const blocked = approveBlocked(loaded);
		return (
			<ActionBar
				label="Review this draft"
				caption={blocked}
				captionId={captionId}
				data-testid="action-bar"
				data-kind="review"
			>
				{openFlags > 0 ? (
					<ActionBarButton
						tone="warning"
						onClick={jumpToFlag}
						data-testid="jump-to-flag"
						aria-label={`Resolve ${openFlags} flagged line${openFlags === 1 ? "" : "s"}: go to the next one`}
					>
						<TriangleAlert />
						Resolve {openFlags}
					</ActionBarButton>
				) : null}
				{chat}
				{more}
				<ActionBarDivider />
				<RejectButton actions={actions} />
				<ActionBarButton
					tone="primary"
					decision
					onClick={() => loaded && approve.mutate(loaded)}
					disabled={!approvable}
					pending={approve.isPending}
					aria-describedby={blocked ? captionId : undefined}
					data-testid="approve"
				>
					<Check />
					Approve
				</ActionBarButton>
				{redraft}
			</ActionBar>
		);
	}

	return (
		<ActionBar label="Actions" data-testid="action-bar" data-kind="other">
			{loaded?.state === "rejected_by_filter" && setAsideActions ? (
				<>
					{setAsideActions}
					<ActionBarDivider />
				</>
			) : null}
			{chat}
			<ActionBarButton
				aria-pressed={detailsOpen}
				onClick={toggleDetails}
				data-testid="inspector-toggle"
				title={`Fit, checks, flags and what happens next (${keyHint("toggle-inspector")})`}
			>
				<PanelRight />
				Details
			</ActionBarButton>
			{more}
			{redraft}
		</ActionBar>
	);
}

/** "…": the secondary actions, each with its real name. */
function MoreMenu({
	items,
	onPick,
}: {
	items: MoreItem[];
	onPick: (id: MoreItem["id"]) => void;
}) {
	const top = items.filter((i) => i.id === "redraft");
	const posting = items.filter(
		(i) => i.id === "open-posting" || i.id === "copy-link",
	);
	const doc = items.filter(
		(i): i is Extract<MoreItem, { group: string }> => "group" in i,
	);
	const item = (i: MoreItem) => {
		const disabled = "disabled" in i ? i.disabled : null;
		return (
			<MenuItem
				key={i.id}
				onClick={() => onPick(i.id)}
				disabled={disabled !== null}
				title={disabled ?? undefined}
				data-testid={`more-${i.id}`}
			>
				{MORE_ICON[i.id]}
				{i.label}
				{"hint" in i ? <MenuItemHint>{i.hint}</MenuItemHint> : null}
			</MenuItem>
		);
	};
	return (
		<Menu>
			<MenuTrigger
				render={
					<ActionBarButton
						className="w-9 px-0"
						aria-label="More actions"
						data-testid="more-actions"
					/>
				}
			>
				<Ellipsis />
			</MenuTrigger>
			<MenuContent
				side="top"
				align="center"
				className="w-72"
				data-testid="more-menu"
			>
				{top.map(item)}
				{top.length > 0 ? <MenuSeparator /> : null}
				{posting.map(item)}
				{doc.length > 0 ? (
					<>
						<MenuSeparator />
						<MenuGroup>
							<MenuGroupLabel>{doc[0]?.group}</MenuGroupLabel>
							{doc.map(item)}
						</MenuGroup>
					</>
				) : null}
			</MenuContent>
		</Menu>
	);
}

/** Reject, with the reason it keeps in the Rejected list, in a popover over the bar. */
function RejectButton({ actions }: { actions: ApplicationActions }) {
	const { loaded, rejecting, setRejecting, reject, reason, setReason } =
		actions;
	return (
		<Popover modal open={rejecting} onOpenChange={(open) => setRejecting(open)}>
			<PopoverTrigger
				render={
					<ActionBarButton
						tone="danger"
						decision
						disabled={!loaded}
						data-testid="reject"
					/>
				}
			>
				<X />
				Reject
			</PopoverTrigger>
			<PopoverContent
				side="top"
				align="center"
				sideOffset={10}
				data-testid="reject-popover"
			>
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						reject.mutate();
					}}
				>
					<div className="flex flex-col gap-0.5">
						<PopoverTitle>Reject this draft?</PopoverTitle>
						<PopoverDescription>
							It moves to Rejected with your reason. Nothing is sent.
						</PopoverDescription>
					</div>
					<Input
						autoFocus
						aria-label="Why reject it"
						placeholder="Why? (kept in the rejected list)"
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						data-testid="reject-reason"
					/>
					<div className="flex items-center justify-end gap-2">
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => setRejecting(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							size="sm"
							variant="destructive"
							pending={reject.isPending}
							data-testid="reject-confirm"
						>
							Reject
						</Button>
					</div>
				</form>
			</PopoverContent>
		</Popover>
	);
}
