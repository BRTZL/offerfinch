import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

/** The switch: an 18 × 30 track, a 14 px thumb, primary when on. */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"bg-input ease-standard focus-visible:ring-ring focus-visible:ring-offset-background data-checked:bg-primary relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-64",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb className="ease-standard pointer-events-none block size-[14px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/25%)] transition-transform duration-150 data-checked:translate-x-[14px]" />
		</SwitchPrimitive.Root>
	);
}

export { Switch };
