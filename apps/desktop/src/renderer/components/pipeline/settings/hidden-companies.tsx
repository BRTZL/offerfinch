import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	QueryState,
	SettingsPage,
} from "@/components/pipeline/settings/shared";
import { Group, GroupBody, Section } from "@/components/system/layout";
import { Row } from "@/components/system/rows";
import { Button } from "@/components/ui/button";
import { client, orpc } from "@/lib/orpc";

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/**
 * Companies hidden with "Hide every job from …" on a match. Their jobs are set aside as they are
 * found; Show again brings back the ones set aside for that reason.
 */
export function HiddenCompaniesSettings() {
	const queryClient = useQueryClient();
	const hidden = useQuery(orpc.dismissals.hidden.list.queryOptions());
	const unhide = useMutation({
		mutationFn: (company: { companyId: string; name: string }) =>
			client.dismissals.hidden.unhide({ companyId: company.companyId }),
		onSuccess: (result, company) => {
			toast.success(
				result.restored.length
					? `${company.name} is shown again, with ${plural(result.restored.length, "job")}.`
					: `${company.name} is shown again.`,
			);
			void queryClient.invalidateQueries({ queryKey: orpc.dismissals.key() });
			void queryClient.invalidateQueries({ queryKey: ["inbox"] });
		},
		onError: (error) => toast.error(error.message),
	});
	return (
		<SettingsPage
			id="hidden-companies"
			title="Hidden companies"
			description="Jobs from these companies are set aside as they are found. Hide one from a match with Not interested."
		>
			<Section title="Hidden">
				<QueryState
					isLoading={hidden.isLoading}
					error={hidden.error}
					what="hidden companies"
				/>
				{hidden.data ? (
					<Group>
						{hidden.data.length === 0 ? (
							<GroupBody className="text-muted-foreground">
								No company is hidden.
							</GroupBody>
						) : (
							hidden.data.map((company) => (
								<Row
									key={company.companyId}
									title={company.name}
									subtitle={`Hidden ${new Date(company.hiddenAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${plural(company.dismissed, "job")} set aside`}
									trailing={
										<Button
											size="sm"
											variant="outline"
											disabled={unhide.isPending}
											onClick={() => unhide.mutate(company)}
											data-testid="unhide-company"
										>
											Show again
										</Button>
									}
									data-testid="hidden-company"
								/>
							))
						)}
					</Group>
				) : null}
			</Section>
		</SettingsPage>
	);
}
