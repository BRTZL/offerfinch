import { COUNTRIES } from "@offerfinch/core/filter/countries";
import { LANGUAGES } from "@offerfinch/core/filter/languages";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useContext, useEffect, useState } from "react";
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
import { TagInputField } from "@/components/ui/tag-input";
import { client, orpc } from "@/lib/orpc";

type Settings = Awaited<ReturnType<typeof client.settings.get>>;

const LEVELS = [
	"Intern",
	"Junior",
	"Mid-level",
	"Senior",
	"Staff",
	"Principal",
	"Lead",
	"Manager",
	"Director",
];

const COMPANY_SIZES = [
	"Startup",
	"Scale-up",
	"Mid-size",
	"Enterprise",
	"Agency or consultancy",
	"Non-profit",
	"Public sector",
];

const CURRENCIES = [
	"EUR",
	"USD",
	"GBP",
	"CHF",
	"CAD",
	"AUD",
	"SEK",
	"NOK",
	"DKK",
	"PLN",
	"TRY",
	"INR",
	"JPY",
];

/**
 * What the user is looking for: where to search, and what the fit score weighs every new job
 * against (work rights, place, languages, roles, level, pay, company). Nothing here sets a job
 * aside on its own, and saving changes no job already in the Inbox.
 */
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
				"Saved. New jobs are scored with it; jobs already here keep their score.",
			);
			void queryClient.invalidateQueries({ queryKey: orpc.settings.key() });
		},
		onError: (error) => toast.error(error.message),
	});
	/** What is saved: the form, without the old "Search for" titles (searches follow the profile). */
	const current = (): Settings | null =>
		form ? { ...form, searchTitles: [] } : form;
	// In onboarding, Continue saves the settings on screen (defaults included), so they are stored.
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
	/** A field of words the user types, as chips (`TagInputField`). */
	const tags = (key: TagKey, label: string, placeholder?: string) => (
		<TagInputField
			id={`f-${key}`}
			aria-label={label}
			data-testid={`tags-${key}`}
			className="w-96"
			value={form?.[key] ?? []}
			onValueChange={(v) => set(key, v)}
			placeholder={placeholder}
		/>
	);

	return (
		<SettingsPage
			id="job-filter"
			title="Job search"
			description="What kind of job you are looking for, and what every source searches for. The fit score weighs every new job against it; jobs already in your Inbox keep their score."
		>
			<QueryState
				isLoading={settings.isLoading}
				error={settings.error}
				what="the job filter"
			/>
			{form && (
				<form
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
								hint="Filled from your profile's location. The fit score checks that remote jobs hire from here."
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
								hint="The fit score rates jobs that need another citizenship or a security clearance below your minimum."
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
								hint="Office and hybrid jobs elsewhere need a visa; the fit score rates them below your minimum unless they offer one."
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
								hint="Searched for. The fit score uses this."
								checked={form.keepRemoteFromHome}
								onChange={(v) => set("keepRemoteFromHome", v)}
								testId="remote-from-home"
							/>
							<Toggle
								label="Worldwide remote"
								hint="Remote jobs open in any country. Searched for; the fit score uses this."
								checked={form.keepGlobalRemote}
								onChange={(v) => set("keepGlobalRemote", v)}
								testId="global-remote"
							/>
							<Field
								id="f-keepOnsiteIn"
								label="Office or hybrid also in"
								hint="Other countries where you could go to an office without moving. Searched; the fit score uses this."
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
								hint="Office jobs abroad that offer relocation or visa support. The fit score uses this."
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
					<PreferenceSections form={form} set={set} tags={tags} />
					<Section title="How good a fit">
						<Group>
							<Field
								id="f-minimum-fit"
								label="Minimum fit"
								hint="From 0 to 100. Weaker matches go to Rejected, with the reason."
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

/** The settings typed as free words, shown as chips. */
type TagKey =
	| "roleKeywords"
	| "excludeTitleKeywords"
	| "wantedRoleTypes"
	| "unwantedRoleTypes"
	| "preferredIndustries"
	| "avoidIndustries";
type SetField = <K extends keyof Settings>(key: K, value: Settings[K]) => void;
type TagField = (key: TagKey, label: string, placeholder?: string) => ReactNode;

/** Roles, languages, level, pay and company: what the fit score weighs, never a reason on their own. */
function PreferenceSections({
	form,
	set,
	tags,
}: {
	form: Settings;
	set: SetField;
	tags: TagField;
}) {
	return (
		<>
			<Section title="Role and language">
				<Group>
					<Field
						id="f-roleKeywords"
						label="Target roles"
						hint="Words for the roles you want, such as frontend or engineer. Press Enter or a comma after each. The fit score uses this."
					>
						{tags("roleKeywords", "Target roles", "Any role")}
					</Field>
					<Field
						id="f-excludeTitleKeywords"
						label="Titles to avoid"
						hint="Words for roles you don't want, such as intern. Searches skip them; the fit score counts them as a poor fit."
					>
						{tags("excludeTitleKeywords", "Titles to avoid", "None")}
					</Field>
					<Field
						id="f-languages"
						label="Languages you work in"
						hint="The fit score rates jobs that require another language below your minimum."
					>
						<MultiComboboxField
							id="f-languages"
							aria-label="Languages you work in"
							data-testid="languages"
							items={[
								...LANGUAGES,
								...form.languages.filter((l) => !LANGUAGES.includes(l)),
							]}
							value={form.languages}
							onValueChange={(v) => set("languages", v)}
							placeholder="Choose languages"
						/>
					</Field>
				</Group>
			</Section>
			<Section title="Level and kind of role">
				<Group>
					<Field
						id="f-seniority"
						label="Level"
						hint="The levels you want. Empty: any. The fit score uses this."
					>
						<MultiComboboxField
							id="f-seniority"
							aria-label="Level"
							data-testid="seniority"
							items={LEVELS}
							value={form.seniority}
							onValueChange={(v) => set("seniority", v)}
							placeholder="Any level"
						/>
					</Field>
					<Field
						id="f-wantedRoleTypes"
						label="Kinds of role you want"
						hint="Such as individual contributor or full-time. The fit score uses this."
					>
						{tags("wantedRoleTypes", "Kinds of role you want", "Any")}
					</Field>
					<Field
						id="f-unwantedRoleTypes"
						label="Kinds of role you don't want"
						hint="Such as people management or contract. The fit score counts them as a poor fit."
					>
						{tags("unwantedRoleTypes", "Kinds of role you don't want", "None")}
					</Field>
				</Group>
			</Section>
			<Section title="Pay">
				<Group>
					<Field
						id="f-minSalary"
						label="Minimum yearly salary"
						hint="A job whose stated pay is below it is rated below your minimum fit. Jobs that state no pay are not marked down. Empty: no minimum."
					>
						<div className="flex items-center gap-2">
							<Input
								id="f-minSalary"
								type="number"
								min={0}
								step={1000}
								className="w-32 tabular-nums"
								data-testid="min-salary"
								value={form.minSalary ?? ""}
								onChange={(e) =>
									set(
										"minSalary",
										e.target.value === ""
											? null
											: Math.max(0, Math.round(Number(e.target.value))),
									)
								}
								placeholder="None"
							/>
							<ComboboxField
								id="f-salaryCurrency"
								aria-label="Currency"
								data-testid="salary-currency"
								items={CURRENCIES}
								value={form.salaryCurrency || null}
								onValueChange={(v) => set("salaryCurrency", v ?? "")}
								placeholder="Currency"
								className="w-28"
							/>
						</div>
					</Field>
				</Group>
			</Section>
			<Section title="Company and industry">
				<Group>
					<Field
						id="f-companySizes"
						label="Company size or stage"
						hint="The kinds of company you prefer. Empty: any. The fit score uses this."
					>
						<MultiComboboxField
							id="f-companySizes"
							aria-label="Company size or stage"
							data-testid="company-sizes"
							items={COMPANY_SIZES}
							value={form.companySizes}
							onValueChange={(v) => set("companySizes", v)}
							placeholder="Any"
						/>
					</Field>
					<Field
						id="f-preferredIndustries"
						label="Industries you prefer"
						hint="Such as fintech or developer tools. The fit score uses this."
					>
						{tags("preferredIndustries", "Industries you prefer", "Any")}
					</Field>
					<Field
						id="f-avoidIndustries"
						label="Industries to avoid"
						hint="Such as gambling. The fit score counts them as a poor fit."
					>
						{tags("avoidIndustries", "Industries to avoid", "None")}
					</Field>
				</Group>
			</Section>
		</>
	);
}
