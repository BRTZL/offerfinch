import { type ReactNode, useLayoutEffect, useState } from "react";
import {
	ResizeHandle,
	useColumnWidth,
} from "@/components/system/resize-handle";

/**
 * An element's width, kept current. Returns a callback ref: the width follows whichever
 * element is attached, also one that renders later (a detail that was loading).
 */
export function useWidth(): [(el: HTMLElement | null) => void, number] {
	const [el, setEl] = useState<HTMLElement | null>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		if (!el) return;
		setWidth(el.getBoundingClientRect().width);
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setWidth(entry.contentRect.width);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [el]);
	return [setEl, width];
}

/** The list column of a master-detail screen: 300 px by default, dragged between 220 and 480. */
export function MasterDetail({
	list,
	children,
}: {
	list: ReactNode;
	children: ReactNode;
}) {
	const [width, setWidth, reset] = useColumnWidth("list", 300);
	return (
		<div className="flex min-h-0 flex-1">
			<div
				className="border-border relative flex min-h-0 shrink-0 flex-col border-r"
				style={{ width }}
			>
				{list}
				<ResizeHandle
					edge="end"
					label="Resize the list"
					width={width}
					min={220}
					max={480}
					onResize={setWidth}
					onReset={reset}
				/>
			</div>
			<div className="relative flex min-h-0 min-w-0 flex-1">{children}</div>
		</div>
	);
}

/** Two panes side by side (posting and CV), 46 : 54. */
export function SplitPanes({
	start,
	end,
}: {
	start: ReactNode;
	end: ReactNode;
}) {
	return (
		<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,46fr)_minmax(0,54fr)]">
			<div className="border-border flex min-h-0 min-w-0 flex-col border-r">
				{start}
			</div>
			<div className="flex min-h-0 min-w-0 flex-col">{end}</div>
		</div>
	);
}
