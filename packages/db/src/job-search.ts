import {
	countryFromLocation,
	profileLocation,
	withLocationDefaults,
} from "@offerfinch/core/filter/home";
import type { FilterSettings } from "@offerfinch/core/filter/settings";

import type { Database } from "./client";
import { DrizzlePipelineRepository, saveFilterSettings } from "./repository";

/*
 * Saving Job search changes what new jobs are scored against, never the jobs already here: no
 * rule rejects a job (docs/decisions.md, 2026-11-05), so there is nothing to filter again, and a
 * fit score is not redone on save.
 */

/**
 * Fills "I live in", citizenship and right to work from the profile's About location ("Izmir,
 * Turkey (GMT+3)" -> Türkiye) the first time it can. Kept fields stay; after one fill nothing is
 * filled again, so a field the user clears stays clear.
 */
export async function ensureLocationDefaults(
	db: Database,
	userId: string,
): Promise<{ changed: boolean; settings: FilterSettings }> {
	const repo = new DrizzlePipelineRepository(db);
	const settings = await repo.getFilterSettings(userId);
	if (settings.locationPrefilled) return { changed: false, settings };
	const profile = await repo.getProfile(userId);
	const next = withLocationDefaults(
		settings,
		countryFromLocation(profileLocation(profile)),
	);
	if (next === settings) return { changed: false, settings };
	await saveFilterSettings(db, userId, next);
	return { changed: true, settings: next };
}
