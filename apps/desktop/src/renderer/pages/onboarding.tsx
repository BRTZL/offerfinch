import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { Suspense, useRef, useState } from "react";
import { TryDemoButton } from "@/components/desktop/demo";
import { useNotificationState } from "@/components/desktop/notifications";
import { STEP_META, StepBody } from "@/components/desktop/setup/steps";
import { Welcome } from "@/components/desktop/setup/welcome";
import {
	type StepAction,
	StepActionProvider,
	useStepActionSlot,
} from "@/components/desktop/step-action";
import {
	EmbeddedSave,
	SettingsEmbedded,
} from "@/components/pipeline/settings/shared";
import { AmbientField } from "@/components/system/ambient";
import { AnimatedHeight } from "@/components/system/animated-height";
import { Notice } from "@/components/system/bits";
import { PageIntro } from "@/components/system/layout";
import { RowsSkeleton } from "@/components/system/skeletons";
import { StepTrail } from "@/components/system/step-trail";
import { Button } from "@/components/ui/button";
import { client, orpc } from "@/lib/orpc";
import { useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";
import {
	SETUP_STEPS,
	type SetupStep,
	timeLeft,
} from "../../shared/setup-steps";

/**
 * Finish later. Home sends a user with nothing done straight into setup unless setup was
 * dismissed, and it reads the cached state: refresh that first, or this bounces right back.
 */
async function finishLater(queryClient: QueryClient, goHome: () => void) {
	await client.onboarding.dismiss({ dismissed: true });
	await queryClient.invalidateQueries({ queryKey: orpc.onboarding.key() });
	goHome();
}

function NoChrome() {
	return (
		<Notice tone="warning" data-testid="onboarding-no-chrome" role="status">
			Google Chrome is not installed. OfferFinch uses your installed Chrome, in
			the background, to read careers pages and print your CV and letter to PDF;
			it downloads no browser of its own. Install Chrome from google.com/chrome
			(Chromium, Edge or Brave also work), then reopen this step. Everything
			else works without it.
		</Notice>
	);
}

/** Where you are: the finch on the step trail, "Step 3 of 5", the time left, the title. */
function StepHeader({
	step,
	done,
	go,
}: {
	step: SetupStep;
	done: SetupStep[];
	go: (key: SetupStep, dir: "forward" | "back") => void;
}) {
	const index = SETUP_STEPS.indexOf(step);
	const meta = STEP_META[step];
	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-end justify-between gap-4">
				<span
					className="text-muted-foreground text-xs tabular-nums"
					data-testid="step-count"
				>
					Step {index + 1} of {SETUP_STEPS.length} · {timeLeft(step, done)}
				</span>
				<StepTrail
					steps={SETUP_STEPS.map((key) => ({
						key,
						title: STEP_META[key].title,
						done: done.includes(key),
					}))}
					current={index}
					onPick={(i) =>
						go(SETUP_STEPS[i] ?? "ai", i < index ? "back" : "forward")
					}
				/>
			</div>
			<div id="step-title">
				<PageIntro title={meta.title} description={meta.lead} />
			</div>
		</div>
	);
}

/**
 * Back on the left; Skip and the step's primary action on the right. They never move. On the
 * welcome, Skip's place holds the second way in: Try it with sample data.
 */
function SetupFooter({
	welcome,
	canSkip,
	primary,
	onBack,
	onSkip,
}: {
	welcome: boolean;
	canSkip: boolean;
	primary: StepAction;
	onBack: () => void;
	onSkip: () => void;
}) {
	return (
		<footer className="relative shrink-0 px-6">
			<div className="mx-auto flex h-16 w-full max-w-160 items-center justify-between gap-2">
				<Button
					variant="ghost"
					onClick={onBack}
					className={cn("-ml-2.5", welcome && "invisible")}
					tabIndex={welcome ? -1 : undefined}
					data-testid="step-back"
				>
					<ChevronLeft />
					Back
				</Button>
				<div className="flex items-center gap-2">
					{welcome ? (
						<TryDemoButton />
					) : (
						<Button
							variant="ghost"
							onClick={onSkip}
							className={cn(!canSkip && "invisible")}
							tabIndex={canSkip ? undefined : -1}
							data-testid="step-skip"
						>
							Skip for now
						</Button>
					)}
					<Button
						className="min-w-36"
						onClick={primary.onClick}
						disabled={primary.disabled}
						pending={primary.busy}
						title={primary.title}
						data-testid={primary.testId}
					>
						{primary.label}
					</Button>
				</div>
			</div>
		</footer>
	);
}

