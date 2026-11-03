import { useQueryClient } from "@tanstack/react-query";
import { Building2, ListChecks } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { StateBadge } from "@/components/pipeline/bits";
import { PrepareTip } from "@/components/pipeline/prepare-tip";
import { Fit, IconTile } from "@/components/system/bits";
import { Group, Page, PageIntro, Section } from "@/components/system/layout";
import { Row } from "@/components/system/rows";
import { Button } from "@/components/ui/button";
import { client, orpc } from "@/lib/orpc";

/** The fields of an Inbox row the summaries show. */
export interface SummaryRow {
	id: string;
	title: string;
	companyName: string;
	locations: string[];
	workplaceType: string;
	score: number | null;
	state: string;
}

const place = (row: SummaryRow) =>
	[
		row.locations.slice(0, 2).join(" · "),
		row.workplaceType !== "unknown" ? row.workplaceType : "",
	]
		.filter(Boolean)
		.join(" · ") || "Location not given";

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

function Roles({
	rows,
	onOpen,
	showCompany,
}: {
	rows: SummaryRow[];
	onOpen: (id: string) => void;
	showCompany?: boolean;
}) {
	return (
		<Group>
			{rows.map((row) => (
				<Row
					key={row.id}
					title={row.title}
					subtitle={
						showCompany ? `${row.companyName} · ${place(row)}` : place(row)
					}
					meta={
						row.state === "scored" ? (
							<Fit value={row.score} />
						) : (
							<StateBadge state={row.state} />
						)
					}
					onClick={() => onOpen(row.id)}
					chevron
					data-testid="summary-role"
				/>
			))}
		</Group>
	);
}

/**
 * A company with several matches, selected in the Inbox: its roles with place and fit, and
 * Not interested in all of them at once (one set of reasons, and the company hidden if wanted).
 */
export function CompanySummary({
	name,
	rows,
	best,
	onOpen,
	action,
}: {
	name: string;
	rows: SummaryRow[];
	best: number | null;
	onOpen: (id: string) => void;
	/** Not interested in all of them (the popover's trigger; X opens it too). */
	action: ReactNode;
}) {
	return (
		<Page width="reading" data-testid="company-summary">
			<PageIntro
				leading={
					<IconTile>
						<Building2 />
					</IconTile>
				}
				title={name}
				description={`${plural(rows.length, "role")}${best !== null ? ` · best fit ${best}` : ""}`}
			/>
			<Section
				title="Roles"
				description="Open one to read the posting and Prepare it."
				end={action}
			>
				<Roles rows={rows} onOpen={onOpen} />
			</Section>
		</Page>
	);
}

/**
 * Prepare for the open matches of a selection, one request after another: the user pressed
 * the selection's own button. Each job then runs under the
 * spending limit and the plan's call budget like any other.
 */
function usePrepareMany(onPrepared: (ids: string[]) => void) {
	const queryClient = useQueryClient();
	const [preparing, setPreparing] = useState(false);
	const prepare = async (ids: string[]) => {
		setPreparing(true);
		const done: string[] = [];
		try {
			for (const id of ids) {
				await client.application.prepare({ id });
				done.push(id);
			}
			toast.success(
				`Drafting ${plural(done.length, "job")}. They move to Drafting.`,
			);
		} catch (error) {
			toast.error(
				`${done.length > 0 ? `${done.length} started; ` : ""}${(error as Error).message}`,
			);
		} finally {
			setPreparing(false);
			if (done.length > 0) onPrepared(done);
			void queryClient.invalidateQueries({ queryKey: ["inbox"] });
			void queryClient.invalidateQueries({ queryKey: orpc.dismissals.key() });
		}
	};
	return { prepare, preparing };
}

/**
 * Several rows chosen with ⌘ or ⇧ click: what they are, Not interested for all, and Prepare
 * for the open matches among them with what that is likely to cost in total (a button only,
 * never a key: decisions.md, 2026-11-03).
 */
export function SelectionSummary({
	rows,
	onOpen,
	action,
	matchIds,
	onPrepared,
}: {
	rows: SummaryRow[];
	onOpen: (id: string) => void;
	/** Not interested in the matches among them, with its label (X opens it too). */
	action: (label: string) => ReactNode;
	/** The open matches among them: what Not interested and Prepare act on. */
	matchIds: string[];
	/** Prepare started for these: they leave the list. */
	onPrepared: (ids: string[]) => void;
}) {
	const canDismiss = matchIds.length;
	const { prepare, preparing } = usePrepareMany(onPrepared);
	return (
		<Page width="reading" data-testid="selection-summary">
			<PageIntro
				leading={
					<IconTile>
						<ListChecks />
					</IconTile>
				}
				title={`${plural(rows.length, "job")} selected`}
				description={
					canDismiss === rows.length
						? "Not interested sets them all aside at once."
						: `${plural(canDismiss, "match", "matches")} can be set aside; the others have moved on.`
				}
			/>
			{canDismiss > 0 ? (
				<Section
					title="Prepare"
					end={
						<PrepareTip jobs={canDismiss}>
							<Button
								size="sm"
								onClick={() => void prepare(matchIds)}
								disabled={preparing}
								data-testid="prepare-selection"
							>
								{preparing ? "Starting…" : `Prepare ${canDismiss}`}
							</Button>
						</PrepareTip>
					}
				>
					<p className="text-muted-foreground text-xs">
						Drafts a CV, letter and answers for each, then checks them against
						your profile.
					</p>
				</Section>
			) : null}
			<Section title="Selected" end={action(`Not interested in ${canDismiss}`)}>
				<Roles rows={rows} onOpen={onOpen} showCompany />
			</Section>
		</Page>
	);
}
