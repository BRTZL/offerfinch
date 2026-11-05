import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Room under scrolling content for the floating action bar (bar, gap and caption), so the last
 * lines of a document can scroll clear of it.
 */
export const ACTION_BAR_SPACE = "pb-28";

/**
 * The detail's actions as a pill floating at the bottom centre of its pane, over the content:
 * one toolbar (arrow keys move between its buttons), with a muted caption under it for what the
 * main action does or why it is off. Never a tooltip over the content.
 */
export function ActionBar({
	label,
	caption,
	captionId,
	children,
	className,
	...rest
}: {
	label: string;
	caption?: ReactNode;
	/** For `aria-describedby` on the action the caption explains. */
	captionId?: string;
	children: ReactNode;
	className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
	return (
		<div
			className={cn(
				// A fade behind the bar and its caption, so the text under them never competes.
				"from-background via-background/90 pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-1.5 bg-linear-to-t to-transparent px-4 pt-10 pb-3",
				className,
			)}
		>
			<div
				role="toolbar"
				aria-label={label}
				aria-orientation="horizontal"
				onKeyDown={(event) => {
					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
					const buttons = [
						...event.currentTarget.querySelectorAll<HTMLButtonElement>(
							"button:not([disabled])",
						),
					];
					const at = buttons.indexOf(
						document.activeElement as HTMLButtonElement,
					);
					if (at < 0) return;
					const step = event.key === "ArrowRight" ? 1 : -1;
					const next =
						buttons[(at + step + buttons.length) % buttons.length] ?? null;
					next?.focus();
					event.preventDefault();
				}}
				className="border-border bg-popover/95 pointer-events-auto flex max-w-full items-center gap-1 rounded-2xl border p-1.5 shadow-[var(--shadow-popup)] backdrop-blur-md"
				{...rest}
			>
				{children}
			</div>
			{caption ? (
				<p
					id={captionId}
					className="text-muted-foreground pointer-events-auto max-w-full truncate text-xs"
					data-testid="action-bar-caption"
				>
					{caption}
				</p>
			) : null}
		</div>
	);
}

/** A thin rule between the bar's groups. */
export function ActionBarDivider() {
	return <span aria-hidden className="bg-border mx-1 h-6 w-px shrink-0" />;
}

type BarTone = "quiet" | "neutral" | "primary" | "danger" | "warning";

const VARIANT = {
	quiet: "ghost",
	neutral: "outline",
	primary: "default",
	danger: "destructive",
	warning: "ghost",
} as const;

const TONE: Record<BarTone, string> = {
	quiet: "",
	neutral: "",
	primary: "",
	danger:
		"border-destructive/40 bg-destructive-surface dark:bg-destructive-surface",
	warning:
		"border-warning/40 bg-warning-surface text-warning hover:bg-warning-surface [&_svg]:text-warning",
};

/**
 * A button of the bar: 36 px high, 12 px corners. `decision` gives the two choices (Not
 * interested and Interested, Reject and Approve) the same width, so only their colour differs.
 */
export function ActionBarButton({
	tone = "quiet",
	decision = false,
	className,
	...props
}: React.ComponentProps<typeof Button> & {
	tone?: BarTone;
	decision?: boolean;
}) {
	return (
		<Button
			size="lg"
			variant={VARIANT[tone]}
			className={cn(
				"rounded-xl",
				TONE[tone],
				decision && "w-40 justify-center",
				className,
			)}
			{...props}
		/>
	);
}
