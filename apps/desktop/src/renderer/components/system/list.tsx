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
				{unread ? (
					<span className="bg-primary absolute top-[18px] left-2 size-1.5 rounded-full">
						<span className="sr-only">New</span>
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

/**
 * A keyboard list for list-plus-detail screens (Applied, Rejected, Questions): the Inbox's rows,
 * ↑ ↓ Home End to move, ↩ into the detail. Not virtualized: these lists are short.
 */
export function SelectableList<T extends { id: string }>({
	items,
	selectedId,
	onSelect,
	label,
	render,
	detailId,
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
}) {
	const [focused, setFocused] = useState(false);
	const index = items.findIndex((i) => i.id === selectedId);
	const move = (to: number) => {
		const item = items[Math.max(0, Math.min(items.length - 1, to))];
		if (item) onSelect(item.id);
	};
	useEffect(() => {
		if (selectedId)
			document
				.getElementById(`row-${selectedId}`)
				?.scrollIntoView({ block: "nearest" });
	}, [selectedId]);
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
				else if (matches(event, "list-last")) move(items.length - 1);
				else if (matches(event, "list-enter") && detailId)
					document.getElementById(detailId)?.focus();
				else return;
				event.preventDefault();
			}}
			className="min-h-0 flex-1 overflow-auto px-2 py-2 outline-none"
		>
			{items.map((item) => {
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
			})}
		</div>
	);
}
