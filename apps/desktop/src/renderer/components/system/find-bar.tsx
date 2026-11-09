import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useCommand, useShortcut } from "@/lib/commands";
import { findRanges } from "@/lib/find";
import { useReducedMotion } from "@/lib/reduced-motion";
import { keyHint } from "../../../shared/shortcuts";

/** The highlight names index.css paints (`::highlight(find)`). */
const ALL = "find";
const CURRENT = "find-current";

function clearHighlights() {
	CSS.highlights.delete(ALL);
	CSS.highlights.delete(CURRENT);
}

/**
 * ⌘G and ⇧⌘G, as keys and as Edit › Find items. In a focused window one press can reach the
 * page both ways; a menu command right after the key is the same press, and steps once.
 */
function useStepKeys(step: (by: 1 | -1) => void) {
	const keyAt = useRef(0);
	const byKey = useCallback(
		(by: 1 | -1) => {
			keyAt.current = performance.now();
			step(by);
		},
		[step],
	);
	const byMenu = useCallback(
		(by: 1 | -1) => {
			if (performance.now() - keyAt.current > 150) step(by);
		},
		[step],
	);
	useShortcut(
		"find-next",
		useCallback(() => byKey(1), [byKey]),
	);
	useShortcut(
		"find-previous",
		useCallback(() => byKey(-1), [byKey]),
	);
	useCommand(
		"find-next",
		useCallback(() => byMenu(1), [byMenu]),
	);
	useCommand(
		"find-previous",
		useCallback(() => byMenu(-1), [byMenu]),
	);
}

/**
 * ⌘F: find text in what the nearest `data-find-scope` ancestor marks `data-findable` (the
 * posting, the CV, the letter, the answers), not in the lists, the sidebar or the chat.
 * Matches are painted with the CSS Custom Highlight API, so the page's DOM is never touched.
 * ⌘G and ⇧⌘G (or ↩ and ⇧↩ in the field) step through them; Esc closes.
 */
export function FindBar() {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [count, setCount] = useState(0);
	const [index, setIndex] = useState(0);
	// Bumped on every search, so the current match repaints even when the count is unchanged.
	const [version, setVersion] = useState(0);
	const ranges = useRef<Range[]>([]);
	// Each step (even onto the same, only match) scrolls; a re-search alone (chat streaming,
	// a redraft) repaints without pulling the page back while the user reads elsewhere.
	const [jump, setJump] = useState(0);
	const scrolledFor = useRef("");
	const input = useRef<HTMLInputElement>(null);
	const bar = useRef<HTMLElement>(null);
	const anchor = useRef<HTMLSpanElement>(null);
	const reduced = useReducedMotion();

	const show = useCallback(() => {
		setOpen(true);
		// The field may not be mounted yet on the first press.
		requestAnimationFrame(() => {
			input.current?.focus();
			input.current?.select();
		});
	}, []);
	useCommand("find", show);
	useShortcut("find", show);

	const step = useCallback(
		(by: 1 | -1) => {
			if (!open) return show();
			const n = ranges.current.length;
			if (n > 0) setIndex((i) => (i + by + n) % n);
			setJump((j) => j + 1);
		},
		[open, show],
	);
	useStepKeys(step);

	// Search, and again whenever the text under the scope changes (a tab switch, a redraft).
	useEffect(() => {
		const root = anchor.current?.closest<HTMLElement>("[data-find-scope]");
		if (!open || !root) return;
		const run = () => {
			const roots = [...root.querySelectorAll("[data-findable]")];
			ranges.current = findRanges(roots, query);
			setCount(ranges.current.length);
			setVersion((v) => v + 1);
			setIndex((i) => Math.min(i, Math.max(0, ranges.current.length - 1)));
			CSS.highlights.set(ALL, new Highlight(...ranges.current));
		};
		run();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const observer = new MutationObserver((records) => {
			// The bar's own count changing is not new text to search.
			if (records.every((r) => bar.current?.contains(r.target))) return;
			clearTimeout(timer);
			timer = setTimeout(run, 120);
		});
		observer.observe(root, {
			childList: true,
			subtree: true,
			characterData: true,
		});
		return () => {
			clearTimeout(timer);
			observer.disconnect();
			clearHighlights();
		};
	}, [open, query]);

	// A new query starts at its first match.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on each new query
	useEffect(() => setIndex(0), [query]);

	// Paint the current match and bring it into view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: version marks fresh ranges
	useEffect(() => {
		const range = ranges.current[index];
		if (!open || !range) {
			CSS.highlights.delete(CURRENT);
			return;
		}
		CSS.highlights.set(CURRENT, new Highlight(range));
		const key = `${query}\u0000${index}\u0000${jump}`;
		if (scrolledFor.current === key) return;
		scrolledFor.current = key;
		range.startContainer.parentElement?.scrollIntoView({
			block: "center",
			behavior: reduced ? "auto" : "smooth",
		});
	}, [open, index, version, reduced, query, jump]);

	const close = () => {
		setOpen(false);
		scrolledFor.current = "";
		clearHighlights();
	};

	// The anchor stays mounted so the bar knows its scope before it opens.
	const scopeAnchor = <span ref={anchor} hidden />;
	if (!open) return scopeAnchor;
	return (
		<>
			{scopeAnchor}
			<search
				ref={bar}
				aria-label="Find in the posting and documents"
				data-testid="find-bar"
				className="border-border bg-popover absolute top-3 right-4 z-30 flex items-center gap-1 rounded-xl border p-1 shadow-lg"
			>
				<input
					ref={input}
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							// Esc here closes only the find bar, not the panel behind it.
							e.preventDefault();
							e.stopPropagation();
							close();
						} else if (e.key === "Enter") {
							e.preventDefault();
							step(e.shiftKey ? -1 : 1);
						}
					}}
					placeholder="Find"
					aria-label="Find"
					data-testid="find-input"
					spellCheck={false}
					className="text-foreground placeholder:text-muted-foreground h-7 w-48 bg-transparent px-2 text-sm outline-none"
				/>
				<span
					className="text-muted-foreground min-w-16 px-1 text-right text-xs tabular-nums"
					aria-live="polite"
					data-testid="find-count"
				>
					{query.trim()
						? count === 0
							? "No results"
							: `${index + 1} of ${count}`
						: ""}
				</span>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label="Previous match"
					title={`Previous match (${keyHint("find-previous")})`}
					disabled={count === 0}
					onClick={() => step(-1)}
				>
					<ChevronUp />
				</Button>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label="Next match"
					title={`Next match (${keyHint("find-next")})`}
					disabled={count === 0}
					onClick={() => step(1)}
				>
					<ChevronDown />
				</Button>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label="Close find"
					title="Close (Esc)"
					onClick={close}
				>
					<X />
				</Button>
			</search>
		</>
	);
}
