import { Suspense } from "react";
import { Redirect } from "wouter";

import { SettingsNav } from "@/components/pipeline/settings/nav";
import { Page, PageHeader } from "@/components/system/layout";
import { RowsSkeleton } from "@/components/system/skeletons";
import { SubNavLayout } from "@/components/system/subnav";
import { preloadable } from "@/lib/preloadable";
import { useParams } from "@/lib/router";

const lazyNamed = <K extends string>(
	load: () => Promise<Record<K, React.ComponentType>>,
	name: K,
) => preloadable(() => load().then((m) => m[name]));

const SECTIONS: Record<string, ReturnType<typeof lazyNamed>> = {
	models: lazyNamed(
		() => import("@/components/desktop/models"),
		"ModelSettings",
	),
	"job-filter": lazyNamed(
		() => import("@/components/pipeline/settings/job-filter"),
		"JobFilterSettings",
	),
	"hidden-companies": lazyNamed(
		() => import("@/components/pipeline/settings/hidden-companies"),
		"HiddenCompaniesSettings",
	),
	documents: lazyNamed(
		() => import("@/components/pipeline/settings/documents"),
		"DocumentSettings",
	),
	sources: lazyNamed(
		() => import("@/components/pipeline/settings/sources"),
		"SourcesSettings",
	),
	applying: lazyNamed(
		() => import("@/components/pipeline/settings/applying"),
		"ApplyingSettings",
	),
	writing: lazyNamed(
		() => import("@/components/pipeline/settings/writing"),
		"WritingSettings",
	),
	notifications: lazyNamed(
		() => import("@/components/desktop/notifications"),
		"NotificationSettings",
	),
	general: lazyNamed(
		() => import("@/components/desktop/general"),
		"GeneralSettings",
	),
	"your-data": lazyNamed(
		() => import("@/components/pipeline/settings/account"),
		"YourDataSettings",
	),
};

// Every section is loaded as soon as Settings' own chunk is (at idle), so none suspends.
for (const section of Object.values(SECTIONS)) void section.preload();

/** Settings: a sub-sidebar of sections, one visible at a time, each at its own URL. */
export default function SettingsPage() {
	const { section } = useParams<{ section?: string }>();
	if (!section || !SECTIONS[section])
		return <Redirect to="/settings/models" replace />;
	const Section = SECTIONS[section];
	return (
		<>
			<PageHeader title="Settings" />
			<SubNavLayout nav={<SettingsNav />}>
				<Suspense
					fallback={
						<Page width="form">
							<RowsSkeleton rows={4} twoLine />
						</Page>
					}
				>
					<Section />
				</Suspense>
			</SubNavLayout>
		</>
	);
}
