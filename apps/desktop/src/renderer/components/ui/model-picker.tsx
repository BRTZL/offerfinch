import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "./tabs";

/**
 * The model picker (T3 Code's, docs/design/models/): one button per step showing the model and
 * its effort; the menu has a search field, the models grouped by provider (a group can be split
 * into sections: OpenCode's billing sources), groups that are not available listed dimmed with
 * their action, and the model's effort levels at the bottom. Keyboard: typing filters, ↑ ↓
 * move, ↩ picks, Tab reaches the actions and the effort, Esc closes and returns to the button.
 */

interface PickerItem {
	value: string;
	label: string;
	/** Right aligned, quiet: a maker, a price. */
	hint?: ReactNode;
	/** Words the search also matches (the provider, the source). */
	keywords?: string;
	testId?: string;
}

export interface PickerSection {
	id: string;
	/** A quiet line over the section's models ("Go plan", "OpenRouter · Pay per use"). */
	label?: ReactNode;
	items: PickerItem[];
}

export interface PickerGroup {
	id: string;
	mark?: ReactNode;
	label: string;
	/** Beside the label: "via Antigravity". */
	hint?: ReactNode;
	/** Not available now: the group shows dimmed, without models, with its action or reason. */
	unavailable?: { reason: ReactNode; action?: ReactNode };
	sections: PickerSection[];
}

const TRIGGER =
	"border-input bg-card text-foreground ease-standard hover:bg-hover focus-visible:ring-ring aria-expanded:bg-hover dark:bg-input/32 dark:hover:bg-input/64 flex h-8 w-full max-w-64 min-w-0 items-center gap-1.5 rounded-lg border pr-2 pl-[9px] text-sm whitespace-nowrap shadow-[var(--bevel),var(--shadow-control)] transition-[background-color,box-shadow] duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-64";

const ITEM =
	"data-[highlighted=true]:bg-primary data-[highlighted=true]:text-primary-foreground relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-sm py-1 pr-2 pl-2 text-sm outline-hidden select-none";

const matches = (query: string, ...texts: (string | undefined)[]) =>
	texts.some((t) => t?.toLowerCase().includes(query));

function filterGroups(groups: PickerGroup[], raw: string): PickerGroup[] {
	const query = raw.trim().toLowerCase();
	if (!query) return groups;
	return groups.flatMap((group) => {
		if (group.unavailable) return matches(query, group.label) ? [group] : [];
		const sections = group.sections
			.map((s) => ({
				...s,
				items: s.items.filter((item) =>
					matches(query, item.label, item.keywords, group.label),
				),
			}))
			.filter((s) => s.items.length > 0);
		return sections.length ? [{ ...group, sections }] : [];
	});
}

