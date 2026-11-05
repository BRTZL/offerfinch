import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";

/**
 * A menu of actions (the action bar's "…", a row's stage): the select's surface, 28 px items with
 * an icon, real labels, sections with a quiet label. Keyboard: arrows move, ↩ picks, Esc closes.
 */
function Menu(props: MenuPrimitive.Root.Props) {
	return <MenuPrimitive.Root data-slot="menu" {...props} />;
}

function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
	return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

function MenuContent({
	className,
	side = "bottom",
	sideOffset = 6,
	align = "end",
	...props
}: MenuPrimitive.Popup.Props &
	Pick<MenuPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Positioner
				side={side}
				sideOffset={sideOffset}
				align={align}
				className="isolate z-50"
			>
				<MenuPrimitive.Popup
					data-slot="menu-content"
					className={cn(
						"border-border bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 relative max-h-(--available-height) min-w-48 origin-(--transform-origin) overflow-y-auto rounded-lg border p-1 shadow-[var(--shadow-popup)] duration-150 outline-none",
						className,
					)}
					{...props}
				/>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}

function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
	return (
		<MenuPrimitive.Item
			data-slot="menu-item"
			className={cn(
				"data-highlighted:bg-primary data-highlighted:text-primary-foreground [&_svg]:text-muted-foreground data-highlighted:[&_svg]:text-primary-foreground relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-sm py-1 pr-2 pl-2 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		/>
	);
}

/** A quiet note at the item's end ("CV, letter or answers"). */
function MenuItemHint({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			className={cn("ml-auto pl-4 text-xs opacity-72", className)}
			{...props}
		/>
	);
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
	return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuGroupLabel({
	className,
	...props
}: MenuPrimitive.GroupLabel.Props) {
	return (
		<MenuPrimitive.GroupLabel
			data-slot="menu-group-label"
			className={cn(
				"text-muted-foreground px-2 pt-1.5 pb-1 text-xs font-medium",
				className,
			)}
			{...props}
		/>
	);
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
	return (
		<MenuPrimitive.Separator
			data-slot="menu-separator"
			className={cn("bg-border -mx-1 my-1 h-px", className)}
			{...props}
		/>
	);
}

export {
	Menu,
	MenuContent,
	MenuGroup,
	MenuGroupLabel,
	MenuItem,
	MenuItemHint,
	MenuSeparator,
	MenuTrigger,
};
