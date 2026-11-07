import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FocusBackdrop } from "./focus-backdrop";

/**
 * Room under scrolling content for the floating action bar (bar, gap and caption), so the last
 * lines of a document can scroll clear of it.
 */
export const ACTION_BAR_SPACE = "pb-28";

/** How long the bar takes to grow into its tray and to fold back. */
export const TRAY_MS = 400;

/**
 * The bar's tray: a slot above its buttons that a child fills (through a portal) to grow the bar
 * upward into a form. `show` opens it with what a click on the backdrop does; `show(null)` folds
 * it. Open, the bar's buttons go quiet and inert, all but the one marked `data-confirm`.
 */
export interface ActionBarTray {
	slot: HTMLDivElement | null;
	show: (onCancel: (() => void) | null) => void;
}

const TrayContext = createContext<ActionBarTray | null>(null);

/** The tray of the action bar this is in; null outside one. */
export function useActionBarTray() {
	return useContext(TrayContext);
}

/**
 * What the tray holds, drawn into its slot above the bar's buttons: it fades and rises in a beat
 * after the tray starts to grow, and closed it is hidden and inert (still there, to fold away).
 */
export function ActionBarTrayPanel({
	tray,
	open,
	className,
	...props
}: React.ComponentProps<"div"> & { tray: ActionBarTray; open: boolean }) {
	if (!tray.slot) return null;
	return createPortal(
		<div
			data-open={open || undefined}
			inert={!open}
			tabIndex={-1}
			className={cn(
				"border-border ease-standard invisible flex translate-y-2 flex-col gap-3 border-b p-4 opacity-0 transition-[opacity,translate,visibility] duration-400 outline-none data-open:visible data-open:translate-y-0 data-open:opacity-100 data-open:delay-75",
				className,
			)}
			{...props}
		/>,
		tray.slot,
	);
}

/**
 * The detail's actions as a pill floating at the bottom centre of its pane, over the content:
 * one toolbar (arrow keys move between its buttons), with a muted caption under it for what the
 * main action does or why it is off. Never a tooltip over the content. A child can extend it
 * upward into a tray (`useActionBarTray`), with the rest of the window dimmed behind it.
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
	const [slot, setSlot] = useState<HTMLDivElement | null>(null);
	const [cancel, setCancel] = useState<{ run: () => void } | null>(null);
	const show = useCallback(
		(onCancel: (() => void) | null) =>
			setCancel(onCancel ? { run: onCancel } : null),
		[],
	);
	const tray = useMemo(() => ({ slot, show }), [slot, show]);
	const open = cancel !== null;
	const toolbarRef = useRef<HTMLDivElement>(null);
	// Open, every button but the tray's confirm is out of reach (dimmed by the classes below).
	useLayoutEffect(() => {
		for (const child of toolbarRef.current?.children ?? []) {
			if (child instanceof HTMLElement)
				child.inert = open && !child.hasAttribute("data-confirm");
		}
	}, [open]);
	return (
		<TrayContext.Provider value={tray}>
			<div
				className={cn(
					// A fade behind the bar and its caption, so the text under them never competes.
					"from-background via-background/90 pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-1.5 bg-linear-to-t to-transparent px-4 pt-10 pb-3",
					// Open, above everything the backdrop dims (the sheets too).
					open && "z-50",
					className,
				)}
			>
				<FocusBackdrop
					open={open}
					onClose={() => cancel?.run()}
					className="data-open:pointer-events-auto"
					testId="tray-backdrop"
				/>
				<div
					data-open={open || undefined}
					className="border-border bg-popover/95 ease-standard pointer-events-auto relative z-40 flex max-w-full flex-col rounded-2xl border shadow-[var(--shadow-popup)] backdrop-blur-md transition-[border-radius] duration-400 data-open:rounded-[18px]"
				>
					{/* The tray grows from nothing to its content's height; never wider than the bar. */}
					<div
						className={cn(
							"ease-standard grid w-0 min-w-full transition-[grid-template-rows] duration-400",
							open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
						)}
					>
						<div ref={setSlot} className="min-h-0 overflow-hidden" />
					</div>
					<div
						ref={toolbarRef}
						role="toolbar"
						aria-label={label}
						aria-orientation="horizontal"
						onKeyDown={(event) => {
							if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
								return;
							const buttons = [
								...event.currentTarget.querySelectorAll<HTMLButtonElement>(
									"button:not([disabled])",
								),
							].filter((button) => !button.closest("[inert]"));
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
						className={cn(
							"flex max-w-full items-center gap-1 p-1.5",
							// The buttons' own transitions, plus the fade to quiet.
							"[&>*]:transition-[opacity,background-color,box-shadow,scale,color]",
							open && "[&>:not([data-confirm])]:opacity-32",
						)}
						{...rest}
					>
						{children}
					</div>
				</div>
				{caption ? (
					<p
						id={captionId}
						className={cn(
							"text-muted-foreground ease-standard pointer-events-auto max-w-full truncate text-xs transition-opacity duration-300",
							open && "opacity-0",
						)}
						data-testid="action-bar-caption"
					>
						{caption}
					</p>
				) : null}
			</div>
		</TrayContext.Provider>
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

/** The tray's submit: filled with the text colour, so its second press reads as confirm. */
const CONFIRM =
	"border-transparent bg-foreground text-background shadow-none hover:bg-foreground/88 aria-expanded:bg-foreground aria-expanded:hover:bg-foreground/88 dark:bg-foreground dark:hover:bg-foreground/88 [&_svg]:text-background";

/**
 * A button of the bar: 36 px high, 12 px corners. `decision` gives the two choices (Not
 * interested and Interested, Reject and Approve) the same width, so only their colour differs.
 * `confirm`: the open tray's submit, the one button that stays in reach while it is open.
 */
export function ActionBarButton({
	tone = "quiet",
	decision = false,
	confirm = false,
	className,
	...props
}: React.ComponentProps<typeof Button> & {
	tone?: BarTone;
	decision?: boolean;
	confirm?: boolean;
}) {
	return (
		<Button
			size="lg"
			variant={VARIANT[tone]}
			data-confirm={confirm || undefined}
			className={cn(
				"rounded-xl",
				TONE[tone],
				decision && "w-40 justify-center",
				confirm && CONFIRM,
				className,
			)}
			{...props}
		/>
	);
}
