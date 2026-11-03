import {
	CircleAlert,
	CircleCheck,
	Info,
	Search,
	TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

export type Tone =
	| "neutral"
	| "primary"
	| "brand"
	| "warning"
	| "destructive"
	| "quiet";

const BADGE_TONE: Record<Tone, string> = {
	neutral: "bg-muted text-foreground",
	quiet: "bg-muted text-muted-foreground",
	primary: "bg-primary-surface text-primary",
	brand: "bg-brand-surface text-brand",
	warning: "bg-warning-surface text-warning",
	destructive: "bg-destructive-surface text-destructive",
};

/** A small label: a state, a board, a count. 20 px high, 4 px corners. */
export function Badge({
	tone = "neutral",
	children,
	className,
	...rest
}: {
	tone?: Tone;
	children: ReactNode;
	className?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
	return (
		<span
			className={cn(
				"text-2xs inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 font-medium whitespace-nowrap",
				BADGE_TONE[tone],
				className,
			)}
			{...rest}
		>
			{children}
		</span>
	);
}

/** A fit score in tabular figures; green (the beak) from 85, the high-fit line. */
export function Fit({
	value,
	size = "sm",
	className,
}: {
	value: number | null | undefined;
	size?: "sm" | "lg";
	className?: string;
}) {
	if (value === null || value === undefined)
		return <span className="text-muted-foreground">—</span>;
	return (
		<span
			data-fit={value}
			className={cn(
				"font-mono font-semibold tabular-nums",
				size === "lg" ? "text-xl" : "text-xs",
				value >= 85
					? "text-brand"
					: value >= 50
						? "text-foreground"
						: "text-muted-foreground",
				className,
			)}
		>
			{value}
		</span>
	);
}

/** A key cap: ⌘K. */
export function Kbd({ children }: { children: ReactNode }) {
	return (
		<kbd className="border-border text-2xs text-muted-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-sm border px-1 font-sans font-medium">
			{children}
		</kbd>
	);
}

/**
 * The mark's cells as a meter: each cell one unit (a tenth of fit, a claim, a company, a dollar
 * of the cap). Cells part by a hair, like the mark above 32 px.
 */
export function Cells({
	total,
	on,
	tone = "brand",
	warn = [],
	size = "md",
	label,
}: {
	total: number;
	on: number;
	tone?: "brand" | "ink" | "primary";
	warn?: number[];
	size?: "sm" | "md";
	/** What the meter says, for screen readers. */
	label?: string;
}) {
	return (
		<span
			role="img"
			aria-label={label ?? `${on} of ${total}`}
			className={cn(
				"inline-flex flex-wrap gap-0.5",
				size === "sm" ? "max-w-full" : "",
			)}
		>
			{Array.from({ length: total }, (_, i) => (
				<i
					key={i}
					className={cn(
						"block rounded-xs",
						size === "sm" ? "size-1.5" : "size-2",
						warn.includes(i)
							? "bg-warning"
							: i < on
								? tone === "brand"
									? "bg-brand"
									: tone === "primary"
										? "bg-primary"
										: "bg-foreground/70"
								: "bg-cell",
					)}
				/>
			))}
		</span>
	);
}

/** The Grid mark: body in the text colour, the beak in brand green. */
export function Mark({ size = 16 }: { size?: 16 | 40 }) {
	return <BrandMark size={size} className="text-foreground shrink-0" />;
}

/** Centred: an icon box, a title, one line, then actions. */
export function EmptyState({
	icon,
	title,
	children,
	actions,
	className,
	...rest
}: {
	icon?: ReactNode;
	title: ReactNode;
	children?: ReactNode;
	actions?: ReactNode;
	className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "title">) {
	return (
		<div
			data-ds="empty"
			className={cn(
				"flex flex-col items-center justify-center gap-4 px-6 py-12 text-center",
				className,
			)}
			{...rest}
		>
			{icon ? (
				<div className="border-border bg-card text-muted-foreground grid size-9 place-items-center rounded-lg border shadow-xs [&_svg]:size-4">
					{icon}
				</div>
			) : null}
			<div className="max-w-sm">
				<p className="text-foreground text-base font-semibold">{title}</p>
				{children ? (
					<div className="text-muted-foreground mt-1 text-sm">{children}</div>
				) : null}
			</div>
			{actions ? (
				<div className="flex flex-wrap items-center justify-center gap-2">
					{actions}
				</div>
			) : null}
		</div>
	);
}

/** An inline message band: info, a warning (needs you) or an error. */
export function Notice({
	tone = "info",
	title,
	children,
	actions,
	className,
	...rest
}: {
	tone?: "info" | "warning" | "destructive" | "success";
	title?: ReactNode;
	children?: ReactNode;
	actions?: ReactNode;
	className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "title">) {
	const Icon =
		tone === "warning"
			? TriangleAlert
			: tone === "destructive"
				? CircleAlert
				: tone === "success"
					? CircleCheck
					: Info;
	return (
		<div
			role={tone === "destructive" ? "alert" : undefined}
			className={cn(
				"flex items-start gap-3 rounded-lg px-4 py-3 text-sm",
				tone === "warning" && "bg-warning-surface",
				tone === "destructive" && "bg-destructive-surface",
				tone === "info" && "bg-muted",
				tone === "success" && "bg-brand-surface",
				className,
			)}
			{...rest}
		>
			<Icon
				className={cn(
					"mt-0.5 size-4",
					tone === "warning" && "text-warning",
					tone === "destructive" && "text-destructive",
					tone === "info" && "text-muted-foreground",
					tone === "success" && "text-brand",
				)}
			/>
			<div className="min-w-0 flex-1">
				{title ? <p className="text-foreground font-medium">{title}</p> : null}
				{children ? (
					<div className={cn("text-muted-foreground", title && "mt-0.5")}>
						{children}
					</div>
				) : null}
			</div>
			{actions ? (
				<div className="flex shrink-0 items-center gap-2">{actions}</div>
			) : null}
		</div>
	);
}

/** A quiet error line for a failed query: what failed, and that it retries. */
export function ErrorLine({ children }: { children: ReactNode }) {
	return (
		<p role="alert" className="text-destructive px-1 text-sm">
			{children}
		</p>
	);
}

/** The toolbar's search field: 28 high, a magnifier, 224 wide. */
export function SearchField({
	value,
	onChange,
	placeholder = "Search",
	label,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	label: string;
	className?: string;
}) {
	return (
		<label
			className={cn(
				"border-input bg-card ease-standard focus-within:border-ring dark:bg-input/32 flex h-7 w-56 items-center gap-1.5 rounded-lg border px-2 text-sm shadow-[var(--bevel)] transition-[border-color,box-shadow] duration-150 focus-within:shadow-[inset_0_0_0_3px_color-mix(in_oklab,var(--ring)_24%,transparent)]",
				className,
			)}
		>
			<Search className="text-muted-foreground size-3.5" />
			<input
				type="search"
				aria-label={label}
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
			/>
		</label>
	);
}

/** One cell of the mark as a status light: green fine, amber needs you, grey busy. */
export function StatusDot({
	tone,
}: {
	tone: "brand" | "warning" | "busy" | "destructive";
}) {
	return (
		<span
			aria-hidden
			className={cn(
				"block size-2 shrink-0 rounded-xs",
				tone === "brand" && "bg-brand",
				tone === "warning" && "bg-warning",
				tone === "busy" && "bg-foreground/50",
				tone === "destructive" && "bg-destructive",
			)}
		/>
	);
}

/** A 28 px rounded tile holding a row's icon: primary for a task, amber when it needs you. */
export function IconTile({
	tone = "primary",
	children,
}: {
	tone?: "primary" | "warning" | "destructive" | "brand";
	children: ReactNode;
}) {
	return (
		<span
			aria-hidden
			className={cn(
				"grid size-7 shrink-0 place-items-center rounded-lg [&_svg]:size-4",
				tone === "primary" && "bg-primary-surface text-primary",
				tone === "warning" && "bg-warning-surface text-warning",
				tone === "destructive" && "bg-destructive-surface text-destructive",
				tone === "brand" && "bg-brand-surface text-brand",
			)}
		>
			{children}
		</span>
	);
}

/** A 16 px icon in the quiet colour, for rows and menu items. */
export function IconSlot({ children }: { children: ReactNode }) {
	return (
		<span
			aria-hidden
			className="text-muted-foreground flex size-4 shrink-0 items-center justify-center [&_svg]:size-4"
		>
			{children}
		</span>
	);
}
