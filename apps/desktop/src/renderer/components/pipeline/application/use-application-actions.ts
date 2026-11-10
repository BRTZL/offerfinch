import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { addedStep } from "@/components/pipeline/added";
import type { Kind } from "@/components/pipeline/application/types";
import { useWidth } from "@/components/system/master-detail";
import { useColumnWidth } from "@/components/system/resize-handle";
import { useCommand } from "@/lib/commands";
import { client, orpc } from "@/lib/orpc";
import { useStoredState } from "@/lib/use-stored-state";
import { matches } from "../../../../shared/shortcuts";
import type { OlderVersion } from "./version-picker";
export type ApplicationDetailProps = {
	id: string;
	/** The state the list shows for this row, before the detail has loaded. */
	listState?: string;
	/** Bumped by the list's right-click Reject to open the reason form. */
	rejectRequest: number;
	/** In the action bar before Interested while this is a match nobody acted on (the Inbox's Not interested). */
	matchActions?: ReactNode;
	/** Interested, as the list does it (P): drafts it and moves on. Otherwise drafts it here. */
	onInterested?: () => void;
	/** Shown while the job filter has set this job aside (the Inbox's Show in Matches). */
	setAsideActions?: ReactNode;
};
/**
 * Prepare was refused: the reason as it came (a posting found closed just now among them), and
 * the page and the Inbox read again so a closed posting shows closed and leaves Matches.
 */
export function prepareRefused(queryClient: QueryClient, error: unknown) {
	toast.error(error instanceof Error ? error.message : String(error));
	void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
	void queryClient.invalidateQueries({ queryKey: ["inbox"] });
}

