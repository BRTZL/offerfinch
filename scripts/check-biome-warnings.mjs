import { spawnSync } from "node:child_process";
import fs from "node:fs";

const baselineFile = new URL("./biome-warnings.json", import.meta.url);
const result = spawnSync(
	"pnpm",
	[
		"exec",
		"biome",
		"ci",
		".",
		"--reporter=json",
		"--max-diagnostics=none",
		"--colors=off",
	],
	{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (result.error) throw result.error;
const report = JSON.parse(result.stdout);
const warnings = {};
let errors = 0;
for (const diagnostic of report.diagnostics) {
	if (diagnostic.severity === "error" || diagnostic.severity === "fatal") {
		errors++;
		console.error(
			`${diagnostic.location.path}: ${diagnostic.category}: ${diagnostic.message}`,
		);
	}
	if (diagnostic.severity !== "warning") continue;
	const message = diagnostic.message.replace(/\d+(?:\.\d+)?/g, "");
	const key = `${diagnostic.location.path} :: ${diagnostic.category} :: ${message}`;
	// Biome's length/complexity messages put the measured value before the limit.
	const measured = Number(diagnostic.message.match(/\d+(?:\.\d+)?/)?.[0] ?? 0);
	warnings[key] ??= { count: 0, max: 0 };
	const budget = warnings[key];
	budget.count++;
	budget.max = Math.max(budget.max, measured);
}
if (errors || result.status !== 0) {
	console.error(result.stderr);
	process.exit(1);
}
if (process.argv.includes("--update")) {
	fs.writeFileSync(
		baselineFile,
		`${JSON.stringify(Object.fromEntries(Object.entries(warnings).sort(([a], [b]) => a.localeCompare(b))), null, "\t")}\n`,
	);
	console.log("Updated the reviewed Biome warning baseline.");
} else {
	const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
	let added = 0;
	let regressed = 0;
	for (const [key, current] of Object.entries(warnings)) {
		const budget = baseline[key];
		const extra = current.count - (budget?.count ?? 0);
		if (extra > 0) {
			added += extra;
			console.error(`${extra} new warning(s): ${key}`);
		}
		if (budget && current.max > budget.max) {
			regressed++;
			console.error(
				`Measured ${current.max} exceeds budget ${budget.max}: ${key}`,
			);
		}
	}
	const total = Object.values(warnings).reduce(
		(sum, budget) => sum + budget.count,
		0,
	);
	console.log(
		`Biome: ${errors} errors, ${total} existing warnings, ${added} new warnings, ${regressed} measurement regressions.`,
	);
	if (added || regressed) process.exit(1);
}
