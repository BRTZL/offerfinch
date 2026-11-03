import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

import { IconTile } from "./bits";

/**
 * One of a few ways to do something, as a card: an icon, a title and one line. A real button,
 * so Tab, Space and Enter work. `dragging` highlights it while a file is dragged over its step.
 */
export function OptionCard({
	icon,
	title,
	description,
	onClick,
	dragging,
	testId,
}: {
	icon: ReactNode;
	title: ReactNode;
	description: ReactNode;
	onClick: () => void;
	dragging?: boolean;
	testId?: string;
}) {
	return (
		<button
			type="button"
			data-ds="option-card"
			data-testid={testId}
			data-dragging={dragging || undefined}
			onClick={onClick}
			className={cn(
				"border-border bg-card ease-standard hover:bg-hover focus-visible:ring-ring flex w-full items-start gap-3 rounded-xl border px-4 py-3.5 text-left shadow-xs transition-colors duration-150 outline-none focus-visible:ring-2",
				dragging && "border-primary bg-primary-surface",
			)}
		>
			<IconTile>{icon}</IconTile>
			<span className="min-w-0 flex-1">
				<span className="text-foreground block text-sm font-medium">
					{title}
				</span>
				<span className="text-muted-foreground mt-0.5 block text-xs">
					{description}
				</span>
			</span>
		</button>
	);
}
