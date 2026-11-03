import { Kbd } from "@/components/system/bits";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	comboLabel,
	SHORTCUT_GROUPS,
	SHORTCUTS,
	type Shortcut,
} from "../../../shared/shortcuts";

/**
 * Help › Keyboard Shortcuts (⌘/): every shortcut in shared/shortcuts.ts, grouped by screen. It
 * renders the registry itself, so a shortcut added there is listed here with nothing else to do.
 */
export function ShortcutsSheet({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const all = SHORTCUTS as readonly Shortcut[];
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-testid="shortcuts-sheet" className="max-w-5xl">
				<DialogHeader>
					<DialogTitle>Keyboard Shortcuts</DialogTitle>
					<DialogDescription>
						No key approves an application: Approve is always a click, with the
						documents in view.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="columns-3 gap-6">
						{SHORTCUT_GROUPS.map((group) => (
							<section
								key={group}
								className="mb-4 break-inside-avoid"
								data-testid="shortcut-group"
							>
								<h3 className="text-muted-foreground mb-1.5 text-xs font-semibold">
									{group}
								</h3>
								<ul className="flex flex-col">
									{all
										.filter((s) => s.group === group)
										.map((s) => (
											<li
												key={s.id}
												className="border-border flex items-center justify-between gap-3 border-b py-1 text-xs last:border-b-0"
												data-testid="shortcut"
												data-shortcut={s.id}
											>
												<span className="text-foreground">{s.label}</span>
												<span className="flex shrink-0 items-center gap-1">
													{s.keys.map((k) => (
														<Kbd key={comboLabel(k)}>{comboLabel(k)}</Kbd>
													))}
												</span>
											</li>
										))}
								</ul>
							</section>
						))}
					</div>
				</DialogBody>
				<DialogFooter>
					<DialogClose>Done</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
