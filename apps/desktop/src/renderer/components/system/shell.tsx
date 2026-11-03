import { PanelLeft } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext } from "react";
import { Button } from "@/components/ui/button";
import { useCommand } from "@/lib/commands";
import { useStoredState } from "@/lib/use-stored-state";
import { keyHint } from "../../../shared/shortcuts";

/** Whether the sidebar is hidden, and the toggle (⌘\, View › Hide Sidebar, the panel buttons). */
export const SidebarState = createContext<{
	hidden: boolean;
	toggle: () => void;
	present: boolean;
}>({ hidden: false, toggle: () => {}, present: false });

/** The button that hides the sidebar (in its top bar) or shows it again (in the page header). */
export function SidebarToggle({ where }: { where: "sidebar" | "header" }) {
	const { hidden, toggle } = useContext(SidebarState);
	return (
		<Button
			size="icon-sm"
			variant="ghost"
			onClick={toggle}
			aria-label={`${hidden ? "Show" : "Hide"} Sidebar (${keyHint("toggle-sidebar")})`}
			title={`${hidden ? "Show" : "Hide"} Sidebar (${keyHint("toggle-sidebar")})`}
			data-testid={where === "sidebar" ? "sidebar-hide" : "sidebar-show"}
		>
			<PanelLeft />
		</Button>
	);
}

/**
 * The window: a 220 px sidebar (with the traffic lights at its top) and the main column. The
 * sidebar can be hidden (animated, remembered); the page header then starts after the traffic
 * lights with the button to bring it back. Bare screens (onboarding) have no sidebar.
 */
export function AppShell({
	sidebar,
	children,
}: {
	sidebar?: ReactNode;
	children: ReactNode;
}) {
	const [hidden, setHidden] = useStoredState(
		"offerfinch.sidebar.hidden",
		false,
	);
	const toggle = useCallback(() => setHidden(!hidden), [hidden, setHidden]);
	useCommand("toggle-sidebar", toggle);
	const collapsed = Boolean(sidebar) && hidden;
	return (
		<SidebarState.Provider
			value={{ hidden: collapsed, toggle, present: Boolean(sidebar) }}
		>
			<div
				data-ds="shell"
				data-sidebar={sidebar ? (collapsed ? "hidden" : "shown") : "none"}
				className={
					sidebar
						? "ease-standard grid h-full grid-cols-[220px_minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-200 data-[sidebar=hidden]:grid-cols-[0px_minmax(0,1fr)]"
						: "flex h-full flex-col overflow-hidden"
				}
			>
				<a
					href="#main"
					className="bg-background sr-only z-50 rounded-sm px-2 py-1 text-xs focus:not-sr-only focus:absolute focus:top-2 focus:left-21"
				>
					Skip to content
				</a>
				{sidebar ? (
					<div
						className="border-separator ease-standard flex min-h-0 w-55 flex-col overflow-hidden border-r transition-opacity duration-200 data-[hidden]:pointer-events-none data-[hidden]:opacity-0"
						data-hidden={collapsed || undefined}
						aria-hidden={collapsed || undefined}
						inert={collapsed || undefined}
					>
						{sidebar}
					</div>
				) : null}
				<main
					id="main"
					className="bg-background flex min-h-0 min-w-0 flex-1 flex-col"
				>
					{children}
				</main>
			</div>
		</SidebarState.Provider>
	);
}
