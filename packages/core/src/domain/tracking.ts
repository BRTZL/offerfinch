/**
 * What happens after Applied: the stages an application goes through with the employer, kept
 * apart from the pipeline's states (`domain/states.ts`). The application itself stays `applied`;
 * its stage is the newest row in `application_stages`. "Rejected by the company" is a stage
 * (`company_rejected`), never the pipeline's `rejected` (a draft the user set aside).
 *
 * Stage entries and private notes are the user's own records: nothing here is ever given to a
 * model.
 */
export const TRACKING_STAGES = [
	"applied",
	"heard_back",
	"interviewing",
	"offer",
	"company_rejected",
	"withdrawn",
	"ghosted",
] as const;
export type TrackingStage = (typeof TRACKING_STAGES)[number];

export const STAGE_LABEL: Record<TrackingStage, string> = {
	applied: "Applied",
	heard_back: "Heard back",
	interviewing: "Interviewing",
	offer: "Offer",
	company_rejected: "Rejected by the company",
	withdrawn: "Withdrawn",
	ghosted: "Ghosted",
};

/** Stages still waiting on the employer: the follow-up reminder and Ghosted watch these. */
const WAITING_STAGES: readonly TrackingStage[] = ["applied", "heard_back"];

/** No change for this long in a waiting stage: Ghosted, set by the app (the user can undo it). */
export const GHOST_AFTER_DAYS = 21;
/** No change for this long in a waiting stage: one reminder to follow up, once per stage entry. */
export const FOLLOW_UP_AFTER_DAYS = 7;

const DAY_MS = 86_400_000;

/** A calendar day, YYYY-MM-DD, as this computer's time zone sees the instant. */
export function localDay(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Whether a string is a real calendar day, YYYY-MM-DD. */
export function isDay(day: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
	const date = new Date(`${day}T00:00:00Z`);
	return (
		!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day
	);
}

/** The first moment of a calendar day in this computer's time zone. */
function dayStart(day: string): Date {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	return new Date(y, m - 1, d);
}

/**
 * A calendar day as the user reads it ("Nov 3, 2026"), with no time zone conversion: the day
 * picked is the day shown, in Auckland as in Los Angeles.
 */
export function dayLabel(day: string, locale?: string): string {
	return new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, {
		timeZone: "UTC",
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

/**
 * When a stage entry's waiting starts: the later of the start of the day the user gave (local
 * midnight) and when they recorded it. A move dated last month must not ghost the job the moment
 * it is saved, and moving a ghosted job back must not ghost it again on the next sweep.
 */
export function stageClock(entry: {
	occurredOn: string;
	createdAt: Date;
}): Date {
	return new Date(
		Math.max(dayStart(entry.occurredOn).getTime(), entry.createdAt.getTime()),
	);
}

/** What the sweep does with an application's current stage now: ghost it, remind once, or nothing. */
export function sweepDecision(input: {
	stage: TrackingStage;
	clock: Date;
	remindedAt: Date | null;
	/** When macOS last did not show the reminder; it is tried again once a day. */
	triedAt?: Date | null;
	now: Date;
}): "ghost" | "remind" | null {
	if (!WAITING_STAGES.includes(input.stage)) return null;
	const waited = input.now.getTime() - input.clock.getTime();
	if (waited >= GHOST_AFTER_DAYS * DAY_MS) return "ghost";
	const retry =
		!input.triedAt || input.now.getTime() - input.triedAt.getTime() >= DAY_MS;
	if (waited >= FOLLOW_UP_AFTER_DAYS * DAY_MS && !input.remindedAt && retry)
		return "remind";
	return null;
}

/* ------------------------------------------------------------------ .ics */

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, and line breaks. */
function escapeText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r?\n/g, "\\n");
}

/** Folds a content line at 75 octets (RFC 5545 3.1), never inside a UTF-8 character. */
function fold(line: string): string {
	const encoder = new TextEncoder();
	const parts: string[] = [];
	let current = "";
	let size = 0;
	for (const char of line) {
		const bytes = encoder.encode(char).length;
		// The first line holds 75 octets; continuation lines start with a space, so 74 more.
		const limit = parts.length === 0 ? 75 : 74;
		if (size + bytes > limit) {
			parts.push(current);
			current = "";
			size = 0;
		}
		current += char;
		size += bytes;
	}
	parts.push(current);
	return parts.join("\r\n ");
}

/** A UTC date-time as iCalendar writes it: 20261103T143000Z. */
function icsTime(date: Date): string {
	return date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

/**
 * An interview as a calendar event the user saves and opens in Calendar: no account, no
 * network. Times are UTC instants, so Calendar shows them in the user's own time zone. The
 * user's private notes never go in: calendars sync to other services.
 */
export function interviewIcs(input: {
	/** Stable per stage entry, so opening the file again updates the same event. */
	uid: string;
	start: Date;
	durationMinutes?: number;
	company: string;
	title: string;
	round: number | null;
	url: string;
	now?: Date;
}): string {
	const end = new Date(
		input.start.getTime() + (input.durationMinutes ?? 60) * 60_000,
	);
	const round = input.round ? ` (round ${input.round})` : "";
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//OfferFinch//Interview//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		"BEGIN:VEVENT",
		`UID:${input.uid}@offerfinch.app`,
		`DTSTAMP:${icsTime(input.now ?? new Date())}`,
		`DTSTART:${icsTime(input.start)}`,
		`DTEND:${icsTime(end)}`,
		`SUMMARY:${escapeText(`Interview${round}: ${input.title} at ${input.company}`)}`,
		`DESCRIPTION:${escapeText(`${input.title} at ${input.company}\n${input.url}`)}`,
		`URL:${input.url}`,
		"END:VEVENT",
		"END:VCALENDAR",
	];
	return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** A file name for the event: letters, digits and dashes only. */
export function icsFileName(company: string, round: number | null): string {
	const slug = company
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/[\s_]+/g, "-")
		.toLowerCase();
	return `interview-${slug || "job"}${round ? `-round-${round}` : ""}.ics`;
}
