import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
	QueryState,
	SettingsPage,
	Toggle,
} from "@/components/pipeline/settings/shared";
import { Group, Section } from "@/components/system/layout";
import { FormRow } from "@/components/system/rows";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { client, orpc } from "@/lib/orpc";

/** What turning submissions on means, said before it happens. */
const ON_MEANS = [
	"An application goes out right after you approve it: OfferFinch fills the form once with the answers you approved and clicks submit once.",
	"A board may show its confirmation page and still drop an application it scored as automated. A confirmation is not proof the employer received it; their email is.",
	"Real job sites stay closed for now: until they are opened for a run, an approved application on a real site stops before any browser opens and comes back to you, with nothing sent.",
];

/**
 * The switch for automatic submissions (`submission_settings.paused`, paused by default). Turning
 * it on asks first; turning it off is immediate. Each application is still sent only after the
 * user approves it (docs/auto-apply-plan.md).
 */
export function ApplyingSettings() {
	const queryClient = useQueryClient();
	const settings = useQuery(orpc.submission.settings.queryOptions());
	const [confirming, setConfirming] = useState(false);
	const set = useMutation({
		mutationFn: (paused: boolean) => client.submission.setPaused({ paused }),
		onSuccess: (result) => {
			setConfirming(false);
			toast.success(
				result.paused
					? "Automatic submissions are off. Nothing is sent."
					: result.woken > 0
						? `Automatic submissions are on. ${result.woken} approved application${result.woken === 1 ? " is" : "s are"} sent now.`
						: "Automatic submissions are on. Each one goes out after you approve it.",
			);
			void queryClient.invalidateQueries({ queryKey: orpc.submission.key() });
			void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
			void queryClient.invalidateQueries({ queryKey: ["inbox"] });
		},
		onError: (error) => toast.error(error.message),
	});
	const on = settings.data?.paused === false;
	return (
		<SettingsPage
			id="applying"
			title="Applying"
			description="How an application reaches the employer once you approve it."
		>
			<Section title="Submitting">
				<QueryState
					isLoading={settings.isLoading}
					error={settings.error}
					what="the submission setting"
				/>
				{settings.data ? (
					<Group>
						<Toggle
							label="Send approved applications automatically"
							hint={
								on
									? "On: OfferFinch fills the form and submits it once, right after you approve that application. Nothing is sent without your approval."
									: "Off: nothing is sent; approved applications wait for you to submit them yourself. When on, each one is still sent only after you approve it."
							}
							checked={on}
							disabled={set.isPending}
							onChange={(value) => {
								if (value) setConfirming(true);
								else set.mutate(true);
							}}
							testId="submissions-switch"
						/>
						<FormRow
							label="Real job sites"
							hint={
								<span data-testid="submissions-real-sites">
									Closed for now. An approved application on a real job site
									stops before any browser opens and comes back to you; nothing
									is sent there until real sites are opened for a run.
								</span>
							}
						/>
					</Group>
				) : null}
			</Section>
			<AlertDialog
				open={confirming}
				onOpenChange={(open) => {
					if (!open && !set.isPending) setConfirming(false);
				}}
			>
				<AlertDialogContent data-testid="submissions-confirm-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>
							Send approved applications automatically?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Nothing is sent without your approval. Once you approve an
							application:
						</AlertDialogDescription>
					</AlertDialogHeader>
					<ul className="text-muted-foreground flex list-disc flex-col gap-2 pl-5 text-sm">
						{ON_MEANS.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={set.isPending}>
							Keep them off
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => set.mutate(false)}
							pending={set.isPending}
							data-testid="submissions-confirm"
						>
							Turn On
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SettingsPage>
	);
}
