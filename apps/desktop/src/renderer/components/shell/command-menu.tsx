import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Archive,
	ArrowRight,
	Bell,
	Copy,
	Database,
	ExternalLink,
	Filter,
	Globe,
	House,
	Inbox,
	Keyboard,
	MessageCircleQuestion,
	Pause,
	PenLine,
	Play,
	Plus,
	RefreshCw,
	Search,
	Send,
	Settings,
	Settings2,
	SlidersHorizontal,
	UserRound,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useDemoMode } from "@/components/desktop/demo";
import { Fit, IconSlot, Kbd } from "@/components/system/bits";
import { sendCommand } from "@/lib/commands";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { usePathname, useRouter } from "@/lib/router";
import { matches as is, keyHint } from "../../../shared/shortcuts";

type Command = {
	id: string;
	group: string;
	label: string;
	hint?: ReactNode;
	icon: ReactNode;
	keywords?: string;
	run: () => void | Promise<void>;
};

const PAGES: { label: string; href: string; icon: ReactNode; key?: string }[] =
	[
		{ label: "Home", href: "/", icon: <House />, key: keyHint("go-1") },
		{ label: "Inbox", href: "/inbox", icon: <Inbox />, key: keyHint("go-2") },
		{
			label: "Questions",
			href: "/questions",
			icon: <MessageCircleQuestion />,
			key: keyHint("go-3"),
		},
		{
			label: "Applied",
			href: "/applied",
			icon: <Send />,
			key: keyHint("go-4"),
		},
		{
			label: "Rejected",
			href: "/rejected",
			icon: <Archive />,
			key: keyHint("go-5"),
		},
		{
			label: "Profile",
			href: "/profile",
			icon: <UserRound />,
			key: keyHint("go-6"),
		},
		{
			label: "Settings",
			href: "/settings",
			icon: <Settings />,
			key: keyHint("settings"),
		},
	];

/** Help › Keyboard Shortcuts, also found by searching. */
const SHORTCUTS_COMMAND: Command = {
	id: "shortcuts",
	group: "Help",
	label: "Keyboard shortcuts",
	hint: <Kbd>{keyHint("shortcuts")}</Kbd>,
	keywords: "keys help hotkeys",
	icon: <Keyboard />,
	run: () => sendCommand("shortcuts"),
};

const SETTINGS: { label: string; href: string; icon: ReactNode }[] = [
	{ label: "Models", href: "/settings/models", icon: <SlidersHorizontal /> },
	{ label: "Job search", href: "/settings/job-filter", icon: <Filter /> },
	{ label: "Sources", href: "/settings/sources", icon: <Globe /> },
	{ label: "Writing", href: "/settings/writing", icon: <PenLine /> },
	{ label: "Notifications", href: "/settings/notifications", icon: <Bell /> },
	{ label: "General", href: "/settings/general", icon: <Settings2 /> },
	{ label: "Your data", href: "/settings/your-data", icon: <Database /> },
];

const matches = (c: Command, q: string) =>
	!q ||
	`${c.label} ${c.group} ${c.keywords ?? ""}`
		.toLowerCase()
		.includes(q.toLowerCase());

/**
 * The open application's posting: open it (not in try-it mode: the default browser holds the
 * real sessions) or copy its link.
 */
function postingCommands(
	job: { company: { name: string }; job: { title: string; url: string } },
	demo: boolean,
): Command[] {
	const group = `${job.company.name} · ${job.job.title}`;
	const copy: Command = {
		id: "copy-link",
		group,
		label: "Copy the posting link",
		icon: <Copy />,
		run: async () => {
			await desktop.copyText(job.job.url);
			toast.success("Posting link copied.");
		},
	};
	if (demo) return [copy];
	return [
		{
			id: "open-posting",
			group,
			label: "Open the posting",
			icon: <ExternalLink />,
			run: () => desktop.openExternal(job.job.url),
		},
		copy,
	];
}

/**
 * ⌘K: go to a page or a settings section, find an application by company or role, scan now,
 * pause scans, open or copy the open application's posting. It has no Approve command, and no
 * key in it approves (docs/ux-pass.md: an accidental key press must not approve).
 */
