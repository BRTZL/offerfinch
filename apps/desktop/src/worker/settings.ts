import type { Database } from "@offerfinch/db";
import { appSettings } from "@offerfinch/db/schema/jobs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { STORED_STEPS, type StoredStep } from "../shared/setup-steps";

/** The one local user every row belongs to (PLAN rule 6 keeps user_id columns). */
export const LOCAL_USER_ID = "local";
export const LOCAL_USER_EMAIL = "local@localhost.invalid";

/**
 * How a model role is paid for. `api`: the vendor's API key (Anthropic for scoring and
 * tailoring, OpenAI for the claims check). Subscriptions are placeholders until the T3 provider
 * research lands (docs/t3-provider-research.md); they cannot be chosen yet. `fake`: the
 * deterministic test models, offered only in test runs.
 */
const ROLE_MODES = [
	"api",
	"claude-subscription",
	"codex-subscription",
	"fake",
] as const;

const roleSchema = z.object({
	mode: z.enum(ROLE_MODES),
	model: z.string().trim().max(100).optional(),
	effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

export const aiSettingsSchema = z.object({
	scoring: roleSchema,
	tailoring: roleSchema,
	claims: roleSchema,
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const DEFAULT_AI: AiSettings = {
	scoring: { mode: "api" },
	tailoring: { mode: "api" },
	claims: { mode: "api" },
};

export const notificationSettingsSchema = z.object({
	match: z.boolean(),
	question: z.boolean(),
	review: z.boolean(),
	stopped: z.boolean(),
	/**
	 * Follow-up reminders after Applied. Added later: a stored choice without it keeps the
	 * user's other switches (a missing key would fail the parse and reset them all).
	 */
	followup: z.boolean().default(true),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
	match: true,
	question: true,
	review: true,
	stopped: true,
	followup: true,
};

const onboardingSchema = z.object({
	/**
	 * Steps finished or skipped; the wizard resumes at the first one left. Either version's keys:
	 * progress from the eight-step setup reads through `setupProgress` (shared/setup-steps.ts).
	 */
	done: z.array(z.enum(STORED_STEPS as [StoredStep, ...StoredStep[]])),
	skipped: z.array(z.enum(STORED_STEPS as [StoredStep, ...StoredStep[]])),
	/** The user left the wizard ("finish later"); it is offered again from Home. */
	dismissed: z.boolean(),
	completedAt: z.string().nullable(),
});
type Onboarding = z.infer<typeof onboardingSchema>;
const DEFAULT_ONBOARDING: Onboarding = {
	done: [],
	skipped: [],
	dismissed: false,
	completedAt: null,
};

const KEYS = {
	ai: { key: "ai", schema: aiSettingsSchema, fallback: DEFAULT_AI },
	notifications: {
		key: "notifications",
		schema: notificationSettingsSchema,
		fallback: DEFAULT_NOTIFICATIONS,
	},
	onboarding: {
		key: "onboarding",
		schema: onboardingSchema,
		fallback: DEFAULT_ONBOARDING,
	},
	paused: { key: "scansPaused", schema: z.boolean(), fallback: false },
	/** The login shell's PATH from the last start, used at once while it is read again. */
	shellPath: { key: "shellPath", schema: z.string(), fallback: "" },
	/**
	 * Earlier versions' LinkedIn switch. Read once at start and moved to Sources' LinkedIn row
	 * (`source_providers`), then cleared.
	 */
	linkedinEnabled: {
		key: "linkedinEnabled",
		schema: z.boolean().nullable(),
		fallback: null as boolean | null,
	},
	/**
	 * What moving the per-source settings of earlier versions did (2026-11-03), shown once in
	 * Settings › Job search until the user dismisses it. Null: nothing to say.
	 */
	movedSearches: {
		key: "movedSearches",
		schema: z.string().nullable(),
		fallback: null as string | null,
	},
	/**
	 * Each site tab's sign-in, as last seen: when a sign-in in the sheet ended on a normal page,
	 * and whether a run since met a sign-in wall. No entry: never signed in in OfferFinch (the
	 * Chrome profiles of earlier versions cannot be carried over).
	 */
	siteSessions: {
		key: "siteSessions",
		schema: z.record(
			z.string(),
			z.object({
				signedInAt: z.string().nullable(),
				needsSignIn: z.boolean(),
			}),
		),
		fallback: {} as Record<
			string,
			{ signedInAt: string | null; needsSignIn: boolean }
		>,
	},
	/** Stalled step attempts, by run and step ("<runId> <step key>"), across worker restarts. */
	stalls: {
		key: "stalls",
		schema: z.record(z.string(), z.number()),
		fallback: {} as Record<string, number>,
	},
	/**
	 * The job filter version the stored matches were last filtered with (`worker/job-search.ts`).
	 * A newer version fills the location settings from the profile and re-filters once at start.
	 */
	jobSearchVersion: {
		key: "jobSearchVersion",
		schema: z.number(),
		fallback: 0,
	},
	/**
	 * What's new: the last version whose release notes were shown (or skipped on a first run).
	 * "" when none was stored yet; never null, so writing it never deletes the row.
	 */
	whatsNewSeen: {
		key: "whatsNewSeen",
		schema: z.string().max(40),
		fallback: "",
	},
	/** Notification watermark: transitions after this time have not been announced. */
	noticeWatermark: {
		key: "noticeWatermark",
		schema: z.number(),
		fallback: 0,
	},
} as const;
type Keys = typeof KEYS;

export class SettingsStore {
	constructor(private readonly db: Database) {}

	async get<K extends keyof Keys>(
		name: K,
	): Promise<z.infer<Keys[K]["schema"]>> {
		const spec = KEYS[name];
		const [row] = await this.db
			.select({ value: appSettings.value })
			.from(appSettings)
			.where(eq(appSettings.key, spec.key));
		const parsed = spec.schema.safeParse(row?.value);
		return (parsed.success ? parsed.data : spec.fallback) as z.infer<
			Keys[K]["schema"]
		>;
	}

	async set<K extends keyof Keys>(
		name: K,
		value: z.infer<Keys[K]["schema"]>,
	): Promise<void> {
		const spec = KEYS[name];
		const parsed = spec.schema.parse(value);
		// Null means unset (every nullable setting falls back to null): the row goes, since the
		// column holds no NULL. Writing null failed the worker's start on databases that had one.
		if (parsed === null) {
			await this.db.delete(appSettings).where(eq(appSettings.key, spec.key));
			return;
		}
		await this.db
			.insert(appSettings)
			.values({ key: spec.key, value: parsed, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: appSettings.key,
				set: { value: parsed, updatedAt: new Date() },
			});
	}
}
