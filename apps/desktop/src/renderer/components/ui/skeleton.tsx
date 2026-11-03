import { cn } from "@/lib/utils";

/** A placeholder bone at the content's geometry; breathes in four steps while shown. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="skeleton"
			className={cn(
				"bg-muted-foreground/15 motion-safe:animate-breathe rounded-sm",
				className,
			)}
			{...props}
		/>
	);
}

export { Skeleton };
