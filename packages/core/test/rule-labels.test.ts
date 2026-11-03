import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BLOCKING_RULES, CONFIRMABLE_RULES } from "../src/tailor/flags";
import {
	CLAIM_RULES,
	RULE_EXPLANATION,
	RULE_LABEL,
	ruleExplanation,
	ruleLabel,
} from "../src/tailor/rule-labels";

/** Issue #21: no claims-check rule id is ever shown; each has plain words beside it. */
describe("claims-check rule labels", () => {
	it.each(CLAIM_RULES)(
		"%s has a plain label and a one-line explanation",
		(rule) => {
			const label = RULE_LABEL[rule];
			expect(label?.trim()).toBeTruthy();
			// Not the id with its underscores swapped, which is what the app used to show.
			expect(label.toLowerCase()).not.toBe(rule.replace(/_/g, " "));
			expect(label).not.toContain("_");
			const explanation = RULE_EXPLANATION[rule];
			expect(explanation?.trim()).toBeTruthy();
			expect(explanation).not.toContain("\n");
			expect(ruleLabel(rule)).toBe(label);
		},
	);

	it("labels only rules that exist", () => {
		expect(Object.keys(RULE_LABEL).sort()).toEqual([...CLAIM_RULES].sort());
		expect(Object.keys(RULE_EXPLANATION).sort()).toEqual(
			[...CLAIM_RULES].sort(),
		);
		for (const rule of [...BLOCKING_RULES, ...CONFIRMABLE_RULES])
			expect(CLAIM_RULES).toContain(rule);
	});

	it("reads a rule no longer checked as words, never its id", () => {
		// Old reviews in a user's database may carry a rule removed since (`current_role`).
		expect(ruleLabel("current_role")).toBe("Another check");
		expect(ruleLabel("current_role")).not.toContain("_");
		expect(ruleExplanation("current_role")).toBeNull();
	});

	it("no renderer code turns a rule id into text by hand", () => {
		const root = path.resolve(
			import.meta.dirname,
			"../../../apps/desktop/src/renderer",
		);
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const file = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(file);
				else if (/\.tsx?$/.test(entry.name)) {
					const text = fs.readFileSync(file, "utf8");
					if (/rule\.replace\(|\?\?\s*(?:r|issue|reason)\.rule\b/.test(text))
						offenders.push(path.relative(root, file));
				}
			}
		};
		walk(root);
		expect(offenders).toEqual([]);
	});
});
