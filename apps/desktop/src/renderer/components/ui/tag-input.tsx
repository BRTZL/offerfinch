"use client";

import { XIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

import { FIELD } from "./input";

/**
 * Words the user types themselves, shown as chips that wrap, so the whole list reads at a glance
 * without scrolling. Enter or a comma adds what was typed (a pasted "a, b, c" adds three);
 * leaving the field adds it too. Backspace in an empty field removes the last chip. Looks like
 * `MultiComboboxField`, without a list to pick from.
 */
export function TagInputField({
	id,
	value,
	onValueChange,
	placeholder,
	className,
	...rest
}: {
	id: string;
	value: string[];
	onValueChange: (value: string[]) => void;
	placeholder?: string;
	className?: string;
	"aria-label"?: string;
	"data-testid"?: string;
}) {
	const [draft, setDraft] = useState("");
	const add = (text: string) => {
		const words = text
			.split(",")
			.map((w) => w.trim())
			.filter(Boolean);
		setDraft("");
		if (words.length === 0) return;
		const seen = new Set(value.map((v) => v.toLocaleLowerCase()));
		const next = [...value];
		for (const w of words)
			if (!seen.has(w.toLocaleLowerCase())) {
				seen.add(w.toLocaleLowerCase());
				next.push(w);
			}
		if (next.length !== value.length) onValueChange(next);
	};
	const remove = (index: number) =>
		onValueChange(value.filter((_, i) => i !== index));

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a click on the field's padding focuses its input, as in MultiComboboxField; the input itself takes the keys.
		// biome-ignore lint/a11y/useKeyWithClickEvents: the input inside handles the keyboard.
		<div
			className={cn(
				FIELD,
				"focus-within:border-ring flex min-h-8 w-72 cursor-text flex-wrap items-center gap-1 px-1 py-1",
				className,
			)}
			data-testid={rest["data-testid"]}
			onClick={(e) => e.currentTarget.querySelector("input")?.focus()}
		>
			{value.map((item, index) => (
				<span
					key={item}
					className="bg-hover text-foreground flex h-6 items-center gap-1 rounded-sm pr-0.5 pl-2 text-xs"
					data-slot="tag-chip"
				>
					{item}
					<button
						type="button"
						aria-label={`Remove ${item}`}
						className="hover:bg-selected text-muted-foreground flex size-5 items-center justify-center rounded-sm"
						onClick={() => remove(index)}
					>
						<XIcon className="size-3" />
					</button>
				</span>
			))}
			<input
				id={id}
				aria-label={rest["aria-label"]}
				value={draft}
				placeholder={value.length > 0 ? "" : placeholder}
				className="text-foreground placeholder:text-muted-foreground h-6 min-w-16 flex-1 border-0 bg-transparent px-1 text-sm outline-none"
				onChange={(e) => {
					const text = e.target.value;
					if (text.includes(",")) add(text);
					else setDraft(text);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						// Adds the word; never submits the form around it.
						e.preventDefault();
						add(draft);
					} else if (e.key === "Backspace" && draft === "" && value.length > 0)
						remove(value.length - 1);
				}}
				onBlur={() => add(draft)}
			/>
		</div>
	);
}
