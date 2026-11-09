import type { ReactNode } from "react";
import { Link } from "@/lib/router";

/** Settings › Applying, where the switch for automatic submissions is. */
export const SUBMISSIONS_SETTINGS = "/settings/applying";

/**
 * "Turn them on in Settings": every place that says submissions are paused links to the switch.
 * Kept apart from the settings section so the application page does not load its chunk.
 */
export function SubmissionsSettingsLink({
	children = "Turn them on in Settings",
	onClick,
}: {
	children?: ReactNode;
	onClick?: () => void;
}) {
	return (
		<Link
			href={SUBMISSIONS_SETTINGS}
			onClick={onClick}
			className="text-primary hover:underline"
			data-testid="submissions-settings-link"
		>
			{children}
		</Link>
	);
}
