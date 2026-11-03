import { COUNTRIES } from "@offerfinch/core/filter/countries";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useContext, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SearchPlanSection } from "@/components/pipeline/settings/search-plan";
import {
	EmbeddedSave,
	Field,
	QueryState,
	SettingsPage,
	Toggle,
} from "@/components/pipeline/settings/shared";
import { Group, Section } from "@/components/system/layout";
import { Button } from "@/components/ui/button";
import { ComboboxField, MultiComboboxField } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { client, orpc } from "@/lib/orpc";

type Settings = Awaited<ReturnType<typeof client.settings.get>>;

const LIST_FIELDS = [
	"languages",
	"searchTitles",
	"roleKeywords",
	"excludeTitleKeywords",
] as const;

const list = (value: string) =>
	value
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);

/** The rules every new job passes before any model call: location, languages, title, score. */
export function JobFilterSettings() {
	const queryClient = useQueryClient();
	const settings = useQuery(orpc.settings.get.queryOptions());
	const [form, setForm] = useState<Settings | null>(null);
	useEffect(() => {
		if (settings.data && !form) setForm(settings.data);
	}, [settings.data, form]);
	const save = useMutation({
		mutationFn: (value: Settings) => client.settings.update(value),
		onSuccess: (value) => {
			setForm(value);
			toast.success(
				"Saved. Matches that no longer fit moved to Closed; new searches use it.",
			);
			void queryClient.invalidateQueries({ queryKey: orpc.settings.key() });
		},
		onError: (error) => toast.error(error.message),
	});
	const formRef = useRef<HTMLFormElement>(null);
	/** What is on screen, the comma-separated fields read from the form even before they blur. */
	const current = (): Settings | null => {
		if (!form || !formRef.current) return form;
		const data = new FormData(formRef.current);
		const next = { ...form };
		for (const key of LIST_FIELDS)
			next[key] = list(String(data.get(key) ?? ""));
		return next;
	};
	// In onboarding, Continue saves the rules on screen (defaults included), so they are stored.
	const embeddedSave = useContext(EmbeddedSave);
	useEffect(() => {
		if (!embeddedSave) return;
		embeddedSave.current = async () => {
			const next = current();
			if (next) await save.mutateAsync(next);
		};
		return () => {
			embeddedSave.current = null;
		};
	});
	const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
		setForm((f) => (f ? { ...f, [key]: value } : f));
	/** "I live in": citizenship and right to work start from it while they are empty. */
	const setLivesIn = (country: string | null) =>
		setForm((f) =>
			f
				? {
						...f,
						livesIn: country ?? "",
						citizenship:
							f.citizenship.length === 0 && country ? [country] : f.citizenship,
						rightToWork:
							f.rightToWork.length === 0 && country ? [country] : f.rightToWork,
					}
				: f,
		);
	const text = (key: (typeof LIST_FIELDS)[number]) => ({
		id: `f-${key}`,
		name: key,
		className: "w-72",
		defaultValue: form?.[key].join(", "),
		onBlur: (e: { target: { value: string } }) =>
			set(key, list(e.target.value)),
	});

	return (
		<SettingsPage
			id="job-filter"
			title="Job search"
			description="What kind of job you are looking for, and what every source searches for. Jobs that do not fit go to Rejected with the reason; new searches use your changes."
		>
			<QueryState
				isLoading={settings.isLoading}
				error={settings.error}
				what="the job filter"
			/>
			{form && (
				<form
					ref={formRef}
					className="flex flex-col gap-8"
					onSubmit={(e) => {
						e.preventDefault();
						// Pressing Enter in a field saves what was typed even before it lost focus.
						const next = current();
						if (next) save.mutate(next);
					}}
				>
					<Section title="Where you can work">
						<Group>
							<Field
								id="f-livesIn"
								label="I live in"
								hint="Filled from your profile's location. Remote jobs must hire from here."
							>
								<ComboboxField
									id="f-livesIn"
									aria-label="I live in"
									data-testid="lives-in"
									items={COUNTRIES}
									value={form.livesIn || null}
									onValueChange={setLivesIn}
									placeholder="Choose a country"
								/>
							</Field>
							<Field
								id="f-citizenship"
								label="Citizenship"
								hint="Jobs that need another citizenship or a security clearance are left out."
							>
								<MultiComboboxField
									id="f-citizenship"
									aria-label="Citizenship"
									data-testid="citizenship"
									items={COUNTRIES}
									value={form.citizenship}
									onValueChange={(v) => set("citizenship", v)}
									placeholder={form.livesIn || "Choose countries"}
								/>
							</Field>
							<Field
								id="f-rightToWork"
								label="Right to work in"
								hint="Office and hybrid jobs there are kept; anywhere else needs a visa."
							>
								<MultiComboboxField
									id="f-rightToWork"
									aria-label="Right to work in"
									data-testid="right-to-work"
									items={COUNTRIES}
									value={form.rightToWork}
									onValueChange={(v) => set("rightToWork", v)}
									placeholder={form.livesIn || "Choose countries"}
								/>
							</Field>
							<Toggle
								label="Remote from my country"
								hint="Remote jobs that hire people where you live or may work."
								checked={form.keepRemoteFromHome}
								onChange={(v) => set("keepRemoteFromHome", v)}
								testId="remote-from-home"
							/>
							<Toggle
								label="Worldwide remote"
								hint="Remote jobs open in any country."
								checked={form.keepGlobalRemote}
								onChange={(v) => set("keepGlobalRemote", v)}
								testId="global-remote"
							/>
							<Field
								id="f-keepOnsiteIn"
								label="Office or hybrid also in"
								hint="Other countries where you could go to an office without moving."
							>
								<MultiComboboxField
									id="f-keepOnsiteIn"
									aria-label="Office or hybrid also in"
									items={COUNTRIES}
									value={form.keepOnsiteIn}
									onValueChange={(v) => set("keepOnsiteIn", v)}
									placeholder="None"
								/>
							</Field>
							<Toggle
								label="Relocation"
								hint="Office jobs abroad, only when the posting offers relocation or visa support."
								checked={form.relocation}
								onChange={(v) => set("relocation", v)}
								testId="relocation"
							/>
							{form.relocation ? (
								<Field
									id="f-relocationCountries"
									label="Countries I'd move to"
									hint="Empty: any country."
								>
									<MultiComboboxField
										id="f-relocationCountries"
										aria-label="Countries I'd move to"
										data-testid="relocation-countries"
										items={COUNTRIES}
										value={form.relocationCountries}
										onValueChange={(v) => set("relocationCountries", v)}
										placeholder="Any country"
									/>
								</Field>
							) : null}
						</Group>
					</Section>
					<Section title="Role and language">
						<Group>
							<Field
								id="f-searchTitles"
								label="Search for"
								hint="Job titles for the searches below, separated by commas. Empty: the titles of the roles in your profile."
							>
								<Input
									{...text("searchTitles")}
									placeholder="From your profile"
								/>
							</Field>
							<Field
								id="f-roleKeywords"
								label="Title words"
								hint="Words a job title should contain, such as frontend or engineer."
							>
								<Input {...text("roleKeywords")} />
							</Field>
							<Field
								id="f-excludeTitleKeywords"
								label="Skip titles with"
								hint="Words that rule a job out, such as intern."
							>
								<Input {...text("excludeTitleKeywords")} />
							</Field>
							<Field
								id="f-languages"
								label="Languages you work in"
								hint="Jobs that need another language are left out."
							>
								<Input {...text("languages")} />
							</Field>
						</Group>
					</Section>
					<Section title="How good a fit">
						<Group>
							<Field
								id="f-minimum-fit"
								label="Minimum fit"
								hint="From 0 to 100. Weaker matches go to Rejected."
							>
								<Input
									id="f-minimum-fit"
									type="number"
									min={0}
									max={100}
									className="w-20 tabular-nums"
									value={form.minScore}
									onChange={(e) => set("minScore", Number(e.target.value))}
								/>
							</Field>
						</Group>
					</Section>
					<div>
						<Button
							type="submit"
							pending={save.isPending}
							data-testid="save-settings"
						>
							Save
						</Button>
					</div>
				</form>
			)}
			{form && <SearchPlanSection embedded={Boolean(embeddedSave)} />}
		</SettingsPage>
	);
}
