import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { BrandMark } from "@/components/brand-mark";
import { orpc } from "@/lib/orpc";
import { SETUP_STEPS, timeLeft } from "../../../../shared/setup-steps";
import { FlowExplainer } from "./flow-explainer";

/**
 * What the app does, before step 1 on a first start: the whole loop as a short demo of the
 * Inbox (find, score, set aside, draft). Shown, not stored. Claude Code and Codex are looked for
 * meanwhile, so Connect AI opens with the answer.
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
			className="flex flex-col items-center gap-6 text-center"
			data-testid="welcome"
		>
			<BrandMark size={48} className="text-foreground" />
			<div id="step-title" className="flex flex-col gap-2">
				<h1 className="text-foreground text-xl font-semibold">
					Welcome to OfferFinch
				</h1>
				<p className="text-muted-foreground text-sm">
					A small bird that brings back offers.
				</p>
			</div>
			<FlowExplainer />
			<p className="text-muted-foreground text-xs">
				Your data stays on this Mac. {SETUP_STEPS.length} short steps,{" "}
				{timeLeft("ai", []).replace(" left", "")}. Skip any and finish later
				from Home.
			</p>
		</div>
	);
}
