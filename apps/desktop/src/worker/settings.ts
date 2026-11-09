import { DEFAULT_LOOK, documentLookSchema } from "@offerfinch/core/export/look";
import {
	DEFAULT_WRITING_STYLE,
	storedWritingStyleSchema,
	writingStyleSchema,
} from "@offerfinch/core/tailor/writing-style";
import type { Database } from "@offerfinch/db";
import { appSettings } from "@offerfinch/db/schema/jobs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	CLAUDE_DEFAULTS,
	EFFORTS,
	FAKE_MODEL_REF,
	formatModelRef,
	isEffort,
	isModelRef,
	type ModelRef,
	ROLES,
	type Role,
} from "../shared/providers";
import { STORED_STEPS, type StoredStep } from "../shared/setup-steps";

/** The one local user every row belongs to (PLAN rule 6 keeps user_id columns). */
export const LOCAL_USER_ID = "local";
export const LOCAL_USER_EMAIL = "local@localhost.invalid";

/**
 * A step's model: a model reference (`shared/providers.ts`), or null while the user has not
 * chosen one (the step pauses until they do). Effort is the model's level, when it has levels.
 */
const roleSchema = z.object({
	model: z
		.string()
		.refine(isModelRef, "Not a model reference (<provider>:<model>)")
		.transform((ref) => ref as ModelRef)
		.nullable(),
	effort: z.enum(EFFORTS).optional(),
});

