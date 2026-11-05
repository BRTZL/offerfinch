import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ChevronLeft,
	FileText,
	FileUp,
	LoaderCircle,
	PenLine,
	Type,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { useStepAction } from "@/components/desktop/step-action";
import { ErrorLine, IconTile, Notice } from "@/components/system/bits";
import { Group } from "@/components/system/layout";
import { OptionCard } from "@/components/system/option-card";
import { Row } from "@/components/system/rows";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { client, orpc } from "@/lib/orpc";

export type Draft = Awaited<
	ReturnType<typeof client.profile.structure>
>["records"];

async function fileText(file: File): Promise<string> {
	if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
		const bytes = new Uint8Array(await file.arrayBuffer());
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return (await client.profile.pdfText({ base64: btoa(binary) })).text;
	}
	return file.text();
}

const MB = 1_000_000;
const sizeLabel = (bytes: number) =>
	bytes >= MB
		? `${(bytes / MB).toFixed(1)} MB`
		: `${Math.max(1, Math.round(bytes / 1000))} KB`;
const ACCEPT = ".pdf,.txt,.md,application/pdf,text/plain,text/markdown";

/** Why a picked file cannot be read, or null when it can. */
function refuseFile(file: File): string | null {
	if (!/\.(pdf|txt|md|markdown)$/i.test(file.name))
		return "Choose a PDF, TXT or Markdown file.";
	if (file.size > 5 * MB) return "That file is over 5 MB.";
	return null;
}

type Mode = "choose" | "upload" | "paste";
type Picked = {
	name: string;
	size: number;
	state: "reading" | "ready" | "error";
	error?: string;
	words?: number;
};

/**
 * The whole step takes a dropped file, not only the Upload card: `dragging` while one is over
 * it, for the card's highlight.
 */
function useFileDrop(onFile: (file: File) => void, enabled: boolean) {
	const [dragging, setDragging] = useState(false);
	if (!enabled)
		return { dragging: false, props: { "data-testid": "resume-drop" } };
	return {
		dragging,
		props: {
			"data-testid": "resume-drop",
			"data-dragging": dragging || undefined,
			onDragOver: (e: React.DragEvent) => {
				e.preventDefault();
				setDragging(true);
			},
			onDragLeave: (e: React.DragEvent) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null))
					setDragging(false);
			},
			onDrop: (e: React.DragEvent) => {
				e.preventDefault();
				setDragging(false);
				const file = e.dataTransfer.files[0];
				if (file) onFile(file);
			},
		},
	};
}

/**
 * The three ways in. `blocked` (no model can draft yet) turns Upload and Paste off; Start from
 * scratch needs no model.
 */
function ResumeOptions({
	blocked,
	dragging,
	onUpload,
	onPaste,
	onScratch,
}: {
	blocked?: ReactNode;
	dragging: boolean;
	onUpload: () => void;
	onPaste: () => void;
	onScratch?: () => void;
}) {
	const off = Boolean(blocked);
	return (
		<fieldset className="flex flex-col gap-2">
			<legend className="sr-only">How to add your resume</legend>
			<OptionCard
				icon={<FileUp />}
				title="Upload a file"
				description="PDF, TXT or Markdown, up to 5 MB. Click, or drop it anywhere here."
				onClick={onUpload}
				dragging={dragging}
				disabled={off}
				testId="resume-option-upload"
			/>
			<OptionCard
				icon={<Type />}
				title="Paste or type it"
				description="Your resume or a few notes about your work."
				onClick={onPaste}
				disabled={off}
				testId="resume-option-paste"
			/>
			{onScratch ? (
				<OptionCard
					icon={<PenLine />}
					title="Start from scratch"
					description="Add your roles and skills by hand in Profile."
					onClick={onScratch}
					testId="resume-option-scratch"
				/>
			) : null}
		</fieldset>
	);
}

/**
 * Step: the resume, by one of three ways: upload a file (click or drop), paste or type it, or
 * start from scratch. Your AI drafts profile records from the text; nothing is saved until the
 * draft is reviewed. In onboarding, "Draft my profile" sits in the footer.
 */