function Loading() {
	return (
		<div className="bg-background flex h-full flex-col">
			<div className="drag h-13 shrink-0" />
			<div className="mx-auto w-full max-w-160 px-6 pt-12">
				<RowsSkeleton rows={4} twoLine />
			</div>
		</div>
	);
}

/**
 * The first run, full window: one centred column over a faint animated field, the step trail
 * with the finch, and a footer whose Back and primary action never move. Five steps, each
 * skippable; progress is stored, so it resumes where it was left, from Home or after a restart.
 */
export default function OnboardingPage() {
	const queryClient = useQueryClient();
	const router = useRouter();
	const state = useQuery(orpc.onboarding.get.queryOptions());
	const status = useQuery({
		...orpc.desktop.status.queryOptions(),
		meta: { quiet: true },
	});
	const notify = useNotificationState();
	const [current, setCurrent] = useState<SetupStep | null>(null);
	// The welcome opens a first start (nothing done or skipped yet) until Get started.
	const [welcome, setWelcome] = useState<boolean | null>(null);
	const { action, slot } = useStepActionSlot();
	const mark = useMutation({
		mutationFn: (input: { step: SetupStep; outcome: "done" | "skipped" }) =>
			client.onboarding.mark(input),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: orpc.onboarding.key() }),
	});
	const dismiss = useMutation({
		mutationFn: () => finishLater(queryClient, () => router.push("/")),
	});
	const embeddedSave = useRef<(() => Promise<unknown>) | null>(null);
	const [saving, setSaving] = useState(false);
	// Which way the last move went, for the slide.
	const [direction, setDirection] = useState<"forward" | "back">("forward");

	const done = state.data?.done ?? [];
	const firstOpen = SETUP_STEPS.find((s) => !done.includes(s)) ?? "scan";
	const step = current ?? (state.data ? firstOpen : null);
	const index = step ? SETUP_STEPS.indexOf(step) : -1;
	const showWelcome = welcome ?? (done.length === 0 && current === null);

	const go = (key: SetupStep, dir: "forward" | "back" = "forward") => {
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
			SETUP_STEPS.slice(index + 1).find((s) => !done.includes(s)) ??
			SETUP_STEPS[index + 1];
		go(after ?? "scan");
	};
	const back = () => {
		if (index <= 0) {
			setDirection("back");
			setWelcome(true);
			return;
		}
		go(SETUP_STEPS[index - 1] ?? "ai", "back");
	};

	if (!state.data || !step) return <Loading />;

	const notifyBlocked =
		!showWelcome && step === "loop" && notify.data?.status !== "delivered";
	// The primary action in the footer: the step's own (Draft my profile, Save profile, the first
	// search), Get started on the welcome, otherwise Continue.
	const primary: StepAction = showWelcome
		? { label: "Get started", onClick: () => go(step), testId: "welcome-start" }
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
	// The resume step can be skipped once there is a profile; the first search never.
	const canSkip =
		!showWelcome &&
		step !== "scan" &&
		(step !== "profile" || state.data.hasProfile);

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
							<StepHeader step={step} done={done} go={go} />
						)}
						<AnimatedHeight>
							<div
								key={showWelcome ? "welcome" : step}
								className="step-in flex flex-col gap-4"
								data-direction={direction}
							>
								{status.data && !status.data.chrome ? <NoChrome /> : null}
								{showWelcome ? (
									<Welcome />
								) : (
									<StepActionProvider slot={slot}>
										<SettingsEmbedded.Provider value={true}>
											<EmbeddedSave.Provider value={embeddedSave}>
												<Suspense fallback={<RowsSkeleton rows={4} twoLine />}>
													<StepBody
														step={step}
														hasProfile={state.data.hasProfile}
														sources={state.data.sources}
														onDone={() => void next("done")}
														onFinished={() => {
															mark.mutate({ step: "scan", outcome: "done" });
															router.push("/inbox");
														}}
													/>
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
			<SetupFooter
				welcome={showWelcome}
				canSkip={canSkip}
				primary={primary}
				onBack={back}
				onSkip={() => void next("skipped")}
			/>
		</div>
	);
}
