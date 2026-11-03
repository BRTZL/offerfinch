import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { Redirect, Route, Router, Switch, useLocation } from "wouter";

import { Sidebar } from "@/components/shell/sidebar";
import { LoadingProvider } from "@/components/system/loading";
import { OverlayScrollbar } from "@/components/system/overlay-scrollbar";
import { AppShell } from "@/components/system/shell";
import { sendCommand, useCommand, useShortcut } from "@/lib/commands";
import { desktop } from "@/lib/desktop";
import { queryClient, reconnect } from "@/lib/orpc";
import { prefetchAllScreens } from "@/lib/prefetch";
import { preloadable } from "@/lib/preloadable";

// One chunk per screen, all loaded right after the first paint. Once loaded a screen renders
// without suspending, so moving between screens never waits (no spinner, no reveal delay).
const Home = preloadable(() => import("./pages/home").then((m) => m.default));
const Inbox = preloadable(() => import("./pages/inbox").then((m) => m.default));
const Questions = preloadable(() =>
	import("./pages/questions").then((m) => m.default),
);
const Applied = preloadable(() =>
	import("./pages/applied").then((m) => m.default),
);
const Rejected = preloadable(() =>
	import("./pages/rejected").then((m) => m.default),
);
const Profile = preloadable(() =>
	import("./pages/profile").then((m) => m.default),
);
const Onboarding = preloadable(() =>
	import("./pages/onboarding").then((m) => m.default),
);
const Settings = preloadable(() =>
	import("./pages/settings/index").then((m) => m.default),
);
const Scans = preloadable(() => import("./pages/scans").then((m) => m.default));
const screens = [
	Home,
	Inbox,
	Questions,
	Applied,
	Rejected,
	Profile,
	Onboarding,
	Settings,
	Scans,
];
// ⌘K: its own chunk, fetched the first time it opens.
const CommandMenu = lazy(() => import("./components/shell/command-menu"));

import { PASTE_FOR_EVENT, type PasteFor } from "@/components/pipeline/added";
import { AddJobDialog } from "./components/pipeline/add-job";
import { DiagnosticsHost } from "./components/shell/diagnostics-sheet";
import { ShortcutsSheet } from "./components/shell/shortcuts-sheet";
import { WhatsNewHost } from "./components/shell/whats-new-sheet";

/** Add job from link: ⌘N (menu or keys), the Inbox's + button and ⌘K open it. */
function AddJobHost() {
	const [open, setOpen] = useState(false);
	const [pasteFor, setPasteFor] = useState<PasteFor | null>(null);
	const show = useCallback(() => {
		setPasteFor(null);
		setOpen(true);
	}, []);
	useCommand("add-job", show);
	// "Paste description" on a job whose posting could not be read.
	useEffect(() => {
		const onPaste = (event: Event) => {
			setPasteFor((event as CustomEvent<PasteFor>).detail);
			setOpen(true);
		};
		window.addEventListener(PASTE_FOR_EVENT, onPaste);
		return () => window.removeEventListener(PASTE_FOR_EVENT, onPaste);
	}, []);
	useShortcut("add-job", show);
	return (
		<AddJobDialog open={open} onOpenChange={setOpen} pasteFor={pasteFor} />
	);
}

function CommandMenuHost() {
	const [open, setOpen] = useState(false);
	const show = useCallback(() => setOpen(true), []);
	useCommand("command-menu", show);
	useShortcut("command-menu", show);
	if (!open) return null;
	return (
		<Suspense fallback={null}>
			<CommandMenu onClose={() => setOpen(false)} />
		</Suspense>
	);
}

/** Help › Keyboard Shortcuts, or ⌘/ anywhere: the sheet of every shortcut. */
function ShortcutsHost() {
	const [open, setOpen] = useState(false);
	const show = useCallback(() => setOpen(true), []);
	useCommand("shortcuts", show);
	useShortcut("shortcuts", show);
	return <ShortcutsSheet open={open} onOpenChange={setOpen} />;
}

function NavigationBridge() {
	const [, navigate] = useLocation();
	useEffect(() => desktop.onNavigate((path) => navigate(path)), [navigate]);
	// A restarted worker: take a new port and refetch, keeping the page as it is.
	useEffect(
		() =>
			desktop.onWorkerRestart(() => {
				void reconnect(() => desktop.reconnect());
			}),
		[],
	);
	useEffect(() => desktop.onCommand(sendCommand), []);
	useEffect(() => {
		const idle = window.requestIdleCallback(() => {
			for (const screen of screens) void screen.preload();
			void prefetchAllScreens();
		});
		return () => window.cancelIdleCallback(idle);
	}, []);
	return null;
}

function Shell() {
	const [location] = useLocation();
	const bare = location.startsWith("/onboarding");
	const routes = (
		<Suspense fallback={<div className="bg-background flex-1" />}>
			<Switch>
				<Route path="/" component={Home} />
				{/* One route for the list and a selection, so choosing a row never remounts the list. */}
				<Route
					path={/^\/(?:inbox|applications\/(?<id>[^/?#]+))\/?$/}
					component={Inbox}
				/>
				<Route
					path={/^\/questions(?:\/(?<id>[^/?#]+))?\/?$/}
					component={Questions}
				/>
				<Route
					path={/^\/applied(?:\/(?<id>[^/?#]+))?\/?$/}
					component={Applied}
				/>
				<Route
					path={/^\/rejected(?:\/(?<id>[^/?#]+))?\/?$/}
					component={Rejected}
				/>
				<Route path={/^\/scans(?:\/(?<id>[^/?#]+))?\/?$/} component={Scans} />
				<Route path="/profile/:section?" component={Profile} />
				<Route path="/onboarding" component={Onboarding} />
				<Route path="/settings/:section?" component={Settings} />
				<Route>
					<Redirect to="/" />
				</Route>
			</Switch>
		</Suspense>
	);
	return <AppShell sidebar={bare ? undefined : <Sidebar />}>{routes}</AppShell>;
}

export function App() {
	return (
		<>
			<LoadingProvider>
				<QueryClientProvider client={queryClient}>
					<Router>
						<NavigationBridge />
						<Shell />
						<CommandMenuHost />
						<AddJobHost />
						<ShortcutsHost />
						<DiagnosticsHost />
						<WhatsNewHost />
					</Router>
				</QueryClientProvider>
			</LoadingProvider>
			<OverlayScrollbar />
			<Toaster
				theme="system"
				position="bottom-right"
				toastOptions={{
					className:
						"rounded-xl border border-border bg-popover text-sm text-popover-foreground shadow-lg",
				}}
			/>
		</>
	);
}