export function ResumeImport({
	onDraft,
	onScratch,
	blocked,
}: {
	onDraft: (draft: Draft) => void;
	onScratch?: () => void;
	/**
	 * Why no model can draft from a resume yet, shown above the options: Upload, Paste and a
	 * dropped file are off; Start from scratch still works.
	 */
	blocked?: ReactNode;
}) {
	const existing = useQuery({
		...orpc.profile.get.queryOptions(),
		retry: false,
		meta: { quiet: true },
	});
	const [mode, setMode] = useState<Mode>("choose");
	const [text, setText] = useState("");
	const [picked, setPicked] = useState<Picked | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const structure = useMutation({
		mutationFn: () => client.profile.structure({ text }),
		onSuccess: (result) => onDraft(result.records),
	});
	const read = async (file: File) => {
		if (blocked) return;
		setMode("upload");
		setText("");
		structure.reset();
		const refused = refuseFile(file);
		if (refused) {
			setPicked({
				name: file.name,
				size: file.size,
				state: "error",
				error: refused,
			});
			return;
		}
		setPicked({ name: file.name, size: file.size, state: "reading" });
		try {
			const body = (await fileText(file)).trim();
			if (body.length < 20)
				throw new Error(
					"No text could be read from it. If it is a scan, paste the text instead.",
				);
			setText(body);
			setPicked({
				name: file.name,
				size: file.size,
				state: "ready",
				words: body.split(/\s+/).length,
			});
		} catch (error) {
			setPicked({
				name: file.name,
				size: file.size,
				state: "error",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const ready = text.trim().length >= 20 && picked?.state !== "reading";
	const drop = useFileDrop(
		(file) => void read(file),
		!structure.isPending && !blocked,
	);
	const inFooter = useStepAction({
		label: "Draft my profile",
		onClick: () => structure.mutate(),
		disabled:
			mode === "choose" || !ready || structure.isPending || Boolean(blocked),
		busy: structure.isPending,
		testId: "onboarding-structure",
		title:
			mode === "choose" ? "Choose a way to add your resume first" : undefined,
	});
	const back = (
		<Button
			variant="ghost"
			size="sm"
			className="-ml-2.5 self-start"
			onClick={() => {
				setMode("choose");
				structure.reset();
			}}
			disabled={structure.isPending}
			data-testid="resume-back"
		>
			<ChevronLeft />
			Other ways
		</Button>
	);
	const picker = (
		<input
			ref={fileInput}
			type="file"
			accept={ACCEPT}
			className="sr-only"
			tabIndex={-1}
			aria-hidden
			data-testid="onboarding-file"
			onChange={(e) => {
				const file = e.target.files?.[0];
				e.target.value = "";
				if (file) void read(file);
			}}
		/>
	);
	return (
		<div className="flex flex-col gap-4" {...drop.props}>
			{existing.data && (
				<Notice tone="info" data-testid="onboarding-replaces">
					You already have a profile. A new draft replaces it when you save it;
					your answers to questions stay.
				</Notice>
			)}
			{/* Readiness can arrive after a way in was opened: the notice shows in every mode. */}
			{blocked}
			{picker}
			{mode === "choose" && (
				<ResumeOptions
					blocked={blocked}
					dragging={drop.dragging}
					onUpload={() => fileInput.current?.click()}
					onPaste={() => setMode("paste")}
					onScratch={onScratch}
				/>
			)}
			{mode === "upload" && (
				<div className="flex flex-col gap-3">
					{back}
					{picked ? (
						<div
							className="border-border bg-card flex items-center gap-3 rounded-xl border px-4 py-3"
							data-testid="resume-file"
						>
							<IconTile
								tone={picked.state === "error" ? "destructive" : "primary"}
							>
								<FileText />
							</IconTile>
							<span className="min-w-0 flex-1">
								<span
									className="text-foreground block truncate text-sm font-medium"
									data-selectable
								>
									{picked.name}
								</span>
								<span
									className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs"
									data-testid="resume-file-status"
								>
									{picked.state === "reading" ? (
										<>
											<LoaderCircle
												className="size-3 animate-spin"
												aria-hidden
											/>
											Reading the text…
										</>
									) : picked.state === "ready" ? (
										`${sizeLabel(picked.size)} · ${picked.words} words read`
									) : (
										sizeLabel(picked.size)
									)}
								</span>
							</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() => fileInput.current?.click()}
								disabled={picked.state === "reading" || structure.isPending}
								data-testid="resume-replace"
							>
								Replace
							</Button>
						</div>
					) : null}
					{picked?.state === "error" ? (
						<ErrorLine>{picked.error}</ErrorLine>
					) : null}
				</div>
			)}
			{mode === "paste" && (
				<div className="flex flex-col gap-3">
					{back}
					<Textarea
						id="onboarding-text"
						aria-label="Your resume or notes"
						className="min-h-56 resize-none text-sm"
						placeholder={
							"Paste your resume, or type a few lines: your roles, what you did, your skills."
						}
						value={text}
						autoFocus
						disabled={structure.isPending}
						onChange={(e) => setText(e.target.value)}
						data-testid="onboarding-text"
					/>
				</div>
			)}
			{mode !== "choose" &&
				(structure.isPending ? (
					<p
						className="text-muted-foreground flex items-center gap-2 text-sm"
						role="status"
						data-testid="resume-drafting"
					>
						<LoaderCircle className="size-4 animate-spin" aria-hidden />
						Your AI is drafting your profile. This can take a minute.
					</p>
				) : structure.error ? (
					<ErrorLine>{structure.error.message}</ErrorLine>
				) : (
					<p className="text-muted-foreground text-xs">
						You review the draft before anything is saved. Email and phone are
						removed before the text is sent.
					</p>
				))}
			{!inFooter && mode !== "choose" ? (
				<div>
					<Button
						disabled={!ready || Boolean(blocked)}
						pending={structure.isPending}
						onClick={() => structure.mutate()}
						data-testid="onboarding-structure"
					>
						Draft my profile
					</Button>
				</div>
			) : null}
		</div>
	);
}

const KIND_LABEL: Record<Draft[number]["kind"], string> = {
	about: "About you",
	experience: "Experience",
	project: "Projects",
	skill: "Skills",
	education: "Education",
	extra: "Extras",
};

/** One line naming a drafted record. */
function draftLine(record: Draft[number]): { title: string; detail: string } {
	const d = record.data as Record<string, unknown>;
	const s = (k: string) => String(d[k] ?? "").trim();
	const list = (k: string) => (Array.isArray(d[k]) ? (d[k] as string[]) : []);
	switch (record.kind) {
		case "about":
			return {
				title: s("name") || "Your name is missing",
				detail: [s("location"), s("email"), s("summary")]
					.filter(Boolean)
					.join(" · "),
			};
		case "experience":
			return {
				title: [s("company"), s("title")].filter(Boolean).join(" · "),
				detail: [
					[s("start"), s("end") || "Present"].join(" – "),
					`${list("bullets").length} lines`,
				].join(" · "),
			};
		case "project":
			return { title: s("name"), detail: s("description") };
		case "skill":
			return { title: s("name"), detail: "" };
		case "education":
			return {
				title: s("school") || s("field"),
				detail: [s("field"), s("years"), s("note")].filter(Boolean).join(" · "),
			};
		case "extra":
			return { title: s("title"), detail: s("text").split("\n")[0] ?? "" };
	}
}

/** Step: check every drafted record, remove what is wrong, then save it as the profile. */
export function DraftReview({
	draft,
	setDraft,
	onSaved,
}: {
	draft: Draft;
	setDraft: (draft: Draft | null) => void;
	onSaved: () => void;
}) {
	const queryClient = useQueryClient();
	const save = useMutation({
		mutationFn: (records: Draft) => client.profile.saveDraft({ records }),
		onSuccess: async () => {
			toast.success("Profile saved.");
			await queryClient.invalidateQueries();
			onSaved();
		},
		onError: (error) => toast.error(error.message),
	});
	const inFooter = useStepAction({
		label: "Save profile",
		onClick: () => save.mutate(draft),
		disabled: save.isPending,
		busy: save.isPending,
		testId: "onboarding-save",
	});
	const kinds = (Object.keys(KIND_LABEL) as Draft[number]["kind"][]).filter(
		(k) => draft.some((r) => r.kind === k),
	);
	return (
		<div className="flex flex-col gap-4" data-testid="onboarding-draft">
			{kinds.map((kind) => (
				<Group key={kind}>
					<p className="text-muted-foreground px-4 pt-3 pb-1 text-xs font-medium">
						{KIND_LABEL[kind]}
					</p>
					{draft.map((record, index) => {
						if (record.kind !== kind) return null;
						const line = draftLine(record);
						return (
							<Row
								key={index}
								title={line.title || "Untitled"}
								subtitle={line.detail || undefined}
								data-testid="draft-record"
								trailing={
									record.kind === "about" ? null : (
										<Button
											size="sm"
											variant="ghost"
											aria-label={`Remove ${line.title} from the draft`}
											onClick={() =>
												setDraft(draft.filter((_, i) => i !== index))
											}
										>
											Remove
										</Button>
									)
								}
							/>
						);
					})}
				</Group>
			))}
			<div className="flex flex-wrap items-center gap-3">
				{inFooter ? null : (
					<Button
						onClick={() => save.mutate(draft)}
						pending={save.isPending}
						data-testid="onboarding-save"
					>
						Save profile
					</Button>
				)}
				<Button variant="ghost" onClick={() => setDraft(null)}>
					Discard the draft
				</Button>
			</div>
		</div>
	);
}
