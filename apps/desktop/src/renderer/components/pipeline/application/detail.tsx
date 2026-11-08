import { ArrowUpRight, ExternalLink, PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useDemoMode } from "@/components/desktop/demo";
import { AddedProgress, linkHost } from "@/components/pipeline/added";
import { Locations } from "@/components/pipeline/application/locations";
import {
	PostingText,
	RereadPosting,
} from "@/components/pipeline/application/posting";
import { StatusStrip } from "@/components/pipeline/application/status";
import { fromFeed, postingLinkLabel } from "@/components/pipeline/bits";
import { ChatPanel } from "@/components/pipeline/chat/chat-panel";
import { ACTION_BAR_SPACE } from "@/components/system/action-bar";
import { ErrorLine } from "@/components/system/bits";
import { ReadingColumn, ReadingPage } from "@/components/system/document";
import { FindBar } from "@/components/system/find-bar";
import { FocusBackdrop } from "@/components/system/focus-backdrop";
import { ResizeHandle } from "@/components/system/resize-handle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DetailActionBar, type DocumentExports } from "./action-bar";
import { barKind, exportTarget } from "./bar-model";
import {
	applicationDocuments,
	DOCUMENT_LABEL,
	DocumentTabs,
} from "./document-tabs";
import { FitCard } from "./fit-card";
import { ApplicationInspector } from "./inspector";
import { DetailSkeleton } from "./skeleton";
import {
	type ApplicationDetailProps,
	useApplicationActions,
} from "./use-application-actions";
import { DocumentReading } from "./versions";

/** The detail's row; ⌘F searches what it marks findable (components/system/find-bar.tsx). */
const ROOT = "relative flex min-h-0 min-w-0 flex-1";

export function ApplicationDetail(props: ApplicationDetailProps) {
	const actions = useApplicationActions(props);
	const {
		loaded,
		query,
		postingWidth,
		postingMax,
		setPostingWidth,
		resetPostingWidth,
		setChatOpen,
		chatWidth,
		rightMax,
		setChatWidth,
		resetChatWidth,
		rootRef,
		postingOpen,
		setPostingOpen,
		tab,
		older,
		detailsOpen,
		toggleDetails,
		rightOpen,
		overlay,
		chatOpen,
	} = actions;

	const bar = (exports: DocumentExports | null) => (
		<DetailActionBar
			actions={actions}
			exports={exports}
			listState={props.listState}
			matchActions={props.matchActions}
			setAsideActions={props.setAsideActions}
			onInterested={props.onInterested}
		/>
	);

	if (!loaded)
		return (
			// The bar is there before the application loads: X in the list opens Not interested on it.
			<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
				{query.isError ? (
					<div className="p-6">
						<ErrorLine>
							Could not open this application: {query.error.message}
						</ErrorLine>
					</div>
				) : (
					<DetailSkeleton />
				)}
				{bar(null)}
			</div>
		);

	const documentState = applicationDocuments({ ...actions, loaded });
	const {
		requirements,
		canEdit,
		hasDocuments,
		unread,
		step,
		current,
		pdf,
		docx,
	} = documentState;
	const context = { ...actions, ...documentState, loaded };
	const kind = barKind(loaded, props.listState);

	const posting = (
		<aside
			aria-label="Posting"
			className="border-border bg-background relative flex shrink-0 flex-col border-r"
			style={{ width: Math.min(postingWidth, Math.max(280, postingMax)) }}
		>
			<ResizeHandle
				edge="end"
				label="Resize the posting"
				width={postingWidth}
				min={280}
				max={Math.min(720, postingMax)}
				onResize={setPostingWidth}
				onReset={resetPostingWidth}
			/>
			<div className="flex h-12 shrink-0 items-center justify-between px-5">
				<h3 className="text-foreground text-sm font-semibold">Posting</h3>
				<PostingLinks id={loaded.id} job={loaded.job} external />
			</div>
			<div
				className={cn("min-h-0 flex-1 overflow-auto px-5", ACTION_BAR_SPACE)}
				data-testid="posting"
				data-selectable
				data-findable
			>
				<PostingText
					text={loaded.job.descriptionText}
					requirements={requirements}
				/>
			</div>
		</aside>
	);

	const docBar = <DocumentTabs {...context} />;

	const reading = <DocumentReading {...context} docBar={docBar} />;

	const inspector = <ApplicationInspector {...context} />;

	const chat = (
		<ChatPanel
			target={{ scope: "application", applicationId: loaded.id }}
			examples={[
				"Make the letter warmer",
				"Mention my Kotlin work in the CV",
				"Shorten answer 2",
			]}
			intro="Ask for a change to the CV, letter or answers, or tell me something about yourself the profile is missing. Nothing changes until you accept it."
			editable={canEdit}
			onClose={() => setChatOpen(false)}
			style={{ width: Math.min(chatWidth, Math.max(300, rightMax)) }}
		>
			<ResizeHandle
				edge="start"
				label="Resize the chat"
				width={chatWidth}
				min={300}
				max={Math.min(640, rightMax)}
				onResize={setChatWidth}
				onReset={resetChatWidth}
			/>
		</ChatPanel>
	);

	return (
		<div ref={rootRef} className={ROOT} data-find-scope>
			{postingOpen && hasDocuments ? posting : null}
			<section
				id="application-detail"
				data-focus="self"
				tabIndex={-1}
				className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none"
				aria-label={`${loaded.job.title} at ${loaded.company.name}`}
			>
				<FindBar />
				<header className="mx-auto flex w-full max-w-192 flex-col gap-3 px-6 pt-6 pb-4">
					<DetailTitle
						app={loaded}
						unread={unread}
						step={step}
						hasDocuments={hasDocuments}
						postingOpen={postingOpen}
						setPostingOpen={setPostingOpen}
					/>
					{loaded.score !== null && !step ? (
						<FitCard
							app={loaded}
							folded={kind !== "match"}
							open={detailsOpen}
							onOpen={toggleDetails}
						/>
					) : null}
					<div id="decision-help">
						<StatusStrip app={loaded} />
					</div>
				</header>
				{step ? (
					<div className={cn("min-h-0 flex-1 overflow-auto", ACTION_BAR_SPACE)}>
						<AddedProgress
							step={step}
							readError={loaded.job.readError}
							job={{
								applicationId: loaded.id,
								url: loaded.job.url,
								title: loaded.job.title,
								description: loaded.job.descriptionText,
							}}
						/>
					</div>
				) : hasDocuments ? (
					reading
				) : (
					<ReadingColumn
						bar={
							<>
								<h3 className="text-foreground text-sm font-semibold">
									Posting
								</h3>
								<PostingLinks id={loaded.id} job={loaded.job} />
							</>
						}
					>
						<ReadingPage data-testid="posting" data-selectable>
							<PostingText
								text={loaded.job.descriptionText}
								requirements={requirements}
							/>
						</ReadingPage>
					</ReadingColumn>
				)}
				{bar({
					label: exportTarget(
						current ? (DOCUMENT_LABEL[tab] ?? null) : null,
						older?.appId === loaded.id && older.kind === tab,
					),
					content: current?.content ?? null,
					pdfId: pdf?.id ?? null,
					docxId: docx?.id ?? null,
					hasDocuments,
				})}
			</section>
			<RightPanel
				open={rightOpen}
				overlay={overlay}
				onClose={() => (chatOpen ? setChatOpen(false) : toggleDetails())}
			>
				{chatOpen ? chat : inspector}
			</RightPanel>
		</div>
	);
}

