import type {
	SDKControlGetUsageResponse,
	SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	PlanAccount,
	PlanSnapshot,
	PlanWindowKind,
	PlanWindowReading,
} from "@offerfinch/core/scoring/plan-usage";
import { clampPercent } from "@offerfinch/core/scoring/plan-usage";

import type { CodexRateLimits } from "./codex";

/**
 * The vendors' usage reports as plan snapshots (core/scoring/plan-usage.ts). Claude's windows
 * are named by the SDK (`five_hour`, `seven_day`, per-model weeklies); Codex's are positions
 * (`primary`, `secondary`), 5 hours and a week on paid plans, a month on Free and Go.
 */

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

const CLAUDE_WINDOWS: Record<
	string,
	{ label: string; kind: PlanWindowKind; durationMins: number }
> = {
	five_hour: { label: "Session", kind: "session", durationMins: SESSION_MINS },
	seven_day: { label: "Weekly", kind: "weekly", durationMins: WEEK_MINS },
	seven_day_opus: {
		label: "Weekly · Opus",
		kind: "weekly",
		durationMins: WEEK_MINS,
	},
	seven_day_sonnet: {
		label: "Weekly · Sonnet",
		kind: "weekly",
		durationMins: WEEK_MINS,
	},
};

function dateFromIso(value: string | null | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function dateFromSeconds(value: number | null | undefined): Date | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		return null;
	return new Date(value * 1000);
}

function scopedId(displayName: string): string {
	return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

/** The plan's full usage report (the SDK's `get_usage`): percentages are 0 to 100. */
export function claudeUsageSnapshot(
	usage: SDKControlGetUsageResponse,
	at: Date,
	plan: string | null = usage.subscription_type ?? null,
): PlanSnapshot | null {
	if (!usage.rate_limits_available || !usage.rate_limits) return null;
	const limits = usage.rate_limits;
	const windows: PlanWindowReading[] = [];
	for (const [id, meta] of Object.entries(CLAUDE_WINDOWS)) {
		const window = limits[id as keyof typeof limits] as
			| { utilization: number | null; resets_at: string | null }
			| null
			| undefined;
		if (!window || typeof window.utilization !== "number") continue;
		windows.push({
			id,
			...meta,
			usedPercent: clampPercent(window.utilization),
			resetsAt: dateFromIso(window.resets_at),
		});
	}
	for (const scoped of limits.model_scoped ?? []) {
		if (typeof scoped.utilization !== "number") continue;
		windows.push({
			id: scopedId(scoped.display_name),
			label: `Weekly · ${scoped.display_name}`,
			kind: "weekly",
			durationMins: WEEK_MINS,
			usedPercent: clampPercent(scoped.utilization),
			resetsAt: dateFromIso(scoped.resets_at),
		});
	}
	const extra = limits.extra_usage;
	const account: PlanAccount = {
		plan,
		extraUsage: extra
			? {
					enabled: Boolean(extra.is_enabled),
					used:
						typeof extra.used_credits === "number" ? extra.used_credits : null,
					limit:
						typeof extra.monthly_limit === "number"
							? extra.monthly_limit
							: null,
					currency: extra.currency ?? null,
				}
			: null,
		credits: null,
	};
	return { at, windows, complete: true, account };
}

/**
 * A call's `rate_limit_event`: one window, its share used as 0 to 1. Overage windows have no
 * row of their own here.
 */
export function claudeRateLimitSnapshot(
	info: SDKRateLimitInfo,
	at: Date,
): PlanSnapshot | null {
	const type = info.rateLimitType;
	if (!type || typeof info.utilization !== "number") return null;
	const meta = CLAUDE_WINDOWS[type];
	if (!meta) return null;
	return {
		at,
		complete: false,
		windows: [
			{
				id: type,
				...meta,
				usedPercent: clampPercent(info.utilization * 100),
				resetsAt: dateFromSeconds(info.resetsAt),
			},
		],
	};
}

/**
 * Codex's `account/rateLimits/read`: the main allowance (`codex` bucket when buckets are
 * named), its two windows by position, and the ChatGPT credit balance.
 */
export function codexUsageSnapshot(
	limits: CodexRateLimits,
	at: Date,
): PlanSnapshot | null {
	const snapshot = limits.rateLimitsByLimitId?.codex ?? limits.rateLimits;
	if (!snapshot) return null;
	const monthly = snapshot.planType === "free" || snapshot.planType === "go";
	const positions = [
		["primary", snapshot.primary, monthly ? MONTH_MINS : SESSION_MINS],
		["secondary", snapshot.secondary, WEEK_MINS],
	] as const;
	const windows: PlanWindowReading[] = [];
	for (const [id, window, fallbackMins] of positions) {
		if (!window || !Number.isFinite(window.usedPercent)) continue;
		const durationMins =
			typeof window.windowDurationMins === "number" &&
			window.windowDurationMins > 0
				? window.windowDurationMins
				: fallbackMins;
		const kind: PlanWindowKind =
			durationMins >= MONTH_MINS
				? "monthly"
				: durationMins >= WEEK_MINS
					? "weekly"
					: "session";
		windows.push({
			id,
			label:
				kind === "session"
					? "Session"
					: kind === "weekly"
						? "Weekly"
						: "Monthly",
			kind,
			durationMins,
			usedPercent: clampPercent(window.usedPercent),
			resetsAt: dateFromSeconds(window.resetsAt),
		});
	}
	const credits = snapshot.credits;
	const balance =
		typeof credits?.balance === "string" &&
		/^\d+(\.\d+)?$/.test(credits.balance)
			? Number(credits.balance)
			: null;
	return {
		at,
		windows,
		complete: true,
		account: {
			plan: snapshot.planType ?? null,
			extraUsage: null,
			credits: credits
				? { balance, unlimited: Boolean(credits.unlimited) }
				: null,
		},
	};
}
