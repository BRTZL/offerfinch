import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { GeneralSettings } from "@/components/desktop/general";
import { NotificationSettings } from "@/components/desktop/notifications";
import {
	type Draft,
	DraftReview,
	ResumeImport,
} from "@/components/desktop/resume-import";
import { useStepAction } from "@/components/desktop/step-action";
import { Notice } from "@/components/system/bits";
import { Group, Section } from "@/components/system/layout";
import { Button } from "@/components/ui/button";
import { client, orpc } from "@/lib/orpc";
import { preloadable } from "@/lib/preloadable";
import { providerOfRef, readyNow } from "../../../../shared/auto-connect";
import type { SetupStep } from "../../../../shared/setup-steps";
import { ConnectAi } from "./connect-ai";
import { FirstScan } from "./first-scan";

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

/** Each step's title and one line on what it is for. */
export const STEP_META: Record<SetupStep, { title: string; lead: string }> = {
	ai: {
		title: "Connect your AI",
		lead: "OfferFinch runs on the AI plans you already pay for. It looked on this computer; you need at least one signed in.",
	},
	profile: {
		title: "Your resume",
		lead: "Your AI turns it into a profile, and you check every line before it's saved. Applications only ever use what's in it.",
	},
	wants: {
		title: "What you want",
		lead: "What you want, and where to look. Your AI weighs every job it finds against it.",
	},
	loop: {
		title: "Stay in the loop",
		lead: "Hear about new matches, questions and drafts ready for review, and let OfferFinch keep looking while you work.",
	},
	scan: {
		title: "First search",
		lead: "OfferFinch searches now and scores every job it finds against what you want. Nothing is drafted until you press Prepare.",
	},
};

/**
 * Whether a model can draft a profile from a resume now: `profile.structure` runs on the scoring
 * model. A plan's role is ready only while its provider is signed in (`readyNow`), so the
 * providers are read only when scoring is on one. Null while that is still being read.
 */
function useCanDraft(): boolean | null {
	const ai = useQuery(orpc.ai.get.queryOptions());
	const scoring = ai.data?.roles.find((r) => r.role === "scoring");
	const onPlan = providerOfRef(scoring?.model ?? null) !== null;
	const models = useQuery({
		...orpc.ai.models.queryOptions(),
		staleTime: 30_000,
		enabled: Boolean(scoring?.ready && onPlan),
		meta: { quiet: true },
	});
	if (!ai.data) return null;
	if (!scoring?.ready) return false;
	if (!onPlan) return true;
	if (!models.data) return models.isError ? false : null;
	const [now] = readyNow(
		[scoring],
		Object.fromEntries(
			models.data.providers.map((p) => [p.provider, p.signedIn]),
		),
	);
	return Boolean(now?.ready);
}

/** No model can draft yet: say so before anything is pasted, and offer the way back. */
function ConnectAiFirst({ onConnect }: { onConnect: () => void }) {
	return (
		<Notice
			tone="warning"
			data-testid="resume-needs-ai"
			title="Connect your AI first to draft a profile from your resume"
			actions={
				<Button
					variant="outline"
					onClick={onConnect}
					data-testid="resume-connect-ai"
				>
					Connect your AI
				</Button>
			}
		>
			Uploading or pasting needs a model to read it. You can still start from
			scratch and add your roles and skills by hand.
		</Notice>
	);
}

/** Your resume, then the draft it makes, reviewed in the same step. */
function ProfileStep({
	hasProfile,
	onDone,
	go,
}: {
	hasProfile: boolean;
	onDone: () => void;
	go: (step: SetupStep) => void;
}) {
	const queryClient = useQueryClient();
	const canDraft = useCanDraft();
	const [draft, setDraft] = useState<Draft | null>(null);
	const scratch = useMutation({
		// Start from scratch: an empty About record, then the roles and skills are added by hand.
		mutationFn: async () => {
			if (!hasProfile)
				await client.profile.saveDraft({
					records: [
						{ kind: "about", source: "you, in the app", data: {} as never },
					],
				});
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries();
			onDone();
		},
		onError: (e) => toast.error(e.message),
	});
	if (draft)
		return (
			<div className="flex flex-col gap-4">
				<p className="text-foreground text-sm" data-testid="draft-intro">
					Here's what your AI read. Remove anything that isn't true; you can
					edit it any time in Profile.
				</p>
				<DraftReview draft={draft} setDraft={setDraft} onSaved={onDone} />
			</div>
		);
	return (
		<ResumeImport
			onDraft={setDraft}
			onScratch={() => scratch.mutate()}
			blocked={
				canDraft === false ? (
					<ConnectAiFirst onConnect={() => go("ai")} />
				) : null
			}
		/>
	);
}

/** Job search and the sources together: what to look for, and where. */
function WantsStep() {
	return (
		<div className="flex flex-col gap-8">
			<Section title="Job search" data-testid="setup-rules">
				<JobFilterSettings />
			</Section>
			<Section title="Where to look" data-testid="setup-sources">
				<SourcesSettings />
			</Section>
		</div>
	);
}

/** Notifications, and opening at login. */
function LoopStep() {
	return (
		<div className="flex flex-col gap-8">
			<NotificationSettings compact />
			<Section
				title="Open at login"
				description="Optional. OfferFinch starts in the tray and keeps looking on its schedule."
			>
				<Group>
					<GeneralSettings compact />
				</Group>
			</Section>
		</div>
	);
}

/**
 * The first search cannot run yet: what it needs, and the footer's action goes to that step.
 * There is no Continue here, so a search that never ran is never marked done.
 */
function ScanBlocked({
	hasProfile,
	sources,
	go,
}: {
	hasProfile: boolean;
	sources: number;
	go: (step: SetupStep) => void;
}) {
	useStepAction(
		hasProfile
			? {
					label: "Choose where to look",
					onClick: () => go("wants"),
					testId: "first-scan-go-wants",
				}
			: {
					label: "Add your resume",
					onClick: () => go("profile"),
					testId: "first-scan-go-profile",
				},
	);
	const missing = [
		hasProfile ? null : "a saved profile",
		sources > 0 ? null : "a search service in What you want",
	].filter(Boolean);
	return (
		<p className="text-foreground text-sm" data-testid="first-scan-blocked">
			A search needs {missing.join(" and ")}.
		</p>
	);
}

/** The body of one step. */
export function StepBody({
	step,
	hasProfile,
	sources,
	onDone,
	onFinished,
	go,
}: {
	step: SetupStep;
	hasProfile: boolean;
	sources: number;
	/** The step is finished: mark it and move on. */
	onDone: () => void;
	/** The first search is done and the user opens the Inbox. */
	onFinished: () => void;
	/** Opens another step (a blocked step's way to what it needs). */
	go: (step: SetupStep) => void;
}) {
	switch (step) {
		case "ai":
			return <ConnectAi onDone={onDone} />;
		case "profile":
			return <ProfileStep hasProfile={hasProfile} onDone={onDone} go={go} />;
		case "wants":
			return <WantsStep />;
		case "loop":
			return <LoopStep />;
		case "scan":
			return hasProfile && sources > 0 ? (
				<FirstScan onDone={onFinished} />
			) : (
				<ScanBlocked hasProfile={hasProfile} sources={sources} go={go} />
			);
	}
}
