import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

const EMPTY = "__empty__";

export type FilterOption = { value: string; label: string };

/**
 * A compact shadcn Select. An option's empty value stands for "no filter". `id` goes on the
 * trigger, the control a `<label htmlFor>` names.
 */
export function FilterSelect({
	id,
	label,
	value,
	options,
	onChange,
	className,
	disabled,
	testId,
	size = "sm",
}: {
	id?: string;
	label: string;
	value: string;
	options: FilterOption[];
	onChange: (value: string) => void;
	className?: string;
	disabled?: boolean;
	testId?: string;
	/** sm (28) in toolbars, default (32) in forms. */
	size?: "sm" | "default";
}) {
	const items = options.map((o) => ({
		value: o.value || EMPTY,
		label: o.label,
	}));
	return (
		<Select
			items={items}
			disabled={disabled}
			value={value || EMPTY}
			onValueChange={(next) =>
				onChange(next == null || next === EMPTY ? "" : String(next))
			}
		>
			<SelectTrigger
				id={id}
				aria-label={label}
				data-testid={testId}
				size={size}
				className={className}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{items.map((item) => (
					<SelectItem key={item.value} value={item.value}>
						{item.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
