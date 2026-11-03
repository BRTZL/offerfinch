import { useReducedMotion } from "@/lib/reduced-motion";

/** Eight of the mark's cells, flung out from the middle in the brand green. */
const SPARKS = Array.from({ length: 8 }, (_, i) => {
	const angle = (Math.PI * 2 * i) / 8 + Math.PI / 8;
	const reach = i % 2 ? 22 : 30;
	return {
		dx: Math.round(Math.cos(angle) * reach),
		dy: Math.round(Math.sin(angle) * reach),
		size: i % 2 ? 3 : 4,
	};
});

/**
 * A small burst of the mark's cells, once, for a moment worth it (setup: AI connected, the
 * first matches). `burst` counts the bursts; each new value plays one. Nothing under reduced
 * motion. Sits over its parent's middle, which must be positioned; it takes no clicks.
 */
export function SparkleBurst({ burst }: { burst: number }) {
	const reduced = useReducedMotion();
	if (!burst || reduced) return null;
	return (
		<span
			key={burst}
			aria-hidden
			className="pointer-events-none absolute top-1/2 left-1/2"
			data-testid="sparkle-burst"
		>
			{SPARKS.map((s) => (
				<span
					key={`${s.dx}-${s.dy}`}
					className="sparkle bg-brand absolute block rounded-xs"
					style={
						{
							width: s.size,
							height: s.size,
							"--dx": `${s.dx}px`,
							"--dy": `${s.dy}px`,
						} as React.CSSProperties
					}
				/>
			))}
		</span>
	);
}
