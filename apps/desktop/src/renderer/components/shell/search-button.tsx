import { Search } from "lucide-react";
import { Kbd } from "@/components/system/bits";
import { sendCommand } from "@/lib/commands";
import { keyHint } from "../../../shared/shortcuts";

/** The toolbar's search: opens the ⌘K command menu. */
export function SearchButton() {
	return (
		<button
			type="button"
			onClick={() => sendCommand("command-menu")}
			className="border-input bg-card text-muted-foreground ease-standard hover:bg-hover focus-visible:ring-ring dark:bg-input flex h-7 w-7 items-center justify-center gap-1.5 rounded-lg border px-2 text-sm transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset xl:w-56 xl:justify-start"
			data-testid="search-button"
			aria-label={`Search (${keyHint("command-menu")})`}
		>
			<Search className="size-3.5" />
			<span className="hidden flex-1 text-left xl:inline">Search</span>
			<span className="hidden xl:inline-flex">
				<Kbd>{keyHint("command-menu")}</Kbd>
			</span>
		</button>
	);
}
