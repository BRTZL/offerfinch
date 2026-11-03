import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Briefcase,
	ChevronDown,
	ChevronUp,
	FolderGit2,
	GraduationCap,
	MessageSquare,
	MessageSquareText,
	Plus,
	StickyNote,
	UserRound,
	Wrench,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Redirect } from "wouter";
import { ChatPanel } from "@/components/pipeline/chat/chat-panel";
import {
	FIELDS,
	KIND_NOUN,
	RecordDialog,
	type RecordKind,
} from "@/components/pipeline/profile/record-dialog";
import { EmptyState, Notice } from "@/components/system/bits";
import { Group, Page, PageHeader, Section } from "@/components/system/layout";
import { Markdown } from "@/components/system/markdown";
import { useWidth } from "@/components/system/master-detail";
import {
	ResizeHandle,
	useColumnWidth,
} from "@/components/system/resize-handle";
import { KeyValue, Row } from "@/components/system/rows";
import { RowsSkeleton } from "@/components/system/skeletons";
import { SubNav, SubNavLayout, SubNavLink } from "@/components/system/subnav";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { client, orpc } from "@/lib/orpc";
import { Link, useParams } from "@/lib/router";
import { useStoredState } from "@/lib/use-stored-state";

type SectionKey =
	| "about"
	| "experience"
	| "projects"
	| "skills"
	| "education"
	| "extras"
	| "answers";

const SECTIONS: {
	key: SectionKey;
	kind: RecordKind | null;
	label: string;
	icon: ReactNode;
	empty: string;
}[] = [
	{
		key: "about",
		kind: "about",
		label: "About you",
		icon: <UserRound />,
		empty: "Your name, contact details and a short summary.",
	},
	{
		key: "experience",
		kind: "experience",
		label: "Experience",
		icon: <Briefcase />,
		empty: "Each role with its dates and what you did there.",
	},
	{
		key: "projects",
		kind: "project",
		label: "Projects",
		icon: <FolderGit2 />,
		empty: "Side projects and open source work.",
	},
	{
		key: "skills",
		kind: "skill",
		label: "Skills",
		icon: <Wrench />,
		empty: "Languages, frameworks and tools you use.",
	},
	{
		key: "education",
		kind: "education",
		label: "Education",
		icon: <GraduationCap />,
		empty: "Schools, fields and years.",
	},
	{
		key: "extras",
		kind: "extra",
		label: "Extras",
		icon: <StickyNote />,
		empty: "Languages, certificates, rules about what never to claim.",
	},
	{
		key: "answers",
		kind: null,
		label: "Answers",
		icon: <MessageSquareText />,
		empty: "Your answers to questions land here, dated.",
	},
];

type Rec = Awaited<ReturnType<typeof client.profile.records>>[number];

const day = (value: string | Date) =>
	new Date(value).toISOString().slice(0, 10);

/** Title and subtitle of a record's row. */
function rowText(r: Rec): { title: string; subtitle?: string } {
	const d = r.data as Record<string, unknown>;
	const s = (k: string) => String(d[k] ?? "").trim();
	switch (r.kind) {
		case "experience":
			return {
				title: [s("company"), s("title")].filter(Boolean).join(" · "),
				subtitle: [
					[s("start"), s("end") || (s("start") ? "Present" : "")]
						.filter(Boolean)
						.join(" – "),
					s("location"),
				]
					.filter(Boolean)
					.join(" · "),
			};
		case "project":
			return { title: s("name"), subtitle: s("description") };
		case "skill":
			return { title: s("name") };
		case "education":
			return {
				title: s("school") || s("field"),
				subtitle: [s("field"), s("years")].filter(Boolean).join(" · "),
			};
		case "extra":
			return { title: s("title"), subtitle: s("text").split("\n")[0] };
		default:
			return { title: r.label };
	}
}

