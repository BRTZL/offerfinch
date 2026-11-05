import { useMutation, useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { desktop } from "@/lib/desktop";

/**
 * Try-it mode (docs/decisions.md, 2026-11-05). Main knows whether the sample data is shown, and
 * why a leave did not finish; it only changes with a reload (entering and leaving reload the
 * window, a failed leave too), so it is read once.
 */
function useDemoStatus() {
	return useQuery({
		queryKey: ["desktop-demo-state"],
		queryFn: () => desktop.demo.state(),
		staleTime: Number.POSITIVE_INFINITY,
		meta: { quiet: true },
	}).data;
}

export function useDemoMode(): boolean {
	return useDemoStatus()?.demo === true;
}

/** Enters or leaves the demo; main reloads the window when it is done. */
function useDemoSwitch(on: boolean) {
	return useMutation({
		mutationFn: async () => {
			const result = on
				? await desktop.demo.enter()
				: await desktop.demo.leave();
			if (!result.ok) throw new Error(result.error);
		},
		onError: (e) => toast.error(e.message),
	});
}

/** The welcome's second way in: the app with sample data, no AI connection needed. */
export function TryDemoButton() {
	const enter = useDemoSwitch(true);
	return (
		<Button
			variant="ghost"
			onClick={() => enter.mutate()}
			pending={enter.isPending || enter.isSuccess}
			title="Look around with a made-up profile and sample jobs. Leaving deletes them."
			data-testid="welcome-demo"
		>
			Try it with sample data
		</Button>
	);
}

/** Height of the strip, so toasts sit above it. */
export const DEMO_STRIP_HEIGHT = 36;

/** On every screen while the demo runs: what this is, and the way out. */
export function DemoBanner() {
	const status = useDemoStatus();
	const leave = useDemoSwitch(false);
	if (!status?.demo) return null;
	const failed = status.leaveFailed;
	return (
		<div
			role="status"
			className="bg-background relative z-50 shrink-0"
			data-testid="demo-banner"
		>
			<div
				className="bg-warning-surface text-foreground border-border flex items-center justify-center gap-3 border-t px-4 text-sm"
				style={{ height: DEMO_STRIP_HEIGHT }}
			>
				<FlaskConical className="text-muted-foreground size-4" aria-hidden />
				{failed === null ? (
					<span>
						<span className="font-medium">Sample data.</span> Nothing here is
						real.
					</span>
				) : (
					<span className="truncate" data-testid="demo-leave-failed">
						<span className="font-medium">Could not go back to your data.</span>{" "}
						{failed}
					</span>
				)}
				<Button
					variant="outline"
					size="xs"
					onClick={() => leave.mutate()}
					pending={leave.isPending || leave.isSuccess}
					data-testid="demo-leave"
				>
					{failed === null ? "Leave demo" : "Try again"}
				</Button>
			</div>
		</div>
	);
}
