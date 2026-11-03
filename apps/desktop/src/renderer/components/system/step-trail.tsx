import { useEffect, useRef, useState } from "react";
import { MarkFrame } from "@/components/animated-mark";
import { useReducedMotion } from "@/lib/reduced-motion";
import { cn } from "@/lib/utils";

/** Each step's bar, and the room between two. */
const BAR = 32;
const GAP = 8;
/** How long a hop shows the hop frame (the move itself takes the same). */
const HOP_MS = 200;
/** The finch: 24 px keeps the mark's cells crisp (16 px blurs them). */
const FINCH = 24;

export interface TrailStep {
	key: string;
	title: string;
	done: boolean;
}

/**
 * Setup's step indicator: one bar per step (done ones green, the current one in ink, the rest
 * quiet), and the finch standing over the current one. Moving to another step, it hops there
 * (the mark's hop frame while it moves, 200 ms). Under reduced motion it is simply there.
 */
export function StepTrail({
	steps,
	current,
	onPick,
}: {
	steps: TrailStep[];
	current: number;
	onPick: (index: number) => void;
}) {
	const reduced = useReducedMotion();
	const [hopping, setHopping] = useState(false);
	const last = useRef(current);
	useEffect(() => {
		// Reduced motion: no hop, and none left showing from before it was turned on.
		if (reduced) {
			last.current = current;
			setHopping(false);
			return;
		}
		if (last.current === current) return;
		last.current = current;
		setHopping(true);
		const timer = window.setTimeout(() => setHopping(false), HOP_MS);
		return () => window.clearTimeout(timer);
	}, [current, reduced]);
	const at = Math.max(0, current);
	return (
		<nav aria-label="Setup steps" className="flex flex-col gap-1">
			<span
				className="finch-trail block size-6"
				style={{
					transform: `translateX(${at * (BAR + GAP) + (BAR - FINCH) / 2}px)`,
				}}
				data-testid="setup-finch"
				data-step={at}
				data-hopping={hopping || undefined}
			>
				<span className="finch-trail-body block">
					<MarkFrame frame={hopping ? "hop" : "idle"} size={FINCH} />
				</span>
			</span>
			<span className="flex items-center" style={{ gap: GAP }}>
				{steps.map((s, i) => (
					<button
						key={s.key}
						type="button"
						aria-label={`Step ${i + 1} of ${steps.length}, ${s.title}, ${i === current ? "current" : s.done ? "done" : "not done yet"}`}
						aria-current={i === current ? "step" : undefined}
						title={s.title}
						onClick={() => onPick(i)}
						data-testid={`step-${s.key}`}
						data-state={i === current ? "current" : s.done ? "done" : "todo"}
						style={{ width: BAR }}
						className={cn(
							"ease-standard focus-visible:ring-ring h-1 rounded-full transition-colors duration-150 outline-none focus-visible:ring-2",
							// Done in the brand green, the current one in ink under the finch, the rest quiet.
							i === current
								? "bg-foreground"
								: s.done
									? "bg-brand"
									: "bg-border",
						)}
					/>
				))}
			</span>
		</nav>
	);
}
