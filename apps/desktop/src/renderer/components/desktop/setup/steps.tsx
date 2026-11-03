import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { GeneralSettings } from "@/components/desktop/general";
import { NotificationSettings } from "@/components/desktop/notifications";
import {
	type Draft,
	DraftReview,
	ResumeImport,
} from "@/components/desktop/resume-import";
import { Group, Section } from "@/components/system/layout";
import { client } from "@/lib/orpc";
import { preloadable } from "@/lib/preloadable";
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
		lead: "OfferFinch uses AI to read jobs and draft applications. It looks for Claude Code and Codex on this Mac first; API keys work too.",
	},
	profile: {
		title: "Your resume",
		lead: "Your AI turns it into a profile, and you check every line before it's saved. Applications only ever use what's in it.",
	},
	wants: {
		title: "What you want",
		lead: "Your rules, and where to look. Jobs that break a rule are set aside before any AI reads them.",
	},
	loop: {
		title: "Stay in the loop",
		lead: "Hear about new matches, questions and drafts ready for review, and let OfferFinch keep looking while you work.",
	},
	scan: {
		title: "First search",
		lead: "OfferFinch searches now, sets aside jobs that break your rules and scores the rest. Nothing is drafted until you press Prepare.",
	},
};

/** Your resume, then the draft it makes, reviewed in the same step. */
function ProfileStep({
	hasProfile,
	onDone,
}: {
	hasProfile: boolean;
	onDone: () => void;
}) {
	const queryClient = useQueryClient();
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
	return <ResumeImport onDraft={setDraft} onScratch={() => scratch.mutate()} />;
}

/** The rules and the sources together: what to look for, and where. */
function WantsStep() {
	return (
		<div className="flex flex-col gap-8">
			<Section title="Job rules" data-testid="setup-rules">
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
				description="Optional. OfferFinch starts in the menu bar and keeps looking every hour."
			>
				<Group>
					<GeneralSettings compact />
				</Group>
			</Section>
		</div>
	);
}

function ScanBlocked({
	hasProfile,
	sources,
}: {
	hasProfile: boolean;
	sources: number;
}) {
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
}: {
	step: SetupStep;
	hasProfile: boolean;
	sources: number;
	/** The step is finished: mark it and move on. */
	onDone: () => void;
	/** The first search is done and the user opens the Inbox. */
	onFinished: () => void;
}) {
	switch (step) {
		case "ai":
			return <ConnectAi />;
		case "profile":
			return <ProfileStep hasProfile={hasProfile} onDone={onDone} />;
		case "wants":
			return <WantsStep />;
		case "loop":
			return <LoopStep />;
		case "scan":
			return hasProfile && sources > 0 ? (
				<FirstScan onDone={onFinished} />
			) : (
				<ScanBlocked hasProfile={hasProfile} sources={sources} />
			);
	}
}
