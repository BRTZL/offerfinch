import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/**
 * Animates its height to its content's: a step that grows or shrinks eases to its new size
 * instead of jumping (none under reduced motion, which index.css makes instant).
 */
export function AnimatedHeight({ children }: { children: ReactNode }) {
	const inner = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState<number | null>(null);
	useLayoutEffect(() => {
		const el = inner.current;
		if (!el) return;
		const measure = () => setHeight(el.getBoundingClientRect().height);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return (
		<div
			className="ease-standard -m-1 overflow-hidden p-1 transition-[height] duration-300"
			// The 4 px padding keeps focus rings inside; the height includes it.
			style={height === null ? undefined : { height: height + 8 }}
		>
			<div ref={inner}>{children}</div>
		</div>
	);
}
