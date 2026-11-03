import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";

/** A popover: the select's surface (card, hairline, popup shadow, 8 px corners), 12 px inset. */
function Popover(props: PopoverPrimitive.Root.Props) {
	return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
	return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/** Closes the popover (Cancel); with `modal`, its presence is what traps focus inside. */
function PopoverClose(props: PopoverPrimitive.Close.Props) {
	return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverContent({
	className,
	side = "bottom",
	sideOffset = 6,
	align = "end",
	alignOffset = 0,
	anchor,
	...props
}: PopoverPrimitive.Popup.Props &
	Pick<
		PopoverPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset" | "anchor"
	>) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				side={side}
				sideOffset={sideOffset}
				align={align}
				alignOffset={alignOffset}
				anchor={anchor}
				className="isolate z-50"
			>
				<PopoverPrimitive.Popup
					data-slot="popover-content"
					className={cn(
						"border-border bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 relative w-80 max-w-(--available-width) origin-(--transform-origin) rounded-lg border p-3 shadow-[var(--shadow-popup)] duration-150 outline-none",
						className,
					)}
					{...props}
				/>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	);
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
	return (
		<PopoverPrimitive.Title
			data-slot="popover-title"
			className={cn("text-foreground text-sm font-semibold", className)}
			{...props}
		/>
	);
}

function PopoverDescription({
	className,
	...props
}: PopoverPrimitive.Description.Props) {
	return (
		<PopoverPrimitive.Description
			data-slot="popover-description"
			className={cn("text-muted-foreground text-xs", className)}
			{...props}
		/>
	);
}

export {
	Popover,
	PopoverClose,
	PopoverContent,
	PopoverDescription,
	PopoverTitle,
	PopoverTrigger,
};