function RecordRow({
	record,
	first,
	last,
}: {
	record: Rec;
	first: boolean;
	last: boolean;
}) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const move = useMutation({
		mutationFn: (direction: "up" | "down") =>
			client.profile.moveRecord({ id: record.id, direction }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: orpc.profile.key() }),
		onError: (error) => toast.error(error.message),
	});
	const text = rowText(record);
	return (
		<>
			<Row
				title={text.title || "Untitled"}
				subtitle={text.subtitle || undefined}
				onClick={() => setOpen(true)}
				chevron={false}
				data-testid="record-row"
				trailing={
					<span className="flex items-center">
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="Move up"
							disabled={first || move.isPending}
							onClick={(e) => {
								e.stopPropagation();
								move.mutate("up");
							}}
						>
							<ChevronUp />
						</Button>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="Move down"
							disabled={last || move.isPending}
							onClick={(e) => {
								e.stopPropagation();
								move.mutate("down");
							}}
						>
							<ChevronDown />
						</Button>
					</span>
				}
			/>
			{open ? (
				<RecordDialog
					kind={record.kind}
					record={record}
					open={open}
					onOpenChange={setOpen}
				/>
			) : null}
		</>
	);
}

type Fact = Awaited<ReturnType<typeof client.questions.facts>>[number];

