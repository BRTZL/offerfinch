import { cn } from "@/lib/utils";

/**
 * Dims and blurs what is behind a panel laid over it, so the panel holds the focus; a click on
 * it closes the panel. It stays mounted and fades in and out (instant under reduced motion,
 * which index.css makes so); closed, it is invisible and takes no clicks. Where it lies is the
 * caller's: by default the whole window (fixed), and the panel sits above its z-index.
 */
export function FocusBackdrop({
	open,
	onClose,
	className,
}: {
	open: boolean;
	onClose: () => void;
	/** Position and stacking; replaces the default `fixed inset-0 z-30`. */
	className?: string;
}) {
	return (
		<div
			aria-hidden
			data-testid="focus-backdrop"
			data-open={open || undefined}
			onClick={open ? onClose : undefined}
			className={cn(
				"fixed inset-0 z-30",
				"bg-scrim ease-standard invisible opacity-0 backdrop-blur-[3px] transition-[opacity,visibility] duration-200 data-[open]:visible data-[open]:opacity-100",
				className,
			)}
		/>
	);
}
