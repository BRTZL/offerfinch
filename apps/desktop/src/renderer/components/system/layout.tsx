import { type ReactNode, useContext } from "react";
import { cn } from "@/lib/utils";
import { SidebarState, SidebarToggle } from "./shell";

/**
 * The page structure every screen is built from (docs/design/desktop/system.md). The exact
 * geometry lives here and nowhere else: a 52 px header with a 20 px inset, a 24 px content
 * inset, 32 px between sections, 12 px from a section's title to its content.
 */

/** The window toolbar: the page title on the left, actions on the right. Moves the window. */
export function PageHeader({
	title,
	subtitle,
	children,
	leading,
	inset,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	/** Actions, right aligned (usually a `Toolbar`). */
	children?: ReactNode;
	/** Before the title (a back button). */
	leading?: ReactNode;
	/** "lights": no sidebar on this screen, so the title clears the traffic lights. */
	inset?: "sidebar" | "lights";
}) {
	const sidebar = useContext(SidebarState);
	// The traffic lights sit over the header when there is no sidebar to hold them.
	const lights = inset === "lights" || (sidebar.present && sidebar.hidden);
	return (
		<header
			data-ds="page-header"
			className={cn(
				"drag border-border bg-background flex h-13 shrink-0 items-center gap-3 border-b pr-3",
				// The show-sidebar button keeps a clear gap from the traffic lights.
				sidebar.present && sidebar.hidden ? "pl-24" : lights ? "pl-21" : "pl-5",
			)}
		>
			{sidebar.present && sidebar.hidden ? (
				<SidebarToggle where="header" />
			) : null}
			{leading}
			<div className="flex min-w-0 items-baseline gap-2">
				<h1
					data-ds="page-title"
					className="text-foreground truncate text-sm font-semibold"
				>
					{title}
				</h1>
				{subtitle ? (
					<span className="text-muted-foreground truncate text-xs">
						{subtitle}
					</span>
				) : null}
			</div>
			{children ? (
				<div className="ml-auto flex shrink-0 items-center gap-2">
					{children}
				</div>
			) : null}
		</header>
	);
}

/** A thin rule between toolbar groups. */
export function ToolbarSeparator() {
	return <span aria-hidden className="bg-border mx-1 h-5 w-px" />;
}

/**
 * The scrolling content of a screen, inset 24 px. `width="form"` keeps forms at 720 px and
 * `"reading"` at 960 px, centred in the space beside the sidebar.
 */
export function Page({
	children,
	width = "full",
	className,
	...rest
}: {
	children: ReactNode;
	width?: "full" | "form" | "reading";
	className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div className="min-h-0 flex-1 overflow-auto" {...rest}>
			<div
				data-ds="page"
				className={cn(
					"flex flex-col gap-8 p-6",
					// Capped columns sit in the middle of the space they have, like a macOS
					// settings pane, instead of hugging the sidebar.
					width !== "full" && "mx-auto w-full",
					width === "form" && "max-w-180",
					width === "reading" && "max-w-240",
					className,
				)}
			>
				{children}
			</div>
		</div>
	);
}

/** A page's own heading inside the content: a title and one line. */
export function PageIntro({
	title,
	description,
	leading,
	size = "base",
}: {
	title: ReactNode;
	description?: ReactNode;
	leading?: ReactNode;
	size?: "base" | "xl";
}) {
	return (
		<div data-ds="page-intro" className="flex items-center gap-4">
			{leading}
			<div className="min-w-0">
				<h2
					className={cn(
						"text-foreground font-semibold",
						size === "xl" ? "text-xl" : "text-base",
					)}
				>
					{title}
				</h2>
				{description ? (
					<p className="text-muted-foreground mt-1 text-sm">{description}</p>
				) : null}
			</div>
		</div>
	);
}

/** A titled block of a page. Sections stack 32 px apart (the `Page`'s gap). */
export function Section({
	title,
	description,
	end,
	children,
	className,
	...rest
}: {
	title?: ReactNode;
	description?: ReactNode;
	/** Right of the title: a link or a small control. */
	end?: ReactNode;
	children: ReactNode;
	className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
	return (
		<section
			data-ds="section"
			className={cn("flex min-w-0 flex-col gap-3", className)}
			{...rest}
		>
			{title || end ? (
				<div className="flex min-h-5 items-end justify-between gap-4">
					<div className="min-w-0">
						{title ? (
							<h3
								data-ds="section-title"
								className="text-foreground text-sm font-semibold"
							>
								{title}
							</h3>
						) : null}
						{description ? (
							<p className="text-muted-foreground mt-0.5 text-xs">
								{description}
							</p>
						) : null}
					</div>
					{end ? (
						<div className="flex shrink-0 items-center gap-2 text-xs">
							{end}
						</div>
					) : null}
				</div>
			) : null}
			{children}
		</section>
	);
}

/** A rounded card holding rows, with hairlines between them. */
export function Group({
	children,
	className,
	...rest
}: {
	children: ReactNode;
	className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			data-ds="group"
			className={cn(
				"border-border bg-card divide-border divide-y overflow-hidden rounded-xl border",
				className,
			)}
			{...rest}
		>
			{children}
		</div>
	);
}

/** Padding for free content inside a `Group` (text, a chart), on the rows' inset. */
export function GroupBody({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div data-ds="group-body" className={cn("px-4 py-3 text-sm", className)}>
			{children}
		</div>
	);
}
