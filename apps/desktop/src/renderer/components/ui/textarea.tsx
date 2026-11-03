import type * as React from "react";
import { cn } from "@/lib/utils";
import { FIELD } from "./input";

/** The multi-line field: the text field's look, 8 px vertical padding. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				FIELD,
				"flex field-sizing-content min-h-16 resize-none py-2",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