export default function CommandMenu({ onClose }: { onClose: () => void }) {
	const router = useRouter();
	const demo = useDemoMode();
	const pathname = usePathname();
	const queryClient = useQueryClient();
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => inputRef.current?.focus(), []);

	const status = useQuery({
		...orpc.desktop.status.queryOptions(),
		meta: { quiet: true },
	});
	const found = useQuery({
		queryKey: ["command-menu", "applications", query],
		queryFn: () =>
			client.inbox.page({
				search: query.trim() || undefined,
				offset: 0,
				limit: 8,
			}),
		enabled: query.trim().length >= 2,
		staleTime: 10_000,
	});
	const openId = pathname.match(/^\/applications\/([^/?]+)/)?.[1];
	const open = useQuery({
		...orpc.application.get.queryOptions({ input: { id: openId ?? "" } }),
		enabled: Boolean(openId),
		meta: { quiet: true },
	});
	const scan = useMutation({
		mutationFn: () => client.desktop.scanNow({}),
		onSuccess: (r) => {
			toast.success(r.started ? "Scan started." : "A scan is already running.");
			void queryClient.invalidateQueries({ queryKey: orpc.desktop.key() });
		},
		onError: (e) => toast.error(e.message),
	});
	const pause = useMutation({
		mutationFn: (paused: boolean) => client.desktop.setPaused({ paused }),
		onSuccess: (r) => {
			toast.success(
				r.paused ? "Hourly scans paused." : "Hourly scans resumed.",
			);
			void queryClient.invalidateQueries({ queryKey: orpc.desktop.key() });
		},
		onError: (e) => toast.error(e.message),
	});

	const commands = useMemo<Command[]>(() => {
		const go = (href: string) => () => router.push(href);
		const list: Command[] = [];
		if (open.data) list.push(...postingCommands(open.data, demo));
		for (const a of found.data ?? [])
			list.push({
				id: `app-${a.id}`,
				group: "Applications",
				label: `${a.companyName} · ${a.title}`,
				hint: <Fit value={a.score} />,
				icon: <ArrowRight />,
				run: go(`/applications/${a.id}?view=all`),
			});
		for (const p of PAGES)
			list.push({
				id: `go-${p.href}`,
				group: "Go to",
				label: p.label,
				hint: p.key ? <Kbd>{p.key}</Kbd> : undefined,
				icon: p.icon,
				run: go(p.href),
			});
		for (const s of SETTINGS)
			list.push({
				id: `settings-${s.href}`,
				group: "Settings",
				label: s.label,
				keywords: "settings preferences",
				icon: s.icon,
				run: go(s.href),
			});
		const paused = Boolean(status.data?.paused);
		list.push(SHORTCUTS_COMMAND);
		list.push({
			id: "add-job",
			group: "Jobs",
			label: "Add job from link",
			hint: <Kbd>{keyHint("add-job")}</Kbd>,
			keywords: "url posting paste manual new",
			icon: <Plus />,
			run: () => sendCommand("add-job"),
		});
		list.push(
			{
				id: "scan-now",
				group: "Scans",
				label: "Scan now",
				keywords: "refresh fetch boards",
				icon: <RefreshCw />,
				run: () => scan.mutate(),
			},
			{
				id: "pause",
				group: "Scans",
				label: paused ? "Resume hourly scans" : "Pause hourly scans",
				icon: paused ? <Play /> : <Pause />,
				run: () => pause.mutate(!paused),
			},
		);
		return list;
	}, [found.data, open.data, status.data, router, scan, pause, demo]);

	const shown = commands.filter(
		(c) => c.id.startsWith("app-") || matches(c, query),
	);
	useEffect(() => {
		listRef.current
			?.querySelector(`[data-index="${active}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [active]);
	const run = (c: Command | undefined) => {
		if (!c) return;
		onClose();
		void Promise.resolve(c.run()).catch((e: Error) => toast.error(e.message));
	};
	const onKeyDown = (event: React.KeyboardEvent) => {
		if (is(event, "search-close")) onClose();
		else if (is(event, "search-next"))
			setActive((i) => Math.min(shown.length - 1, i + 1));
		else if (is(event, "search-previous")) setActive((i) => Math.max(0, i - 1));
		else if (is(event, "search-run")) run(shown[active]);
		else return;
		event.preventDefault();
	};

	let lastGroup = "";
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a click outside closes it; Escape does too
		<div
			className="bg-scrim fixed inset-0 z-50 flex items-start justify-center pt-12"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			role="presentation"
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Command menu"
				className="border-border bg-popover flex max-h-120 w-full max-w-140 flex-col overflow-hidden rounded-2xl border shadow-2xl"
				data-testid="command-menu"
				onKeyDown={onKeyDown}
			>
				<div className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-4">
					<Search className="text-muted-foreground size-4" />
					<input
						ref={inputRef}
						role="combobox"
						aria-expanded="true"
						aria-controls="command-list"
						aria-activedescendant={
							shown[active] ? `command-${shown[active].id}` : undefined
						}
						placeholder="Search pages, settings and applications"
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setActive(0);
						}}
						className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
						data-testid="command-input"
					/>
					<Kbd>esc</Kbd>
				</div>
				<div
					ref={listRef}
					id="command-list"
					role="listbox"
					aria-label="Commands"
					className="min-h-0 flex-1 overflow-auto p-2"
				>
					{shown.length === 0 ? (
						<p className="text-muted-foreground px-3 py-6 text-center text-sm">
							{query.trim().length >= 2 && found.isFetching
								? "Searching…"
								: "Nothing found."}
						</p>
					) : null}
					{shown.map((c, i) => {
						const header = c.group !== lastGroup ? c.group : null;
						lastGroup = c.group;
						return (
							<div key={c.id}>
								{header ? (
									<p className="text-muted-foreground truncate px-3 pt-3 pb-1 text-xs font-medium first:pt-1">
										{header}
									</p>
								) : null}
								<div
									id={`command-${c.id}`}
									role="option"
									tabIndex={-1}
									aria-selected={i === active}
									data-index={i}
									data-testid="command-item"
									onMouseMove={() => setActive(i)}
									onMouseDown={(e) => {
										e.preventDefault();
										run(c);
									}}
									className={
										i === active
											? "bg-selected text-foreground flex h-9 items-center gap-3 rounded-lg px-3 text-sm"
											: "text-foreground flex h-9 items-center gap-3 rounded-lg px-3 text-sm"
									}
								>
									<IconSlot>{c.icon}</IconSlot>
									<span className="min-w-0 flex-1 truncate">{c.label}</span>
									{c.hint}
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
