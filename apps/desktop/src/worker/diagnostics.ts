import { DashboardRepository } from "@offerfinch/db";
import { recentScans } from "@offerfinch/runner";
import type { WorkerApp } from "./app";
import { providerStatus } from "./routers/shared";
import { nextScan } from "./schedule";
import { LOCAL_USER_ID } from "./settings";

/**
 * The worker's half of Export Diagnostics (issue #54): a summary of settings built from an
 * allowlist (never a dump of app_settings: those hold paths, sign-in state and notes), and the
 * user's own name, email, phone and links, which main uses to redact the bundle and never
 * writes into it.
 */
export async function diagnosticsSummary(app: WorkerApp) {
	const [settings, personal] = await Promise.all([
		settingsSummary(app),
		personalDetails(app),
	]);
	return { settings, personal };
}

async function settingsSummary(app: WorkerApp) {
	const ai = await app.settings.get("ai");
	const onboarding = await app.settings.get("onboarding");
	const status = await app.status();
	const providers = await providerStatus(app, LOCAL_USER_ID);
	const [last] = await recentScans(app.db, LOCAL_USER_ID, 1);
	const hasProfile = Boolean(
		await new DashboardRepository(app.db).profileFiles(LOCAL_USER_ID),
	);
	return {
		models: (["scoring", "tailoring", "claims"] as const).map((role) => ({
			role,
			model: ai[role].model ?? "none",
			effort: ai[role].effort ?? "default",
			provider: app.roles.find((r) => r.role === role)?.provider ?? null,
		})),
		sources: providers.map((p) => ({
			source: p.provider,
			on: p.enabled,
			ready: p.ready,
			stop: p.stop
				? { kind: p.stop.kind, held: p.stop.held, failures: p.stop.failures }
				: null,
			lastRunAt: p.lastRunAt?.toISOString() ?? null,
		})),
		schedule: {
			state: status.state,
			paused: status.paused,
			next: nextScan({
				now: new Date(),
				paused: status.paused,
				hasProfile,
				scheduleOff: Boolean(app.init.test?.noSchedule),
				thisHourRan: false,
			}).note,
			lastScan: last
				? {
						status: last.status,
						at: (last.endedAt ?? last.createdAt).toISOString(),
						error: last.error,
					}
				: null,
		},
		notifications: await app.settings.get("notifications"),
		onboarding: {
			done: onboarding.done,
			skipped: onboarding.skipped,
			finished: Boolean(onboarding.completedAt),
		},
		hasProfile,
		counts: status.counts,
	};
}

/** Name, email, phone and links from the profile's About (personal.md), for redaction only. */
async function personalDetails(app: WorkerApp) {
	const files = await new DashboardRepository(app.db).profileFiles(
		LOCAL_USER_ID,
	);
	return personalFields(
		files?.files.find((f) => f.path === "personal.md")?.content ?? "",
	);
}

/**
 * The fields of personal.md, as records render it and as profiles kept as files wrote it
 * ("- **Name:** …"); also "**Name**: …" and "Full name". Values are trimmed; empty ones left out.
 */
export function personalFields(personal: string) {
	const field = (...labels: string[]) =>
		labels
			.map(
				(label) =>
					personal
						.match(
							new RegExp(
								`^\\s*[-*]?\\s*\\*\\*${label}(?::\\*\\*|\\*\\*:)\\s*(.+)$`,
								"mi",
							),
						)?.[1]
						?.trim() ?? "",
			)
			.filter(Boolean);
	return {
		names: field("Name", "Full name"),
		emails: field("Email", "E-mail"),
		phones: field("Phone", "Mobile"),
		links: field("LinkedIn", "Website", "GitHub"),
	};
}
