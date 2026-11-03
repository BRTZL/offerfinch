import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The text field: 32 high (28 with `size="sm"`), 8 px corners, a bevel that drops on focus,
 * a primary edge and a 3 px inset ring when focused.
 */
const FIELD =
	"w-full min-w-0 rounded-lg border border-input bg-card px-[9px] text-sm text-foreground shadow-[var(--bevel),var(--shadow-control)] outline-none transition-[border-color,box-shadow] duration-150 ease-standard placeholder:text-muted-foreground focus-visible:border-ring focus-visible:shadow-[inset_0_0_0_3px_color-mix(in_oklab,var(--ring)_24%,transparent)] disabled:cursor-not-allowed disabled:opacity-64 aria-invalid:border-destructive dark:bg-input/32";

function Input({
	className,
	type,
	size = "default",
	...props
}: Omit<React.ComponentProps<"input">, "size"> & { size?: "default" | "sm" }) {
	return (
		<InputPrimitive
			type={type}
			data-slot="input"
			className={cn(
				FIELD,
				size === "sm" ? "h-7" : "h-8",
				"file:bg-secondary file:text-foreground file:mr-2 file:h-6 file:rounded-md file:border-0 file:px-2 file:text-xs file:font-medium",
				className,
			)}
			{...props}
		/>
	);
}

export { FIELD, Input };
