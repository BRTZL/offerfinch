import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { AppDetail } from "@/components/pipeline/application/types";
import { Button } from "@/components/ui/button";
import { client, orpc } from "@/lib/orpc";

type Requirement = NonNullable<AppDetail["fit"]>["requirements"][number];

const words = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9+#.]+/g, " ")
		.split(" ")
		.filter((w) => w.length > 2);

/**
 * The requirement a posting line states, if the fit score listed one like it: most of the
 * requirement's words appear in the line.
 */
function matchRequirement(
	line: string,
	requirements: Requirement[],
): Requirement | null {
	const have = new Set(words(line));
	let best: { r: Requirement; score: number } | null = null;
	for (const r of requirements) {
		const want = words(r.requirement);
		if (want.length === 0) continue;
		const score = want.filter((w) => have.has(w)).length / want.length;
		if (score >= 0.6 && (!best || score > best.score)) best = { r, score };
	}
	return best?.r ?? null;
}

const BULLET = /^\s*(?:[-*•·▪◦]|\d+[.)])\s+/;
const MD_HEADING = /^#{1,6}\s+/;

/** **bold** and *italic* in a line of posting Markdown, as elements; the rest stays text. */
function inline(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	const re = /\*\*(.+?)\*\*|\*(\S(?:.*?\S)?)\*/g;
	let last = 0;
	for (const m of text.matchAll(re)) {
		const at = m.index ?? 0;
		if (at > last) out.push(text.slice(last, at));
		out.push(
			m[1] !== undefined ? (
				<strong key={at} className="text-foreground font-semibold">
					{m[1]}
				</strong>
			) : (
				<em key={at}>{m[2]}</em>
			),
		);
		last = at + m[0].length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}
/** A short line ending in a colon, or a short line followed by a list: a heading. */
const looksLikeHeading = (line: string, next?: string) =>
	line.length < 60 &&
	!BULLET.test(line) &&
	(/[:：]$/.test(line.trim()) || (next !== undefined && BULLET.test(next)));

/**
 * The posting as readable text: paragraphs, headings and lists. Each list line the fit score
 * judged gets a green tick (met) or an amber dash (a gap), so it reads beside the CV.
 */
export function PostingText({
	text,
	requirements,
}: {
	text: string;
	requirements: Requirement[];
}) {
	const lines = text.replace(/\r/g, "").split("\n");
	const blocks: ReactNode[] = [];
	let list: ReactNode[] = [];
	let para: string[] = [];
	const flushPara = () => {
		if (para.length)
			blocks.push(
				<p key={`p${blocks.length}`} className="text-muted-foreground">
					{inline(para.join(" "))}
				</p>,
			);
		para = [];
	};
	const flushList = () => {
		if (list.length)
			blocks.push(
				<ul key={`l${blocks.length}`} className="flex flex-col gap-1.5">
					{list}
				</ul>,
			);
		list = [];
	};
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the ordered posting-line parser branches together so earlier matches retain precedence.
	lines.forEach((raw, i) => {
		const line = raw.trim();
		if (!line) {
			flushPara();
			flushList();
			return;
		}
		if (BULLET.test(line)) {
			flushPara();
			const content = line.replace(BULLET, "");
			const r = matchRequirement(content, requirements);
			list.push(
				<li
					key={`i${i}`}
					className="flex gap-2"
					data-mark={r ? (r.status === "met" ? "met" : "gap") : undefined}
				>
					<span className="flex w-4 shrink-0 justify-center pt-0.5">
						{r ? (
							r.status === "met" ? (
								<Check
									className="text-brand size-3.5"
									aria-label="Met in your profile"
								/>
							) : (
								<span
									className="bg-warning mt-1.5 block h-0.5 w-2 rounded-full"
									title="A gap"
								/>
							)
						) : (
							<span className="bg-muted-foreground mt-1.5 block size-1 rounded-full" />
						)}
					</span>
					<span
						className={
							r && r.status !== "met"
								? "text-foreground"
								: "text-muted-foreground"
						}
					>
						{inline(content)}
					</span>
				</li>,
			);
			return;
		}
		const next = lines
			.slice(i + 1)
			.find((l) => l.trim())
			?.trim();
		if (MD_HEADING.test(line)) {
			flushPara();
			flushList();
			blocks.push(
				<h3
					key={`h${i}`}
					className="text-foreground mt-2 text-sm font-semibold"
				>
					{inline(line.replace(MD_HEADING, ""))}
				</h3>,
			);
			return;
		}
		if (looksLikeHeading(line, next)) {
			flushPara();
			flushList();
			blocks.push(
				<h3
					key={`h${i}`}
					className="text-foreground mt-1 text-sm font-semibold"
				>
					{inline(line.replace(/[:：]$/, ""))}
				</h3>,
			);
			return;
		}
		flushList();
		para.push(line);
	});
	flushPara();
	flushList();
	return <div className="flex flex-col gap-3 text-sm">{blocks}</div>;
}

/** Reads the posting again and stores it cleaned: the page's structured data or main content. */
export function RereadPosting({
	id,
	className,
}: {
	id: string;
	className?: string;
}) {
	const queryClient = useQueryClient();
	const reread = useMutation({
		mutationFn: () => client.jobs.reread({ id }),
		onSuccess: (result) => {
			toast.success(
				result.via === "page"
					? "Posting read again."
					: "The page couldn't be read now, so the stored text was cleaned instead.",
			);
			void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.inbox.key() });
		},
		onError: (error) => toast.error(error.message),
	});
	return (
		<Button
			size="xs"
			variant="ghost"
			className={className}
			onClick={() => reread.mutate()}
			disabled={reread.isPending}
			title="Read the posting from its link again and store it cleaned"
			data-testid="reread-posting"
		>
			<RotateCw className={reread.isPending ? "animate-spin" : undefined} />
			{reread.isPending ? "Reading…" : "Re-read posting"}
		</Button>
	);
}
