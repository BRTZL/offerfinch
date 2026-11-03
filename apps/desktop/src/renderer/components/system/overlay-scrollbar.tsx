import { useEffect } from "react";

/** The thumb's distance from the box's edges and its shortest length (px). */
const INSET = 2;
const SHORTEST = 24;
/** How long the thumb stays after the last scroll (ms). */
const IDLE_MS = 900;
/** A pointer this close to a scrolling box's right edge shows its thumb, so a mouse can grab it. */
const EDGE = 14;

/** The nearest box at or above `node` that scrolls vertically and has more to show. */
function scrollingBox(node: Element | null): HTMLElement | null {
	for (let el = node; el && el !== document.body; el = el.parentElement) {
		if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 1)
			continue;
		const overflow = getComputedStyle(el).overflowY;
		if (overflow === "auto" || overflow === "scroll") return el;
	}
	return null;
}

/**
 * One scrollbar thumb for the whole app, floating over whichever box is scrolling. Native
 * scrollbars are hidden (index.css), since with a mouse connected macOS gives every box a bar
 * that takes width from its content; this thumb takes none, fades out when idle, and can be
 * dragged.
 */
export function OverlayScrollbar() {
	useEffect(() => {
		const thumb = document.createElement("div");
		thumb.className = "overlay-thumb";
		thumb.dataset.testid = "overlay-thumb";
		thumb.setAttribute("aria-hidden", "true");
		document.body.append(thumb);

		let box: HTMLElement | null = null;
		let timer = 0;
		let frame = 0;
		let drag: { y: number; top: number } | null = null;

		const hide = () => {
			if (drag || thumb.matches(":hover")) return;
			delete thumb.dataset.visible;
		};
		const hideLater = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(hide, IDLE_MS);
		};
		const place = () => {
			if (!box?.isConnected || box.scrollHeight <= box.clientHeight + 1) {
				delete thumb.dataset.visible;
				return;
			}
			const { scrollHeight, clientHeight, scrollTop } = box;
			const rect = box.getBoundingClientRect();
			const track = clientHeight - INSET * 2;
			const length = Math.max(SHORTEST, (track * clientHeight) / scrollHeight);
			const offset =
				((track - length) * scrollTop) / (scrollHeight - clientHeight);
			const right = rect.left + box.clientLeft + box.clientWidth - INSET;
			thumb.style.height = `${length}px`;
			thumb.style.transform = `translate(calc(${right}px - 100%), ${rect.top + box.clientTop + INSET + offset}px)`;
			thumb.dataset.visible = "true";
		};
		const show = (el: HTMLElement) => {
			box = el;
			place();
			hideLater();
		};

		const onScroll = (event: Event) => {
			const el =
				event.target instanceof HTMLElement
					? event.target
					: document.scrollingElement;
			if (el instanceof HTMLElement) show(el);
		};
		const onPointerMove = (event: PointerEvent) => {
			if (drag || frame) return;
			const { clientX, target } = event;
			frame = window.requestAnimationFrame(() => {
				frame = 0;
				if (target === thumb || !(target instanceof Element)) return;
				const el = scrollingBox(target);
				if (!el) return;
				const right =
					el.getBoundingClientRect().left + el.clientLeft + el.clientWidth;
				if (clientX <= right && right - clientX <= EDGE) show(el);
			});
		};
		const onThumbDown = (event: PointerEvent) => {
			if (!box || event.button !== 0) return;
			event.preventDefault();
			thumb.setPointerCapture(event.pointerId);
			drag = { y: event.clientY, top: box.scrollTop };
			thumb.dataset.dragging = "true";
		};
		const onThumbMove = (event: PointerEvent) => {
			if (!drag || !box) return;
			const track = box.clientHeight - INSET * 2;
			const travel = Math.max(1, track - thumb.offsetHeight);
			box.scrollTop =
				drag.top +
				((event.clientY - drag.y) * (box.scrollHeight - box.clientHeight)) /
					travel;
		};
		const onThumbUp = () => {
			drag = null;
			delete thumb.dataset.dragging;
			hideLater();
		};

		document.addEventListener("scroll", onScroll, {
			capture: true,
			passive: true,
		});
		document.addEventListener("pointermove", onPointerMove, { passive: true });
		thumb.addEventListener("pointerdown", onThumbDown);
		thumb.addEventListener("pointermove", onThumbMove);
		thumb.addEventListener("pointerup", onThumbUp);
		thumb.addEventListener("pointercancel", onThumbUp);
		thumb.addEventListener("pointerleave", hideLater);
		return () => {
			document.removeEventListener("scroll", onScroll, { capture: true });
			document.removeEventListener("pointermove", onPointerMove);
			window.clearTimeout(timer);
			window.cancelAnimationFrame(frame);
			thumb.remove();
		};
	}, []);
	return null;
}
