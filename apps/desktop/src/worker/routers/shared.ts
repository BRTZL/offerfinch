import fs from "node:fs";
import path from "node:path";
import { APPLICATION_STATES } from "@offerfinch/core/domain/states";
import { FEED_IDS } from "@offerfinch/core/feeds/feeds";
import { nextFeedRead } from "@offerfinch/core/feeds/provider";
import { detectLinkedInStop } from "@offerfinch/core/linkedin/detect";
import { nextLinkedInRead } from "@offerfinch/core/linkedin/provider";
import { LINKEDIN_ORIGIN } from "@offerfinch/core/linkedin/runner";
import {
	isHeldStop,
	retryDue,
	type SiteStopRecord,
} from "@offerfinch/core/sites/provider";
import {
	detectAnySiteCheck,
	detectSiteStop,
} from "@offerfinch/core/sites/read";
import { SITES } from "@offerfinch/core/sites/sites";
import {
	DUCKDUCKGO_ORIGIN,
	detectDuckDuckGoStop,
} from "@offerfinch/core/sources/duckduckgo";
import {
	clearProviderStop,
	DrizzleLinkedInStore,
	feedReads,
	listProviders,
	type ProviderId,
} from "@offerfinch/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { SITE_TABS, type SiteTabId } from "../../shared/bridge";
import type { WorkerApp } from "../app";
import { siteActivity } from "../checks";
import { DUCKDUCKGO_PROVIDERS } from "../pipeline";
import { siteOrigins } from "../sites";
import { PROVIDER_LABEL } from "../source-labels";

export const pastedSchema = z.object({
	title: z.string().trim().min(1, "Add the job title").max(300),
	company: z.string().trim().min(1, "Add the company name").max(200),
	location: z.string().trim().max(200).optional(),
	description: z
		.string()
		.trim()
		.min(80, "Paste the posting's text: at least a few lines")
		.max(60_000),
});

/** Where each vendor shows what was billed (not verified against the vendors' sites). */
export function usagePage(vendor: string, subscription: boolean): string {
	if (vendor === "anthropic")
		return subscription
			? "https://claude.ai/settings/usage"
			: "https://console.anthropic.com/settings/usage";
	if (vendor === "openai")
		return subscription
			? "https://chatgpt.com/codex/settings/usage"
			: "https://platform.openai.com/usage";
	return "";
}

/** Application states that wait for the user, in the order Home lists them. */
export const WAITING_ON_YOU = [
	"needs_human",
	"ready_for_review",
	"needs_answers",
	"approved",
] as const;

/** The worker app, reached from procedures through the oRPC context. */
let app: WorkerApp | null = null;

export function bindApp(value: WorkerApp) {
	app = value;
}

export function worker(): WorkerApp {
	if (!app) throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Starting" });
	return app;
}

export const stateSchema = z.enum(APPLICATION_STATES);

/**
 * Each site tab (LinkedIn, Indeed, Glassdoor): its sign-in as last seen, whether a run reads it
 * now, the check it waits on the user for, and whether an earlier version's Chrome profile is
 * still on disk (left there: it cannot be carried into OfferFinch's own session).
 */
export async function siteTabsStatus(w: WorkerApp) {
	const sessions = await w.settings.get("siteSessions");
	const entries = SITE_TABS.map((site) => {
		const session = sessions[site];
		const live = siteActivity(site);
		return [
			site,
			{
				signIn: session?.needsSignIn
					? ("needed" as const)
					: session?.signedInAt
						? ("signed-in" as const)
						: ("never" as const),
				signedInAt: session?.signedInAt ?? null,
				legacyProfile: fs.existsSync(
					path.join(w.init.userData, `${site}-chrome`),
				),
				running: live.running,
				check: live.check,
				lastCheck: live.lastCheck,
			},
		] as const;
	});
	return Object.fromEntries(entries) as Record<
		SiteTabId,
		(typeof entries)[number][1]
	>;
}

