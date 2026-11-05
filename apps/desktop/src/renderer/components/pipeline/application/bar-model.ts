/**
 * What the detail's floating action bar offers for an application, and why Approve is off when
 * it is. No imports from the app: unit-tested in node.
 */

export interface BarApp {
	state: string;
	prepareRequestedAt: Date | string | null;
	endedReason: string | null;
	job: { closedAt: Date | string | null; source?: string };
	openFlags?: number;
	approvable?: boolean;
	reviewCurrent?: boolean;
	checkError?: unknown;
	staleProfile?: unknown[];
}

/**
 * `match`: decide (Not interested, Interested). `review`: resolve, reject or approve. `other`:
 * the state's own actions and Chat.
 */
export function barKind(
	app: BarApp | undefined,
	listState?: string,
): "match" | "review" | "other" {
	if (!app) return listState === "ready_for_review" ? "review" : "other";
	if (
		app.state === "scored" &&
		!app.prepareRequestedAt &&
		!app.endedReason &&
		!app.job.closedAt
	)
		return "match";
	return app.state === "ready_for_review" ? "review" : "other";
}

/** Why Approve is off, as the caption under the bar; null when it can be pressed. */
export function approveBlocked(app: BarApp | undefined): string | null {
	if (!app) return "Loading the documents and checks.";
	if (app.approvable) return null;
	const flags = app.openFlags ?? 0;
	if (flags > 0)
		return flags === 1
			? "Approve opens once the flagged line is resolved: edit, delete or confirm it."
			: `Approve opens once the ${flags} flagged lines are resolved: edit, delete or confirm each.`;
	if ((app.staleProfile?.length ?? 0) > 0)
		return "Your profile changed since the check: check again before approving.";
	if (!app.reviewCurrent && !app.checkError)
		return "Approve opens when the check of this version passes.";
	return "Only documents that passed every check can be approved.";
}

export type MoreItem =
	| { id: "redraft"; label: string; hint: string; disabled: string | null }
	| { id: "open-posting" | "copy-link"; label: string }
	| {
			id: "save-pdf" | "open-docx" | "copy-text";
			label: string;
			group: string;
			disabled: string | null;
	  };

const REDRAFT_STATES = ["ready_for_review", "approved"];

/**
 * The "…" menu: the review's secondary actions, with real labels (no trailing dots): Redraft,
 * the posting, and the open document's exports.
 */
export function moreItems(input: {
	app: BarApp & { redraft?: { problem?: unknown } | null };
	hasDocuments: boolean;
	/** The document the exports act on ("CV", "Letter"); null when it has none. */
	document: string | null;
	pdf: boolean;
	docx: boolean;
}): MoreItem[] {
	const { app } = input;
	const items: MoreItem[] = [];
	if (REDRAFT_STATES.includes(app.state) && input.hasDocuments)
		items.push({
			id: "redraft",
			label: "Redraft",
			hint: "CV, letter or answers",
			disabled: app.job.closedAt
				? "This posting looks closed, so Redraft is off"
				: app.redraft && !app.redraft.problem
					? "A redraft is already running"
					: app.state === "ready_for_review" &&
							!app.reviewCurrent &&
							!app.checkError
						? "The current version is still being checked"
						: null,
		});
	items.push(
		{ id: "open-posting", label: "Open Posting" },
		{ id: "copy-link", label: "Copy Posting Link" },
	);
	if (input.document) {
		const group = input.document;
		items.push(
			{
				id: "save-pdf",
				label: "Save PDF",
				group,
				disabled: input.pdf ? null : "The PDF is not exported yet",
			},
			{
				id: "open-docx",
				label: "Open Word Document",
				group,
				disabled: input.docx ? null : "The Word file is not exported yet",
			},
			{ id: "copy-text", label: "Copy Text", group, disabled: null },
		);
	}
	return items;
}
