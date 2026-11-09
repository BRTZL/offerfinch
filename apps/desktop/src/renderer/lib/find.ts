/**
 * ⌘F in an open application: the text matches, apart from the DOM so tests can read them.
 * Matching runs on the original text (never a lowercased copy, whose offsets drift: "İ"
 * lowercases to two code units), case-insensitively and Unicode-aware. Turkish dotted and
 * dotless i (İ ı) match I and i both ways, which case folding alone does not do.
 */

/** Between blocks in the joined text: no query, not even its spaces, matches across it. */
const BLOCK_BREAK = "\u0000";

/** Each match of `query` in `text`, as [start, end) offsets into `text`. */
export function findMatches(text: string, query: string): [number, number][] {
	const q = query.trim();
	if (!q) return [];
	const escaped = q
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\s+/g, "\\s+")
		.replace(/[iIıİ]/g, "[iIıİ]");
	const out: [number, number][] = [];
	for (const m of text.matchAll(new RegExp(escaped, "giu"))) {
		if (m[0].length === 0) continue;
		const at = m.index ?? 0;
		out.push([at, at + m[0].length]);
	}
	return out;
}

/** A run of text: the node it lives in and where it starts in the joined string. */
export interface TextPiece<N> {
	node: N;
	start: number;
	length: number;
}

/**
 * A match over the joined string, as positions in its first and last pieces (a phrase can
 * cross <strong>, so it spans nodes). Pieces are in order; `null` when a bound falls outside.
 */
export function locate<N>(
	pieces: TextPiece<N>[],
	[start, end]: [number, number],
): { startNode: N; startOffset: number; endNode: N; endOffset: number } | null {
	const first = pieces.find(
		(p) => start >= p.start && start < p.start + p.length,
	);
	const last = pieces.find((p) => end > p.start && end <= p.start + p.length);
	if (!first || !last) return null;
	return {
		startNode: first.node,
		startOffset: start - first.start,
		endNode: last.node,
		endOffset: end - last.start,
	};
}

/** The text of `roots`, joined, with each visible text node's place in it. */
function collectText(roots: Element[]): {
	text: string;
	pieces: TextPiece<Text>[];
} {
	const pieces: TextPiece<Text>[] = [];
	let text = "";
	const blockOf = (node: Node): Element | null => {
		for (let el = node.parentElement; el; el = el.parentElement)
			if (!getComputedStyle(el).display.startsWith("inline")) return el;
		return null;
	};
	for (const root of roots) {
		let block: Element | null = null;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const t = node as Text;
			if (!t.data) continue;
			const parent = t.parentElement;
			if (parent && !parent.checkVisibility()) continue;
			// Paragraphs and list items never run together into one false match.
			const nextBlock = blockOf(t);
			if (block && nextBlock !== block) text += BLOCK_BREAK;
			block = nextBlock;
			pieces.push({ node: t, start: text.length, length: t.data.length });
			text += t.data;
		}
		text += BLOCK_BREAK;
	}
	return { text, pieces };
}

/** The DOM ranges of `query` across `roots`, in reading order. */
export function findRanges(roots: Element[], query: string): Range[] {
	const { text, pieces } = collectText(roots);
	const ranges: Range[] = [];
	for (const match of findMatches(text, query)) {
		const at = locate(pieces, match);
		if (!at) continue;
		const range = document.createRange();
		range.setStart(at.startNode, at.startOffset);
		range.setEnd(at.endNode, at.endOffset);
		ranges.push(range);
	}
	return ranges;
}