/** Where a site's tab is expected to be (the stand-in's host in test runs). */
export function signInDetector(w: WorkerApp, site: SiteTabId) {
	if (site === "linkedin") {
		const host = new URL(w.init.test?.linkedinOrigin ?? LINKEDIN_ORIGIN)
			.hostname;
		return (page: { url: string; status: number | null; html: string }) =>
			detectLinkedInStop(page, host);
	}
	if (site === "web")
		return (page: { url: string; status: number | null; html: string }) =>
			detectAnySiteCheck(page);
	if (site === "duckduckgo") {
		const origin =
			siteOrigins(Boolean(w.init.test)).duckduckgo ?? DUCKDUCKGO_ORIGIN;
		const host = new URL(origin).host;
		return (page: { url: string; status: number | null; html: string }) =>
			detectDuckDuckGoStop(page, host);
	}
	const config = SITES[site];
	const origin = siteOrigins(Boolean(w.init.test))[site] ?? config.origin;
	const host = new URL(origin).host;
	return (page: { url: string; status: number | null; html: string }) =>
		detectSiteStop(page, config, host);
}

/**
 * Each provider with whether it can run now (on, and its backend set up), and its recorded stop:
 * `held` (a check or sign-in, until the user clears it) or transient (`retryAt`: a later scan
 * tries again by itself).
 */
export async function providerStatus(w: WorkerApp, userId: string) {
	const states = await listProviders(w.db, userId);
	const now = new Date();
	// LinkedIn keeps its stop in its own table; it is held (a check, sign-in or warning).
	const linkedin = new DrizzleLinkedInStore(w.db);
	const block = await linkedin.blocked(userId);
	const linkedinStop: SiteStopRecord | null = block
		? {
				kind: block.kind as SiteStopRecord["kind"],
				reason: block.reason,
				at: block.at.toISOString(),
			}
		: null;
	const next = await nextLinkedInRead(linkedin, userId, now);
	return states.map((p) => {
		const record =
			p.provider === "linkedin"
				? linkedinStop
				: ((p.config.stop as SiteStopRecord | undefined) ?? null);
		return {
			...p,
			label: PROVIDER_LABEL[p.provider],
			// Nothing to set up for any of them (job-board search reads DuckDuckGo in its own tab).
			ready: p.enabled && (!record || retryDue(record, now)),
			/**
			 * LinkedIn and the remote feeds: when a scan reads it next (LinkedIn every 6 hours, 10
			 * pages a day; a feed every 6 hours, 4 reads a day).
			 */
			nextReadAt: record
				? null
				: p.provider === "linkedin"
					? next.at.toISOString()
					: (FEED_IDS as readonly string[]).includes(p.provider)
						? nextFeedRead(feedReads(p.config), now).toISOString()
						: null,
			stop: record
				? {
						kind: record.kind,
						reason: record.reason,
						at: record.at,
						held: isHeldStop(record),
						failures: record.failures ?? 1,
						retryAt: isHeldStop(record) ? null : (record.retryAt ?? null),
					}
				: null,
		};
	});
}

/** A source's stop lifted; DuckDuckGo's stop is one for both sources that search through it. */
export async function clearStops(
	w: WorkerApp,
	userId: string,
	provider: ProviderId,
) {
	if (provider === "linkedin") {
		await new DrizzleLinkedInStore(w.db).clear(userId);
		return;
	}
	const ids: readonly ProviderId[] = (
		DUCKDUCKGO_PROVIDERS as readonly string[]
	).includes(provider)
		? DUCKDUCKGO_PROVIDERS
		: [provider];
	const keepLastRun = (FEED_IDS as readonly string[]).includes(provider);
	for (const id of ids)
		await clearProviderStop(w.db, userId, id, { keepLastRun });
}

/** A domain refusal ("Refusing: …") as a 409 the app shows as-is. */
export async function refuse<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof Error && /^Refusing/.test(error.message))
			throw new ORPCError("CONFLICT", { message: error.message });
		throw error;
	}
}
