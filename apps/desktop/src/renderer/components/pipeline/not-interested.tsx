import {
	DISMISS_REASON_LABEL,
	DISMISS_REASONS,
	type DismissReason,
} from "@offerfinch/core/domain/dismissal";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ThumbsDown } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
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

/**
 * The toolbar's Not interested button and its popover: optional reasons (several), an optional
 * note, and "Hide every job from <Company>". Open it from the list too (X, the context menu)
 * through `open`. Nothing here approves or sends anything.
 */
export function NotInterested({
	target,
	open,
	onOpenChange,
	dismiss,
	label = "Not interested",
	returnFocus,
}: {
	target: DismissTarget | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	dismiss: ReturnType<typeof useDismiss>;
	label?: string;
	/** Where focus goes when it closes (the list, so X ↩ X ↩ works); the trigger otherwise. */
	returnFocus?: () => HTMLElement | null;
}) {
	const [reasons, setReasons] = useState<DismissReason[]>([]);
	const [note, setNote] = useState("");
	const [hide, setHide] = useState(false);
	const hideId = useId();
	const confirmRef = useRef<HTMLButtonElement>(null);
	// After a dismissal focus goes back to the list (X ↩ X ↩); after Esc or Cancel, to the trigger.
	const confirmed = useRef(false);
	const reset = () => {
		setReasons([]);
		setNote("");
		setHide(false);
	};
	const confirm = () => {
		if (!target || dismiss.isPending) return;
		confirmed.current = true;
		dismiss.mutate(
			{ target, reasons, note, hide },
			{
				onError: () => {
					confirmed.current = false;
				},
				onSuccess: () => {
					onOpenChange(false);
					reset();
				},
			},
		);
	};
	const toggle = (reason: DismissReason) =>
		setReasons((prev) =>
			prev.includes(reason)
				? prev.filter((r) => r !== reason)
				: [...prev, reason],
		);
	const several = (target?.ids.length ?? 0) > 1;
	return (
		<Popover
			// Modal: Tab and ⇧Tab stay inside, Esc closes it.
			modal
			open={open && Boolean(target)}
			onOpenChange={(next) => {
				if (next) confirmed.current = false;
				onOpenChange(next);
				if (!next) reset();
			}}
		>
			<PopoverTrigger
				render={
					<Button
						size="sm"
						variant="outline"
						disabled={!target}
						data-testid="not-interested"
						title="Not interested (X). Optional reasons help find better matches."
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
					if (event.key !== "Enter" || event.shiftKey) return;
					const tag = (event.target as HTMLElement).tagName;
					// ↩ toggles a reason and breaks a line in the note; ⌘↩ confirms from anywhere.
					if (!event.metaKey && (tag === "TEXTAREA" || tag === "BUTTON"))
						return;
					event.preventDefault();
					confirm();
				}}
			>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-0.5">
						<PopoverTitle>
							{several
								? `Not interested in ${target?.label}?`
								: "Not interested?"}
						</PopoverTitle>
						<PopoverDescription>
							Why, if you like. It helps find better matches.
						</PopoverDescription>
					</div>
					<fieldset className="flex flex-wrap gap-1.5">
						<legend className="sr-only">Reasons</legend>
						{DISMISS_REASONS.map((reason) => (
							<Button
								key={reason}
								size="xs"
								variant={reasons.includes(reason) ? "secondary" : "outline"}
								aria-pressed={reasons.includes(reason)}
								className="aria-pressed:border-primary aria-pressed:text-primary"
								onClick={() => toggle(reason)}
								data-testid={`dismiss-reason-${reason}`}
							>
								{DISMISS_REASON_LABEL[reason]}
							</Button>
						))}
					</fieldset>
					<Textarea
						aria-label="Anything else"
						placeholder="Anything else? (optional)"
						value={note}
						onChange={(e) => setNote(e.target.value)}
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
								checked={hide}
								onCheckedChange={(checked) => setHide(Boolean(checked))}
								data-testid="dismiss-hide-company"
							/>
							<span className="min-w-0 truncate">
								Hide every job from {target.company.name}
							</span>
						</label>
					) : null}
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
