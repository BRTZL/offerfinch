import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

/** The 280 px right column: fit, checks, flags, what happens next. */
export function Inspector({
	children,
	className,
	...rest
}: {
	children: ReactNode;
	className?: string;
} & React.HTMLAttributes<HTMLElement>) {
	return (
		<aside
			data-ds="inspector"
			className={cn(
				"border-border bg-background flex w-70 shrink-0 flex-col overflow-auto border-l",
				className,
			)}
			{...rest}
		>
			{children}
		</aside>
	);
}

export function InspectorSection({
	title,
	end,
	children,
	className,
	...rest
}: {
	title?: ReactNode;
	end?: ReactNode;
	children: ReactNode;
	className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
	return (
		<section
			data-ds="inspector-section"
			className={cn(
				"border-border flex flex-col gap-3 border-b px-5 py-4",
				className,
			)}
			{...rest}
		>
			{title || end ? (
				<div className="flex items-baseline justify-between gap-3">
					{title ? (
						<h3 className="text-foreground text-sm font-semibold">{title}</h3>
					) : null}
					{end ? (
						<span className="text-muted-foreground text-xs tabular-nums">
							{end}
						</span>
					) : null}
				</div>
			) : null}
			{children}
		</section>
	);
}

/** A folded inspector line (cost, form answers, history) that opens in place. */
export function Disclosure({
	title,
	value,
	children,
	defaultOpen = false,
	...rest
}: {
	title: ReactNode;
	value?: ReactNode;
	children: ReactNode;
	defaultOpen?: boolean;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "title">) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div data-ds="disclosure" {...rest}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="text-foreground ease-standard hover:bg-hover focus-visible:ring-ring flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset"
			>
				<ChevronRight
					className={cn(
						"text-muted-foreground ease-standard size-3.5 transition-transform duration-150",
						open && "rotate-90",
					)}
				/>
				<span className="flex-1 truncate">{title}</span>
				{value !== undefined ? (
					<span className="text-muted-foreground text-xs tabular-nums">
						{value}
					</span>
				) : null}
			</button>
			{open ? <div className="px-2 pt-1 pb-2">{children}</div> : null}
		</div>
	);
}
