import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ago } from "@/components/pipeline/bits";
import { Group, Section } from "@/components/system/layout";
import { FormRow } from "@/components/system/rows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { client, orpc } from "@/lib/orpc";

type Where = "remote-worldwide" | "remote-in-country" | "onsite";

const WHERE: { value: Where; label: string }[] = [
	{ value: "remote-worldwide", label: "Remote, worldwide" },
	{ value: "remote-in-country", label: "Remote, in a country" },
	{ value: "onsite", label: "Office or hybrid" },
];

const BY: Record<"you" | "ai" | "rules", string> = {
	you: "Yours",
	ai: "Written by AI",
	rules: "From your titles and places",
};

/**
 * "What OfferFinch searches for": the one search plan every source uses (LinkedIn, Indeed,
 * Glassdoor, job boards, web search), each in its own form. AI writes it once a day from the
 * profile and the settings above; the user's own searches come first and stay. Regenerate is
 * left out during setup, where no model may be connected yet.
 */
export function SearchPlanSection({ embedded }: { embedded: boolean }) {
	const queryClient = useQueryClient();
	const plan = useQuery(orpc.settings.plan.queryOptions());
	const [keywords, setKeywords] = useState("");
	const [where, setWhere] = useState<Where>("remote-worldwide");
	const [place, setPlace] = useState("");
	const done = (value: Awaited<ReturnType<typeof client.settings.plan>>) =>
		queryClient.setQueryData(orpc.settings.plan.queryKey(), value);
	const add = useMutation({
		mutationFn: () =>
			client.settings.addSearch({
				keywords: keywords.trim(),
				where,
				...(where !== "remote-worldwide" && place.trim()
					? { place: place.trim() }
					: {}),
			}),
		onSuccess: (value) => {
			setKeywords("");
			setPlace("");
			done(value);
		},
		onError: (e) => toast.error(e.message),
	});
	const remove = useMutation({
		mutationFn: (key: string) => client.settings.removeSearch({ key }),
		onSuccess: done,
		onError: (e) => toast.error(e.message),
	});
	const regenerate = useMutation({
		mutationFn: () => client.settings.regenerate(),
		onSuccess: (value) => {
			toast.success("Today's searches written again.");
			done(value);
		},
		onError: (e) => toast.error(e.message),
	});
	const dismiss = useMutation({
		mutationFn: () => client.settings.dismissMoved(),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: orpc.settings.plan.queryKey(),
			}),
	});
	const data = plan.data;
	if (!data) return null;
	const written =
		data.basis === "ai" && data.generatedAt
			? `AI wrote them ${ago(data.generatedAt)}`
			: "AI writes them with the next scan";
	return (
		<Section
			title="What OfferFinch searches for"
			description={`Every source uses these searches, each in its own form. ${written}, from your profile and the settings above, once a day; yours come first and stay.`}
		>
			{data.moved ? (
				<Group data-testid="search-plan-moved">
					<FormRow label="Your saved searches moved here" hint={data.moved}>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => dismiss.mutate()}
							disabled={dismiss.isPending}
						>
							OK
						</Button>
					</FormRow>
				</Group>
			) : null}
			<Group data-testid="search-plan">
				{data.searches.map((s) => (
					<FormRow
						key={s.key}
						label={s.label}
						hint={BY[s.by]}
						data-testid="search-plan-entry"
					>
						{s.by === "you" ? (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => remove.mutate(s.key)}
								disabled={remove.isPending}
								aria-label={`Remove ${s.label}`}
							>
								Remove
							</Button>
						) : null}
					</FormRow>
				))}
				<FormRow
					label="Add a search"
					htmlFor="search-plan-keywords"
					hint="A job title or a few words; where to look."
				>
					<form
						className="flex flex-wrap items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (keywords.trim()) add.mutate();
						}}
					>
						<Input
							id="search-plan-keywords"
							className="w-48"
							value={keywords}
							placeholder="Design Engineer"
							onChange={(e) => setKeywords(e.target.value)}
							data-testid="search-plan-keywords"
						/>
						<Select
							value={where}
							onValueChange={(next) => {
								if (next) setWhere(next as Where);
							}}
							items={WHERE}
						>
							<SelectTrigger
								aria-label="Where"
								className="w-44"
								data-testid="search-plan-where"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{WHERE.map((option) => (
									<SelectItem
										key={option.value}
										value={option.value}
										data-testid={`search-plan-where-${option.value}`}
									>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{where !== "remote-worldwide" ? (
							<Input
								aria-label="Country or city"
								className="w-32"
								value={place}
								placeholder="Where you live"
								onChange={(e) => setPlace(e.target.value)}
								data-testid="search-plan-place"
							/>
						) : null}
						<Button
							type="submit"
							variant="outline"
							disabled={!keywords.trim() || add.isPending}
							data-testid="search-plan-add"
						>
							Add
						</Button>
					</form>
				</FormRow>
				{embedded ? null : (
					<FormRow
						label="Regenerate"
						hint="AI writes today's searches again now (one call, counted like any other)."
					>
						<Button
							variant="outline"
							onClick={() => regenerate.mutate()}
							pending={regenerate.isPending}
							data-testid="search-plan-regenerate"
						>
							Regenerate
						</Button>
					</FormRow>
				)}
			</Group>
		</Section>
	);
}
