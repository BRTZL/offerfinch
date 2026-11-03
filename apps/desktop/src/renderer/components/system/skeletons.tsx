import { Group } from "./layout";
import { LoadingShape } from "./loading";
import { Row } from "./rows";

const SAMPLE = [
	["Nimbus Labs  Frontend Engineer, Design System", "Ready for review"],
	["Orbit Freight  Senior Backend Engineer", "CV and letter drafted"],
	["Halcyon Health  Staff Product Engineer", "2 questions to answer"],
	["Juniper Maps  Senior Frontend Engineer", "Drafting"],
	["Kestrel Bank  Full-Stack Engineer", "Applied"],
	["Lumen Grid  React Engineer", "Ready for review"],
];

/**
 * Rows of a `Group` while their data loads: real `Row`s with sample text, drawn as bones by
 * Skullet at exactly the rows' geometry.
 */
export function RowsSkeleton({
	rows = 4,
	twoLine = false,
}: {
	rows?: number;
	twoLine?: boolean;
}) {
	return (
		<LoadingShape>
			<Group>
				{Array.from({ length: rows }, (_, i) => {
					const [title, sub] = SAMPLE[i % SAMPLE.length] ?? ["", ""];
					return (
						<Row
							key={title + String(i)}
							title={title}
							subtitle={twoLine ? sub : undefined}
							meta={<span>2h</span>}
						/>
					);
				})}
			</Group>
		</LoadingShape>
	);
}