export function useApplicationActions({
	id,
	listState,
	rejectRequest,
}: ApplicationDetailProps) {
	const queryClient = useQueryClient();

	const query = useQuery({
		...orpc.application.get.queryOptions({ input: { id } }),
		refetchInterval: (q) => {
			const d = q.state.data;
			if (!d) return 10_000;
			const step = addedStep({
				state: d.state,
				source: d.job.source,
				readStatus: d.job.readStatus,
				readError: d.job.readError,
				runStatus: d.runStatus,
				filterDecision:
					(d.filter as { decision?: string } | null)?.decision ?? null,
			});
			if (step && step !== "failed") return 1_000;
			if (d.redraft && !d.redraft.problem) return 2_000;
			return d.reviewCurrent ? 10_000 : 2_000;
		},
	});

	const [tab, setTab] = useState<Kind>("cv");

	// Both closed by default: the screen is the document and the decision. The details open by
	// themselves when a flag or a hand-off needs the user (below).
	const [postingOpen, setPostingOpen] = useStoredState(
		"offerfinch.posting",
		false,
	);

	const [detailsOpen, setDetailsOpen] = useState(false);

	// The chat and the details share the right column: opening one closes the other.
	// Not kept between applications, so the details still open by themselves where a flag or
	// a hand-off needs the user; a reply in progress is kept in the thread either way.
	const [chatOpen, setChatOpen] = useState(false);

	const toggleChat = () => {
		if (!chatOpen) setDetailsOpen(false);
		setChatOpen(!chatOpen);
	};

	const toggleDetails = () => {
		if (!detailsOpen) setChatOpen(false);
		setDetailsOpen(!detailsOpen);
	};

	const [autoOpened, setAutoOpened] = useState<string | null>(null);

	const [editing, setEditing] = useState<Kind | null>(null);

	const [older, setOlder] = useState<OlderVersion | null>(null);

	/** Rendered as it will be exported (the default), or the Markdown source. */
	const [view, setView] = useState<"rendered" | "source">("rendered");

	const [draft, setDraft] = useState("");

	const [answers, setAnswers] = useState<
		{ question: string; answer: string }[]
	>([]);

	const [rejecting, setRejecting] = useState(false);

	const [seenRejectRequest, setSeenRejectRequest] = useState(rejectRequest);

	if (rejectRequest !== seenRejectRequest) {
		setSeenRejectRequest(rejectRequest);
		setRejecting(true);
	}

	const [reason, setReason] = useState("");

	const actionKey = useRef(crypto.randomUUID());

	const [rootRef, rootWidth] = useWidth();

	useInspectorToggle(toggleDetails);

	// The document keeps at least 480 px: panels dock beside it when that leaves room, and
	// otherwise open over it (closed again with Esc or their toolbar button).
	const READING_MIN = 480;

	// Both panels can be dragged wider or narrower; the widths are kept between launches.
	const [postingWidth, setPostingWidth, resetPostingWidth] = useColumnWidth(
		"posting",
		360,
	);

	const [detailsWidth, setDetailsWidth, resetDetailsWidth] = useColumnWidth(
		"details",
		280,
	);

	const [chatWidth, setChatWidth, resetChatWidth] = useColumnWidth("chat", 360);

	const rightOpen = chatOpen || detailsOpen;

	const rightWidth = chatOpen ? chatWidth : detailsWidth;

	const postingOverlay =
		rootWidth > 0 && rootWidth < READING_MIN + postingWidth;

	const overlay =
		rootWidth > 0 &&
		rootWidth <
			READING_MIN +
				rightWidth +
				(postingOpen && !postingOverlay ? postingWidth : 0);

	// Docked, a panel can grow until the document is down to its minimum; over the document,
	// until it leaves 120 px of it showing.
	const postingDocked = postingOpen && !postingOverlay;

	const rightDocked = rightOpen && !overlay;

	const postingMax = postingOverlay
		? rootWidth - 120
		: rootWidth - READING_MIN - (rightDocked ? rightWidth : 0);

	const rightMax = overlay
		? rootWidth - 120
		: rootWidth - READING_MIN - (postingDocked ? postingWidth : 0);

	useEffect(() => {
		if (!(overlay && rightOpen) && !(postingOverlay && postingOpen)) return;
		const onKey = (event: KeyboardEvent) => {
			if (!matches(event, "close-panels")) return;
			setDetailsOpen(false);
			setChatOpen(false);
			if (postingOverlay) setPostingOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [overlay, rightOpen, postingOverlay, postingOpen, setPostingOpen]);

	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: orpc.application.get.key() });

	const refreshLists = () =>
		Promise.all([
			refresh(),
			queryClient.invalidateQueries({ queryKey: ["inbox"] }),
			queryClient.invalidateQueries({ queryKey: orpc.inbox.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.desktop.key() }),
			// Sent: its progress after Applied shows at once.
			queryClient.invalidateQueries({ queryKey: orpc.tracking.key() }),
		]);

	const app = query.data;

	// The loaded object is this application (no placeholder from another row).
	const loaded = app && app.id === id ? app : undefined;

	const save = useMutation({
		mutationFn: (input: { kind: Kind; content: string; baseVersion: number }) =>
			client.application.editDocument({ id, ...input }),
		onSuccess: (result) => {
			setEditing(null);
			toast.success(
				result.revoked
					? `Saved version ${result.version}. The approval was revoked; review again.`
					: `Saved version ${result.version}. Checking claims…`,
			);
			void refresh();
		},
		onError: (error) => toast.error(error.message),
	});

	const approve = useMutation({
		mutationFn: (target: NonNullable<typeof loaded>) =>
			client.application.approve({
				id: target.id,
				hashes: target.currentHashes ?? {},
				idempotencyKey: actionKey.current,
			}),
		onSuccess: () => {
			toast.success("Approved these exact documents.");
			actionKey.current = crypto.randomUUID();
			void refreshLists();
		},
		onError: (error) => toast.error(error.message),
	});

	const reject = useMutation({
		mutationFn: () =>
			client.application.reject({
				id,
				reason,
				idempotencyKey: actionKey.current,
			}),
		onSuccess: () => {
			toast.success("Rejected. It is listed under Rejected with your reason.");
			setRejecting(false);
			actionKey.current = crypto.randomUUID();
			void refreshLists();
		},
		onError: (error) => toast.error(error.message),
	});

	const { retry, markSubmitted, confirmedNotSent, setConfirmedNotSent } =
		useSubmissionActions(id, refresh, refreshLists);

	const dryRun = useMutation({
		mutationFn: () => client.submission.dryRun({ id }),
		onSuccess: () => {
			toast.success("Dry run finished: nothing was submitted.");
			void refresh();
		},
		onError: (error) => toast.error(error.message),
	});

	const openFlags = loaded?.openFlags ?? 0;
	const needsDetails = detailsNeeded(loaded);

	// Only where it docks: an auto-opened overlay would hide the very flag it is about.
	if (
		needsDetails &&
		needsDetails !== autoOpened &&
		rootWidth > 0 &&
		!overlay &&
		!chatOpen
	) {
		setAutoOpened(needsDetails);
		setDetailsOpen(true);
	}

	const jumpToFlag = () => {
		// The open document's first flag, else the first anywhere (in reading order).
		const open = (loaded?.flags ?? []).filter((f) => f.state === "open");
		const first = open.find((f) => f.document === tab) ?? open[0];
		if (!first) return;
		setEditing(null);
		setView("rendered");
		setTab(first.document as Kind);
		requestAnimationFrame(() => {
			const el = document.getElementById(`flag-${first.id}`);
			el?.scrollIntoView({ block: "center" });
			el?.focus();
		});
	};

	const inReview = (loaded?.state ?? listState) === "ready_for_review";

	const prepare = useMutation({
		mutationFn: () => client.application.prepare({ id }),
		onSuccess: () => {
			toast.success("Drafting started. It shows up here when it is ready.");
			void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.inbox.key() });
		},
		onError: (error) => prepareRefused(queryClient, error),
	});

	const approvable = Boolean(loaded?.approvable && !approve.isPending);
	return {
		older,
		setOlder,
		loaded,
		postingOpen,
		setPostingOpen,
		chatOpen,
		toggleChat,
		detailsOpen,
		toggleDetails,
		prepare,
		inReview,
		rejecting,
		openFlags,
		jumpToFlag,
		setRejecting,
		approve,
		approvable,
		query,
		tab,
		setEditing,
		setAnswers,
		setDraft,
		editing,
		view,
		setView,
		postingWidth,
		postingMax,
		setPostingWidth,
		resetPostingWidth,
		setTab,
		refresh,
		answers,
		draft,
		save,
		detailsWidth,
		rightMax,
		setDetailsWidth,
		resetDetailsWidth,
		confirmedNotSent,
		setConfirmedNotSent,
		retry,
		markSubmitted,
		dryRun,
		setChatOpen,
		chatWidth,
		setChatWidth,
		resetChatWidth,
		rootRef,
		reject,
		reason,
		setReason,
		rightOpen,
		overlay,
	};
}
export type ApplicationActions = ReturnType<typeof useApplicationActions>;

