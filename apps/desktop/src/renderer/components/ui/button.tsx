import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The push button (docs/design/desktop/system.md): 32, 28 or 24 high, 8 px corners, 14 px
 * medium text, a quiet fill on hover, a 0.97 press. The default is the primary action; one per
 * view. Horizontal padding is a step minus the 1 px edge, so text sits on the same grid.
 */
const buttonVariants = cva(
	"ease-standard focus-visible:ring-ring aria-invalid:border-destructive relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent text-sm font-medium whitespace-nowrap transition-[background-color,box-shadow,scale,color] duration-150 outline-none select-none focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset active:not-aria-[haspopup]:scale-[0.97] disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default:
					"bg-primary text-primary-foreground hover:bg-primary/90 shadow-[inset_0_1px_rgb(255_255_255/16%),var(--shadow-control)] active:shadow-[inset_0_1px_rgb(0_0_0/8%)]",
				outline:
					"border-input bg-card text-foreground hover:bg-hover aria-expanded:bg-hover dark:bg-input/32 dark:hover:bg-input/64 shadow-[var(--bevel),var(--shadow-control)] active:shadow-none",
				secondary:
					"bg-secondary text-foreground hover:bg-hover aria-expanded:bg-hover",
				ghost:
					"text-foreground hover:bg-hover aria-expanded:bg-hover [&_svg]:text-muted-foreground",
				destructive:
					"border-input bg-card text-destructive hover:bg-destructive-surface dark:bg-input/32 shadow-[var(--bevel),var(--shadow-control)] active:shadow-none",
				link: "text-primary h-auto border-0 px-0 underline-offset-2 hover:underline active:not-aria-[haspopup]:scale-100",
			},
			size: {
				default: "h-8 px-[11px]",
				sm: "h-7 gap-1 px-[9px]",
				xs: "h-6 gap-1 rounded-md px-[7px] text-xs [&_svg:not([class*='size-'])]:size-3.5",
				lg: "h-9 px-[15px]",
				icon: "size-8",
				"icon-sm": "size-7",
				"icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
				"icon-lg": "size-9",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
