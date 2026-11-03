import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A hover tip drawn by the page, on the popover's surface, for text a native `title` cannot
 * hold (several lines, a figure that loads later). The trigger is `children`, rendered as is.
 */
function Tooltip({
	content,
	children,
	side = "bottom",
	align = "end",
	className,
	"data-testid": testId,
}: {
	content: ReactNode;
	children: ReactElement;
	side?: TooltipPrimitive.Positioner.Props["side"];
	align?: TooltipPrimitive.Positioner.Props["align"];
	className?: string;
	"data-testid"?: string;
}) {
	return (
		<TooltipPrimitive.Root>
			<TooltipPrimitive.Trigger delay={300} render={children} />
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Positioner
					side={side}
					align={align}
					sideOffset={6}
					className="isolate z-50"
				>
					<TooltipPrimitive.Popup
						data-slot="tooltip"
						data-testid={testId}
						className={cn(
							"border-border bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 max-w-72 origin-(--transform-origin) rounded-lg border px-2.5 py-2 text-xs shadow-[var(--shadow-popup)] duration-100",
							className,
						)}
					>
						{content}
					</TooltipPrimitive.Popup>
				</TooltipPrimitive.Positioner>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}

export { Tooltip };
