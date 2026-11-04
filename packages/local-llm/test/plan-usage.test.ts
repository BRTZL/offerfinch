import type {
	SDKControlGetUsageResponse,
	SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import type { CodexRateLimits } from "../src/codex";
import {
	claudeRateLimitSnapshot,
	claudeUsageSnapshot,
	codexUsageSnapshot,
} from "../src/plan-usage";

const AT = new Date("2026-11-04T10:00:00Z");

describe("claudeUsageSnapshot", () => {
	it("maps the session, weekly and per-model windows, and the extra-usage setting", () => {
		const usage = {
			session: {},
			subscription_type: "max",
			rate_limits_available: true,
			rate_limits: {
				five_hour: { utilization: 42.5, resets_at: "2026-11-04T14:00:00Z" },
				seven_day: { utilization: 10, resets_at: "2026-11-09T00:00:00Z" },
				seven_day_sonnet: null,
				model_scoped: [
					{
						display_name: "Fable",
						utilization: 3,
						resets_at: "2026-11-09T00:00:00Z",
					},
					{ display_name: "Opus", utilization: null, resets_at: null },
				],
				extra_usage: {
					is_enabled: true,
					monthly_limit: 5000,
					used_credits: 125,
					utilization: 2.5,
					currency: "USD",
				},
			},
		} as unknown as SDKControlGetUsageResponse;
		const snapshot = claudeUsageSnapshot(usage, AT);
		expect(snapshot).toEqual({
			at: AT,
			complete: true,
			windows: [
				{
					id: "five_hour",
					label: "Session",
					kind: "session",
					durationMins: 300,
					usedPercent: 42.5,
					resetsAt: new Date("2026-11-04T14:00:00Z"),
				},
				{
					id: "seven_day",
					label: "Weekly",
					kind: "weekly",
					durationMins: 7 * 24 * 60,
					usedPercent: 10,
					resetsAt: new Date("2026-11-09T00:00:00Z"),
				},
				{
					id: "seven_day_fable",
					label: "Weekly · Fable",
					kind: "weekly",
					durationMins: 7 * 24 * 60,
					usedPercent: 3,
					resetsAt: new Date("2026-11-09T00:00:00Z"),
				},
			],
			account: {
				plan: "max",
				extraUsage: {
					enabled: true,
					used: 125,
					limit: 5000,
					currency: "USD",
				},
				credits: null,
			},
		});
	});

	it("is null when the plan's limits are not available (an API key)", () => {
		expect(
			claudeUsageSnapshot(
				{
					rate_limits_available: false,
					rate_limits: null,
				} as unknown as SDKControlGetUsageResponse,
				AT,
			),
		).toBeNull();
	});
});

describe("claudeRateLimitSnapshot", () => {
	it("maps a call's event (share as 0 to 1, reset in seconds) as a partial read", () => {
		const info: SDKRateLimitInfo = {
			status: "allowed",
			rateLimitType: "five_hour",
			utilization: 0.455,
			resetsAt: 1_762_264_800,
		};
		expect(claudeRateLimitSnapshot(info, AT)).toEqual({
			at: AT,
			complete: false,
			windows: [
				{
					id: "five_hour",
					label: "Session",
					kind: "session",
					durationMins: 300,
					usedPercent: 45.5,
					resetsAt: new Date(1_762_264_800 * 1000),
				},
			],
		});
	});

	it("ignores overage events and events without a share", () => {
		expect(
			claudeRateLimitSnapshot(
				{ status: "allowed", rateLimitType: "overage", utilization: 0.1 },
				AT,
			),
		).toBeNull();
		expect(
			claudeRateLimitSnapshot(
				{ status: "allowed", rateLimitType: "five_hour" },
				AT,
			),
		).toBeNull();
	});
});

describe("codexUsageSnapshot", () => {
	const limits = (
		snapshot: NonNullable<CodexRateLimits["rateLimits"]>,
		byId?: CodexRateLimits["rateLimitsByLimitId"],
	): CodexRateLimits => ({
		ordinaryUsageAllowed: true,
		rateLimits: snapshot,
		rateLimitsByLimitId: byId ?? null,
	});
	const window = (
		usedPercent: number,
		resetsAt: number,
		windowDurationMins?: number,
	) => ({ usedPercent, resetsAt, windowDurationMins });

	it("maps the two windows by position, 5 hours and a week on a paid plan, with credits", () => {
		const snapshot = codexUsageSnapshot(
			limits({
				limitId: "codex",
				primary: window(30, 1_762_264_800),
				secondary: window(12, 1_762_646_400, 10_080),
				credits: { hasCredits: true, unlimited: false, balance: "12.50" },
				spendControlReached: false,
				planType: "pro",
				rateLimitReachedType: null,
			}),
			AT,
		);
		expect(snapshot).toEqual({
			at: AT,
			complete: true,
			windows: [
				{
					id: "primary",
					label: "Session",
					kind: "session",
					durationMins: 300,
					usedPercent: 30,
					resetsAt: new Date(1_762_264_800 * 1000),
				},
				{
					id: "secondary",
					label: "Weekly",
					kind: "weekly",
					durationMins: 10_080,
					usedPercent: 12,
					resetsAt: new Date(1_762_646_400 * 1000),
				},
			],
			account: {
				plan: "pro",
				extraUsage: null,
				credits: { balance: 12.5, unlimited: false },
			},
		});
	});

	it("reads the main allowance from the codex bucket when buckets are named, monthly on Free", () => {
		const snapshot = codexUsageSnapshot(
			limits(
				{
					limitId: "other-model",
					primary: window(99, 1),
					secondary: null,
					credits: null,
					spendControlReached: null,
					planType: "free",
					rateLimitReachedType: null,
				},
				{
					codex: {
						limitId: "codex",
						primary: window(5, 1_764_000_000),
						secondary: null,
						credits: { hasCredits: false, unlimited: false, balance: "abc" },
						spendControlReached: null,
						planType: "free",
						rateLimitReachedType: null,
					},
				},
			),
			AT,
		);
		expect(snapshot?.windows).toEqual([
			{
				id: "primary",
				label: "Monthly",
				kind: "monthly",
				durationMins: 30 * 24 * 60,
				usedPercent: 5,
				resetsAt: new Date(1_764_000_000 * 1000),
			},
		]);
		expect(snapshot?.account?.credits).toEqual({
			balance: null,
			unlimited: false,
		});
	});

	it("is null without any snapshot", () => {
		expect(
			codexUsageSnapshot(
				{
					ordinaryUsageAllowed: null,
					rateLimits: null,
					rateLimitsByLimitId: null,
				},
				AT,
			),
		).toBeNull();
	});
});
