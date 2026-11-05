import { useAutoAnimate } from "@formkit/auto-animate/react";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { matches } from "../../../shared/shortcuts";

/**
 * A row of a master list (the Inbox): three lines (title and time, subtitle, meta), inset 8 px
 * with 8 px corners. Hover is a quiet fill; the selection a stronger one, with a primary bar
 * while the list has focus (Mail-style). A dot marks a row not opened yet.
 */
export function ListRow({
	id,
	title,
	time,
	subtitle,
	meta,
	selected,
	focused,
	unread,
	onSelect,
	onContextMenu,
	...rest
}: {
	id: string;
	title: ReactNode;
	time?: ReactNode;
	subtitle?: ReactNode;
	meta?: ReactNode;
	selected: boolean;
	focused: boolean;
	/** Not opened yet: a dot. Undefined where rows are never unread (no dot at all). */
	unread?: boolean;
	/** With the mouse event, so a list can read ⌘ and ⇧ (multiple selection). */
	onSelect: (event: React.MouseEvent) => void;
	onContextMenu?: (event: React.MouseEvent) => void;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "title" | "onSelect">) {
	return (
		<div className="pb-0.5">
			<div
				id={id}
				role="option"
				aria-selected={selected}
				tabIndex={-1}
				onMouseDown={(e) => {
					// Keep focus on the list (the listbox), as Mail does.
					e.preventDefault();
					(
						e.currentTarget.closest("[role=listbox]") as HTMLElement | null
					)?.focus();
					onSelect(e);
				}}
				onContextMenu={onContextMenu}
				className={cn(
					"ease-standard relative flex flex-col gap-0.5 rounded-lg py-3 pr-3 pl-5 transition-colors duration-150",
					selected ? "bg-selected" : "hover:bg-hover",
					selected &&
						focused &&
						"before:bg-primary before:absolute before:inset-y-3 before:left-1.5 before:w-0.5 before:rounded-full",
				)}
				{...rest}
			>
				{unread !== undefined ? (
					// Stays mounted and fades once read, so nothing around it moves.
					<span
						aria-hidden={!unread}
						data-testid={unread ? "unread-dot" : undefined}
						className={cn(
							"bg-primary ease-standard absolute top-[18px] left-2 size-1.5 rounded-full transition-opacity duration-500",
							unread ? "opacity-100" : "opacity-0",
						)}
					>
						{unread ? <span className="sr-only">New</span> : null}
					</span>
				) : null}
				<div className="flex items-baseline gap-2">
					<span className="text-foreground min-w-0 flex-1 truncate text-sm font-semibold">
						{title}
					</span>
					{time ? (
						<span className="text-2xs text-muted-foreground shrink-0">
							{time}
						</span>
					) : null}
				</div>
				{subtitle ? (
					<div className="text-foreground truncate text-xs">{subtitle}</div>
				) : null}
				{meta ? (
					<div className="text-2xs mt-1 flex min-w-0 items-center gap-2">
						{meta}
					</div>
				) : null}
			</div>
		</div>
	);
}

/** The list before it loads, at the rows' geometry. */
export function ListRowsSkeleton({ rows = 6 }: { rows?: number }) {
	return (
		<div className="flex flex-col px-2" role="status" aria-busy="true">
			<span className="sr-only">Loading</span>
			{Array.from({ length: rows }, (_, i) => (
				<div key={i} className="flex h-[82px] flex-col gap-0.5 py-3 pr-3 pl-5">
					<div className="flex h-5 items-center">
						<Skeleton className="h-3.5 w-28" />
					</div>
					<div className="flex h-4 items-center">
						<Skeleton className="h-3 w-40" />
					</div>
					<div className="mt-1 flex h-4 items-center">
						<Skeleton className="h-3 w-24" />
					</div>
				</div>
			))}
		</div>
	);
}

export type ListGroup = { key: string; label: string };

/**
 * A keyboard list for list-plus-detail screens (Applied, Rejected, Questions): the Inbox's rows,
 * ↑ ↓ Home End to move, ↩ into the detail. Not virtualized: these lists are short. Rows added,
 * removed or moved slide to their places (auto-animate; none with Reduce motion). With
 * `groupOf`, rows sit under collapsible group headers with their counts, in `groups` order.
 */
export function SelectableList<T extends { id: string }>({
	items,
	selectedId,
	onSelect,
	label,
	render,
	detailId,
	groupOf,
	groups,
}: {
	items: T[];
	selectedId?: string;
	onSelect: (id: string) => void;
	label: string;
	/** The row's lines, for `ListRow`. */
	render: (item: T) => {
		title: ReactNode;
		time?: ReactNode;
		subtitle?: ReactNode;
		meta?: ReactNode;
		testId?: string;
	};
	/** The detail to focus on ↩. */
	detailId?: string;
	/** The group a row belongs to (its key). */
	groupOf?: (item: T) => string;
	/** The groups in order, with their names; empty ones are left out. */
	groups?: ListGroup[];
}) {
	const [focused, setFocused] = useState(false);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [animated] = useAutoAnimate<HTMLDivElement>({ duration: 200 });
	const sections =
		groupOf && groups
			? groups
					.map((g) => ({
						...g,
						rows: items.filter((i) => groupOf(i) === g.key),
					}))
					.filter((g) => g.rows.length > 0)
			: null;
	// The rows in the order shown, without those under a closed group: what ↑ ↓ move through.
	const shown = sections
		? sections.flatMap((g) => (collapsed.has(g.key) ? [] : g.rows))
		: items;
	const index = shown.findIndex((i) => i.id === selectedId);
	const move = (to: number) => {
		const item = shown[Math.max(0, Math.min(shown.length - 1, to))];
		if (item) onSelect(item.id);
	};
	useEffect(() => {
		if (selectedId)
			document
				.getElementById(`row-${selectedId}`)
				?.scrollIntoView({ block: "nearest" });
	}, [selectedId]);
	const row = (item: T) => {
		const r = render(item);
		return (
			<ListRow
				key={item.id}
				id={`row-${item.id}`}
				selected={item.id === selectedId}
				focused={focused}
				onSelect={() => onSelect(item.id)}
				title={r.title}
				time={r.time}
				subtitle={r.subtitle}
				meta={r.meta}
				data-testid={r.testId}
			/>
		);
	};
	const toggle = (key: string) =>
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	return (
		<div
			role="listbox"
			aria-label={label}
			aria-activedescendant={selectedId ? `row-${selectedId}` : undefined}
			tabIndex={0}
			data-focus="self"
			onFocus={() => setFocused(true)}
			onBlur={() => setFocused(false)}
			onKeyDown={(event) => {
				// Keys from shared/shortcuts.ts; none with ⌘, ⌥ or ⌃.
				if (matches(event, "list-next")) move(index < 0 ? 0 : index + 1);
				else if (matches(event, "list-previous"))
					move(index < 0 ? 0 : index - 1);
				else if (matches(event, "list-first")) move(0);
				else if (matches(event, "list-last")) move(shown.length - 1);
				else if (matches(event, "list-enter") && detailId)
					document.getElementById(detailId)?.focus();
				else return;
				event.preventDefault();
			}}
			className="min-h-0 flex-1 overflow-auto px-2 py-2 outline-none"
		>
			{/* One flat parent, so a row moving to another group slides there. */}
			<div ref={animated} className="flex flex-col">
				{sections
					? sections.flatMap((g) => [
							<GroupHeader
								key={`group-${g.key}`}
								label={g.label}
								count={g.rows.length}
								open={!collapsed.has(g.key)}
								onToggle={() => toggle(g.key)}
							/>,
							...(collapsed.has(g.key) ? [] : g.rows.map(row)),
						])
					: items.map(row)}
			</div>
		</div>
	);
}

/** A group's header in a list: its name and count; closes and opens the group. */
function GroupHeader({
	label,
	count,
	open,
	onToggle,
}: {
	label: string;
	count: number;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<div role="presentation" className="pt-2 pb-1 first:pt-0">
			<button
				type="button"
				aria-expanded={open}
				onMouseDown={(e) => e.preventDefault()}
				onClick={onToggle}
				className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-full items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium outline-none focus-visible:ring-2"
				data-testid="list-group"
				data-group={label}
			>
				<ChevronRight
					className={cn(
						"ease-standard size-3.5 transition-transform duration-150",
						open && "rotate-90",
					)}
				/>
				{label}
				<span className="tabular-nums">{count}</span>
			</button>
		</div>
	);
}