/**
 * Retry, I submitted this and Got the email. Each names the attempt the page showed
 * (`currentAttempt`, passed by the button pressed); the worker refuses it once that changed.
 */
function useSubmissionActions(
	id: string,
	refresh: () => Promise<unknown>,
	refreshLists: () => Promise<unknown>,
) {
	const submitKey = useRef(crypto.randomUUID());

	const [confirmedNotSent, setConfirmedNotSent] = useState(false);

	/**
	 * A confirmation named an attempt that changed since the page showed it (another run, another
	 * window): the page reads again and the box is unticked, so the user looks again.
	 */
	const submissionRefused = (error: Error) => {
		toast.error(error.message);
		setConfirmedNotSent(false);
		void refreshLists();
	};

	const retry = useMutation({
		/** `attemptId`: the attempt the page showed (`currentAttempt`), from the button pressed. */
		mutationFn: (input: { attemptId: string | null }) =>
			client.submission.retry({
				id,
				attemptId: input.attemptId,
				confirmedNotSent,
				idempotencyKey: submitKey.current,
			}),
		onSuccess: () => {
			toast.success("Retrying the submission.");
			submitKey.current = crypto.randomUUID();
			setConfirmedNotSent(false);
			void refresh();
		},
		onError: submissionRefused,
	});

	const markSubmitted = useMutation({
		/**
		 * I submitted this, or Got the email (`gotEmail`: the sent attempt went through). Sent by
		 * hand after "It didn't go through" was ticked, the clicked attempt is recorded not sent.
		 * `attemptId`: the attempt the page showed (`currentAttempt`), from the button pressed.
		 */
		mutationFn: (input: {
			appliedOn: string;
			attemptId: string | null;
			gotEmail?: boolean;
		}) =>
			client.submission.markSubmitted({
				id,
				attemptId: input.attemptId,
				idempotencyKey: submitKey.current,
				appliedOn: input.appliedOn,
				confirmedNotSent: !input.gotEmail && confirmedNotSent,
			}),
		onSuccess: () => {
			toast.success("Marked as applied.");
			submitKey.current = crypto.randomUUID();
			void refreshLists();
		},
		onError: submissionRefused,
	});

	return { retry, markSubmitted, confirmedNotSent, setConfirmedNotSent };
}

/** Opens the inspector with ⌘⌥I (View › Show or Hide Inspector). */
function useInspectorToggle(toggle: () => void) {
	useCommand("toggle-inspector", toggle);
}

/**
 * Open the details once when they hold the next step: a flag to settle, a hand-off, or (once
 * sent) its progress with the employer. The key changes when the reason does.
 */
function detailsNeeded(
	loaded: { state: string; openFlags?: number } | null | undefined,
): string | null {
	if (!loaded) return null;
	const flagged = (loaded.openFlags ?? 0) > 0;
	return flagged ||
		["approved", "needs_human", "applied"].includes(loaded.state)
		? `${loaded.state}:${flagged}`
		: null;
}
