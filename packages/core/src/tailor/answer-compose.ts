/**
 * Turns the picks on the Questions page's "Help me remember" card into a draft answer. Its own
 * module, with no imports, so the window can compose without pulling the prompt code in.
 *
 * Only code-written words, the asks the guard let through, and what the user ticked or typed go
 * into the draft: the model's options become the user's words only once the user picks them.
 */

/** Picks that answer nothing: the part stays open, and Improve lists it as missing. */
export const NOT_SURE = "Not sure";
/** The exclusive "no" of a group: ticking it clears the others, ticking another clears it. */
export const NONE = "None of these";

export interface ChoiceGroup {
	/** A short, generic question ("Which of these have you used?"). */
	ask: string;
	/** Several picks allowed, or one. */
	multi: boolean;
	options: { label: string; inProfile: boolean }[];
}

export interface ChoicePicks {
	/** Ticked option labels, possibly NONE or NOT_SURE. */
	picked: string[];
	/** What the user typed under "Other". */
	other: string;
}

const joinList = (items: string[]) =>
	items.length < 2
		? (items[0] ?? "")
		: `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const sentence = (text: string) => {
	const t = text.trim().replace(/[.\s]+$/, "");
	return t ? `${t}.` : "";
};

/** One line per answered group, "Ask? Pick, pick and other."; unanswered groups are left out. */
export function composeChoices(
	groups: ChoiceGroup[],
	picks: ChoicePicks[],
): string {
	const lines: string[] = [];
	groups.forEach((group, i) => {
		const p = picks[i];
		if (!p) return;
		const other = p.other.trim();
		// Only labels this group offers: a pick made under another set of asks (Help me remember
		// pressed again) never becomes a fact here.
		const offered = new Set([
			NOT_SURE,
			NONE,
			...group.options.map((o) => o.label),
		]);
		const picked = p.picked.filter((x) => offered.has(x));
		const chosen = picked.filter((x) => x !== NOT_SURE && x !== NONE);
		const answer = picked.includes(NONE)
			? other
				? sentence(`None of these; ${other}`)
				: "None of these."
			: sentence(joinList(other ? [...chosen, other] : chosen));
		if (!answer) return;
		const ask = group.ask.trim().replace(/[?:.\s]*$/, "?");
		lines.push(`${ask} ${answer}`);
	});
	return lines.join("\n");
}

/** A tick on `label` in a group: NONE and NOT_SURE are exclusive, a single-pick group keeps one. */
export function togglePick(
	group: Pick<ChoiceGroup, "multi">,
	picked: string[],
	label: string,
): string[] {
	if (picked.includes(label)) return picked.filter((x) => x !== label);
	if (label === NONE || label === NOT_SURE || !group.multi) return [label];
	return [...picked.filter((x) => x !== NONE && x !== NOT_SURE), label];
}
