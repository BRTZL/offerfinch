import { shell, type WebContents } from "electron";
import { IPC } from "../shared/bridge";
import { showsDemo } from "./demo-actions";
import { DEMO_SWITCHING, lifecycle } from "./lifecycle";
import { APP_ORIGIN } from "./protocol";
import { log } from "./state";

/** The toast a refused link shows (docs/decisions.md, 2026-11-05). */
export const LINKS_OFF = "Links are off in the demo";

/** Where the sample jobs point (worker/demo.ts): a reserved name that never resolves. */
const SAMPLE_HOST = "jobs.sample.invalid";

/**
 * Links go nowhere while the sample data is shown, and while the app switches to or from it:
 * the default browser holds the real sites' sessions.
 */
const linksOff = () => showsDemo() || lifecycle.holder() === DEMO_SWITCHING;

/** A sample job's link: http(s) on exactly the sample host, nothing that only looks like it. */
function isSampleLink(url: string): boolean {
	try {
		const u = new URL(url);
		return (
			(u.protocol === "https:" || u.protocol === "http:") &&
			u.hostname === SAMPLE_HOST &&
			!u.username &&
			!u.password
		);
	} catch {
		return false;
	}
}

/**
 * Opens a web link in the default browser. In try-it mode and during its switch nothing is
 * opened (only a sample job's own link, which never resolves): the page that asked is told,
 * and shows "Links are off in the demo". True when the link was handed to the browser.
 */
export async function openExternalLink(
	url: string,
	from: WebContents | null,
): Promise<boolean> {
	if (!/^https?:\/\//i.test(url))
		throw new Error("Only web links open outside the app");
	if (linksOff() && !isSampleLink(url)) {
		log("link refused: sample data");
		if (from && !from.isDestroyed()) from.send(IPC.linkRefused, LINKS_OFF);
		return false;
	}
	await shell.openExternal(url);
	return true;
}

/**
 * The window's links: its own pages stay in it; a web link (a new window or a navigation away)
 * goes to the default browser through `openExternalLink`; anything else is dropped.
 */
export function guardLinks(wc: WebContents) {
	const open = (url: string) => {
		if (/^https?:\/\//i.test(url))
			void openExternalLink(url, wc).catch((error) =>
				log("link not opened", String(error)),
			);
	};
	wc.setWindowOpenHandler(({ url }) => {
		open(url);
		return { action: "deny" };
	});
	wc.on("will-navigate", (event, url) => {
		if (url.startsWith(`${APP_ORIGIN}/`)) return;
		event.preventDefault();
		open(url);
	});
}
