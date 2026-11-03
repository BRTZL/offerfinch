import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

/**
 * A screen's own second column of links (Settings' sections, as in System Settings): 220 px,
 * the same rows as the sidebar, then the content.
 */
export function SubNavLayout({
	nav,
	children,
}: {
	nav: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
			<div className="border-border min-h-0 overflow-auto border-r">{nav}</div>
			<div className="flex min-h-0 min-w-0 flex-col">{children}</div>
		</div>
	);
}

export function SubNav({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<nav
			aria-label={label}
			data-ds="subnav"
			className="flex flex-col gap-1 p-2"
		>
			{children}
		</nav>
	);
}

export function SubNavGroup({ label }: { label: string }) {
	return (
		<p className="text-muted-foreground mt-4 mb-1 px-2.5 text-xs font-medium first:mt-2">
			{label}
		</p>
	);
}

export function SubNavLink({
	href,
	icon,
	active,
	tone,
	count,
	countLabel,
	children,
	onIntent,
}: {
	href: string;
	/** The pointer rests on the link or it takes focus: a chance to load what it opens. */
	onIntent?: () => void;
	icon?: ReactNode;
	active: boolean;
	tone?: "destructive";
	/** A plain grey number on the right, as in Mail. */
	count?: number;
	countLabel?: string;
	children: ReactNode;
}) {
	return (
		<Link
			href={href}
			aria-current={active ? "page" : undefined}
			onPointerEnter={onIntent}
			onFocus={onIntent}
			className={cn(
				"ease-standard focus-visible:ring-ring flex h-8 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset",
				active
					? "bg-selected text-foreground font-medium"
					: "text-foreground hover:bg-hover",
				tone === "destructive" && "text-destructive",
			)}
		>
			{icon ? (
				<span
					className={cn(
						"flex size-4 items-center justify-center [&_svg]:size-4",
						active ? "text-primary" : "text-muted-foreground",
					)}
				>
					{icon}
				</span>
			) : null}
			<span className="flex-1 truncate">{children}</span>
			{count ? (
				<>
					<span
						aria-hidden
						className={cn(
							"text-xs tabular-nums",
							active ? "text-foreground" : "text-muted-foreground",
						)}
					>
						{count}
					</span>
					<span className="sr-only">
						, {count} {countLabel}
					</span>
				</>
			) : null}
		</Link>
	);
}
