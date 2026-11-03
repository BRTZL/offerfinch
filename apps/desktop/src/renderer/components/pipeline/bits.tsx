import type { ReactNode } from "react";
import { toast } from "sonner";
import { Badge, type Tone } from "@/components/system/bits";
import { InspectorSection } from "@/components/system/pane";
import { desktop } from "@/lib/desktop";
import { usd } from "@/lib/money";

export const STATE_LABEL: Record<string, string> = {
	found: "Found",
	rejected_by_filter: "Filtered out",
	scored: "Scored",
	preparing: "Preparing",
	needs_answers: "Needs answers",
	ready_for_review: "Ready for review",
	approved: "Approved",
	rejected: "Rejected",
	expired: "Expired",
	applying: "Submitting",
	applied: "Applied",
	needs_human: "Needs you",
	failed: "Failed",
	dismissed: "Not interested",
	low_score: "Low fit",
};

/** What each state means, for a tooltip or a first-time reader. */
const STATE_HINT: Record<string, string> = {
	found: "Just found; the job filter and fit score run next.",
	rejected_by_filter: "Failed a job filter rule; never scored or tailored.",
	scored: "Scored; the CV and letter are drafted next.",
	preparing: "Drafting the CV, letter and answers, then checking every claim.",
	needs_answers:
		"Waiting for you to answer a question in Questions before drafting.",
	ready_for_review: "Drafted and checked; read it, then approve or reject.",
	approved: "Approved; ready to be submitted.",
	rejected: "You rejected it.",
	expired: "Waited too long and closed; nothing was sent.",
	applying: "Being submitted automatically.",
	applied: "Submitted.",
	needs_human:
		"Stopped during an automatic submission; check it and finish by hand.",
	failed: "Preparation stopped on an error; nothing was sent.",
	dismissed:
		"You were not interested, or it is from a company you hid; nothing was drafted.",
	low_score: "Scored below your minimum fit; not tailored.",
};

const STATE_TONE: Record<string, Tone> = {
	needs_answers: "warning",
	ready_for_review: "brand",
	approved: "primary",
	applying: "primary",
	applied: "neutral",
	preparing: "quiet",
	scored: "quiet",
	failed: "destructive",
	needs_human: "warning",
	rejected: "quiet",
	rejected_by_filter: "quiet",
	expired: "quiet",
	dismissed: "quiet",
};

export function StateBadge({ state }: { state: string }) {
	return (
		<Badge
			tone={STATE_TONE[state] ?? "neutral"}
			data-state={state}
			title={STATE_HINT[state]}
		>
			{STATE_LABEL[state] ?? state}
		</Badge>
	);
}

/** A titled block of a side panel (inspector, details). */
export function Section({
	title,
	aside,
	children,
	className,
}: {
	title: string;
	aside?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<InspectorSection title={title} end={aside} className={className}>
			<div className="text-sm">{children}</div>
		</InspectorSection>
	);
}

export function ago(date: string | Date | null | undefined): string {
	if (!date) return "";
	const seconds = (Date.now() - new Date(date).getTime()) / 1000;
	if (seconds < 90) return "just now";
	const minutes = seconds / 60;
	if (minutes < 90) return `${Math.round(minutes)}m ago`;
	const hours = minutes / 60;
	if (hours < 36) return `${Math.round(hours)}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/**
 * An exported file (PDF, DOCX): opens it in its default app (Preview, Word). The worker reads it
 * from the app's folder; nothing is served over HTTP.
 */
export function FileLink({
	documentId,
	children,
	className,
	...rest
}: {
	documentId: string;
	children: React.ReactNode;
	className?: string;
	title?: string;
	"aria-label"?: string;
}) {
	return (
		<button
			type="button"
			className={className}
			onClick={() =>
				desktop
					.openDocument(documentId)
					.catch((error: Error) => toast.error(error.message))
			}
			{...rest}
		>
			{children}
		</button>
	);
}

/**
 * An application's model cost. Calls on a subscription have no per-call price, so they read
 * "Subscription" rather than a misleading "$0"; mixed with API calls, the API part is priced.
 */
export function costLabel(
	micros: number,
	subscriptionCalls = 0,
	apiCalls = 0,
): string {
	if (subscriptionCalls > 0 && apiCalls === 0) return "Subscription";
	if (subscriptionCalls > 0) return `${usd(micros)} + subscription`;
	return usd(micros);
}

const SOURCE_LABEL: Record<string, string> = {
	ashby: "Ashby",
	greenhouse: "Greenhouse",
	lever: "Lever",
	scrape: "Careers page",
	linkedin: "LinkedIn",
	indeed: "Indeed",
	glassdoor: "Glassdoor",
	web: "Web",
	remotive: "Remotive",
	remoteok: "Remote OK",
	weworkremotely: "We Work Remotely",
	hackernews: "Hacker News",
	manual: "Added by hand",
};

/**
 * Sources whose terms ask that a job link back to its page there and name them (Remotive, Remote
 * OK, We Work Remotely), and Hacker News, whose post is the posting: the link says where it goes.
 */
const LINK_BACK = new Set([
	"remotive",
	"remoteok",
	"weworkremotely",
	"hackernews",
]);

/** A job from a remote feed: its whole posting came from the feed, never read again. */
export function fromFeed(source?: string | null): boolean {
	return Boolean(source && LINK_BACK.has(source));
}

/** The posting's link text: "Open on Remotive" for a feed's job, "Open original" otherwise. */
export function postingLinkLabel(source?: string | null): string {
	return source && LINK_BACK.has(source)
		? `Open on ${sourceLabel(source)}`
		: "Open original";
}

/** A board's name in words: Greenhouse, Careers page. */
export function sourceLabel(source?: string | null): string {
	return source ? (SOURCE_LABEL[source] ?? source) : "";
}
