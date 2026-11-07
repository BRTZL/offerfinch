import {
	Bell,
	Database,
	EyeOff,
	Filter,
	Globe,
	Settings2,
	SlidersHorizontal,
} from "lucide-react";
import type { ReactNode } from "react";
import { SubNav, SubNavGroup, SubNavLink } from "@/components/system/subnav";
import { usePathname } from "@/lib/router";

const GROUPS: {
	label: string;
	links: { href: string; label: string; icon: ReactNode }[];
}[] = [
	{
		label: "Pipeline",
		links: [
			{
				href: "/settings/models",
				label: "Models",
				icon: <SlidersHorizontal />,
			},
			{ href: "/settings/job-filter", label: "Job search", icon: <Filter /> },
			{
				href: "/settings/hidden-companies",
				label: "Hidden companies",
				icon: <EyeOff />,
			},
			{ href: "/settings/sources", label: "Sources", icon: <Globe /> },
		],
	},
	{
		label: "App",
		links: [
			{
				href: "/settings/notifications",
				label: "Notifications",
				icon: <Bell />,
			},
			{ href: "/settings/general", label: "General", icon: <Settings2 /> },
			{ href: "/settings/your-data", label: "Your data", icon: <Database /> },
		],
	},
];

/** The settings sections, each its own URL, in a second column like System Settings. */
export function SettingsNav() {
	const pathname = usePathname();
	return (
		<SubNav label="Settings">
			{GROUPS.map((group) => (
				<div key={group.label} className="flex flex-col gap-1">
					<SubNavGroup label={group.label} />
					{group.links.map((link) => (
						<SubNavLink
							key={link.href}
							href={link.href}
							icon={link.icon}
							active={pathname === link.href}
						>
							{link.label}
						</SubNavLink>
					))}
				</div>
			))}
		</SubNav>
	);
}
