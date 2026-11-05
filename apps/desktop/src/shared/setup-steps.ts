/**
 * The first-run setup's steps, and how progress stored by earlier versions reads in them.
 *
 * Earlier versions had eight steps; setup now has five. Stored progress keeps whatever keys it
 * has (the stored schema accepts both sets), and is read through `setupProgress`, so a step
 * finished before the update is not asked again.
 */

/** The five steps, in order. */
export const SETUP_STEPS = ["ai", "profile", "wants", "loop", "scan"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** The eight steps of earlier versions, as stored. */
const LEGACY_STEPS = [
	"ai",
	"resume",
	"profile",
	"rules",
	"watchlist",
	"notifications",
	"login",
	"scan",
] as const;
type LegacyStep = (typeof LEGACY_STEPS)[number];

/** Every key stored progress may hold. */
export const STORED_STEPS = [
	...new Set<string>([...LEGACY_STEPS, ...SETUP_STEPS]),
] as (LegacyStep | SetupStep)[];
export type StoredStep = LegacyStep | SetupStep;

/**
 * The earlier steps a new step covers. The new step reads as done when its own key is stored or
 * every earlier step it covers is. `profile` (the saved review) and `ai` and `scan` are the same
 * step; "resume" alone (a draft made but not saved) never finished the profile.
 */
const COVERS: Record<SetupStep, LegacyStep[]> = {
	ai: ["ai"],
	profile: ["profile"],
	wants: ["rules", "watchlist"],
	loop: ["notifications", "login"],
	scan: ["scan"],
};

/** Stored progress (either version's keys) as the five steps. */
export function setupProgress(stored: {
	done: readonly string[];
	skipped: readonly string[];
}): { done: SetupStep[]; skipped: SetupStep[] } {
	const done = new Set(stored.done);
	const skipped = new Set(stored.skipped);
	const out = { done: [] as SetupStep[], skipped: [] as SetupStep[] };
	for (const step of SETUP_STEPS) {
		const parts = COVERS[step];
		const own = done.has(step);
		const viaParts = parts.every((p) => done.has(p));
		if (!own && !viaParts) continue;
		out.done.push(step);
		const wasSkipped = own
			? skipped.has(step)
			: parts.some((p) => skipped.has(p));
		if (wasSkipped) out.skipped.push(step);
	}
	return out;
}

/**
 * The steps still open, in order: not done, or skipped. A skipped step is stored in `done` too
 * (the wizard moves past it), but setup is not finished while one is.
 */
export function openSteps(progress: {
	done: readonly SetupStep[];
	skipped: readonly SetupStep[];
}): SetupStep[] {
	return SETUP_STEPS.filter(
		(s) => !progress.done.includes(s) || progress.skipped.includes(s),
	);
}

/** Every step done, none skipped. */
export function setupComplete(progress: {
	done: readonly SetupStep[];
	skipped: readonly SetupStep[];
}): boolean {
	return openSteps(progress).length === 0;
}

/**
 * What an open step leaves undone, for Home's "Setup: AI not connected, no resume yet." The AI
 * and the resume can be set up outside setup (Settings › Models, Profile), so those two read
 * from the live state: a skipped step whose work is there anyway only says it was skipped.
 */
function openStepText(
	step: SetupStep,
	live: { aiReady: boolean; hasProfile: boolean },
): string {
	switch (step) {
		case "ai":
			return live.aiReady ? "AI step skipped" : "AI not connected";
		case "profile":
			return live.hasProfile ? "resume step skipped" : "no resume yet";
		case "wants":
			return "no rules or sources chosen";
		case "loop":
			return "notifications not set up";
		case "scan":
			return "no first search yet";
	}
}

/** "Setup: AI not connected, no resume yet." for the open steps, or null when none is. */
export function openStepsLine(
	open: readonly SetupStep[],
	live: { aiReady: boolean; hasProfile: boolean },
): string | null {
	if (!open.length) return null;
	const text = open.map((s) => openStepText(s, live)).join(", ");
	return `Setup: ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** A step named in `/onboarding?step=`, or null. */
export function stepFrom(value: string | null | undefined): SetupStep | null {
	return (SETUP_STEPS as readonly string[]).includes(value ?? "")
		? (value as SetupStep)
		: null;
}

/** Rough minutes each step takes, for "about N minutes left". */
const MINUTES: Record<SetupStep, number> = {
	ai: 1,
	profile: 1.5,
	wants: 1,
	loop: 0.5,
	scan: 1,
};

/** "About 3 minutes left" for the steps from `from` on that are not done yet. */
export function timeLeft(from: SetupStep, done: readonly SetupStep[]): string {
	const start = SETUP_STEPS.indexOf(from);
	const minutes = SETUP_STEPS.slice(start)
		.filter((s) => s === from || !done.includes(s))
		.reduce((sum, s) => sum + MINUTES[s], 0);
	const rounded = Math.round(minutes);
	if (rounded <= 1) return "about a minute left";
	return `about ${rounded} minutes left`;
}
