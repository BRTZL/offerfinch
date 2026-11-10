import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
	QueryState,
	SettingsPage,
	Toggle,
} from "@/components/pipeline/settings/shared";
import { Group, Section } from "@/components/system/layout";
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
	"Real job sites stay closed until you open each one below: an approved application on a site you have not opened stops before any browser opens and comes back to you, with nothing sent.",
];

/** One real job site as `submission.settings` lists it. */
type RealSite = Awaited<
	ReturnType<typeof client.submission.settings>
>["boards"][number];

/**
 * The switch for automatic submissions (`submission_settings.paused`, paused by default). Turning
 * it on asks first; turning it off is immediate. Each application is still sent only after the
 * user approves it (docs/auto-apply-plan.md). Below it, real job sites open one by one
 * (`submission_boards`, all closed by default; step 8): opening one names its known risks first,
 * closing is immediate. The main switch still gates everything.
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
	const [opening, setOpening] = useState<RealSite | null>(null);
	const setSite = useMutation({
		mutationFn: (input: { board: RealSite["board"]; open: boolean }) =>
			client.submission.setBoardOpen(input),
		onSuccess: (result) => {
			const name =
				settings.data?.boards.find((b) => b.board === result.board)?.name ??
				result.board;
			setOpening(null);
			toast.success(
				result.open
					? `${name} is open for automatic submissions.`
					: `${name} is closed for new runs. A run already started may finish.`,
			);
			void queryClient.invalidateQueries({ queryKey: orpc.submission.key() });
		},
		onError: (error) => toast.error(error.message),
	});
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
					</Group>
				) : null}
			</Section>
			{settings.data ? (
				<Section
					title="Real job sites"
					description="Each site stays closed until you open it. An approved application on a closed site stops before any browser opens and comes back to you, with nothing sent."
					data-testid="submissions-real-sites"
				>
					<Group>
						{settings.data.boards.map((site) => (
							<Toggle
								key={site.board}
								label={site.name}
								hint={
									<span data-testid={`real-site-hosts-${site.board}`}>
										{site.open ? "Open. " : "Closed. "}
										Opens{" "}
										{site.hosts.map((host, i) => (
											<span key={host}>
												{i > 0 ? ", " : ""}
												{host.includes(".") ? (
													<code className="text-2xs">{host}</code>
												) : (
													host
												)}
											</span>
										))}
										.
									</span>
								}
								checked={site.open}
								disabled={setSite.isPending}
								onChange={(value) => {
									if (value) setOpening(site);
									else setSite.mutate({ board: site.board, open: false });
								}}
								testId={`real-site-${site.board}`}
							/>
						))}
					</Group>
				</Section>
			) : null}
			<AlertDialog
				open={opening !== null}
				onOpenChange={(open) => {
					if (!open && !setSite.isPending) setOpening(null);
				}}
			>
				<AlertDialogContent data-testid="real-site-confirm-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>Open {opening?.name}?</AlertDialogTitle>
						<AlertDialogDescription>
							Approved applications on {opening?.name} can then be sent
							automatically, while the main switch is on. Known risks:
						</AlertDialogDescription>
					</AlertDialogHeader>
					<ul className="text-muted-foreground flex list-disc flex-col gap-2 pl-5 text-sm">
						{opening?.risks.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={setSite.isPending}>
							Keep it closed
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() =>
								opening && setSite.mutate({ board: opening.board, open: true })
							}
							pending={setSite.isPending}
							data-testid="real-site-confirm"
						>
							Open {opening?.name}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
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