function FactDialog({
	fact,
	open,
	onOpenChange,
}: {
	fact?: Fact;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const queryClient = useQueryClient();
	const [question, setQuestion] = useState(fact?.question ?? "");
	const [answer, setAnswer] = useState(fact?.answer ?? "");
	const done = (message: string) => {
		toast.success(message);
		onOpenChange(false);
		void queryClient.invalidateQueries({
			queryKey: orpc.questions.facts.key(),
		});
		void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
	};
	const save = useMutation({
		mutationFn: () =>
			fact
				? client.profile.facts.update({ id: fact.id, question, answer })
				: client.profile.facts.add({ question, answer }),
		onSuccess: () => done(fact ? "Saved, dated today." : "Added, dated today."),
		onError: (error) => toast.error(error.message),
	});
	const remove = useMutation({
		mutationFn: () => client.profile.facts.remove({ id: fact?.id ?? "" }),
		onSuccess: () => done("Removed from your profile."),
		onError: (error) => toast.error(error.message),
	});
	const ready = question.trim().length >= 3 && answer.trim().length > 0;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-testid="fact-dialog">
				<DialogHeader>
					<DialogTitle>{fact ? "Edit answer" : "Add an answer"}</DialogTitle>
					<DialogDescription>
						A dated fact drafts may cite: what it answers, and your answer.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<form
						id="fact-form"
						className="flex flex-col gap-2 pb-1"
						onSubmit={(e) => {
							e.preventDefault();
							if (ready) save.mutate();
						}}
					>
						<Input
							aria-label="Question"
							placeholder="What it answers, e.g. Notice period"
							value={question}
							onChange={(e) => setQuestion(e.target.value)}
							data-testid="fact-question"
						/>
						<Textarea
							aria-label="Answer"
							placeholder="Your answer, only what is true"
							className="min-h-24"
							value={answer}
							onChange={(e) => setAnswer(e.target.value)}
							data-testid="fact-answer"
						/>
					</form>
				</DialogBody>
				<DialogFooter>
					{fact ? (
						<span className="text-muted-foreground mr-auto text-xs">
							From {fact.source}, {day(fact.answeredAt)}
						</span>
					) : null}
					{fact ? (
						<AlertDialog>
							<AlertDialogTrigger render={<Button variant="ghost" />}>
								Remove
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>Remove this answer?</AlertDialogTitle>
									<AlertDialogDescription>
										New drafts can no longer cite it. A draft whose check cited
										it waits for a new check before you can approve it.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>Keep it</AlertDialogCancel>
									<AlertDialogAction
										variant="destructive"
										onClick={() => remove.mutate()}
									>
										Remove
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					) : null}
					<DialogClose>Cancel</DialogClose>
					<Button
						type="submit"
						form="fact-form"
						disabled={!ready || save.isPending}
						data-testid="fact-add"
					>
						{fact ? "Save" : "Add"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function FactRow({ fact }: { fact: Fact }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Row
				title={fact.question}
				subtitle={fact.answer}
				meta={day(fact.answeredAt)}
				onClick={() => setOpen(true)}
				chevron={false}
				data-testid="fact"
			/>
			{open ? (
				<FactDialog fact={fact} open={open} onOpenChange={setOpen} />
			) : null}
		</>
	);
}

/** About you: one record, shown as its fields. */
function AboutView({ record }: { record: Rec | undefined }) {
	const d = (record?.data ?? {}) as Record<string, unknown>;
	const shown = FIELDS.about.filter((f) => String(d[f.key] ?? "").trim());
	if (!record || shown.length === 0)
		return (
			<Group>
				<EmptyState icon={<UserRound />} title="Nothing here yet">
					{SECTIONS[0]?.empty}
				</EmptyState>
			</Group>
		);
	return (
		<Group>
			{shown.map((f) =>
				f.long ? (
					<div key={f.key} className="flex flex-col gap-1 px-4 py-3">
						<span className="text-muted-foreground text-xs">{f.label}</span>
						<Markdown
							text={String(d[f.key])}
							data-selectable
							data-testid="record-markdown"
						/>
					</div>
				) : (
					<KeyValue
						key={f.key}
						className="px-4 py-2.5 text-sm"
						label={f.label}
						value={<span data-selectable>{String(d[f.key])}</span>}
					/>
				),
			)}
		</Group>
	);
}

/**
 * The profile as records (PLAN C): a section per kind in the second column, each record a row
 * that opens in a sheet, Add in the header. Every fact keeps its source and date.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep profile draft and selection state order unchanged; current e2e does not cover every editor state.
export default function ProfilePage() {
	const { section } = useParams<{ section?: string }>();
	const queryClient = useQueryClient();
	const records = useQuery(orpc.profile.records.queryOptions());
	const facts = useQuery(orpc.questions.facts.queryOptions());
	const legacy = useQuery({
		...orpc.profile.get.queryOptions(),
		retry: false,
		meta: { quiet: true },
	});
	const [adding, setAdding] = useState(false);
	const [chatOpen, setChatOpen] = useStoredState(
		"offerfinch.profileChat",
		false,
	);
	const [chatWidth, setChatWidth, resetChatWidth] = useColumnWidth(
		"profileChat",
		360,
	);
	const [bodyRef, bodyWidth] = useWidth();
	// The records keep 400 px beside the sections column; below that the chat opens over them.
	const chatOverlay = bodyWidth > 0 && bodyWidth < 220 + 400 + chatWidth;
	const chatMax = chatOverlay ? bodyWidth - 120 : bodyWidth - 220 - 400;
	const convert = useMutation({
		mutationFn: () => client.profile.convert({}),
		onSuccess: (r) => {
			toast.success(
				r.records > 0
					? `Converted into ${r.records} records. A copy of your data is in backups.`
					: "Nothing to convert.",
			);
			void queryClient.invalidateQueries({ queryKey: orpc.profile.key() });
		},
		onError: (error) => toast.error(error.message),
	});

	const current = SECTIONS.find((s) => s.key === section);
	if (!current) return <Redirect to="/profile/about" replace />;
	const all = records.data ?? [];
	const about = all.find((r) => r.kind === "about");
	const ofKind = current.kind ? all.filter((r) => r.kind === current.kind) : [];
	const count = (s: (typeof SECTIONS)[number]) =>
		s.kind === null
			? (facts.data?.length ?? 0)
			: s.kind === "about"
				? undefined
				: all.filter((r) => r.kind === s.kind).length;
	const unconverted =
		records.isSuccess && all.length === 0 && Boolean(legacy.data);

	const addLabel =
		current.kind === "about"
			? about
				? "Edit"
				: "Add"
			: current.kind
				? `Add ${KIND_NOUN[current.kind]}`
				: "Add answer";

	return (
		<>
			<PageHeader title="Profile" subtitle={current.label}>
				<Button
					size="sm"
					variant="ghost"
					aria-pressed={chatOpen}
					onClick={() => setChatOpen(!chatOpen)}
					disabled={unconverted}
					data-testid="profile-chat-toggle"
					aria-label="Chat"
					title="Tell OfferFinch about your work; it drafts records for you to accept"
				>
					<MessageSquare />
					Chat
				</Button>
				<Button
					size="sm"
					onClick={() => setAdding(true)}
					disabled={unconverted}
					data-testid="profile-add"
				>
					{current.kind === "about" && about ? null : <Plus />}
					{addLabel}
				</Button>
			</PageHeader>
			<div ref={bodyRef} className="relative flex min-h-0 min-w-0 flex-1">
				<SubNavLayout
					nav={
						<SubNav label="Profile sections">
							{SECTIONS.map((s) => (
								<SubNavLink
									key={s.key}
									href={`/profile/${s.key}`}
									icon={s.icon}
									active={s.key === current.key}
									count={count(s)}
								>
									{s.label}
								</SubNavLink>
							))}
						</SubNav>
					}
				>
					<Page width="form">
						{unconverted ? (
							<Notice tone="info" data-testid="profile-unconverted">
								<span className="flex flex-col items-start gap-2">
									<span>
										Your profile is still kept as files from an earlier version.
										Convert it to records to edit it here. A full copy of your
										data is saved first; nothing is lost, and answers stay.
									</span>
									<Button
										size="sm"
										onClick={() => convert.mutate()}
										disabled={convert.isPending}
										data-testid="profile-convert"
									>
										{convert.isPending ? "Converting…" : "Convert"}
									</Button>
								</span>
							</Notice>
						) : null}
						<Section
							description={
								current.key === "answers"
									? "Your answers to questions and anything you add here, each dated. Drafts may cite them."
									: undefined
							}
						>
							{records.isLoading ||
							(current.kind === null && facts.isLoading) ? (
								<RowsSkeleton rows={4} twoLine />
							) : current.kind === "about" ? (
								<AboutView record={about} />
							) : current.kind === null ? (
								facts.data?.length ? (
									<Group>
										{facts.data.map((fact) => (
											<FactRow key={fact.id} fact={fact} />
										))}
									</Group>
								) : (
									<Group>
										<EmptyState icon={current.icon} title="No answers yet">
											{current.empty}
										</EmptyState>
									</Group>
								)
							) : ofKind.length > 0 ? (
								<Group>
									{ofKind.map((r, i) => (
										<RecordRow
											key={r.id}
											record={r}
											first={i === 0}
											last={i === ofKind.length - 1}
										/>
									))}
								</Group>
							) : (
								<Group>
									<EmptyState icon={current.icon} title="Nothing here yet">
										{current.empty}{" "}
										{all.length === 0 && !unconverted ? (
											<Link
												href="/onboarding"
												className="text-primary hover:underline"
											>
												Import your resume
											</Link>
										) : null}
									</EmptyState>
								</Group>
							)}
						</Section>
					</Page>
				</SubNavLayout>
				{chatOpen && !unconverted ? (
					<div
						className={
							chatOverlay
								? "absolute inset-y-0 right-0 z-20 flex shadow-2xl"
								: "flex"
						}
					>
						<ChatPanel
							target={{ scope: "profile" }}
							title="Profile chat"
							examples={[
								"I built a billing service at my last job in 2024 with Go and Postgres; it cut latency 40%",
								"Make my experience bullets stronger",
								"What is my profile missing for senior roles?",
							]}
							intro="Tell me about a role, project or skill in your own words. I draft records for you to accept and ask about anything missing; I never make up numbers, dates or tools."
							onClose={() => setChatOpen(false)}
							style={{ width: Math.min(chatWidth, Math.max(300, chatMax)) }}
						>
							<ResizeHandle
								edge="start"
								label="Resize the chat"
								width={chatWidth}
								min={300}
								max={Math.min(640, chatMax)}
								onResize={setChatWidth}
								onReset={resetChatWidth}
							/>
						</ChatPanel>
					</div>
				) : null}
			</div>
			{adding && current.kind ? (
				<RecordDialog
					kind={current.kind}
					record={current.kind === "about" ? about : undefined}
					open={adding}
					onOpenChange={setAdding}
				/>
			) : null}
			{adding && current.kind === null ? (
				<FactDialog open={adding} onOpenChange={setAdding} />
			) : null}
		</>
	);
}
