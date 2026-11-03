import { useEffect } from "react";
import type { AppCommand } from "../../shared/bridge";
import { matches, type ShortcutId } from "../../shared/shortcuts";

/** Menu bar and toolbar commands, delivered inside the page as one DOM event. */
const COMMAND_EVENT = "offerfinch:command";

export function sendCommand(command: AppCommand) {
	window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: command }));
}

export function useCommand(command: AppCommand, handler: () => void) {
	useEffect(() => {
		const listener = (event: Event) => {
			if ((event as CustomEvent).detail === command) handler();
		};
		window.addEventListener(COMMAND_EVENT, listener);
		return () => window.removeEventListener(COMMAND_EVENT, listener);
	}, [command, handler]);
}

/**
 * A shortcut pressed anywhere in the page (shared/shortcuts.ts). The menu bar's accelerator
 * covers the packaged app; this covers a page with focus in a field, and a window in the
 * background in tests, where the menu bar is not the window's.
 */
export function useShortcut(id: ShortcutId, handler: () => void) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!matches(event, id)) return;
			event.preventDefault();
			handler();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [id, handler]);
}
