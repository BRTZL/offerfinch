import {
	ACCENTS,
	type Accent,
	type DocumentLook,
	FONTS,
	type Font,
	PAGE_MM,
	PAGE_SIZES,
	type PageSize,
	type Template,
} from "@offerfinch/core/export/look";
import { printCss } from "@offerfinch/core/export/print-css";
import { markdownToPreviewHtml } from "@offerfinch/core/export/render";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	QueryState,
	SettingsPage,
} from "@/components/pipeline/settings/shared";
import { Group, Section } from "@/components/system/layout";
import { FormRow } from "@/components/system/rows";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { client, orpc } from "@/lib/orpc";

const TEMPLATE_OPTIONS: { value: Template; label: string; hint: string }[] = [
	{
		value: "classic",
		label: "Classic",
		hint: "Ruled section headings in capitals. The look exports have always had.",
	},
	{
		value: "modern",
		label: "Modern",
		hint: "A larger name over a heavier rule; headings in the accent.",
	},
	{
		value: "compact",
		label: "Compact",
		hint: "Classic with smaller type and margins, for a CV close to its page limit.",
	},
];

const FONT_OPTIONS = (Object.keys(FONTS) as Font[]).map((value) => ({
	value,
	label: FONTS[value].label,
}));

const ACCENT_OPTIONS = (Object.keys(ACCENTS) as Accent[]).map((value) => ({
	value,
	label: ACCENTS[value].label,
}));

const PAGE_OPTIONS = PAGE_SIZES.map((value) => ({
	value,
	label: value === "A4" ? "A4 (210 × 297 mm)" : "US Letter (8.5 × 11 in)",
}));

/** A made-up CV in the export's shape (`tailor.ts`): name, contact line, sections, roles. */
const SAMPLE_CV = `# Jordan Example

Lisbon, Portugal · jordan@example.com · +1 555 0142 · linkedin.com/in/jordan-example

## Summary

Product engineer with eight years of TypeScript and React, most recently leading checkout and payments work for a mid-size marketplace.

## Experience

### Senior Software Engineer — Northwind Analytics
*Lisbon, Portugal · Remote · Mar 2022 – Present*

- Led the move of checkout to a typed API, cutting failed payments by a fifth.
- Built the reporting pipeline on PostgreSQL that finance closes the month with.
- Mentored four engineers through their first on-call rotation.

### Software Engineer — Bluefin Labs
*Porto, Portugal · Hybrid · Jun 2018 – Feb 2022*

- Shipped the React design system used by six product teams.
- Cut the main bundle by 40% with route-level code splitting.

## Skills

TypeScript, React, Node.js, PostgreSQL, GraphQL, AWS, Playwright

## Education

### BSc Computer Science — University of Example
*2014 – 2018*
`;

const MM_TO_PX = 96 / 25.4;
/** The preview's widest drawing, so the whole page stays in view beside the controls. */
const PREVIEW_MAX_PX = 440;

/** Settings › Documents: the template, font, accent and page size of exported CVs and letters. */
export function DocumentSettings() {
	const queryClient = useQueryClient();
	const look = useQuery(orpc.documentLook.get.queryOptions());
	const save = useMutation({
		mutationFn: (next: DocumentLook) => client.documentLook.set(next),
		onMutate: (next) =>
			queryClient.setQueryData(orpc.documentLook.get.queryKey(), next),
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: orpc.documentLook.key() }),
		onError: (e) => toast.error(e.message),
	});
	const data = look.data;
	const set = <K extends keyof DocumentLook>(
		key: K,
		value: DocumentLook[K],
	) => {
		if (data && data[key] !== value) save.mutate({ ...data, [key]: value });
	};
	return (
		<SettingsPage
			id="documents"
			title="Documents"
			description="How exported CVs and cover letters look, as PDF and Word. Every look is one column of real text and gets the same ATS check."
		>
			<QueryState
				isLoading={look.isLoading}
				error={look.error}
				what="the document look"
			/>
			{data ? (
				<>
					<Section
						title="Look"
						description="Used for documents exported from now on. Files already exported keep the look they were checked in."
					>
						<Group>
							<LookSelect
								label="Template"
								hint={
									TEMPLATE_OPTIONS.find((t) => t.value === data.template)?.hint
								}
								value={data.template}
								options={TEMPLATE_OPTIONS}
								onChange={(v) => set("template", v)}
								testId="look-template"
							/>
							<LookSelect
								label="Font"
								hint="Word documents use Arial for the sans fonts and Georgia for the serifs."
								value={data.font}
								options={FONT_OPTIONS}
								onChange={(v) => set("font", v)}
								testId="look-font"
								render={(o) => (
									<span style={{ fontFamily: FONTS[o.value].css }}>
										{o.label}
									</span>
								)}
							/>
							<LookSelect
								label="Accent"
								hint="On headings and rules only; the text stays near-black."
								value={data.accent}
								options={ACCENT_OPTIONS}
								onChange={(v) => set("accent", v)}
								testId="look-accent"
								render={(o) => (
									<>
										<Swatch hex={ACCENTS[o.value].hex} />
										{o.label}
									</>
								)}
							/>
							<LookSelect
								label="Page size"
								hint="The page limit (one page, two for a senior CV) counts pages of this size."
								value={data.pageSize}
								options={PAGE_OPTIONS}
								onChange={(v) => set("pageSize", v as PageSize)}
								testId="look-page-size"
							/>
						</Group>
					</Section>
					<Section
						title="Preview"
						description="A made-up CV in this look, page 1. Your exports use your own documents."
					>
						<PagePreview look={data} markdown={SAMPLE_CV} />
					</Section>
				</>
			) : null}
		</SettingsPage>
	);
}

