import { useQuery } from "@tanstack/react-query";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { orpc } from "@/lib/orpc";

/** Up to this many places are listed inline; more collapse into a summary. */
const INLINE = 3;

const REMOTE = /^\s*remote\b/i;

/** "Remote (Turkey)" → "Turkey"; anything else unchanged. */
function placeName(location: string): string {
	return location.match(/^\s*remote\s*\((.+)\)\s*$/i)?.[1] ?? location;
}

/**
 * Where a job is, in one short line. A long list (a posting open in 140 countries) reads as a
 * summary — "Remote in 141 countries, including Turkey" — and the full list opens on hover or
 * click, so it never pushes the posting off screen.
 */
export function Locations({ locations }: { locations: string[] }) {
	const settings = useQuery(orpc.settings.get.queryOptions());
	const home = settings.data?.livesIn?.trim() ?? "";
	if (locations.length <= INLINE) return <>{locations.join(" · ")}</>;

	const isHome = (location: string) =>
		home !== "" && location.toLowerCase().includes(home.toLowerCase());
	const homeLocation = locations.find(isHome);
	const allRemote = locations.every((l) => REMOTE.test(l));
	const summary = allRemote
		? `Remote in ${locations.length} countries`
		: `${locations.slice(0, 2).join(" · ")} and ${locations.length - 2} more`;
	return (
		<Popover>
			<PopoverTrigger
				openOnHover
				delay={250}
				className="decoration-muted-foreground/50 hover:text-foreground underline decoration-dotted underline-offset-4"
				data-testid="locations-summary"
			>
				{summary}
				{homeLocation ? `, including ${placeName(homeLocation)}` : ""}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-96"
				data-testid="locations-list"
			>
				<p className="text-foreground mb-2 text-sm font-semibold">
					{locations.length} locations
				</p>
				<ul
					className="text-muted-foreground flex max-h-72 flex-col gap-0.5 overflow-auto text-sm"
					data-selectable
				>
					{[...(homeLocation ? [homeLocation] : []), ...locations]
						.filter((l, i) => i === 0 || l !== homeLocation)
						.map((location, i) => (
							<li
								key={`${i}-${location}`}
								className={isHome(location) ? "text-foreground" : undefined}
							>
								{location}
							</li>
						))}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
