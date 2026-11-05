import {
	Check,
	ChevronRight,
	CircleHelp,
	Minus,
	TriangleAlert,
} from "lucide-react";
import type { AppDetail } from "@/components/pipeline/application/types";
import { Cells, Fit } from "@/components/system/bits";
import { cn } from "@/lib/utils";

type Requirement = NonNullable<AppDetail["fit"]>["requirements"][number];

/** The requirement as a line: no closing full stop ("Go is a plus: unclear"). */
const line = (r: Requirement) => r.requirement.trim().replace(/[.;]+$/, "");

const MISSING_NOTE: Record<string, string> = {
	partial: "partly",
	unknown: "unclear",
};

/** Musts first, then the rest, in the posting's order. */
const byImportance = (list: Requirement[]) =>
	[...list].sort(
		(a, b) => Number(b.importance === "must") - Number(a.importance === "must"),
	);

/**
 * The fit under the detail's title: the score, its cells, requirements met, what matches and
 * what's missing, from the fit assessment. The whole card is one button that opens the details
 * sheet. Folded to one line for a draft in review, where the documents come first.
 */
export function FitCard({
	app,
	folded,
	open,
	onOpen,
}: {
	app: AppDetail;
	folded: boolean;
	/** The details sheet is open. */
	open: boolean;
	onOpen: () => void;
}) {
	const requirements = app.fit?.requirements ?? [];
	const met = requirements.filter((r) => r.status === "met");
	const missing = byImportance(requirements.filter((r) => r.status !== "met"));
	const claims = (app.review?.claims ?? []) as { supported: boolean }[];
	const traced = claims.filter((c) => c.supported).length;
	const score = app.score ?? 0;
	const cells = (
		<Cells
			total={10}
			on={Math.round(score / 10)}
			tone="brand"
			label={`Fit ${score} of 100`}
		/>
	);
	const metText =
		requirements.length > 0
			? folded
				? `${met.length} of ${requirements.length} met`
				: `${met.length} of ${requirements.length} requirements met`
			: null;
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-expanded={open}
			aria-controls={open ? "application-inspector" : undefined}
			data-testid="fit-card"
			data-folded={folded ? "" : undefined}
			className={cn(
				"border-border bg-card ease-standard hover:bg-hover focus-visible:ring-ring flex w-full flex-col rounded-xl border text-left transition-colors duration-150 outline-none focus-visible:ring-2",
				folded ? "px-4 py-2.5" : "gap-4 p-4",
			)}
		>
			<span className="flex w-full items-center gap-3">
				<Fit value={app.score} size="lg" />
				<span
					className={cn(
						"flex min-w-0 flex-1",
						folded ? "items-center gap-3" : "flex-col gap-1",
					)}
				>
					{cells}
					{metText ? (
						<span
							className="text-muted-foreground truncate text-xs"
							data-testid="fit-met"
						>
							{metText}
						</span>
					) : null}
					{folded && claims.length > 0 && traced < claims.length ? (
						<span
							className="text-warning flex min-w-0 items-center gap-1 truncate text-xs"
							data-testid="fit-claims"
						>
							<TriangleAlert className="size-3.5 shrink-0" />
							{traced} of {claims.length} claims trace
						</span>
					) : null}
				</span>
				<span className="bg-muted text-foreground flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium">
					{folded ? "Details" : "Fit details"}
					<ChevronRight className="text-muted-foreground size-3.5" />
				</span>
			</span>
			{!folded && requirements.length > 0 ? (
				<span className="border-border grid w-full grid-cols-2 gap-4 border-t pt-3">
					<span className="flex min-w-0 flex-col gap-1.5">
						<span className="text-muted-foreground text-xs font-medium">
							What matches
						</span>
						{met.length === 0 ? (
							<span className="text-muted-foreground text-xs">
								No requirement met yet
							</span>
						) : (
							met.slice(0, 3).map((r) => (
								<span
									key={r.requirement}
									className="text-foreground flex min-w-0 items-start gap-2 text-sm"
									data-testid="fit-match"
								>
									<Check className="text-brand mt-0.5 size-3.5 shrink-0" />
									<span className="min-w-0 truncate">{line(r)}</span>
								</span>
							))
						)}
					</span>
					<span className="flex min-w-0 flex-col gap-1.5">
						<span className="text-muted-foreground text-xs font-medium">
							What's missing
						</span>
						{missing.length === 0 ? (
							<span className="text-muted-foreground text-xs">
								Every listed requirement is met
							</span>
						) : (
							missing.slice(0, 2).map((r) => (
								<span
									key={r.requirement}
									className="text-foreground flex min-w-0 items-start gap-2 text-sm"
									data-testid="fit-missing"
								>
									{r.status === "not_met" ? (
										<Minus className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
									) : (
										<CircleHelp className="text-warning mt-0.5 size-3.5 shrink-0" />
									)}
									<span className="min-w-0 truncate">
										{line(r)}
										{MISSING_NOTE[r.status]
											? `: ${MISSING_NOTE[r.status]}`
											: ""}
									</span>
								</span>
							))
						)}
					</span>
				</span>
			) : null}
		</button>
	);
}
