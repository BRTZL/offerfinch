import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

/**
 * Tabs as a segmented control: a 2 px padded track, segments 28 high (24 with `size="sm"`),
 * the chosen one raised. Arrow keys move between segments.
 */
function Tabs({
	className,
	orientation = "horizontal",
	...props
}: TabsPrimitive.Root.Props) {
	return (
		<TabsPrimitive.Root
			data-slot="tabs"
			data-orientation={orientation}
			className={cn(
				"group/tabs flex gap-2 data-horizontal:flex-col",
				className,
			)}
			{...props}
		/>
	);
}

function TabsList({
	className,
	size = "default",
	...props
}: TabsPrimitive.List.Props & { size?: "default" | "sm" }) {
	return (
		<TabsPrimitive.List
			data-slot="tabs-list"
			data-size={size}
			className={cn(
				"group/tabs-list bg-muted inline-flex w-fit items-center gap-0.5 rounded-lg p-0.5 shadow-[inset_0_0_0_1px_var(--border)]",
				className,
			)}
			{...props}
		/>
	);
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
	return (
		<TabsPrimitive.Tab
			data-slot="tabs-trigger"
			className={cn(
				"text-muted-foreground ease-standard hover:text-foreground focus-visible:ring-ring data-active:bg-card data-active:text-foreground dark:data-active:bg-input/72 inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-[9px] text-sm font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 outline-none group-data-[size=sm]/tabs-list:h-6 group-data-[size=sm]/tabs-list:px-[7px] group-data-[size=sm]/tabs-list:text-xs focus-visible:ring-2 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-64 data-active:shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/6%)] dark:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
				className,
			)}
			{...props}
		/>
	);
}

export { Tabs, TabsList, TabsTrigger };
