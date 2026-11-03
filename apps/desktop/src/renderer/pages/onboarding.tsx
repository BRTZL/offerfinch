import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, LoaderCircle } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BrandMark } from "@/components/brand-mark";
import { GeneralSettings } from "@/components/desktop/general";
import { ModelSettings } from "@/components/desktop/models";
import {
	NotificationSettings,
	useNotificationState,
} from "@/components/desktop/notifications";
import {
	type Draft,
	DraftReview,
	ResumeImport,
} from "@/components/desktop/resume-import";
import {
	StepActionProvider,
	useStepAction,
	useStepActionSlot,
} from "@/components/desktop/step-action";
import {
	EmbeddedSave,
	SettingsEmbedded,
} from "@/components/pipeline/settings/shared";
import { AmbientField } from "@/components/system/ambient";
import { AnimatedHeight } from "@/components/system/animated-height";
import { Cells, Notice, StatusDot } from "@/components/system/bits";
import { Group, GroupBody, PageIntro } from "@/components/system/layout";
import { RowsSkeleton } from "@/components/system/skeletons";
import { Button } from "@/components/ui/button";
import { client, orpc } from "@/lib/orpc";
import { preloadable } from "@/lib/preloadable";
import { Link, useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";

const SourcesSettings = preloadable(() =>
	import("@/components/pipeline/settings/sources").then(
		(m) => m.SourcesSettings,
	),
);
const JobFilterSettings = preloadable(() =>
	import("@/components/pipeline/settings/job-filter").then(
		(m) => m.JobFilterSettings,
	),
);
void SourcesSettings.preload();
void JobFilterSettings.preload();

type Step =
	| "ai"
	| "resume"
	| "profile"
	| "rules"
	| "watchlist"
	| "notifications"
	| "login"
	| "scan";

const STEPS: { key: Step; title: string; lead: string }[] = [
	{
		key: "ai",
		title: "Connect your AI",
		lead: "OfferFinch uses AI to read jobs and draft your applications. Use an API key, or your Claude and ChatGPT plans on this Mac. A second AI, from another company, checks every draft.",
	},
	{
		key: "resume",
		title: "Add your resume",
		lead: "Your AI drafts your profile from it. You review it before anything is saved.",
	},
	{
		key: "profile",
		title: "Review your profile",
		lead: "Every line in an application must come from your profile. Remove anything untrue now; you can edit it any time in Profile.",
	},
	{
		key: "rules",
		title: "Job rules",
		lead: "Where you can work, your languages and the titles to look for. Jobs that break a rule are set aside before any AI runs.",
	},
	{
		// Stored as "watchlist" so earlier onboarding progress still reads; it sets up Sources.
		key: "watchlist",
		title: "Where to look",
		lead: "OfferFinch searches the internet for roles that fit you; you never add companies. Choose a search service.",
	},
	{
		key: "notifications",
		title: "Notifications",
		lead: "Hear about new matches, questions and applications ready for review.",
	},
	{
		key: "login",
		title: "Open at login",
		lead: "Optional. OfferFinch starts in the menu bar when you log in and keeps looking every hour.",
	},
	{
		key: "scan",
		title: "First search",
		lead: "Searches now, sets aside jobs that break your rules, then scores the rest. Nothing is drafted until you press Prepare on a match.",
	},
];

/** What the app does, before step 1 on a first start. Shown, not stored: no setup step. */
function Welcome() {
	return (
		<div
			className="flex flex-col items-center gap-8 text-center"
			data-testid="welcome"
		>
			<BrandMark size={64} className="text-foreground" />
			<div id="step-title" className="flex flex-col gap-2">
				<h1 className="text-foreground text-xl font-semibold">
					Welcome to OfferFinch
				</h1>
				<p className="text-muted-foreground text-sm">
					A small bird that brings back offers.
				</p>
			</div>
			<ul className="flex w-full flex-col gap-3 text-left">
				{[
					"Finds roles that fit you, every hour.",
					"Drafts a CV and letter only when you ask, every line from your profile, checked by a second AI.",
					"Sends nothing. You approve, then apply yourself with everything ready to copy.",
					"Runs on this Mac. Your data stays here.",
				].map((line) => (
					<li
						key={line}
						className="text-foreground flex items-start gap-3 text-sm"
					>
						<span className="mt-1.5">
							<StatusDot tone="brand" />
						</span>
						{line}
					</li>
				))}
			</ul>
			<p className="text-muted-foreground text-xs">
				{STEPS.length} short steps. Skip any, and finish later from Home.
			</p>
		</div>
	);
}

function FirstScan({ onDone }: { onDone: () => void }) {
	const queryClient = useQueryClient();
	const [runId, setRunId] = useState<string | null>(null);
	const start = useMutation({
		mutationFn: () => client.desktop.scanNow({}),
		onSuccess: (r) => setRunId(r.id),
		onError: (e) => toast.error(e.message),
	});
	const progress = useQuery({
		...orpc.desktop.scan.queryOptions({ input: { id: runId ?? "" } }),
		enabled: Boolean(runId),
		refetchInterval: (q) =>
			q.state.data && ["complete", "errored"].includes(q.state.data.status)
				? false
				: 1_000,
	});
	const p = progress.data;
	const finished = p?.status === "complete" || p?.status === "errored";
	useEffect(() => {
		if (finished) void queryClient.invalidateQueries();
	}, [finished, queryClient]);
	const result = p?.result as
		| { jobsFetched?: number; jobsInserted?: number }
		| null
		| undefined;
	useStepAction(
		finished
			? {
					label: "Open the Inbox",
					onClick: onDone,
					testId: "onboarding-finish",
				}
			: runId
				? { label: "Searching…", onClick: () => {}, disabled: true, busy: true }
				: {
						label: "Start the first search",
						onClick: () => start.mutate(),
						disabled: start.isPending,
						testId: "first-scan-start",
					},
	);
	return (
		<div className="flex flex-col gap-4" data-testid="first-scan">
			{runId ? (
				<Group>
					<GroupBody className="flex flex-col gap-3">
						{p?.total ? (
							<Cells
								total={p.total}
								on={finished ? p.total : p.done}
								tone="ink"
								label={`${p.done} of ${p.total} read`}
							/>
						) : null}
						<p
							data-testid="first-scan-progress"
							className="text-foreground flex items-center gap-2 text-sm"
						>
							{!finished ? (
								<LoaderCircle
									className="text-muted-foreground size-4 animate-spin"
									aria-hidden
								/>
							) : null}
							{!p
								? "Starting…"
								: p.status === "errored"
									? `The search stopped: ${p.error}`
									: finished
										? `Done: ${result?.jobsFetched ?? 0} jobs read, ${result?.jobsInserted ?? 0} new. Matches appear in the Inbox as they are scored.`
										: "Searching for jobs…"}
						</p>
					</GroupBody>
				</Group>
			) : (
				<p className="text-muted-foreground text-sm">
					It takes a minute or two. You can leave this page; it carries on.
				</p>
			)}
		</div>
	);
}

/**
 * The first run, full window: one centred column over a faint animated field, a minimal step
 * indicator, and a footer whose Back and primary action never move. Each step is skippable;
 * progress is stored, so it resumes where it was left, from Home or after a restart.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep onboarding hook and transition order unchanged; current e2e covers only the completed path.
export default function OnboardingPage() {
	const queryClient = useQueryClient();
	const router = useRouter();
	const state = useQuery(orpc.onboarding.get.queryOptions());
	const status = useQuery({
		...orpc.desktop.status.queryOptions(),
		meta: { quiet: true },
	});
	const noChrome = status.data && !status.data.chrome;
	const notify = useNotificationState();
	const [current, setCurrent] = useState<Step | null>(null);
	// The welcome opens a first start (nothing done or skipped yet) until Get started.
	const [welcome, setWelcome] = useState<boolean | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const { action, slot } = useStepActionSlot();
	const mark = useMutation({
		mutationFn: (input: { step: Step; outcome: "done" | "skipped" }) =>
			client.onboarding.mark(input),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: orpc.onboarding.key() }),
	});
	const dismiss = useMutation({
		mutationFn: () => client.onboarding.dismiss({ dismissed: true }),
		onSuccess: () => router.push("/"),
	});
	const scratch = useMutation({
		// Start from scratch: an empty About record, then the roles and skills are added by hand.
		mutationFn: async () => {
			if (!state.data?.hasProfile)
				await client.profile.saveDraft({
					records: [
						{ kind: "about", source: "you, in the app", data: {} as never },
					],
				});
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries();
			mark.mutate({ step: "resume", outcome: "done" });
			go("profile");
		},
		onError: (e) => toast.error(e.message),
	});
	const done = new Set<string>(state.data?.done ?? []);
	const firstOpen = STEPS.find((s) => !done.has(s.key))?.key ?? "scan";
	const step = current ?? (state.data ? firstOpen : null);
	const index = STEPS.findIndex((s) => s.key === step);
	const meta = STEPS[index];
	const embeddedSave = useRef<(() => Promise<unknown>) | null>(null);
	const [saving, setSaving] = useState(false);
	// Which way the last move went, for the slide.
	const [direction, setDirection] = useState<"forward" | "back">("forward");
	const showWelcome =
		welcome ?? ((state.data?.done.length ?? 0) === 0 && current === null);

	const go = (key: Step, dir: "forward" | "back" = "forward") => {
		setDirection(dir);
		setWelcome(false);
		setCurrent(key);
	};
	const next = async (outcome: "done" | "skipped") => {
		if (!step) return;
		// Continue on a settings step saves what is on screen first; a failed save stays here.
		if (outcome === "done" && embeddedSave.current) {
			setSaving(true);
			try {
				await embeddedSave.current();
			} catch {
				return;
			} finally {
				setSaving(false);
			}
		}
		mark.mutate({ step, outcome });
		const after =
			STEPS.slice(index + 1).find((s) => !done.has(s.key)) ?? STEPS[index + 1];
		go(after?.key ?? "scan");
	};
	const back = () => {
		if (index <= 0) {
			setDirection("back");
			setWelcome(true);
			return;
		}
		go(STEPS[index - 1]?.key ?? "ai", "back");
	};

	if (!state.data || !meta)
		return (
			<div className="bg-background flex h-full flex-col">
				<div className="drag h-13 shrink-0" />
				<div className="mx-auto w-full max-w-160 px-6 pt-12">
					<RowsSkeleton rows={4} twoLine />
				</div>
			</div>
		);

	const notifyBlocked =
		!showWelcome &&
		step === "notifications" &&
		notify.data?.status !== "delivered";
	// The primary action in the footer: the step's own (Draft my profile, Save profile, the first
	// search), Get started on the welcome, otherwise Continue.
	const primary = showWelcome
		? {
				label: "Get started",
				onClick: () => go(step ?? "ai"),
				testId: "welcome-start",
			}
		: (action ?? {
				label: "Continue",
				onClick: () => void next("done"),
				disabled: saving || notifyBlocked,
				busy: saving,
				testId: "step-continue",
				title: notifyBlocked
					? "Send a test notification first, or skip this step"
					: undefined,
			});
	const canSkip = !showWelcome && step !== "scan" && step !== "resume";
	const stepKey = showWelcome ? "welcome" : step;

	return (
		<div
			className="bg-background relative isolate flex h-full flex-col overflow-hidden"
			data-testid="onboarding"
		>
			<AmbientField />
			<header className="drag relative flex h-13 shrink-0 items-center justify-end px-4">
				<Button
					variant="ghost"
					size="sm"
					onClick={() => dismiss.mutate()}
					data-testid="onboarding-later"
				>
					Finish later
				</Button>
			</header>
			<main
				className="relative min-h-0 flex-1 overflow-y-auto"
				aria-labelledby="step-title"
			>
				<div className="flex min-h-full items-center justify-center px-6 py-6">
					<div className="flex w-full max-w-160 flex-col gap-6">
						{showWelcome ? null : (
							<div className="flex flex-col gap-4">
								<div className="flex items-center justify-between gap-4">
									<span className="text-muted-foreground text-xs tabular-nums">
										Step {index + 1} of {STEPS.length}
									</span>
									<nav
										aria-label="Setup steps"
										className="flex items-center gap-1"
									>
										{STEPS.map((s, i) => (
											<button
												key={s.key}
												type="button"
												aria-label={s.title}
												aria-current={s.key === step ? "step" : undefined}
												title={s.title}
												onClick={() =>
													go(s.key, i < index ? "back" : "forward")
												}
												data-testid={`step-${s.key}`}
												className={cn(
													"ease-standard h-1 w-6 rounded-full transition-colors duration-200",
													s.key === step
														? "bg-brand"
														: done.has(s.key)
															? "bg-muted-foreground"
															: "bg-border",
												)}
											/>
										))}
									</nav>
								</div>
								<div id="step-title">
									<PageIntro title={meta.title} description={meta.lead} />
								</div>
							</div>
						)}
						<AnimatedHeight>
							<div
								key={stepKey ?? "none"}
								className="step-in flex flex-col gap-4"
								data-direction={direction}
							>
								{showWelcome ? <Welcome /> : null}
								{noChrome && (
									<Notice
										tone="warning"
										data-testid="onboarding-no-chrome"
										role="status"
									>
										Google Chrome is not installed. OfferFinch uses your
										installed Chrome, in the background, to read careers pages
										and print your CV and letter to PDF; it downloads no browser
										of its own. Install Chrome from google.com/chrome (Chromium,
										Edge or Brave also work), then reopen this step. Everything
										else works without it.
									</Notice>
								)}
								{showWelcome ? null : (
									<StepActionProvider slot={slot}>
										<SettingsEmbedded.Provider value={true}>
											<EmbeddedSave.Provider value={embeddedSave}>
												<Suspense fallback={<RowsSkeleton rows={4} twoLine />}>
													{step === "ai" && <ModelSettings compact />}
													{step === "resume" && (
														<ResumeImport
															onDraft={(d) => {
																setDraft(d);
																mark.mutate({
																	step: "resume",
																	outcome: "done",
																});
																go("profile");
															}}
															onScratch={() => scratch.mutate()}
														/>
													)}
													{step === "profile" &&
														(draft ? (
															<DraftReview
																draft={draft}
																setDraft={setDraft}
																onSaved={() => next("done")}
															/>
														) : (
															<p className="text-foreground text-sm">
																{state.data.hasProfile ? (
																	<>
																		Your profile is saved. Add roles, skills and
																		more any time in{" "}
																		<Link
																			href="/profile/experience"
																			className="text-primary hover:underline"
																		>
																			Profile
																		</Link>
																		.
																	</>
																) : (
																	"Add your resume first; its draft appears here for review."
																)}
															</p>
														))}
													{step === "rules" && <JobFilterSettings />}
													{step === "watchlist" && <SourcesSettings />}
													{step === "notifications" && (
														<NotificationSettings compact />
													)}
													{step === "login" && (
														<Group>
															<GeneralSettings compact />
														</Group>
													)}
													{step === "scan" &&
														(state.data.hasProfile && state.data.sources > 0 ? (
															<FirstScan
																onDone={() => {
																	mark.mutate({
																		step: "scan",
																		outcome: "done",
																	});
																	router.push("/inbox");
																}}
															/>
														) : (
															<p
																className="text-foreground text-sm"
																data-testid="first-scan-blocked"
															>
																A search needs{" "}
																{state.data.hasProfile ? "" : "a saved profile"}
																{!state.data.hasProfile &&
																state.data.sources === 0
																	? " and "
																	: ""}
																{state.data.sources === 0
																	? "a search service in Where to look"
																	: ""}
																.
															</p>
														))}
												</Suspense>
											</EmbeddedSave.Provider>
										</SettingsEmbedded.Provider>
									</StepActionProvider>
								)}
							</div>
						</AnimatedHeight>
					</div>
				</div>
			</main>
			<footer className="relative shrink-0 px-6">
				<div className="mx-auto flex h-16 w-full max-w-160 items-center justify-between gap-2">
					<Button
						variant="ghost"
						onClick={back}
						className={cn("-ml-2.5", showWelcome && "invisible")}
						tabIndex={showWelcome ? -1 : undefined}
						data-testid="step-back"
					>
						<ChevronLeft />
						Back
					</Button>
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							onClick={() => void next("skipped")}
							className={cn(!canSkip && "invisible")}
							tabIndex={canSkip ? undefined : -1}
							data-testid="step-skip"
						>
							Skip for now
						</Button>
						<Button
							className="min-w-36"
							onClick={primary.onClick}
							disabled={primary.disabled}
							title={primary.title}
							data-testid={primary.testId}
						>
							{primary.busy ? (
								<LoaderCircle className="animate-spin" aria-hidden />
							) : null}
							{primary.label}
						</Button>
					</div>
				</div>
			</footer>
		</div>
	);
}
