import {
	DISMISS_REASON_LABEL,
	type DismissReason,
	ENDED_COMPANY_HIDDEN,
} from "@offerfinch/core/domain/dismissal";
import { filterRuleLabel } from "@offerfinch/core/filter/rule-labels";
import { useQuery } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { useState } from "react";
import { ApplicationListPage } from "@/components/pipeline/application-list";
import { ago } from "@/components/pipeline/bits";
import { Fit } from "@/components/system/bits";
import { Button } from "@/components/ui/button";
import { type client, orpc } from "@/lib/orpc";

type RejectedRow = NonNullable<
	Awaited<ReturnType<typeof client.rejected.list>>
>[number];

/** Why the job was turned down, in a few words. */
function reason(r: RejectedRow): string {
	if (r.state === "rejected") return r.userReason || "Rejected by you";
	if (r.state === "dismissed") return notInterested(r);
	if (r.state === "scored") return "Fit below your minimum";
	const failed = (r.filterResult?.reasons ?? []).find(
		(x) => x.outcome === "reject",
	);
	return failed
		? `${filterRuleLabel(failed.rule)}: ${failed.message}`
		: (r.filterResult?.summary ?? r.endedReason ?? "Ruled out");
}

/** Not interested, with the reasons the user ticked; or the company they hid. */
function notInterested(r: RejectedRow): string {
	if (r.endedReason === ENDED_COMPANY_HIDDEN) return "Company hidden";
	let ticked: DismissReason[] = [];
	try {
		ticked = r.dismissReasons ? JSON.parse(r.dismissReasons) : [];
	} catch {}
	const words = ticked
		.map((x) => DISMISS_REASON_LABEL[x])
		.filter(Boolean)
		.join(", ");
	return words ? `Not interested: ${words}` : "Not interested";
}

type ReasonKind = "filter" | "score" | "user";

const kindOf = (r: RejectedRow): ReasonKind =>
	r.state === "rejected" || r.state === "dismissed"
		? "user"
		: r.state === "scored"
			? "score"
			: "filter";

/** The reason chips' words, short enough for the list column. */
const KIND_LABEL: Record<ReasonKind, string> = {
	filter: "Search prefs",
	score: "Low fit",
	user: "By you",
};
const KINDS: ReasonKind[] = ["filter", "score", "user"];

/**
 * Every job the pipeline or the user turned down, with the stated reason, beside the one chosen.
 * The reasons are a row of chips on top of the list, each with its count.
 */
export default function RejectedPage() {
	const list = useQuery(orpc.rejected.list.queryOptions());
	const [kind, setKind] = useState<ReasonKind | "all">("all");
	const all = list.data ?? [];
	const count = (k: ReasonKind) => all.filter((r) => kindOf(r) === k).length;
	const rows = kind === "all" ? all : all.filter((r) => kindOf(r) === kind);
	const filtered = kind !== "all";
	const chip = (value: ReasonKind | "all", label: string, n: number) => (
		<Button
			key={value}
			size="xs"
			variant={kind === value ? "secondary" : "outline"}
			aria-pressed={kind === value}
			className="aria-pressed:border-primary rounded-full"
			onClick={() => setKind(value)}
			data-testid={`reason-${value}`}
		>
			{label}
			<span className="text-muted-foreground tabular-nums">{n}</span>
		</Button>
	);
	return (
		<ApplicationListPage
			base="/rejected"
			title="Rejected"
			subtitle={
				list.data
					? `${all.length} job${all.length === 1 ? "" : "s"}`
					: undefined
			}
			label="Rejected"
			top={
				all.length > 0 ? (
					<fieldset
						className="flex shrink-0 flex-wrap gap-1.5 px-3 pt-3"
						data-testid="reason-filter"
					>
						<legend className="sr-only">Reason</legend>
						{chip("all", "All", all.length)}
						{KINDS.filter((k) => count(k) > 0 || k === kind).map((k) =>
							chip(k, KIND_LABEL[k], count(k)),
						)}
					</fieldset>
				) : null
			}
			items={rows}
			loading={list.isLoading}
			error={
				list.isError
					? `Could not load rejected jobs: ${list.error.message}. It retries shortly.`
					: null
			}
			empty={{
				icon: <Archive />,
				title: filtered ? "None for this reason" : "Nothing rejected yet",
				body: filtered
					? "No job was turned down for this reason. Choose All to see every one."
					: "Jobs your search preferences rule out, or that score below your minimum fit, land here with the reason.",
			}}
			render={(r) => ({
				testId: "rejected-row",
				title: r.companyName,
				time: ago(r.stateChangedAt),
				subtitle: r.title,
				meta: (
					<>
						<Fit value={r.score} />
						<span className="text-muted-foreground truncate">{reason(r)}</span>
					</>
				),
			})}
		/>
	);
}
