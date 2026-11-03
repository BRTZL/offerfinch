import { filterRuleLabel } from "@offerfinch/core/filter/rule-labels";
import { useQuery } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { useState } from "react";
import { ApplicationListPage } from "@/components/pipeline/application-list";
import { ago } from "@/components/pipeline/bits";
import { FilterSelect } from "@/components/pipeline/filter-select";
import { Fit, SearchField } from "@/components/system/bits";
import { type client, orpc } from "@/lib/orpc";

type RejectedRow = NonNullable<
	Awaited<ReturnType<typeof client.rejected.list>>
>[number];

/** Why the job was turned down, in a few words. */
function reason(r: RejectedRow): string {
	if (r.state === "rejected") return r.userReason || "Rejected by you";
	if (r.state === "scored") return "Fit below your minimum";
	const failed = (r.filterResult?.reasons ?? []).find(
		(x) => x.outcome === "reject",
	);
	return failed
		? `${filterRuleLabel(failed.rule)}: ${failed.message}`
		: (r.filterResult?.summary ?? r.endedReason ?? "Ruled out");
}

/** Every job the pipeline or the user turned down, with the stated reason, beside the one chosen. */
export default function RejectedPage() {
	const list = useQuery(orpc.rejected.list.queryOptions());
	const [search, setSearch] = useState("");
	const [kind, setKind] = useState("all");
	const rows = (list.data ?? []).filter((r) => {
		const reasonKind =
			r.state === "rejected"
				? "user"
				: r.state === "scored"
					? "score"
					: "filter";
		if (kind !== "all" && kind !== reasonKind) return false;
		const q = search.toLowerCase();
		return (
			!q ||
			r.title.toLowerCase().includes(q) ||
			r.companyName.toLowerCase().includes(q)
		);
	});
	const filtered = Boolean(search) || kind !== "all";
	return (
		<ApplicationListPage
			base="/rejected"
			title="Rejected"
			subtitle={
				list.data
					? `${rows.length} job${rows.length === 1 ? "" : "s"}`
					: undefined
			}
			label="Rejected"
			toolbar={
				<>
					<FilterSelect
						label="Reason"
						value={kind}
						onChange={setKind}
						options={[
							{ value: "all", label: "All reasons" },
							{ value: "filter", label: "Search preferences" },
							{ value: "score", label: "Low fit" },
							{ value: "user", label: "Rejected by you" },
						]}
					/>
					<SearchField
						label="Search title or company"
						placeholder="Search"
						value={search}
						onChange={setSearch}
						className="w-48"
					/>
				</>
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
				title: filtered ? "No matches" : "Nothing rejected yet",
				body: filtered
					? "Nothing matches this search or reason."
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
