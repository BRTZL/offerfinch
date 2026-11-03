import type { DesktopBridge } from "../../shared/bridge";

declare global {
	interface Window {
		desktop: DesktopBridge;
	}
}

/** The preload's bridge. In a plain browser (Vite preview) it is missing; calls then fail. */
export const desktop: DesktopBridge = window.desktop;
