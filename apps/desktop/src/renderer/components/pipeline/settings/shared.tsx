import { createContext, type ReactNode, useContext } from "react";
import { ErrorLine } from "@/components/system/bits";
import { Page, PageIntro } from "@/components/system/layout";
import { FormRow } from "@/components/system/rows";
import { RowsSkeleton } from "@/components/system/skeletons";
import { Switch } from "@/components/ui/switch";

/** Set by onboarding: a settings section inside a step shows only its controls. */
export const SettingsEmbedded = createContext(false);
/**
 * Set by a host that embeds a settings page and has its own Continue (onboarding): the page
 * puts its save here, so Continue saves what is on screen before moving on.
 */
export const EmbeddedSave = createContext<{
	current: (() => Promise<unknown>) | null;
} | null>(null);

/**
 * One settings section: its title and what it controls, then `Section`s of grouped rows. The
 * page scrolls on its own; the section column stays.
 */
export function SettingsPage({
	id,
	title,
	description,
	children,
}: {
	id: string;
	title: string;
	description: ReactNode;
	tone?: "destructive";
	children: ReactNode;
}) {
	const embedded = useContext(SettingsEmbedded);
	if (embedded)
		return (
			<div className="flex flex-col gap-8" data-testid={`settings-${id}`}>
				{children}
			</div>
		);
	return (
		<Page
			width="form"
			data-testid={`settings-${id}`}
			aria-labelledby={`settings-${id}-title`}
		>
			<div id={`settings-${id}-title`}>
				<PageIntro title={title} description={description} />
			</div>
			{children}
		</Page>
	);
}

/** A labelled switch with a one-line explanation, as a row of a `Group`. */
export function Toggle({
	label,
	hint,
	checked,
	onChange,
	disabled,
	testId,
}: {
	label: string;
	hint: ReactNode;
	checked: boolean;
	onChange: (value: boolean) => void;
	disabled?: boolean;
	testId?: string;
}) {
	return (
		<FormRow label={label} hint={hint}>
			<Switch
				aria-label={label}
				checked={checked}
				onCheckedChange={(value) => onChange(value === true)}
				disabled={disabled}
				data-testid={testId}
			/>
		</FormRow>
	);
}

/** A label and hint on the left, the control on the right, as a row of a `Group`. */
export function Field({
	id,
	label,
	hint,
	children,
	layout,
}: {
	id: string;
	label: string;
	hint?: ReactNode;
	children: ReactNode;
	layout?: "inline" | "stack";
}) {
	return (
		<FormRow label={label} hint={hint} htmlFor={id} layout={layout}>
			{children}
		</FormRow>
	);
}

/** Loading and error states for a section's query, so a section never renders blank. */
export function QueryState({
	isLoading,
	error,
	what,
}: {
	isLoading: boolean;
	error: Error | null;
	what: string;
}) {
	if (isLoading) return <RowsSkeleton rows={3} twoLine />;
	if (error)
		return (
			<ErrorLine>
				Could not load {what}: {error.message}. It retries shortly.
			</ErrorLine>
		);
	return null;
}
