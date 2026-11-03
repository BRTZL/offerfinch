import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The CV or letter as the page it exports to: a white sheet on a grey well. Paper, not UI, so
 * its type follows the PDF (`.doc-page` in index.css), not the interface's scale. The one
 * documented exception (docs/design/desktop/system.md).
 */
export function DocumentWell({
	children,
	onContextMenu,
	className,
}: {
	children: ReactNode;
	onContextMenu?: (event: React.MouseEvent) => void;
	className?: string;
}) {
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: right-click opens the native menu; every item is also in the toolbar
		<div
			className={cn(
				"bg-well mx-3 min-h-0 flex-1 overflow-auto rounded-t-xl px-4 pt-4",
				className,
			)}
			onContextMenu={onContextMenu}
		>
			{children}
		</div>
	);
}

/** Sanitized HTML from the export's renderer (no raw HTML, images or scripts). */
export function DocumentPage({
	html,
	children,
	className = "doc-page",
	...rest
}: {
	html?: string;
	children?: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
	if (html !== undefined)
		return (
			<div
				className={className}
				// Rendered in the worker by the export's sanitizing renderer: no raw HTML, no images,
				// only http, mailto and tel links.
				dangerouslySetInnerHTML={{ __html: html }}
				{...rest}
			/>
		);
	return (
		<div className={className} {...rest}>
			{children}
		</div>
	);
}

/**
 * The calm reading area: a grey well, the page centred at a readable 720 px, a quiet bar above
 * it for the document's tabs and actions. One document at a time.
 */
export function ReadingColumn({
	bar,
	children,
	onContextMenu,
}: {
	bar: ReactNode;
	children: ReactNode;
	onContextMenu?: (event: React.MouseEvent) => void;
}) {
	return (
		<div className="bg-well flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="mx-auto flex w-full max-w-192 shrink-0 items-center gap-2 px-6 pt-4 pb-3">
				{bar}
			</div>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: right-click opens the native menu; every item is also in the bar's More menu */}
			<div
				className="min-h-0 flex-1 overflow-auto"
				onContextMenu={onContextMenu}
			>
				<div className="mx-auto flex w-full max-w-192 flex-col gap-4 px-6 pb-8">
					{children}
				</div>
			</div>
		</div>
	);
}

/** The page itself, on the well: rounded on all sides in the reading column. */
export function ReadingPage({
	html,
	children,
	...rest
}: {
	html?: string;
	children?: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
	return (
		<DocumentPage html={html} className="doc-page doc-page--sheet" {...rest}>
			{children}
		</DocumentPage>
	);
}