export const aiSettingsSchema = z.object({
	scoring: roleSchema,
	tailoring: roleSchema,
	claims: roleSchema,
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const DEFAULT_AI: AiSettings = {
	scoring: { model: null },
	tailoring: { model: null },
	claims: { model: null },
};

/**
 * One step's choice as earlier versions stored it (`{ mode, model?, effort? }`), in the new
 * shape: a plan becomes its provider's reference (a model stored for the other company, which
 * those versions never sent, gives way to the default), an API key becomes no choice (keys are
 * gone; the step asks for a model), the test models stay the test models. Anything else is left
 * for the schema to judge.
 */
function migrateRole(role: Role, value: unknown): unknown {
	if (!value || typeof value !== "object" || !("mode" in value)) return value;
	const old = value as { mode?: unknown; model?: unknown; effort?: unknown };
	const model = typeof old.model === "string" ? old.model.trim() : "";
	const effort = isEffort(old.effort) ? { effort: old.effort } : {};
	const claude = model.startsWith("claude");
	switch (old.mode) {
		case "claude-subscription":
			return {
				model: formatModelRef(
					"claude",
					claude && isModelRef(`claude:${model}`)
						? model
						: CLAUDE_DEFAULTS[role],
				),
				...effort,
			};
		case "codex-subscription":
			return {
				model: formatModelRef(
					"codex",
					!claude && isModelRef(`codex:${model}`) ? model : "",
				),
				...effort,
			};
		case "fake":
			return { model: FAKE_MODEL_REF };
		case "api":
			return { model: null };
		default:
			return value;
	}
}

/** The stored `ai` setting, older shapes read as the new one, each step on its own. */
function migrateAi(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	const stored = value as Record<string, unknown>;
	const out: Record<string, unknown> = { ...stored };
	for (const role of ROLES) {
		const read = roleSchema.safeParse(migrateRole(role, stored[role]));
		// A step that does not read is unset; the other steps keep their choices.
		out[role] = read.success ? read.data : DEFAULT_AI[role];
	}
	return out;
}

const storedAiSchema = z.preprocess(migrateAi, aiSettingsSchema);

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

/** The intervals a scheduled scan may run at, in hours. */
const SCAN_EVERY_HOURS = [1, 3, 6, 12, 24] as const;

/** A local clock time, "HH:MM" (24-hour), as `<input type="time">` gives it. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Not HH:MM");

/**
 * When scheduled scans run: at most once every `every` hours, never in quiet hours (the Mac's
 * local time; the window may cross midnight). Quiet hours also hold notifications until they end.
 * What the app writes and the API accepts: every field, each valid.
 */
export const scanScheduleSchema = z.object({
	every: z.literal(SCAN_EVERY_HOURS),
	quietHours: z.object({
		enabled: z.boolean(),
		start: clockTime,
		end: clockTime,
	}),
});
export type ScanSchedule = z.infer<typeof scanScheduleSchema>;
export type QuietHours = ScanSchedule["quietHours"];
export const DEFAULT_SCAN_SCHEDULE: ScanSchedule = {
	every: 1,
	quietHours: { enabled: false, start: "22:00", end: "07:00" },
};

/**
 * The schedule as read back: each field on its own, so one missing or bad field (a field added
 * later, a hand-edited time) falls back to its default and the user's other choices stay.
 */
const storedScanScheduleSchema = z
	.object({
		every: z.literal(SCAN_EVERY_HOURS).catch(DEFAULT_SCAN_SCHEDULE.every),
		quietHours: z
			.object({
				enabled: z.boolean().catch(DEFAULT_SCAN_SCHEDULE.quietHours.enabled),
				start: clockTime.catch(DEFAULT_SCAN_SCHEDULE.quietHours.start),
				end: clockTime.catch(DEFAULT_SCAN_SCHEDULE.quietHours.end),
			})
			.catch(DEFAULT_SCAN_SCHEDULE.quietHours),
	})
	.catch(DEFAULT_SCAN_SCHEDULE);

/**
 * A notification waiting to go out (`NoticeBatcher`), kept across a restart. Follow-ups are not
 * kept: their stage entries say whether they went out, so they are found again.
 */
const heldNoticeSchema = z.object({
	kind: z.enum(["match", "question", "review", "stopped"]),
	applicationId: z.string().optional(),
	title: z.string(),
	company: z.string().optional(),
	score: z.number().optional(),
	detail: z.string().optional(),
});
export type HeldNotice = z.infer<typeof heldNoticeSchema>;
/** Read: an item that no longer fits is dropped, the others kept. */
const storedHeldNoticesSchema = z
	.array(z.unknown())
	.catch([])
	.transform((items) =>
		items.flatMap((item) => {
			const parsed = heldNoticeSchema.safeParse(item);
			return parsed.success ? [parsed.data] : [];
		}),
	);

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
	/** Read: earlier shapes moved to today's. Written: today's shape only. */
	ai: {
		key: "ai",
		schema: storedAiSchema,
		write: aiSettingsSchema,
		fallback: DEFAULT_AI,
	},
	notifications: {
		key: "notifications",
		schema: notificationSettingsSchema,
		fallback: DEFAULT_NOTIFICATIONS,
	},
	/**
	 * Settings › Writing: tone, the letter's length inside 220 to 400 words, words to avoid,
	 * guidance. Read field by field (a new field, or a value a newer version wrote, never resets
	 * the others); written strict.
	 */
	writingStyle: {
		key: "writingStyle",
		schema: storedWritingStyleSchema,
		write: writingStyleSchema,
		fallback: DEFAULT_WRITING_STYLE,
	},
	onboarding: {
		key: "onboarding",
		schema: onboardingSchema,
		fallback: DEFAULT_ONBOARDING,
	},
	/** Settings › Documents: how exported CVs and letters look (`core/export/look.ts`). */
	documentLook: {
		key: "documentLook",
		schema: documentLookSchema,
		fallback: DEFAULT_LOOK,
	},
	paused: { key: "scansPaused", schema: z.boolean(), fallback: false },
	/** Read: field by field (see `storedScanScheduleSchema`). Written: every field, valid. */
	scanSchedule: {
		key: "scanSchedule",
		schema: storedScanScheduleSchema,
		write: scanScheduleSchema,
		fallback: DEFAULT_SCAN_SCHEDULE,
	},
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
	/**
	 * API keys were removed (docs/model-providers.md): the steps an earlier version ran on a key,
	 * for Settings › Models' one-time notice, until the user dismisses it. Null: nothing to say.
	 */
	keysRemoved: {
		key: "keysRemoved",
		schema: z
			.object({
				steps: z.array(z.enum(ROLES as [Role, ...Role[]])),
				dismissed: z.boolean(),
			})
			.nullable(),
		fallback: null as { steps: Role[]; dismissed: boolean } | null,
	},
	/**
	 * Notifications read from the database (past the watermark) that had not gone out yet, as of
	 * the last change: quiet hours, a scan still running or the gap between notifications held
	 * them. They wait again after a restart.
	 */
	heldNotices: {
		key: "heldNotices",
		schema: storedHeldNoticesSchema,
		write: z.array(heldNoticeSchema),
		fallback: [] as HeldNotice[],
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

	/** A setting's row as stored, before any move to today's shape; undefined when unset. */
	async raw(name: keyof Keys): Promise<unknown> {
		const [row] = await this.db
			.select({ value: appSettings.value })
			.from(appSettings)
			.where(eq(appSettings.key, KEYS[name].key));
		return row?.value;
	}

	async set<K extends keyof Keys>(
		name: K,
		value: z.infer<Keys[K]["schema"]>,
	): Promise<void> {
		const spec = KEYS[name];
		const parsed = ("write" in spec ? spec.write : spec.schema).parse(value);
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