/**
 * The details or the chat beside the document; in a narrow window laid over it, with the window
 * behind dimmed and blurred (a click there closes it).
 */
function RightPanel({
	open,
	overlay,
	onClose,
	children,
}: {
	open: boolean;
	overlay: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<>
			{overlay ? <FocusBackdrop open={open} onClose={onClose} /> : null}
			{open ? (
				<div
					className={
						overlay ? "absolute inset-y-0 right-0 z-40 flex shadow-2xl" : "flex"
					}
				>
					{children}
				</div>
			) : null}
		</>
	);
}

/** The title, the company and places, and the way to the posting (beside, or out). */
function DetailTitle({
	app,
	unread,
	step,
	hasDocuments,
	postingOpen,
	setPostingOpen,
}: {
	app: NonNullable<ReturnType<typeof useApplicationActions>["loaded"]>;
	unread: boolean;
	step: string | null;
	hasDocuments: boolean;
	postingOpen: boolean;
	setPostingOpen: (open: boolean) => void;
}) {
	// Try-it mode opens no link (the default browser holds the real sessions).
	const demo = useDemoMode();
	return (
		<div className="flex items-start gap-4">
			<div className="min-w-0 flex-1">
				<h2 className="text-foreground text-xl font-semibold">
					{app.job.title}
				</h2>
				<p className="text-muted-foreground mt-0.5 text-sm">
					{unread ? linkHost(app.job.url) : app.company.name}
					{app.job.locations.length ? (
						<>
							{" · "}
							<Locations locations={app.job.locations} />
						</>
					) : null}
				</p>
			</div>
			{hasDocuments ? (
				<Button
					size="sm"
					variant="link"
					className="mt-1 shrink-0"
					aria-pressed={postingOpen}
					onClick={() => setPostingOpen(!postingOpen)}
					data-testid="posting-toggle"
					title="Show the posting beside the document"
				>
					<PanelLeft />
					Posting
				</Button>
			) : step || demo ? null : (
				<a
					href={app.job.url}
					target="_blank"
					rel="noreferrer"
					className="text-primary mt-1 flex shrink-0 items-center gap-1 text-sm hover:underline"
					data-testid="open-posting"
				>
					{fromFeedLabel(app.job.source)}
					<ArrowUpRight className="size-3.5" />
				</a>
			)}
		</div>
	);
}

/** The header's link to the posting: "Open on Remotive" for a feed that asks to be credited. */
function fromFeedLabel(source: string): string {
	const label = postingLinkLabel(source);
	return label === "Open original" ? "Open posting" : label;
}

/**
 * The posting's header links: Re-read (not for a feed's job: the feed gave the whole posting,
 * and its page there is never read) and, beside a document, the link to the original, named
 * after the feed that asks to be credited ("Open on Remotive").
 */
function PostingLinks({
	id,
	job,
	external = false,
}: {
	id: string;
	job: { url: string; source: string };
	/** Also the link out (beside the document; the header has it otherwise). */
	external?: boolean;
}) {
	// Try-it mode opens no link (the default browser holds the real sessions).
	const demo = useDemoMode();
	return (
		<>
			{fromFeed(job.source) ? (
				<span className="ml-auto" />
			) : (
				<RereadPosting id={id} className="ml-auto" />
			)}
			{external && !demo ? (
				<a
					href={job.url}
					target="_blank"
					rel="noreferrer"
					className="text-primary flex items-center gap-1 text-xs hover:underline"
				>
					{postingLinkLabel(job.source)}
					<ExternalLink className="size-3" />
				</a>
			) : null}
		</>
	);
}
