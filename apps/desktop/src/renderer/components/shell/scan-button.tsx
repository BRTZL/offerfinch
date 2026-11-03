import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useDesktopStatus } from "@/components/shell/sidebar";
import { Button } from "@/components/ui/button";
import { client, orpc } from "@/lib/orpc";

/** The toolbar's Scan now: reads every watched board once, now. */
export function ScanButton({ compact = false }: { compact?: boolean }) {
	const queryClient = useQueryClient();
	const status = useDesktopStatus();
	const scan = useMutation({
		mutationFn: () => client.desktop.scanNow({}),
		onSuccess: (r) => {
			toast.success(r.started ? "Scan started." : "A scan is already running.");
			void queryClient.invalidateQueries({ queryKey: orpc.desktop.key() });
			// The Scans page lists the new run at once, and follows it while it runs.
			void queryClient.invalidateQueries({ queryKey: orpc.scanHistory.key() });
		},
		onError: (e) => toast.error(e.message),
	});
	const s = status.data;
	const scanning = s?.state === "scanning";
	const label = scanning ? "Scanning…" : "Scan now";
	const next = s?.next.at
		? `Next scan at ${new Date(s.next.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
		: s?.next.note;
	return (
		<Button
			size={compact ? "icon-sm" : "sm"}
			variant={compact ? "ghost" : "outline"}
			disabled={!s || scanning || scan.isPending}
			onClick={() => scan.mutate()}
			data-testid="scan-now"
			aria-label={label}
			title={compact ? `${label}. ${next ?? ""}` : next}
		>
			<RefreshCw />
			{compact ? null : label}
		</Button>
	);
}
