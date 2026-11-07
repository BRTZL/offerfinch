import {
	DISMISS_REASON_LABEL,
	DISMISS_REASONS,
	type DismissReason,
} from "@offerfinch/core/domain/dismissal";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ThumbsDown, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	ActionBarButton,
	type ActionBarTray,
	ActionBarTrayPanel,
	TRAY_MS,
	useActionBarTray,
} from "@/components/system/action-bar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Popover,
	PopoverClose,
	PopoverContent,
	PopoverDescription,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { client, orpc } from "@/lib/orpc";
import { primaryModifier } from "../../../shared/platform";

/** What Not interested acts on: one match, a company's matches, or a selection. */
export interface DismissTarget {
	ids: string[];
	/** The one company they share, which the user may hide; null across companies. */
	company: { id: string; name: string } | null;
	/** For the title and the toast: "Senior Engineer", "6 roles at Lockheed Martin". */
	label: string;
}

type Result = Awaited<ReturnType<typeof client.dismissals.dismiss>>;

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** Undo for about 6 seconds: the matches come back, and the company is shown again. */
export function useDismiss(options: {
	onDismissed?: (result: Result) => void;
	onUndone?: (ids: string[]) => void;
}) {
	const queryClient = useQueryClient();
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ["inbox"] });
		void queryClient.invalidateQueries({ queryKey: orpc.inbox.key() });
		void queryClient.invalidateQueries({ queryKey: orpc.dismissals.key() });
		void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
	};
	return useMutation({
		mutationFn: (input: {
			target: DismissTarget;
			reasons: DismissReason[];
			note: string;
			hide: boolean;
		}) =>
			client.dismissals.dismiss({
				ids: input.target.ids,
				reasons: input.reasons,
				note: input.note.trim() || undefined,
				hideCompanyId:
					input.hide && input.target.company
						? input.target.company.id
						: undefined,
			}),
		onSuccess: (result, input) => {
			options.onDismissed?.(result);
			refresh();
			const company = input.target.company?.name;
			const message =
				input.hide && company
					? `Hid ${company}${result.autoDismissed.length ? ` and ${plural(result.autoDismissed.length, "other job")}` : ""}.`
					: result.dismissed.length === 1
						? `Not interested in ${input.target.label}.`
						: `Not interested in ${plural(result.dismissed.length, "match", "matches")}.`;
			const skipped = result.skipped.length
				? ` ${plural(result.skipped.length, "job")} had moved on and stayed.`
				: "";
			toast(message + skipped, {
				duration: 6_000,
				action: {
					label: "Undo",
					onClick: () => {
						client.dismissals
							.undo({
								ids: result.dismissed,
								unhideCompanyId: result.hiddenCompanyId ?? undefined,
							})
							.then((undone) => {
								options.onUndone?.(undone.restored);
								refresh();
							})
							.catch((error: Error) => toast.error(error.message));
					},
				},
			});
		},
		onError: (error) => toast.error(error.message),
	});
}

const TITLE = "Not interested (X). Optional reasons help find better matches.";

/** The form's choices, kept until it confirms or cancels. */
function useDismissForm() {
	const [reasons, setReasons] = useState<DismissReason[]>([]);
	const [note, setNote] = useState("");
	const [hide, setHide] = useState(false);
	return {
		reasons,
		note,
		setNote,
		hide,
		setHide,
		toggle: (reason: DismissReason) =>
			setReasons((prev) =>
				prev.includes(reason)
					? prev.filter((r) => r !== reason)
					: [...prev, reason],
			),
		reset: () => {
			setReasons([]);
			setNote("");
			setHide(false);
		},
	};
}

type DismissForm = ReturnType<typeof useDismissForm>;

const titleOf = (target: DismissTarget | null) =>
	(target?.ids.length ?? 0) > 1
		? `Not interested in ${target?.label}?`
		: "Not interested in this job?";

const DESCRIPTION = "Why, if you like. It helps find better matches.";

/**
 * ↩ toggles a reason and breaks a line in the note; ⌘↩ confirms from anywhere; ↩ anywhere else
 * in the form confirms too.
 */
const confirmsOnEnter = (event: {
	key: string;
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	target: EventTarget | null;
}) => {
	if (event.key !== "Enter" || event.shiftKey) return false;
	const tag = (event.target as HTMLElement | null)?.tagName;
	return primaryModifier(event) || (tag !== "TEXTAREA" && tag !== "BUTTON");
};

