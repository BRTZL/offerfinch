/**
 * The mark as a little pixel animation for Home: a frame sheet (every frame side by side in one
 * SVG strip) stepped through like a GIF, never tweened. The finch idles, blinks, hops twice,
 * pecks twice, then chirps a green note. Cells use the large mark's geometry (3-unit squares on
 * a 4-unit grid); the body takes the text colour, the beak and the note the brand green.
 * Reduced motion shows the first frame only (the global reduced-motion rule stops animations).
 */

type Cell = readonly [x: number, y: number];

const BODY: Cell[] = [
	[16, 6],
	[20, 6],
	[24, 6],
	[12, 10],
	[20, 10],
	[24, 10],
	[8, 14],
	[12, 14],
	[16, 14],
	[20, 14],
	[24, 14],
	[4, 18],
	[8, 18],
	[12, 18],
	[16, 18],
	[20, 18],
	[0, 22],
	[4, 22],
	[8, 22],
	[12, 22],
	[16, 22],
	[0, 26],
	[12, 26],
];
const LEG: Cell = [12, 26];
const EYE: Cell = [16, 10];

interface Frame {
	name: string;
	body: Cell[];
	green: Cell[];
	/** A cell drawn faint (the note fading out). */
	faint?: Cell[];
}

const up = (cells: Cell[]): Cell[] => cells.map(([x, y]) => [x, y - 4]);
const withoutLeg = BODY.filter(([x, y]) => !(x === LEG[0] && y === LEG[1]));

/** The frames, in sheet order. Index 0 is the resting mark. */
const MARK_FRAMES: Frame[] = [
	// 0 idle
	{ name: "idle", body: BODY, green: [[28, 10]] },
	// 1 blink: the eye closes
	{ name: "blink", body: [...BODY, EYE], green: [[28, 10]] },
	// 2 hop: one cell up, leg tucked
	{ name: "hop", body: up(withoutLeg), green: [[28, 6]] },
	// 3 peck: the beak dips
	{ name: "peck", body: BODY, green: [[28, 14]] },
	// 4 chirp: the beak opens
	{
		name: "chirp",
		body: BODY,
		green: [
			[28, 6],
			[28, 14],
		],
	},
	// 5 a note pops out
	{
		name: "note",
		body: BODY,
		green: [
			[28, 10],
			[28, 2],
		],
	},
	// 6 the note fades
	{ name: "fade", body: BODY, green: [[28, 10]], faint: [[28, 2]] },
];

function Cells({
	cells,
	fill,
	opacity,
}: {
	cells: Cell[];
	fill: string;
	opacity?: number;
}) {
	return cells.map(([x, y]) => (
		<rect
			key={`${x}-${y}`}
			x={x + 0.5}
			y={y + 0.5}
			width="3"
			height="3"
			fill={fill}
			opacity={opacity}
		/>
	));
}

export function AnimatedMark({ size = 40 }: { size?: number }) {
	const count = MARK_FRAMES.length;
	return (
		<span
			className="brand-anim text-foreground inline-block shrink-0 overflow-hidden"
			style={
				{
					width: size,
					height: size,
					"--frame": `${size}px`,
				} as React.CSSProperties
			}
			aria-hidden="true"
			data-testid="animated-mark"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox={`0 0 ${32 * count} 32`}
				width={size * count}
				height={size}
				className="brand-anim-strip block"
				data-brand="grid"
				aria-hidden="true"
			>
				{MARK_FRAMES.map((frame, i) => (
					<g key={frame.name} transform={`translate(${32 * i} 0)`}>
						<Cells cells={frame.body} fill="currentColor" />
						<Cells cells={frame.green} fill="var(--brand)" />
						{frame.faint ? (
							<Cells cells={frame.faint} fill="var(--brand)" opacity={0.35} />
						) : null}
					</g>
				))}
			</svg>
		</span>
	);
}