export function ModelPicker({
	label,
	value,
	groups,
	trigger,
	efforts,
	effort,
	effortLabels,
	onChange,
	onEffort,
	disabled,
	empty = "No model matches",
	"data-testid": testId,
}: {
	/** What the button picks, for screen readers ("Drafting: model"). */
	label: string;
	value: string | null;
	groups: PickerGroup[];
	/** The button's content: mark, model and effort. */
	trigger: ReactNode;
	/** The chosen model's effort levels; none hides the control. */
	efforts: string[];
	effort: string | undefined;
	effortLabels: Record<string, string>;
	onChange: (value: string) => void;
	onEffort: (effort: string) => void;
	disabled?: boolean;
	empty?: string;
	"data-testid"?: string;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const id = useId();
	const shown = useMemo(() => filterGroups(groups, query), [groups, query]);
	const flat = useMemo(
		() => shown.flatMap((g) => g.sections.flatMap((s) => s.items)),
		[shown],
	);
	const optionId = (v: string) =>
		`${id}-${flat.findIndex((i) => i.value === v)}`;
	const active = flat.some((i) => i.value === highlight)
		? highlight
		: (flat[0]?.value ?? null);

	const move = (by: number) => {
		if (!flat.length) return;
		const at = flat.findIndex((i) => i.value === active);
		const next = flat[(at + by + flat.length) % flat.length];
		if (!next) return;
		setHighlight(next.value);
		list.current
			?.querySelector(`[id="${optionId(next.value)}"]`)
			?.scrollIntoView({ block: "nearest" });
	};
	const pick = (v: string) => {
		setOpen(false);
		if (v !== value) onChange(v);
	};

	return (
		<PopoverPrimitive.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					setQuery("");
					setHighlight(value);
				}
			}}
		>
			<PopoverPrimitive.Trigger
				aria-label={label}
				disabled={disabled}
				className={TRIGGER}
				data-testid={testId}
			>
				<span className="flex min-w-0 flex-1 items-center gap-1 truncate">
					{trigger}
				</span>
				<ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0" />
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					className="isolate z-50"
				>
					<PopoverPrimitive.Popup
						initialFocus={input}
						data-slot="model-picker"
						data-testid={testId ? `${testId}-menu` : undefined}
						className="border-border bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 flex max-h-(--available-height) w-96 max-w-(--available-width) origin-(--transform-origin) flex-col overflow-hidden rounded-lg border shadow-[var(--shadow-popup)] duration-150 outline-none"
					>
						<div className="border-border flex items-center gap-2 border-b px-3">
							<SearchIcon className="text-muted-foreground size-4 shrink-0" />
							<input
								ref={input}
								role="combobox"
								aria-expanded="true"
								aria-controls={`${id}-list`}
								aria-autocomplete="list"
								aria-activedescendant={active ? optionId(active) : undefined}
								aria-label="Search models"
								placeholder="Search models"
								value={query}
								onChange={(e) => {
									setQuery(e.target.value);
									setHighlight(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "ArrowDown" || e.key === "ArrowUp") {
										e.preventDefault();
										move(e.key === "ArrowDown" ? 1 : -1);
									} else if (e.key === "Enter" && active) {
										e.preventDefault();
										pick(active);
									}
								}}
								className="text-foreground placeholder:text-muted-foreground h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
								data-testid={testId ? `${testId}-search` : undefined}
							/>
						</div>
						<div
							ref={list}
							id={`${id}-list`}
							role="listbox"
							aria-label={label}
							className="max-h-96 min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
						>
							{shown.length === 0 ? (
								<p className="text-muted-foreground px-2 py-1.5 text-sm">
									{empty}
								</p>
							) : null}
							{shown.map((group, n) => (
								<Group
									key={group.id}
									group={group}
									first={n === 0}
									value={value}
									active={active}
									optionId={optionId}
									onHighlight={setHighlight}
									onPick={pick}
								/>
							))}
						</div>
						{efforts.length > 0 ? (
							<div className="border-border flex items-center justify-between gap-3 border-t px-3 py-2">
								<span
									className="text-muted-foreground text-xs"
									id={`${id}-effort`}
								>
									Effort
								</span>
								<Tabs
									value={effort ?? null}
									onValueChange={(next) => onEffort(String(next))}
								>
									<TabsList
										size="sm"
										aria-labelledby={`${id}-effort`}
										data-testid={testId ? `${testId}-effort` : undefined}
									>
										{efforts.map((e) => (
											<TabsTrigger
												key={e}
												value={e}
												data-testid={
													testId ? `${testId}-effort-${e}` : undefined
												}
											>
												{effortLabels[e] ?? e}
											</TabsTrigger>
										))}
									</TabsList>
								</Tabs>
							</div>
						) : null}
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}

function Group({
	group,
	first,
	value,
	active,
	optionId,
	onHighlight,
	onPick,
}: {
	group: PickerGroup;
	first: boolean;
	value: string | null;
	active: string | null;
	optionId: (value: string) => string;
	onHighlight: (value: string) => void;
	onPick: (value: string) => void;
}) {
	const labelId = useId();
	return (
		// biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox has no native element (a fieldset is for form controls)
		<div
			role="group"
			aria-labelledby={labelId}
			data-group={group.id}
			data-unavailable={group.unavailable ? "true" : undefined}
			className={cn(!first && "border-border -mx-1 mt-1 border-t px-1 pt-1")}
		>
			<div className="flex min-h-7 items-center gap-2 px-2 py-1">
				<span
					className={cn(
						"flex min-w-0 flex-1 items-center gap-2",
						group.unavailable && "opacity-64",
					)}
				>
					{group.mark}
					<span
						id={labelId}
						className="text-muted-foreground text-xs font-medium"
					>
						{group.label}
					</span>
					{group.hint ? (
						<span className="text-muted-foreground text-2xs truncate">
							{group.hint}
						</span>
					) : null}
				</span>
				{group.unavailable ? (
					<span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
						{group.unavailable.action ?? group.unavailable.reason}
					</span>
				) : null}
			</div>
			{group.unavailable
				? null
				: group.sections.map((section) => (
						<div key={section.id} role="presentation">
							{section.label ? (
								<div className="text-muted-foreground text-2xs px-2 pt-1 pb-0.5 pl-8">
									{section.label}
								</div>
							) : null}
							{section.items.map((item) => (
								<div
									key={item.value}
									id={optionId(item.value)}
									role="option"
									tabIndex={-1}
									aria-selected={item.value === value}
									data-highlighted={item.value === active}
									data-testid={item.testId}
									className={ITEM}
									onMouseMove={() => onHighlight(item.value)}
									onMouseDown={(e) => {
										// The search field keeps the focus; the press picks.
										e.preventDefault();
										onPick(item.value);
									}}
								>
									<span className="flex size-4 shrink-0 items-center justify-center">
										{item.value === value ? (
											<CheckIcon className="size-4" />
										) : null}
									</span>
									<span className="min-w-0 flex-1 truncate">{item.label}</span>
									{item.hint ? (
										<span className="shrink-0 pl-4 text-xs opacity-72">
											{item.hint}
										</span>
									) : null}
								</div>
							))}
						</div>
					))}
		</div>
	);
}