/** The reasons, the note and "Hide every job from <Company>": the same in the popover and the tray. */
function DismissFields({
	form,
	target,
}: {
	form: DismissForm;
	target: DismissTarget | null;
}) {
	const hideId = useId();
	return (
		<>
			<fieldset className="flex flex-wrap gap-1.5">
				<legend className="sr-only">Reasons</legend>
				{DISMISS_REASONS.map((reason) => (
					<Button
						key={reason}
						size="xs"
						variant={form.reasons.includes(reason) ? "secondary" : "outline"}
						aria-pressed={form.reasons.includes(reason)}
						className="aria-pressed:border-primary aria-pressed:text-primary"
						onClick={() => form.toggle(reason)}
						data-testid={`dismiss-reason-${reason}`}
					>
						{DISMISS_REASON_LABEL[reason]}
					</Button>
				))}
			</fieldset>
			<Textarea
				aria-label="Anything else"
				placeholder="Anything else? (optional)"
				value={form.note}
				onChange={(e) => form.setNote(e.target.value)}
				maxLength={500}
				rows={2}
				data-testid="dismiss-note"
			/>
			{target?.company ? (
				<label
					htmlFor={hideId}
					className="text-foreground flex items-center gap-2 text-sm"
				>
					<Checkbox
						id={hideId}
						checked={form.hide}
						onCheckedChange={(checked) => form.setHide(Boolean(checked))}
						data-testid="dismiss-hide-company"
					/>
					<span className="min-w-0 truncate">
						Hide every job from {target.company.name}
					</span>
				</label>
			) : null}
		</>
	);
}

interface NotInterestedProps {
	target: DismissTarget | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	dismiss: ReturnType<typeof useDismiss>;
	label?: string;
	/** Where focus goes when it closes (the list, so X ↩ X ↩ works); the trigger otherwise. */
	returnFocus?: () => HTMLElement | null;
	/** The action bar's button: as wide as Interested beside it, the bar growing into a tray. */
	bar?: boolean;
}

/**
 * Not interested and its form: optional reasons (several), an optional note, and "Hide every job
 * from <Company>". In the detail's action bar (`bar`) the bar itself grows upward into a tray
 * holding the form, and its button becomes the confirm; elsewhere the form is a popover. Open it
 * from the list too (X, the context menu) through `open`. Nothing here approves or sends anything.
 */
export function NotInterested({ bar = false, ...props }: NotInterestedProps) {
	const tray = useActionBarTray();
	return bar && tray ? (
		<NotInterestedTray {...props} tray={tray} />
	) : (
		<NotInterestedPopover {...props} />
	);
}

