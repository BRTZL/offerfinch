import { useQuery } from "@tanstack/react-query";
import {
	Archive,
	House,
	Inbox,
	MessageCircleQuestion,
	Send,
	Settings,
	UserRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { Cells, Mark } from "@/components/system/bits";
import { SidebarToggle } from "@/components/system/shell";
import { SubNavGroup, SubNavLink } from "@/components/system/subnav";
import { Button } from "@/components/ui/button";
import { desktop } from "@/lib/desktop";
import { orpc } from "@/lib/orpc";
import { prefetchScreen } from "@/lib/prefetch";
import { Link, usePathname } from "@/lib/router";
import { useUpdateState } from "@/lib/updates";

type Item = {
	href: string;
	label: string;
	icon: ReactNode;
	count?: number;
	countLabel?: string;
};

/** How long ago, in words that fit the sidebar foot. */
function since(iso: string | null | undefined): string {
	if (!iso) return "";
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export function useDesktopStatus() {
	return useQuery({
		...orpc.desktop.status.queryOptions(),
		refetchInterval: (q) =>
			q.state.data?.state === "scanning" ? 2_000 : 15_000,
		meta: { quiet: true },
	});
}

/** The scan running now: companies done of all, for the meters. */
export function useScanProgress(scanId: string | null | undefined) {
	return useQuery({
		...orpc.desktop.scan.queryOptions({ input: { id: scanId ?? "" } }),
		enabled: Boolean(scanId),
		refetchInterval: 2_000,
		meta: { quiet: true },
	});
}

function SidebarLink({ item, active }: { item: Item; active: boolean }) {
	return (
		<SubNavLink
			href={item.href}
			icon={item.icon}
			active={active}
			count={item.count}
			countLabel={item.countLabel}
			onIntent={() => prefetchScreen(item.href)}
		>
			{item.label}
		</SubNavLink>
	);
}

/**
 * The window's sidebar: the traffic lights at its top, the pages with plain counts (as in
 * Mail), and the scan state with the mark at its foot.
 */
export function Sidebar() {
	const pathname = usePathname();
	const status = useDesktopStatus();
	const s = status.data;
	const update = useUpdateState();
	const progress = useScanProgress(s?.state === "scanning" ? s.scanId : null);
	const main: Item[] = [
		{ href: "/", label: "Home", icon: <House /> },
		{
			href: "/inbox",
			label: "Inbox",
			icon: <Inbox />,
			count: s?.counts.review,
			countLabel: "to review",
		},
		{
			href: "/questions",
			label: "Questions",
			icon: <MessageCircleQuestion />,
			count: s?.counts.questions,
			countLabel: "open",
		},
		{
			href: "/applied",
			label: "Applied",
			icon: <Send />,
			count: s?.counts.applied,
			countLabel: "applied",
		},
		{ href: "/rejected", label: "Rejected", icon: <Archive /> },
	];
	const you: Item[] = [
		{ href: "/profile", label: "Profile", icon: <UserRound /> },
		{ href: "/settings", label: "Settings", icon: <Settings /> },
	];
	const isActive = (href: string) =>
		href === "/"
			? pathname === "/"
			: pathname.startsWith(href) ||
				(href === "/inbox" && pathname.startsWith("/applications/"));
	const p = progress.data;
	return (
		<nav
			aria-label="Main"
			data-ds="sidebar"
			className="bg-sidebar flex min-h-0 flex-1 flex-col"
		>
			<div className="drag flex h-13 shrink-0 items-center justify-end px-2">
				<SidebarToggle where="sidebar" />
			</div>
			<div className="flex flex-col gap-1 px-2">
				{main.map((item) => (
					<SidebarLink
						key={item.href}
						item={item}
						active={isActive(item.href)}
					/>
				))}
				<SubNavGroup label="You" />
				{you.map((item) => (
					<SidebarLink
						key={item.href}
						item={item}
						active={isActive(item.href)}
					/>
				))}
			</div>
			<Link
				href="/scans"
				className="ease-standard hover:bg-hover focus-visible:ring-ring mx-2 mt-auto mb-2 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset"
				data-testid="scan-status"
				title="Scan history: what each scan searched, found and set aside"
				onMouseEnter={() => prefetchScreen("/scans")}
			>
				<Mark size={16} />
				<div className="flex min-w-0 flex-col gap-1">
					{!s ? (
						<span className="text-muted-foreground text-xs">Starting…</span>
					) : s.state === "scanning" ? (
						<>
							<span className="text-foreground truncate text-xs">
								{p?.total
									? `Scanning ${Math.min(p.done + 1, p.total)} of ${p.total}`
									: "Scanning…"}
							</span>
							{p?.total ? (
								<Cells
									total={p.total}
									on={p.done}
									tone="ink"
									size="sm"
									label={`${p.done} of ${p.total} companies read`}
								/>
							) : null}
						</>
					) : (
						<>
							<span className="text-foreground truncate text-xs">
								{s.paused
									? "Scans paused"
									: s.lastScanAt
										? `Scanned ${since(s.lastScanAt)}`
										: "Not scanned yet"}
							</span>
							{s.lastScanSummary ? (
								<span className="text-2xs text-muted-foreground truncate">
									{s.lastScanSummary}
								</span>
							) : null}
						</>
					)}
				</div>
			</Link>
			{update?.status === "ready" ? (
				<div className="px-3 pb-3">
					<Button
						size="sm"
						className="w-full"
						data-testid="sidebar-update"
						title={`OfferFinch ${update.version} is downloaded`}
						onClick={() => void desktop.updates.install()}
					>
						Restart to Update
					</Button>
				</div>
			) : null}
		</nav>
	);
}
