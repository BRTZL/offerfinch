import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useDemoMode } from "@/components/desktop/demo";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";

/**
 * Opens the application's form in the user's browser (Finish it yourself, the hand-off's link).
 * The page names the application and the attempt it shows (`currentAttempt`), never a URL: the
 * worker resolves the stored form and refuses a changed attempt. A click that may have sent the
 * application is first recorded as not gone through (the user ticked "It didn't go through"),
 * and only then does the form open. Try-it mode opens nothing.
 */
export function useOpenForm(app: {
	id: string;
	currentAttempt: { id: string } | null;
	unresolvedAttempt: { attempt: number } | null;
}) {
	const queryClient = useQueryClient();
	const demo = useDemoMode();
	return useMutation({
		mutationFn: async () => {
			const attemptId = app.currentAttempt?.id ?? null;
			if (app.unresolvedAttempt && attemptId)
				await client.submission.confirmNotSent({ id: app.id, attemptId });
			if (!demo) await desktop.openApplicationForm(app.id, attemptId);
		},
		onError: (error: Error) => toast.error(error.message),
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
			void queryClient.invalidateQueries({ queryKey: ["inbox"] });
			void queryClient.invalidateQueries({ queryKey: orpc.inbox.key() });
		},
	});
}