function NotInterestedPopover({
	target,
	open,
	onOpenChange,
	dismiss,
	label = "Not interested",
	returnFocus,
}: Omit<NotInterestedProps, "bar">) {
	const form = useDismissForm();
	const confirmRef = useRef<HTMLButtonElement>(null);
	// After a dismissal focus goes back to the list (X ↩ X ↩); after Esc or Cancel, to the trigger.
	const confirmed = useRef(false);
	const confirm = () => {
		if (!target || dismiss.isPending) return;
		confirmed.current = true;
		dismiss.mutate(
			{ target, reasons: form.reasons, note: form.note, hide: form.hide },
			{
				onError: () => {
					confirmed.current = false;
				},
				onSuccess: () => {
					onOpenChange(false);
					form.reset();
				},
			},
		);
	};
	return (
		<Popover
			// Modal: Tab and ⇧Tab stay inside, Esc closes it.
			modal
			open={open && Boolean(target)}
			onOpenChange={(next) => {
				if (next) confirmed.current = false;
				onOpenChange(next);
				if (!next) form.reset();
			}}
		>
			<PopoverTrigger
				render={
					<Button
						size="sm"
						variant="outline"
						disabled={!target}
						data-testid="not-interested"
						title={TITLE}
					/>
				}
			>
				<ThumbsDown />
				{label}
			</PopoverTrigger>
			<PopoverContent
				data-testid="not-interested-popover"
				// X then ↩ dismisses with no reasons; Tab reaches the reasons first.
				initialFocus={confirmRef}
				finalFocus={() => (confirmed.current && returnFocus?.()) || true}
				onKeyDown={(event) => {
					if (!confirmsOnEnter(event)) return;
					event.preventDefault();
					confirm();
				}}
			>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-0.5">
						<PopoverTitle>{titleOf(target)}</PopoverTitle>
						<PopoverDescription>{DESCRIPTION}</PopoverDescription>
					</div>
					<DismissFields form={form} target={target} />
					<div className="flex items-center justify-end gap-2">
						<PopoverClose
							render={<Button size="sm" variant="ghost" />}
							data-testid="dismiss-cancel"
						>
							Cancel
						</PopoverClose>
						<Button
							ref={confirmRef}
							size="sm"
							variant="outline"
							onClick={confirm}
							disabled={!target}
							pending={dismiss.isPending}
							data-testid="dismiss-confirm"
						>
							Not interested
						</Button>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}

/** What can take focus in the tray's form, in order. */
const tabStops = (root: HTMLElement) =>
	[
		...root.querySelectorAll<HTMLElement>(
			"button, input, textarea, select, a[href], [tabindex]",
		),
	].filter((el) => el.tabIndex >= 0 && !el.matches(":disabled"));

/** The stop after (or before) the focused one, round the end; the first (or last) from outside. */
const nextStop = (stops: HTMLElement[], back: boolean) => {
	const at = stops.indexOf(document.activeElement as HTMLElement);
	if (at < 0) return stops.at(back ? -1 : 0);
	return stops[(at + (back ? -1 : 1) + stops.length) % stops.length];
};

/**
 * In the action bar: its button grows the bar upward into a tray with the form, the rest of the
 * window dimmed behind it. Open, the button is the confirm (focused, so X ↩ dismisses with no
 * reasons), Tab and ⇧Tab go round the form and the confirm, Esc, the X and a click on the backdrop
 * cancel. A confirm folds the tray back first, then dismisses.
 */
function NotInterestedTray({
	target,
	open,
	onOpenChange,
	dismiss,
	label = "Not interested",
	returnFocus,
	tray,
}: Omit<NotInterestedProps, "bar"> & { tray: ActionBarTray }) {
	const form = useDismissForm();
	const titleId = useId();
	const descriptionId = useId();
	const buttonRef = useRef<HTMLButtonElement>(null);
	// Between a confirm and the dismissal settling (the fold runs first): it does not reopen.
	const [confirming, setConfirming] = useState(false);
	const isOpen = open && Boolean(target) && !confirming;
	// After a dismissal focus goes back to the list (X ↩ X ↩); after Esc or Cancel, to the button.
	const confirmed = useRef(false);

	const cancel = () => {
		onOpenChange(false);
		form.reset();
	};
	const confirm = () => {
		if (!target || dismiss.isPending || confirming) return;
		const input = {
			target,
			reasons: form.reasons,
			note: form.note,
			hide: form.hide,
		};
		confirmed.current = true;
		setConfirming(true);
		onOpenChange(false);
		const fold = window.matchMedia("(prefers-reduced-motion: reduce)").matches
			? 0
			: TRAY_MS;
		// The choices stay until it is done: a failed dismissal reopens the tray with them.
		window.setTimeout(
			() =>
				dismiss.mutate(input, {
					onSuccess: () => form.reset(),
					onError: () => {
						confirmed.current = false;
						onOpenChange(true);
					},
					onSettled: () => setConfirming(false),
				}),
			fold,
		);
	};
	const latest = useRef({ cancel, confirm });
	latest.current = { cancel, confirm };

	const { show, slot } = tray;
	useLayoutEffect(() => {
		if (!isOpen) return;
		show(() => latest.current.cancel());
		return () => show(null);
	}, [isOpen, show]);

	// Focus: on the confirm when it opens; back to the list after a dismissal, else on the button.
	const wasOpen = useRef(false);
	const returnFocusRef = useRef(returnFocus);
	returnFocusRef.current = returnFocus;
	useEffect(() => {
		if (isOpen) {
			confirmed.current = false;
			buttonRef.current?.focus();
		} else if (wasOpen.current) {
			const back = confirmed.current ? returnFocusRef.current?.() : null;
			(back ?? buttonRef.current)?.focus();
		}
		wasOpen.current = isOpen;
	}, [isOpen]);

	// The keys work wherever focus is while it is open, before the page's own shortcuts.
	useEffect(() => {
		if (!isOpen || !slot) return;
		const onKey = (event: KeyboardEvent) => {
			const button = buttonRef.current;
			// Esc and ↩ while an input method composes belong to it, not to the tray.
			if (!button || event.isComposing || event.keyCode === 229) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				latest.current.cancel();
			} else if (event.key === "Tab") {
				event.preventDefault();
				nextStop([...tabStops(slot), button], event.shiftKey)?.focus();
			} else if (confirmsOnEnter(event)) {
				const inside =
					slot.contains(event.target as Node) || event.target === button;
				if (!inside && !primaryModifier(event)) return;
				event.preventDefault();
				event.stopPropagation();
				latest.current.confirm();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [isOpen, slot]);

	return (
		<>
			<ActionBarButton
				ref={buttonRef}
				tone="neutral"
				decision
				disabled={!target}
				onClick={() => (isOpen ? confirm() : !confirming && onOpenChange(true))}
				confirm={isOpen}
				aria-expanded={isOpen}
				data-testid="not-interested"
				title={TITLE}
			>
				<ThumbsDown />
				{label}
			</ActionBarButton>
			<ActionBarTrayPanel
				tray={tray}
				open={isOpen}
				role="dialog"
				aria-labelledby={titleId}
				aria-describedby={descriptionId}
				data-testid="not-interested-popover"
				className="relative"
			>
				<div className="flex min-w-0 flex-col gap-0.5 pr-8">
					<h2 id={titleId} className="text-foreground text-sm font-semibold">
						{titleOf(target)}
					</h2>
					<p id={descriptionId} className="text-muted-foreground text-xs">
						{DESCRIPTION}
					</p>
				</div>
				<DismissFields form={form} target={target} />
				{/* At the top right, but after the fields in Tab order: from the confirm, Tab reaches the reasons first. */}
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label="Cancel"
					title="Cancel (Esc)"
					onClick={cancel}
					className="absolute top-3 right-3"
					data-testid="dismiss-cancel"
				>
					<X />
				</Button>
			</ActionBarTrayPanel>
		</>
	);
}
