import { orpc, queryClient } from "./orpc";

/**
 * Each screen's first data, keyed by the sidebar path. Prefetched once the app is idle after
 * launch and again when the pointer rests on a sidebar link, so opening a screen draws its
 * content at once instead of a skeleton. Same query options as the screens use, so the cache
 * entries are the ones they read. (The Inbox list is an infinite query keyed by the user's
 * stored view and order; it is fast and stays with the screen.)
 */
const SCREEN_QUERIES: Record<string, () => object[]> = {
	"/": () => [
		orpc.onboarding.get.queryOptions(),
		orpc.desktop.home.queryOptions(),
		orpc.profile.get.queryOptions(),
	],
	"/inbox": () => [
		orpc.inbox.counts.queryOptions(),
		orpc.dismissals.views.queryOptions(),
		orpc.profile.get.queryOptions(),
	],
	"/questions": () => [
		orpc.questions.list.queryOptions({ input: { status: "open" } }),
	],
	"/applied": () => [orpc.submission.applied.queryOptions()],
	"/rejected": () => [orpc.rejected.list.queryOptions()],
	"/scans": () => [orpc.scanHistory.list.queryOptions()],
	"/profile": () => [
		orpc.profile.records.queryOptions(),
		orpc.questions.facts.queryOptions(),
		orpc.profile.get.queryOptions(),
	],
	// Settings opens on Models; its subscription check runs the Claude and Codex CLIs (~0.7 s).
	"/settings": () => [
		orpc.ai.get.queryOptions(),
		{ ...orpc.ai.subscriptions.queryOptions(), staleTime: 30_000 },
	],
};

/** Warms the cache for the screen at `path` (fresh entries are left alone). */
export function prefetchScreen(path: string) {
	const queries = SCREEN_QUERIES[path];
	if (!queries) return;
	for (const options of queries())
		void queryClient.prefetchQuery(
			options as Parameters<typeof queryClient.prefetchQuery>[0],
		);
}

/** Every screen's data (at idle after launch). */
export function prefetchAllScreens() {
	for (const path of Object.keys(SCREEN_QUERIES)) prefetchScreen(path);
}
