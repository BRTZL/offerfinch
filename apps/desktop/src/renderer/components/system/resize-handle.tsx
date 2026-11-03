import { useRef, useState } from "react";
import { useStoredState } from "@/lib/use-stored-state";
import { cn } from "@/lib/utils";

/** A column width the user can drag, kept between launches. */
export function useColumnWidth(
	key: string,
	initial: number,
): [number, (width: number) => void, () => void] {
	const [width, setWidth] = useStoredState(`offerfinch.width.${key}`, initial);
	return [
		Number.isFinite(width) ? width : initial,
		setWidth,
		() => setWidth(initial),
	];
}

const STEP = 16;

/**
 * The drag strip on a column's edge. `edge` is the side it sits on: "end" (right edge of a
 * column on the left) grows the column when dragged right, "start" grows it when dragged left.
 * Arrow keys move it 16 px, double-click puts the column back to its default width.
 * The column must be `relative`.
 */
export function ResizeHandle({
	edge,
	width,
	min,
	max,
	onResize,
	onReset,
	label,
}: {
	edge: "start" | "end";
	width: number;
	min: number;
	max: number;
	onResize: (width: number) => void;
	onReset: () => void;
	label: string;
}) {
	const drag = useRef<{ x: number; width: number } | null>(null);
	const [dragging, setDragging] = useState(false);
	const ceiling = Math.max(min, max);
	const clamp = (w: number) => Math.round(Math.min(ceiling, Math.max(min, w)));
	const sign = edge === "end" ? 1 : -1;
	return (
		// biome-ignore lint/a11y/useSemanticElements: a focusable splitter has no native element
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={width}
			aria-valuemin={min}
			aria-valuemax={ceiling}
			tabIndex={0}
			data-ds="resize-handle"
			title="Drag to resize, double-click to reset"
			className={cn(
				"group absolute inset-y-0 z-10 flex w-2 cursor-col-resize touch-none justify-center outline-none select-none",
				edge === "end" ? "-right-1" : "-left-1",
			)}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				drag.current = { x: e.clientX, width };
				setDragging(true);
				document.body.style.cursor = "col-resize";
			}}
			onPointerMove={(e) => {
				if (!drag.current) return;
				onResize(
					clamp(drag.current.width + sign * (e.clientX - drag.current.x)),
				);
			}}
			onPointerUp={(e) => {
				drag.current = null;
				setDragging(false);
				document.body.style.cursor = "";
				e.currentTarget.releasePointerCapture(e.pointerId);
			}}
			onLostPointerCapture={() => {
				drag.current = null;
				setDragging(false);
				document.body.style.cursor = "";
			}}
			onDoubleClick={onReset}
			onKeyDown={(e) => {
				const delta =
					e.key === "ArrowRight" ? STEP : e.key === "ArrowLeft" ? -STEP : 0;
				if (delta) {
					e.preventDefault();
					onResize(clamp(width + sign * delta));
				} else if (e.key === "Home") {
					e.preventDefault();
					onResize(min);
				} else if (e.key === "End") {
					e.preventDefault();
					onResize(ceiling);
				}
			}}
		>
			<span
				className={cn(
					"ease-standard group-hover:bg-primary/60 group-focus-visible:bg-primary h-full w-0.5 bg-transparent transition-colors duration-150",
					dragging && "bg-primary",
				)}
			/>
		</div>
	);
}
