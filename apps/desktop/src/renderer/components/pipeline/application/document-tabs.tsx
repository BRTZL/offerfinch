import { Ellipsis, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { addedStep } from "@/components/pipeline/added";
import {
	FlagList,
	flagsOf,
	MarkedText,
} from "@/components/pipeline/application/flags";
import { DOC_LABEL, type Kind } from "@/components/pipeline/application/types";
import { ReadingColumn, ReadingPage } from "@/components/system/document";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { desktop } from "@/lib/desktop";
import type { ApplicationActions } from "./use-application-actions";
import { VersionPicker } from "./version-picker";

const TABS: Kind[] = ["cv", "cover_letter", "form_answers"];

const TAB_LABEL: Record<Kind, string> = {
	cv: "CV",
	cover_letter: "Letter",
	form_answers: "Answers",
	notes: "Fit notes",
};

const EDITABLE_STATES = ["ready_for_review", "approved"];
export function applicationDocuments({
	loaded,
	tab,
	setEditing,
	setAnswers,
	setDraft,
	editing,
	view,
	setView,
}: ApplicationActions & { loaded: NonNullable<ApplicationActions["loaded"]> }) {
	const docs = Object.fromEntries(loaded.documents.map((d) => [d.kind, d]));

	const notesHtml =
		(loaded.preview as Record<string, string | null> | undefined)?.notes ??
		null;

	// Nothing drafted (not prepared, or ruled out): the posting is what there is to read.
	const hasDocuments = loaded.documents.some(
		(d) => d.kind === "cv" || d.kind === "cover_letter",
	);

	// A job added by link that is still being read, checked or scored (or failed to read).
	const step = addedStep({
		state: loaded.state,
		source: loaded.job.source,
		readStatus: loaded.job.readStatus,
		readError: loaded.job.readError,
		runStatus: loaded.runStatus,
		filterDecision:
			(loaded.filter as { decision?: string } | null)?.decision ?? null,
	});

	const unread = step === "queued" || step === "reading" || step === "failed";

	const current = docs[tab];

	// An API without previews (an older server) shows the source, as before.
	const rendered =
		tab === "form_answers" || !current
			? null
			: ((loaded.preview as Record<string, string | null> | undefined)?.[tab] ??
				null);

	const canEdit = EDITABLE_STATES.includes(loaded.state);

	const exportsFor = (kind: string) =>
		loaded.exports.filter(
			(e) => e.kind === kind && e.sourceVersion === docs[kind]?.version,
		);

	const pdf = exportsFor(tab).find((e) => e.format === "pdf");

	const docx = exportsFor(tab).find((e) => e.format === "docx");

	const requirements = loaded.fit?.requirements ?? [];

	const startEdit = () => {
		if (!current) return;
		setEditing(tab);
		if (tab === "form_answers") setAnswers(loaded.formAnswers);
		else setDraft(current.content);
	};

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep document state and available reading or editing actions together to preserve their ordering.
	const onDocumentMenu = async (event: React.MouseEvent) => {
		if (editing === tab || !current) return;
		event.preventDefault();
		const choice = await desktop.contextMenu([
			{ id: "open-pdf", label: "Open PDF in Preview", enabled: Boolean(pdf) },
			{ id: "save-pdf", label: "Save PDF…", enabled: Boolean(pdf) },
			{ id: "open-docx", label: "Open Word Document", enabled: Boolean(docx) },
			{ id: "separator" },
			{ id: "copy-text", label: "Copy Text" },
			{
				id: view === "rendered" ? "show-source" : "show-rendered",
				label: view === "rendered" ? "Show Markdown Source" : "Show as Page",
				enabled: rendered !== null,
			},
			...(canEdit
				? [
						{ id: "separator" as const },
						{ id: "edit" as const, label: "Edit…" },
					]
				: []),
		]);
		if (choice === "open-pdf" && pdf)
			desktop.openDocument(pdf.id).catch((e: Error) => toast.error(e.message));
		else if (choice === "save-pdf" && pdf)
			desktop.saveDocument(pdf.id).catch((e: Error) => toast.error(e.message));
		else if (choice === "open-docx" && docx)
			desktop.openDocument(docx.id).catch((e: Error) => toast.error(e.message));
		else if (choice === "copy-text") void desktop.copyText(current.content);
		else if (choice === "show-source") setView("source");
		else if (choice === "show-rendered") setView("rendered");
		else if (choice === "edit") startEdit();
	};
	return {
		requirements,
		current,
		canEdit,
		startEdit,
		onDocumentMenu,
		rendered,
		docs,
		notesHtml,
		hasDocuments,
		unread,
		step,
	};
}
export type DocumentContext = ApplicationActions &
	ReturnType<typeof applicationDocuments> & {
		loaded: NonNullable<ApplicationActions["loaded"]>;
	};

export function DocumentTabs({
	tab,
	setTab,
	setEditing,
	loaded,
	current,
	canEdit,
	editing,
	startEdit,
	onDocumentMenu,
	older,
	setOlder,
}: DocumentContext) {
	return (
		<>
			<Tabs
				value={tab}
				onValueChange={(v) => {
					setTab(v as Kind);
					setEditing(null);
				}}
			>
				<TabsList size="sm" aria-label="Document">
					{TABS.map((kind) => {
						const open = flagsOf(loaded, kind).filter(
							(f) => f.state === "open",
						).length;
						return (
							<TabsTrigger key={kind} value={kind}>
								{TAB_LABEL[kind]}
								{open > 0 ? (
									<span className="text-warning tabular-nums">
										{open}
										<span className="sr-only"> flagged</span>
									</span>
								) : null}
							</TabsTrigger>
						);
					})}
				</TabsList>
			</Tabs>
			{current ? (
				<VersionPicker
					app={loaded}
					kind={tab}
					current={current}
					older={older}
					setOlder={setOlder}
				/>
			) : null}
			{canEdit && editing !== tab && current ? (
				<Button
					size="sm"
					variant="ghost"
					onClick={startEdit}
					aria-label={`Edit ${DOC_LABEL[tab]}`}
				>
					<Pencil />
					Edit
				</Button>
			) : null}
			{current && editing !== tab ? (
				<span data-testid="view-toggle">
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label="More: PDF, Word, source"
						title="Open the PDF, the Word file or the Markdown source"
						onClick={(e) => void onDocumentMenu(e)}
					>
						<Ellipsis />
					</Button>
				</span>
			) : null}
		</>
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep document state and available reading or editing actions together to preserve their ordering.
export function ApplicationReading({
	docBar,
	onDocumentMenu,
	current,
	editing,
	tab,
	loaded,
	refresh,
	answers,
	setAnswers,
	draft,
	setDraft,
	save,
	setEditing,
	rendered,
	view,
}: DocumentContext & { docBar: ReactNode }) {
	return (
		<ReadingColumn bar={docBar} onContextMenu={(e) => void onDocumentMenu(e)}>
			{current && editing !== tab ? (
				<FlagList app={loaded} kind={tab} onChanged={refresh} />
			) : null}
			{!current ? (
				<p className="text-muted-foreground py-12 text-center text-sm">
					{loaded.state === "needs_answers"
						? "Waiting for your answers in Questions before drafting."
						: loaded.state === "preparing" ||
								(loaded.state === "scored" && loaded.prepareRequestedAt)
							? "Drafting now. This updates by itself."
							: loaded.state === "scored" && loaded.job.closedAt
								? "Nothing drafted: this posting looks closed, so Prepare is off."
								: loaded.state === "scored"
									? "Nothing drafted yet. Press Prepare to draft a CV, letter and answers."
									: `No ${DOC_LABEL[tab]?.toLowerCase()} for this application.`}
				</p>
			) : editing === tab ? (
				<div className="flex flex-col gap-3">
					{tab === "form_answers" ? (
						answers.map((a, i) => (
							<div
								key={a.question}
								className="text-foreground flex flex-col gap-1 text-sm"
							>
								<span className="font-medium">{a.question}</span>
								<Textarea
									aria-label={a.question}
									value={a.answer}
									onChange={(e) =>
										setAnswers((all) =>
											all.map((x, j) =>
												j === i ? { ...x, answer: e.target.value } : x,
											),
										)
									}
									className="min-h-20"
								/>
							</div>
						))
					) : (
						<Textarea
							aria-label={`Edit ${DOC_LABEL[tab]}`}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							className="min-h-120 resize-y font-mono text-xs"
							data-testid="editor"
							spellCheck
						/>
					)}
					<div className="flex flex-wrap items-center gap-2">
						<Button
							onClick={() =>
								save.mutate({
									kind: tab,
									content:
										tab === "form_answers"
											? JSON.stringify(answers, null, 2)
											: draft,
									baseVersion: current.version,
								})
							}
							disabled={save.isPending}
							data-testid="save"
						>
							Save version {current.version + 1}
						</Button>
						<Button variant="ghost" onClick={() => setEditing(null)}>
							Cancel
						</Button>
						<span className="text-muted-foreground text-xs">
							{loaded.state === "approved"
								? "Saving withdraws the approval; the new version is checked again."
								: "Every saved version is checked again before it can be approved."}
						</span>
					</div>
				</div>
			) : tab === "form_answers" ? (
				<ReadingPage data-testid="doc-form_answers">
					{loaded.formAnswers.map((a) => (
						<div key={a.question} className="mb-4">
							<p>
								<strong>{a.question}</strong>
							</p>
							<p className="whitespace-pre-wrap">
								<MarkedText
									app={loaded}
									text={a.answer}
									flags={flagsOf(loaded, "form_answers")}
									index={loaded.formAnswers.indexOf(a)}
								/>
							</p>
						</div>
					))}
					{loaded.formAnswers.length === 0 && (
						<p>No form answers for this posting.</p>
					)}
				</ReadingPage>
			) : rendered !== null && view === "rendered" ? (
				<ReadingPage
					html={rendered}
					data-testid={`doc-${tab}`}
					data-view="rendered"
				/>
			) : (
				<ReadingPage data-testid={`doc-${tab}`} data-view="source">
					<pre>
						<MarkedText
							app={loaded}
							text={current.content}
							flags={flagsOf(loaded, tab)}
						/>
					</pre>
				</ReadingPage>
			)}
		</ReadingColumn>
	);
}
