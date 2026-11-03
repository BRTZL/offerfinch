import { markdownToPreviewHtml } from "@offerfinch/core/export/render";
import { useMemo, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Markdown the user or the app wrote (profile records, notes), rendered at interface scale with
 * the export's sanitizing renderer: no raw HTML, no images, only http, mailto and tel links.
 */
export function Markdown({
	text,
	className,
	...rest
}: { text: string; className?: string } & Omit<
	React.HTMLAttributes<HTMLDivElement>,
	"children" | "dangerouslySetInnerHTML"
>) {
	const html = useMemo(() => markdownToPreviewHtml(text), [text]);
	return (
		<div
			className={cn("ui-prose ui-prose--body", className)}
			// Sanitized by markdownToPreviewHtml: raw HTML and images are dropped.
			dangerouslySetInnerHTML={{ __html: html }}
			{...rest}
		/>
	);
}

/**
 * A Markdown field: write the source, or preview it as it will read. The text is kept exactly as
 * typed (no editor reformats it), because drafts and the claims check quote it word for word.
 */
export function MarkdownField({
	value,
	onChange,
	id,
	placeholder,
	testId,
}: {
	value: string;
	onChange: (value: string) => void;
	id: string;
	placeholder?: string;
	testId?: string;
}) {
	const [view, setView] = useState<"write" | "preview">("write");
	return (
		<div className="flex w-full flex-col gap-2">
			<Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
				<TabsList size="sm" aria-label="Markdown view">
					<TabsTrigger value="write" data-testid={testId && `${testId}-write`}>
						Write
					</TabsTrigger>
					<TabsTrigger
						value="preview"
						data-testid={testId && `${testId}-preview`}
					>
						Preview
					</TabsTrigger>
				</TabsList>
			</Tabs>
			{view === "write" ? (
				<Textarea
					id={id}
					className="min-h-40"
					value={value}
					placeholder={placeholder}
					onChange={(e) => onChange(e.target.value)}
					data-testid={testId}
				/>
			) : (
				<div
					className="border-input min-h-40 rounded-lg border px-3 py-2"
					data-testid={testId && `${testId}-rendered`}
				>
					{value.trim() ? (
						<Markdown text={value} data-selectable />
					) : (
						<p className="text-muted-foreground text-sm">Nothing to preview.</p>
					)}
				</div>
			)}
		</div>
	);
}
