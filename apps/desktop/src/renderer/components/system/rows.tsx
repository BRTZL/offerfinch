import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

/**
 * A row inside a `Group`: 40 px for one line, 12 px vertical padding for two. A row with
 * `href` or `onClick` takes the quiet hover fill and a chevron.
 */
export function Row({
	leading,
	title,
	subtitle,
	detail,
	meta,
	trailing,
	href,
	onClick,
	onContextMenu,
	chevron,
	className,
	...rest
}: {
	leading?: ReactNode;
	title: ReactNode;
	subtitle?: ReactNode;
	/** Under the subtitle, wrapping (reasons, quotes). */
	detail?: ReactNode;
	/** Right aligned, quiet: a time, a board, a count. */
	meta?: ReactNode;
	/** Right aligned, after the meta: a control. */
	trailing?: ReactNode;
	href?: string;
	onClick?: () => void;
	onContextMenu?: (event: React.MouseEvent) => void;
	chevron?: boolean;
	className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, "title" | "onClick">) {
	const interactive = Boolean(href || onClick);
	const body = (
		<>
			{leading ? (
				<span className="flex shrink-0 items-center">{leading}</span>
			) : null}
			<span className="min-w-0 flex-1">
				<span className="text-foreground block truncate text-sm">{title}</span>
				{subtitle ? (
					<span className="text-muted-foreground mt-0.5 block truncate text-xs">
						{subtitle}
					</span>
				) : null}
				{detail ? (
					<span className="text-muted-foreground mt-1 block text-xs">
						{detail}
					</span>
				) : null}
			</span>
			{meta ? (
				<span className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs tabular-nums">
					{meta}
				</span>
			) : null}
			{trailing ? (
				<span className="flex shrink-0 items-center gap-2">{trailing}</span>
			) : null}
			{interactive && chevron !== false ? (
				<ChevronRight className="text-muted-foreground size-4 shrink-0" />
			) : null}
		</>
	);
	const classes = cn(
		"flex min-h-10 w-full items-center gap-3 px-4 py-2 text-left",
		(subtitle || detail) && "items-start py-3",
		interactive &&
			"ease-standard hover:bg-hover focus-visible:ring-ring transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset",
		className,
	);
	if (href)
		return (
			<Link
				href={href}
				data-ds="row"
				className={classes}
				onContextMenu={onContextMenu}
				{...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
			>
				{body}
			</Link>
		);
	if (onClick)
		return (
			<button
				type="button"
				data-ds="row"
				className={classes}
				onClick={onClick}
				onContextMenu={onContextMenu}
				{...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}
			>
				{body}
			</button>
		);
	return (
		<div data-ds="row" className={classes} {...rest}>
			{body}
		</div>
	);
}

/**
 * A settings row: label and hint on the left, the control on the right. `stack` puts a wide
 * control (a text area, a list) under the label instead.
 */
export function FormRow({
	label,
	hint,
	children,
	layout = "inline",
	htmlFor,
	className,
	...rest
}: {
	label: ReactNode;
	hint?: ReactNode;
	children?: ReactNode;
	layout?: "inline" | "stack";
	htmlFor?: string;
	className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
	const Label = htmlFor ? "label" : "div";
	return (
		<div
			data-ds="form-row"
			className={cn(
				"flex min-h-13 gap-x-8 gap-y-3 px-4 py-3",
				layout === "inline" ? "items-center" : "flex-col",
				className,
			)}
			{...rest}
		>
			<div className="min-w-0 flex-1">
				<Label
					{...(htmlFor ? { htmlFor } : {})}
					className="text-foreground block text-sm font-medium"
				>
					{label}
				</Label>
				{hint ? (
					<div className="text-muted-foreground mt-0.5 max-w-120 text-xs">
						{hint}
					</div>
				) : null}
			</div>
			{children ? (
				<div
					className={cn(
						"flex min-w-0 items-center gap-2",
						layout === "inline" ? "shrink-0 justify-end" : "w-full flex-wrap",
					)}
				>
					{children}
				</div>
			) : null}
		</div>
	);
}

/** A key and value line inside a group or inspector. */
export function KeyValue({
	label,
	value,
	className,
}: {
	label: ReactNode;
	value: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex items-baseline justify-between gap-4 text-xs",
				className,
			)}
		>
			<span className="text-muted-foreground">{label}</span>
			<span className="text-foreground text-right tabular-nums">{value}</span>
		</div>
	);
}
