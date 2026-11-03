"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

import { FIELD } from "./input";

/**
 * A searchable pick-list over plain strings (countries): type to filter, arrow keys to move,
 * Enter to pick, Escape to close (never to clear). `ComboboxField` picks one; `MultiComboboxField` picks several,
 * shown as chips (Backspace at the start of the field removes the last one). Base UI's Combobox
 * carries the ARIA roles and keyboard handling.
 */

const POPUP =
	"border-border bg-popover text-popover-foreground z-50 max-h-[min(var(--available-height),20rem)] w-(--anchor-width) min-w-48 overflow-y-auto overscroll-contain rounded-lg border p-1 shadow-[var(--shadow-popup)] outline-none";
const ITEM =
	"relative flex min-h-7 cursor-pointer items-center gap-2 rounded-sm py-1 pr-8 pl-2 text-sm outline-hidden select-none data-highlighted:bg-hover data-selected:font-medium";

function Options({ empty }: { empty: string }) {
	return (
		<ComboboxPrimitive.Portal>
			<ComboboxPrimitive.Positioner className="z-50" sideOffset={4}>
				<ComboboxPrimitive.Popup data-slot="combobox-content" className={POPUP}>
					<ComboboxPrimitive.Empty className="text-muted-foreground px-2 py-1.5 text-sm empty:hidden">
						{empty}
					</ComboboxPrimitive.Empty>
					<ComboboxPrimitive.List>
						{(item: string) => (
							<ComboboxPrimitive.Item
								key={item}
								value={item}
								className={ITEM}
								data-slot="combobox-item"
							>
								{item}
								<ComboboxPrimitive.ItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
									<CheckIcon className="size-4" />
								</ComboboxPrimitive.ItemIndicator>
							</ComboboxPrimitive.Item>
						)}
					</ComboboxPrimitive.List>
				</ComboboxPrimitive.Popup>
			</ComboboxPrimitive.Positioner>
		</ComboboxPrimitive.Portal>
	);
}

interface CommonProps {
	id: string;
	items: readonly string[];
	placeholder?: string;
	/** Shown when typing matches nothing. */
	empty?: string;
	className?: string;
	"aria-label"?: string;
	"data-testid"?: string;
}

/** One value from a searchable list; Clear empties it. */
function ComboboxField({
	id,
	items,
	value,
	onValueChange,
	placeholder,
	empty = "No match",
	className,
	...rest
}: CommonProps & {
	value: string | null;
	onValueChange: (value: string | null) => void;
}) {
	return (
		<ComboboxPrimitive.Root
			items={items as string[]}
			value={value}
			onValueChange={(next, details) => {
				// Escape only closes the list; it never clears what was picked.
				if (details.reason === "escape-key") return;
				onValueChange((next as string | null) ?? null);
			}}
		>
			<ComboboxPrimitive.InputGroup
				className={cn("relative flex w-72 items-center", className)}
				data-testid={rest["data-testid"]}
			>
				<ComboboxPrimitive.Input
					id={id}
					placeholder={placeholder}
					aria-label={rest["aria-label"]}
					className={cn(FIELD, "h-8 pr-14")}
				/>
				<div className="text-muted-foreground absolute right-1 flex items-center">
					<ComboboxPrimitive.Clear
						aria-label="Clear"
						className="hover:bg-hover flex size-6 items-center justify-center rounded-sm"
					>
						<XIcon className="size-3.5" />
					</ComboboxPrimitive.Clear>
					<ComboboxPrimitive.Trigger
						aria-label="Show the list"
						className="hover:bg-hover flex size-6 items-center justify-center rounded-sm"
					>
						<ChevronDownIcon className="size-4" />
					</ComboboxPrimitive.Trigger>
				</div>
			</ComboboxPrimitive.InputGroup>
			<Options empty={empty} />
		</ComboboxPrimitive.Root>
	);
}

/** Several values from a searchable list, as removable chips inside the field. */
function MultiComboboxField({
	id,
	items,
	value,
	onValueChange,
	placeholder,
	empty = "No match",
	className,
	...rest
}: CommonProps & {
	value: string[];
	onValueChange: (value: string[]) => void;
}) {
	return (
		<ComboboxPrimitive.Root
			items={items as string[]}
			multiple
			value={value}
			onValueChange={(next, details) => {
				// Escape only closes the list; it never clears the chips.
				if (details.reason === "escape-key") return;
				onValueChange((next as string[] | null) ?? []);
			}}
		>
			<ComboboxPrimitive.InputGroup
				className={cn(
					FIELD,
					"focus-within:border-ring flex min-h-8 w-72 cursor-text flex-wrap items-center gap-1 px-1 py-1",
					className,
				)}
				data-testid={rest["data-testid"]}
			>
				<ComboboxPrimitive.Value>
					{(selected: string[]) => (
						<ComboboxPrimitive.Chips
							className="flex w-full flex-wrap items-center gap-1"
							aria-label={
								selected.length > 0
									? `${rest["aria-label"] ?? "Selected"}`
									: undefined
							}
						>
							{selected.map((item) => (
								<ComboboxPrimitive.Chip
									key={item}
									aria-label={item}
									aria-description="Press Backspace or Delete to remove"
									className="bg-hover text-foreground data-highlighted:bg-selected flex h-6 items-center gap-1 rounded-sm pr-0.5 pl-2 text-xs outline-none"
									data-slot="combobox-chip"
								>
									{item}
									<ComboboxPrimitive.ChipRemove
										aria-label={`Remove ${item}`}
										className="hover:bg-selected text-muted-foreground flex size-5 items-center justify-center rounded-sm"
									>
										<XIcon className="size-3" />
									</ComboboxPrimitive.ChipRemove>
								</ComboboxPrimitive.Chip>
							))}
							<ComboboxPrimitive.Input
								id={id}
								placeholder={selected.length > 0 ? "" : placeholder}
								aria-label={rest["aria-label"]}
								aria-description={
									selected.length > 0
										? `${selected.length} selected. From the start of the field, press Left Arrow to reach them.`
										: undefined
								}
								className="text-foreground placeholder:text-muted-foreground h-6 min-w-16 flex-1 border-0 bg-transparent px-1 text-sm outline-none"
							/>
						</ComboboxPrimitive.Chips>
					)}
				</ComboboxPrimitive.Value>
			</ComboboxPrimitive.InputGroup>
			<Options empty={empty} />
		</ComboboxPrimitive.Root>
	);
}

export { ComboboxField, MultiComboboxField };
