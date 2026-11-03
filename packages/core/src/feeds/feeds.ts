import { hackerNewsFeed } from "./hackernews";
import type { Feed } from "./provider";
import { remoteOkFeed } from "./remoteok";
import { remotiveFeed } from "./remotive";
import { weWorkRemotelyFeed } from "./weworkremotely";

/** The remote-job feeds, in the order a scan reads them. */
export const FEEDS: readonly Feed[] = [
	remotiveFeed,
	remoteOkFeed,
	weWorkRemotelyFeed,
	hackerNewsFeed,
];

/** Their provider ids, as Settings › Sources and the scan history know them. */
export const FEED_IDS = [
	"remotive",
	"remoteok",
	"weworkremotely",
	"hn-hiring",
] as const;
