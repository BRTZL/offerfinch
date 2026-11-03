/**
 * What's new (issue #9): the release notes bundled with the app (apps/desktop/CHANGELOG.md),
 * shown once after the app starts on a new version. Pure, so the decision is unit-tested.
 *
 * The changelog has one `## <version>` section per release, newest first, under an
 * `## Unreleased` section that the release script renames to the version it tags.
 */

export interface ReleaseSection {
	/** "0.2.0", or "Unreleased". */
	version: string;
	/** The heading's text after the version ("2026-11-03"), if any. */
	date: string | null;
	/** The section's Markdown, without its heading. */
	body: string;
}

const HEADING =
	/^##\s+(?:\[?v?(\d+\.\d+\.\d+|Unreleased)\]?)(?:\s*[-–—(]+\s*([^)\n]*)\)?)?\s*$/i;

/** Splits the changelog into its sections, in the file's order (newest first). */
export function parseChangelog(text: string): ReleaseSection[] {
	const sections: ReleaseSection[] = [];
	let current: ReleaseSection | null = null;
	const lines: string[] = [];
	const close = () => {
		if (current) sections.push({ ...current, body: lines.join("\n").trim() });
		lines.length = 0;
	};
	for (const line of text.split("\n")) {
		const heading = line.match(HEADING);
		if (heading?.[1]) {
			close();
			const version = /unreleased/i.test(heading[1])
				? "Unreleased"
				: heading[1];
			current = { version, date: heading[2]?.trim() || null, body: "" };
		} else if (current) lines.push(line);
	}
	close();
	return sections.filter((s) => s.body.length > 0);
}

/** Negative, zero or positive as a is older than, the same as or newer than b. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

const released = (s: ReleaseSection) => s.version !== "Unreleased";

export interface WhatsNewInput {
	/** The version running now. */
	version: string;
	/** The last version whose notes were shown or skipped; "" when none was ever stored. */
	seen: string;
	/** Onboarding has progress: this database was used before (an upgrade, not a first run). */
	usedBefore: boolean;
	sections: ReleaseSection[];
}

export type WhatsNewDecision =
	/** Show these sections, then store `version` as seen once the sheet is closed. */
	| { kind: "show"; sections: ReleaseSection[] }
	/** Nothing to show; store `version` as seen (a first run, or no notes for this version). */
	| { kind: "record" }
	/** Nothing to do: this version's notes were already shown. */
	| { kind: "none" };

/**
 * After an update, the notes of every version newer than the last one seen, up to the running
 * one (an update can skip versions). A fresh install shows nothing: the first run is not news.
 * A database from a version before What's new existed has no `seen` but has onboarding
 * progress: that is an upgrade, and this version's notes show.
 */
export function whatsNew(input: WhatsNewInput): WhatsNewDecision {
	if (input.seen === input.version) return { kind: "none" };
	if (!input.seen && !input.usedBefore) return { kind: "record" };
	const sections = input.sections.filter(
		(s) =>
			released(s) &&
			compareVersions(s.version, input.version) <= 0 &&
			(input.seen
				? compareVersions(s.version, input.seen) > 0
				: s.version === input.version),
	);
	return sections.length ? { kind: "show", sections } : { kind: "record" };
}

/**
 * Settings › General › What's new, any time: the running version's notes and the ones before
 * it. A build made before its release (the version's section is still "Unreleased") shows the
 * upcoming notes first.
 */
export function notesUpTo(
	version: string,
	sections: ReleaseSection[],
	count = 3,
): ReleaseSection[] {
	const current = sections.filter(
		(s) => released(s) && compareVersions(s.version, version) <= 0,
	);
	const upcoming = current.some((s) => s.version === version)
		? []
		: sections.filter((s) => !released(s));
	return [...upcoming, ...current].slice(0, count);
}
