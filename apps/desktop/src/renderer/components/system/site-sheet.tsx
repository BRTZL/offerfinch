import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { desktop } from "@/lib/desktop";
import type {
	SiteBounds,
	SitePageInfo,
	SiteSheetMode,
	SiteTabId,
} from "../../../shared/bridge";

const hostOf = (url: string) => {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
};

/**
 * A site's page inside the app: the sheet draws its frame (title, the page's host, Close, a
 * hint) and leaves a hole where main attaches the site's own view, at the hole's bounds, kept
 * in place on every resize. Sign-in: the site's login page in its own session. Live: the very
 * tab a run is using; closing hides it and the run goes on.
 *
 * The native view paints above the page, so nothing of the sheet is drawn inside the hole, and
 * the view is attached only once the opening animation has finished (its size is final) and
 * detached before the closing one starts.
 */
export function SiteSheet({
	site,
	label,
	mode,
	open,
	onOpenChange,
	onClosed,
	note,
}: {
	site: SiteTabId;
	label: string;
	mode: SiteSheetMode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** After the view was detached. */
	onClosed?: () => void;
	/** Above the page: a check the run waits on, for example. */
	note?: React.ReactNode;
}) {
	const hole = useRef<HTMLDivElement>(null);
	const attached = useRef(false);
	const [page, setPage] = useState<SitePageInfo | null>(null);

	const bounds = useCallback((): SiteBounds | null => {
		const el = hole.current;
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.left, y: r.top, width: r.width, height: r.height };
	}, []);

	// The latest callback, read when the view is detached: the page passes a new one on every
	// render (its status polls), and that must never count as a reason to detach.
	const onClosedRef = useRef(onClosed);
	onClosedRef.current = onClosed;
	const siteRef = useRef(site);
	siteRef.current = site;
	/** Detaches the view: only on close or unmount, never on a rerender. Stable identity. */
	const detach = useCallback(() => {
		if (!attached.current) return;
		attached.current = false;
		void desktop.sites
			.hide(siteRef.current)
			.finally(() => onClosedRef.current?.());
	}, []);

	const attach = useCallback(async () => {
		const b = bounds();
		if (!b || attached.current) return;
		attached.current = true;
		const result = await desktop.sites.show(site, mode, b);
		if (!result.ok) {
			attached.current = false;
			toast.error(result.reason);
			onOpenChange(false);
			return;
		}
		setPage(result.page);
	}, [bounds, site, mode, onOpenChange]);

	// The view follows the hole when the window or the sheet changes size.
	useEffect(() => {
		if (!open) return;
		const follow = () => {
			const b = bounds();
			if (b && attached.current) desktop.sites.setBounds(site, b);
		};
		const observer = new ResizeObserver(follow);
		if (hole.current) observer.observe(hole.current);
		window.addEventListener("resize", follow);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", follow);
		};
	}, [open, site, bounds]);

	useEffect(
		() =>
			desktop.sites.onPage((next) => {
				if (next.site === site) setPage(next);
			}),
		[site],
	);

	// Leaving the page (unmount) must not leave the view on top. Runs once, on unmount only.
	useEffect(() => detach, [detach]);

	const close = (next: boolean) => {
		if (!next) detach();
		onOpenChange(next);
	};

	const host = hostOf(page?.url ?? "");
	return (
		<DialogPrimitive.Root
			open={open}
			onOpenChange={close}
			onOpenChangeComplete={(isOpen) => {
				if (isOpen) void attach();
			}}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Backdrop className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 bg-scrim fixed inset-0 isolate z-50 duration-200" />
				<DialogPrimitive.Popup
					data-testid="site-sheet"
					data-mode={mode}
					className="border-border bg-popover text-popover-foreground ease-standard data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 fixed inset-10 z-50 flex flex-col overflow-hidden rounded-2xl border shadow-[var(--shadow-popup)] duration-200 outline-none"
				>
					<div className="border-border flex h-12 shrink-0 items-center gap-3 border-b px-4">
						<div className="min-w-0 flex-1">
							<DialogPrimitive.Title className="truncate text-sm font-semibold">
								{mode === "sign-in" ? `Sign in to ${label}` : `${label}, live`}
							</DialogPrimitive.Title>
						</div>
						<span
							className="text-muted-foreground truncate font-mono text-xs"
							data-testid="site-sheet-host"
						>
							{page?.loading ? "Loading… " : ""}
							{host}
						</span>
						<DialogPrimitive.Close
							render={<Button variant="outline" size="sm" />}
							data-testid="site-sheet-close"
						>
							{mode === "sign-in" ? "Done" : "Close"}
						</DialogPrimitive.Close>
					</div>
					{note ? (
						<div className="border-border shrink-0 border-b px-4 py-3">
							{note}
						</div>
					) : null}
					<div
						ref={hole}
						className="bg-well relative min-h-0 flex-1"
						data-testid="site-sheet-view"
					/>
					<DialogPrimitive.Description className="border-border text-muted-foreground shrink-0 border-t px-4 py-3 text-xs">
						{mode === "sign-in"
							? `Your sign-in stays in OfferFinch, apart from your everyday browser, and no password is stored by OfferFinch. "Sign in with Google" doesn't work inside apps: use your email and password (set a password on ${label} first if you only use Google).`
							: "This is the tab OfferFinch is reading right now. It only opens and reads pages. Close hides it; the run goes on."}
					</DialogPrimitive.Description>
				</DialogPrimitive.Popup>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