function LookSelect<V extends string>({
	label,
	hint,
	value,
	options,
	onChange,
	testId,
	render,
}: {
	label: string;
	hint?: ReactNode;
	value: V;
	options: { value: V; label: string }[];
	onChange: (value: V) => void;
	testId: string;
	render?: (option: { value: V; label: string }) => ReactNode;
}) {
	return (
		<FormRow label={label} hint={hint}>
			<Select
				value={value}
				onValueChange={(next) => {
					if (next) onChange(next as V);
				}}
				items={options}
			>
				<SelectTrigger aria-label={label} className="w-52" data-testid={testId}>
					<SelectValue>
						{(selected: V) => {
							const option = options.find((o) => o.value === selected);
							return option ? (render?.(option) ?? option.label) : null;
						}}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem
							key={option.value}
							value={option.value}
							data-testid={`${testId}-${option.value}`}
						>
							{render?.(option) ?? option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</FormRow>
	);
}

/** The accent as a small filled square, drawn (not styled), outlined so ink shows in dark mode. */
function Swatch({ hex }: { hex: string }) {
	return (
		<svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
			<rect
				x="0.5"
				y="0.5"
				width="11"
				height="11"
				rx="3"
				fill={hex}
				stroke="currentColor"
				strokeOpacity={0.35}
			/>
		</svg>
	);
}

/**
 * Page 1 of a document in a look, with the export's own stylesheet and sanitizing renderer, in a
 * shadow root so neither the app's styles nor the page's leak across. Paper stays white in dark
 * mode, as printed.
 */
function PagePreview({
	look,
	markdown,
}: {
	look: DocumentLook;
	markdown: string;
}) {
	const frame = useRef<HTMLDivElement>(null);
	const host = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(PREVIEW_MAX_PX);
	useLayoutEffect(() => {
		const el = frame.current;
		if (!el) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setWidth(Math.min(entry.contentRect.width, PREVIEW_MAX_PX));
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	useLayoutEffect(() => {
		const el = host.current;
		if (!el) return;
		const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
		// Sanitized by markdownToPreviewHtml: raw HTML and images are dropped.
		root.innerHTML = `<style>:host { all: initial; display: block; }\n${printCss(look, ".sheet")}</style><div class="sheet"><div>${markdownToPreviewHtml(markdown)}</div></div>`;
	}, [look, markdown]);
	const page = PAGE_MM[look.pageSize];
	const pageWidth = page.width * MM_TO_PX;
	const pageHeight = page.height * MM_TO_PX;
	const scale = width / pageWidth;
	return (
		<div ref={frame} className="flex w-full justify-center">
			<div
				className="border-border overflow-hidden rounded-lg border"
				style={{ width: pageWidth * scale, height: pageHeight * scale }}
				data-testid="look-preview"
				data-template={look.template}
				data-page-size={look.pageSize}
			>
				<div
					ref={host}
					style={{
						width: pageWidth,
						height: pageHeight,
						transform: `scale(${scale})`,
						transformOrigin: "top left",
					}}
				/>
			</div>
		</div>
	);
}
