import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Notice } from "@/components/system/bits";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useCommand } from "@/lib/commands";
import { desktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import type { DiagnosticsPreview } from "../../../shared/bridge";

const size = (bytes: number) =>
	bytes < 1024 ? `${bytes} B` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Help › Export Diagnostics… (issue #54): main builds the bundle and redacts it; this sheet
 * shows every file as it will be saved, so the user sees what they would share. Save writes
 * that bundle where they choose; nothing is sent anywhere.
 */
export function DiagnosticsHost() {
	const [bundle, setBundle] = useState<DiagnosticsPreview | null>(null);
	const [open, setOpen] = useState(false);
	const prepare = useMutation({
		mutationFn: () => desktop.diagnostics.prepare(),
		onSuccess: setBundle,
		onError: (error) => {
			setOpen(false);
			toast.error(`Could not build the diagnostics: ${error.message}`);
		},
	});
	const show = useCallback(() => {
		if (prepare.isPending) return;
		setBundle(null);
		setOpen(true);
		prepare.mutate();
	}, [prepare]);
	useCommand("export-diagnostics", show);
	const close = () => {
		if (bundle) void desktop.diagnostics.discard(bundle.id);
		setOpen(false);
	};
	const save = useMutation({
		mutationFn: (id: string) => desktop.diagnostics.save(id),
		onSuccess: (saved) => {
			if (!saved) return;
			toast.success(
				"Saved the diagnostics. Share the zip only if you want to.",
			);
			setBundle(null);
			setOpen(false);
		},
		onError: (error) => toast.error(error.message),
	});
	return (
		<Dialog open={open} onOpenChange={(next) => !next && close()}>
			<DialogContent
				data-testid="diagnostics-sheet"
				className="h-160 max-w-5xl"
			>
				<DialogHeader>
					<DialogTitle>Export Diagnostics</DialogTitle>
					<DialogDescription>
						Recent logs, versions and a settings summary, with names, emails,
						phone numbers, keys and tokens removed. Look through each file;
						nothing is sent anywhere.
					</DialogDescription>
				</DialogHeader>
				{bundle ? (
					<BundleView bundle={bundle} />
				) : (
					<DialogBody className="text-muted-foreground flex items-center justify-center text-sm">
						Gathering logs and settings…
					</DialogBody>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={close}>
						Cancel
					</Button>
					<Button
						disabled={!bundle || save.isPending}
						onClick={() => bundle && save.mutate(bundle.id)}
						data-testid="diagnostics-save"
					>
						Save…
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** The bundle's files on the left; the chosen file's text on the right, scrollable. */
function BundleView({ bundle }: { bundle: DiagnosticsPreview }) {
	const [chosen, setChosen] = useState(0);
	const file = bundle.files[chosen] ?? bundle.files[0];
	return (
		<DialogBody className="flex flex-col gap-3 overflow-hidden">
			{bundle.warnings.map((w) => (
				<Notice key={w} tone="warning" data-testid="diagnostics-warning">
					{w}
				</Notice>
			))}
			<div className="flex min-h-0 flex-1 gap-3">
				<ul
					className="border-border w-64 shrink-0 overflow-auto rounded-lg border p-1"
					aria-label="Files in the bundle"
				>
					{bundle.files.map((f, i) => (
						<li key={f.name}>
							<button
								type="button"
								onClick={() => setChosen(i)}
								data-testid="diagnostics-file"
								className={cn(
									"flex w-full items-baseline justify-between gap-2 rounded-lg px-2 py-1 text-left text-xs",
									i === chosen
										? "bg-accent text-accent-foreground"
										: "hover:bg-muted",
								)}
							>
								<span className="truncate font-mono">{f.name}</span>
								<span className="text-muted-foreground shrink-0">
									{size(f.bytes)}
								</span>
							</button>
						</li>
					))}
				</ul>
				<pre
					className="bg-muted/40 border-border min-w-0 flex-1 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap select-text"
					data-testid="diagnostics-preview"
				>
					{file?.preview}
					{file?.cut
						? "\n[The preview ends here; the zip holds the whole file.]"
						: ""}
				</pre>
			</div>
		</DialogBody>
	);
}
