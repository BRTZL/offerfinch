import { ArrowDown, Check, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverClose,
	PopoverContent,
	PopoverDescription,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import { desktop } from "@/lib/desktop";
import { useUpdateState } from "@/lib/updates";
import type { UpdateState } from "../../../shared/bridge";

const R = 12;
const C = 2 * Math.PI * R;

/** The ring round the indicator while the update downloads: a turning arc until progress comes. */
function Ring({ percent }: { percent: number }) {
	const known = percent > 0;
	return (
		<svg
			viewBox="0 0 28 28"
			aria-hidden
			className={
				known
					? "absolute inset-0 size-7 -rotate-90"
					: "absolute inset-0 size-7 -rotate-90 motion-safe:animate-spin"
			}
		>
			<circle
				cx={14}
				cy={14}
				r={R}
				fill="none"
				strokeWidth={2}
				className="stroke-border"
			/>
			<circle
				cx={14}
				cy={14}
				r={R}
				fill="none"
				strokeWidth={2}
				strokeLinecap="round"
				className="stroke-primary transition-all duration-500 ease-out"
				strokeDasharray={C}
				strokeDashoffset={
					known ? C * (1 - Math.min(percent, 100) / 100) : C * 0.75
				}
			/>
		</svg>
	);
}

/** Where the green check sits: the button's bottom-right, with a gap cut out of the button. */
const CUTOUT =
	"radial-gradient(circle at calc(100% - 3px) calc(100% - 3px), transparent 7.5px, #000 8px)";

function Ready({
	update,
}: {
	update: Extract<UpdateState, { status: "ready" }>;
}) {
	const [open, setOpen] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const notes = update.notes.slice(0, 2);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				data-testid="sidebar-update"
				aria-label={`OfferFinch ${update.version} is ready. Restart to update`}
				title={`OfferFinch ${update.version} is ready`}
				className="group text-foreground focus-visible:ring-ring motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-75 relative grid size-7 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 motion-safe:duration-300"
			>
				<span
					aria-hidden
					className="bg-foreground/8 group-hover:bg-foreground/14 group-aria-expanded:bg-foreground/14 ease-standard absolute inset-0 rounded-full transition-colors duration-150"
					style={{ maskImage: CUTOUT, WebkitMaskImage: CUTOUT }}
				/>
				<RefreshCw className="relative size-3.5" strokeWidth={2} />
				<span
					aria-hidden
					className="bg-brand motion-safe:animate-in motion-safe:zoom-in-0 text-background absolute -right-0.75 -bottom-0.75 grid size-3 place-items-center rounded-full motion-safe:duration-300"
				>
					<Check className="size-2" strokeWidth={3.5} />
				</span>
			</PopoverTrigger>
			<PopoverContent
				side="top"
				align="start"
				sideOffset={8}
				className="w-72"
				data-testid="update-popover"
			>
				<div className="flex flex-col gap-0.5">
					<PopoverTitle>OfferFinch {update.version} is ready</PopoverTitle>
					<PopoverDescription>
						Downloaded in the background. Restarting takes a few seconds.
					</PopoverDescription>
				</div>
				{notes.length ? (
					<div className="mt-3">
						<p className="text-muted-foreground mb-1 text-xs font-medium">
							What's new
						</p>
						<ul
							className="text-foreground/85 marker:text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-xs"
							data-testid="update-notes"
						>
							{notes.map((note) => (
								<li key={note} title={note}>
									<span className="line-clamp-2">{note}</span>
								</li>
							))}
						</ul>
					</div>
				) : null}
				<div className="mt-3 flex items-center justify-end gap-2">
					<PopoverClose render={<Button size="sm" variant="ghost" />}>
						Later
					</PopoverClose>
					<Button
						size="sm"
						pending={restarting}
						data-testid="update-restart"
						onClick={async () => {
							setRestarting(true);
							// False when it can't install (nothing ready any more): stay usable.
							const started = await desktop.updates
								.install()
								.catch(() => false);
							if (!started) setRestarting(false);
						}}
					>
						Restart now
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

/**
 * The sidebar foot's update indicator, after T3 Code's: nothing while up to date, a ring while
 * a new version downloads in the background, then a restart button with a green check that
 * opens what's new, Later and Restart now.
 */
export function UpdateIndicator() {
	const update = useUpdateState();
	// Leaving "ready" (an install that fails turns it into an error) unmounts Ready and its
	// popover, so it never floats with nothing to restart into.
	if (update?.status === "ready")
		return <Ready key={update.version} update={update} />;
	if (update?.status !== "downloading") return null;
	return (
		<span
			role="img"
			aria-label={`Downloading OfferFinch ${update.version}, ${update.percent}%`}
			title={`Downloading OfferFinch ${update.version}… ${update.percent}%`}
			data-testid="sidebar-update-progress"
			className="text-muted-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-75 relative grid size-7 shrink-0 place-items-center motion-safe:duration-300"
		>
			<Ring percent={update.percent} />
			<ArrowDown className="relative size-3.5" strokeWidth={2} />
		</span>
	);
}
