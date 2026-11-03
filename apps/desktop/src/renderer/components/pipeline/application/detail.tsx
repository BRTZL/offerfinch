import { ExternalLink } from "lucide-react";
import { AddedProgress, linkHost } from "@/components/pipeline/added";
import { Locations } from "@/components/pipeline/application/locations";
import {
	PostingText,
	RereadPosting,
} from "@/components/pipeline/application/posting";
import { StatusStrip } from "@/components/pipeline/application/status";
import { postingLinkLabel } from "@/components/pipeline/bits";
import { ChatPanel } from "@/components/pipeline/chat/chat-panel";
import { ErrorLine } from "@/components/system/bits";
import { ReadingColumn, ReadingPage } from "@/components/system/document";
import { ResizeHandle } from "@/components/system/resize-handle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	ApplicationReading,
	applicationDocuments,
	DocumentTabs,
} from "./document-tabs";
import { ApplicationInspector } from "./inspector";
import { DetailSkeleton } from "./skeleton";
import { ApplicationToolbar } from "./toolbar";
import {
	type ApplicationDetailProps,
	useApplicationActions,
} from "./use-application-actions";

export { ToolbarSlot } from "./toolbar";
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
		rejecting,
		reject,
		setRejecting,
		reason,
		setReason,
		rightOpen,
		overlay,
		chatOpen,
	} = actions;

	const toolbar = (
		<ApplicationToolbar
			{...actions}
			matchActions={props.matchActions}
			setAsideActions={props.setAsideActions}
		/>
	);

	if (!loaded)
		return (
			<>
				{toolbar}
				{query.isError ? (
					<div className="p-6">
						<ErrorLine>
							Could not open this application: {query.error.message}
						</ErrorLine>
					</div>
				) : (
					<DetailSkeleton />
				)}
			</>
		);

	const documentState = applicationDocuments({ ...actions, loaded });
	const { requirements, canEdit, hasDocuments, unread, step } = documentState;
	const context = { ...actions, ...documentState, loaded };

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
				<RereadPosting id={loaded.id} className="ml-auto" />
				<a
					href={loaded.job.url}
					target="_blank"
					rel="noreferrer"
					className="text-primary flex items-center gap-1 text-xs hover:underline"
				>
					{postingLinkLabel(loaded.job.source)}
					<ExternalLink className="size-3" />
				</a>
			</div>
			<div
				className="min-h-0 flex-1 overflow-auto px-5 pb-6"
				data-testid="posting"
				data-selectable
			>
				<PostingText
					text={loaded.job.descriptionText}
					requirements={requirements}
				/>
			</div>
		</aside>
	);

	const docBar = <DocumentTabs {...context} />;

	const reading = <ApplicationReading {...context} docBar={docBar} />;

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
		<>
			{toolbar}
			<div ref={rootRef} className="relative flex min-h-0 min-w-0 flex-1">
				{postingOpen && hasDocuments ? posting : null}
				<section
					id="application-detail"
					data-focus="self"
					tabIndex={-1}
					className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
					aria-label={`${loaded.job.title} at ${loaded.company.name}`}
				>
					<header className="mx-auto flex w-full max-w-192 flex-col gap-3 px-6 pt-6 pb-4">
						<div>
							<h2 className="text-foreground text-xl font-semibold">
								{loaded.job.title}
							</h2>
							<p className="text-muted-foreground mt-0.5 text-sm">
								{unread ? linkHost(loaded.job.url) : loaded.company.name}
								{loaded.job.locations.length ? (
									<>
										{" · "}
										<Locations locations={loaded.job.locations} />
									</>
								) : null}
							</p>
						</div>
						{rejecting ? (
							<form
								className="flex flex-wrap items-center gap-2"
								onSubmit={(e) => {
									e.preventDefault();
									reject.mutate();
								}}
								onKeyDown={(e) => {
									if (e.key === "Escape") setRejecting(false);
								}}
							>
								<Input
									autoFocus
									aria-label="Why reject it"
									placeholder="Why? (kept in the rejected list)"
									value={reason}
									onChange={(e) => setReason(e.target.value)}
									className="w-80"
								/>
								<Button
									type="submit"
									variant="destructive"
									disabled={reject.isPending}
								>
									Reject
								</Button>
								<Button
									type="button"
									variant="ghost"
									onClick={() => setRejecting(false)}
								>
									Cancel
								</Button>
							</form>
						) : null}
						<div id="decision-help">
							<StatusStrip app={loaded} />
						</div>
					</header>
					{step ? (
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
					) : hasDocuments ? (
						reading
					) : (
						<ReadingColumn
							bar={
								<>
									<h3 className="text-foreground text-sm font-semibold">
										Posting
									</h3>
									<RereadPosting id={loaded.id} className="ml-auto" />
									<a
										href={loaded.job.url}
										target="_blank"
										rel="noreferrer"
										className="text-primary flex items-center gap-1 text-xs hover:underline"
									>
										{postingLinkLabel(loaded.job.source)}
										<ExternalLink className="size-3" />
									</a>
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
				</section>
				{rightOpen ? (
					<div
						className={
							overlay
								? "absolute inset-y-0 right-0 z-20 flex shadow-2xl"
								: "flex"
						}
					>
						{chatOpen ? chat : inspector}
					</div>
				) : null}
			</div>
		</>
	);
}
