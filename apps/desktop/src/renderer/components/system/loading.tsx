import type { ReactNode } from "react";
import { Skeleton as Skullet, SkulletProvider } from "skullet/react";

/**
 * Loading shapes by Skullet (skullet 0.0.3, MIT, https://skullet.lochie.me): it lays out the
 * real component with sample content, unseen, and draws a bone over each line and control, so
 * the placeholder has the content's own geometry and nothing moves when the data lands. Only
 * mounted while something loads; at rest nothing animates.
 */
export function LoadingProvider({ children }: { children: ReactNode }) {
	return (
		<SkulletProvider
			mode="system"
			theme={{
				light: { base: "rgba(0,0,0,0.07)", highlight: "rgba(0,0,0,0.035)" },
				dark: {
					base: "rgba(255,255,255,0.08)",
					highlight: "rgba(255,255,255,0.04)",
				},
				radius: "4px",
				animation: "pulse",
				speed: "slow",
			}}
			reveal="together"
		>
			{children}
		</SkulletProvider>
	);
}

/** Sample content, laid out unseen and drawn as bones while `loading`. */
export function LoadingShape({
	loading = true,
	label = "Loading",
	children,
}: {
	loading?: boolean;
	label?: string;
	children: ReactNode;
}) {
	return (
		<Skullet loading={loading} label={label}>
			{children}
		</Skullet>
	);
}
