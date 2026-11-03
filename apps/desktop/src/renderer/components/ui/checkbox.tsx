import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** The checkbox: 16 px, 4 px corners, primary when on. */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			className={cn(
				"peer border-muted-foreground bg-card ease-standard focus-visible:ring-ring focus-visible:ring-offset-background data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground relative flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors duration-150 outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-64",
				className,
			)}
			{...props}
		>
			<CheckboxPrimitive.Indicator
				data-slot="checkbox-indicator"
				className="grid place-content-center text-current [&>svg]:size-3 [&>svg]:stroke-3"
			>
				<CheckIcon />
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
}

export { Checkbox };
