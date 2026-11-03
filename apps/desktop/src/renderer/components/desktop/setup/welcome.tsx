import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { BrandMark } from "@/components/brand-mark";
import { StatusDot } from "@/components/system/bits";
import { orpc } from "@/lib/orpc";
import { SETUP_STEPS, timeLeft } from "../../../../shared/setup-steps";

const LINES = [
	"Finds roles that fit you, every hour.",
	"Drafts your CV and letter when you ask, only from your profile, and a second AI checks them.",
	"Sends nothing, and runs on this Mac. Your data stays here.",
];

/**
 * What the app does, before step 1 on a first start. Shown, not stored. Claude Code and Codex
 * are looked for meanwhile, so Connect AI opens with the answer.
 */
export function Welcome() {
	const queryClient = useQueryClient();
	useEffect(() => {
		void queryClient.prefetchQuery({
			...orpc.ai.subscriptions.queryOptions(),
			staleTime: 30_000,
		});
	}, [queryClient]);
	return (
		<div
			className="flex flex-col items-center gap-8 text-center"
			data-testid="welcome"
		>
			<BrandMark size={64} className="text-foreground" />
			<div id="step-title" className="flex flex-col gap-2">
				<h1 className="text-foreground text-xl font-semibold">
					Welcome to OfferFinch
				</h1>
				<p className="text-muted-foreground text-sm">
					A small bird that brings back offers.
				</p>
			</div>
			<ul className="flex w-full flex-col gap-3 text-left">
				{LINES.map((line) => (
					<li
						key={line}
						className="text-foreground flex items-start gap-3 text-sm"
					>
						<span className="mt-1.5">
							<StatusDot tone="brand" />
						</span>
						{line}
					</li>
				))}
			</ul>
			<p className="text-muted-foreground text-xs">
				{SETUP_STEPS.length} short steps,{" "}
				{timeLeft("ai", []).replace(" left", "")}. Skip any and finish later
				from Home.
			</p>
		</div>
	);
}
