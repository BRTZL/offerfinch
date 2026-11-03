import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("./check-biome-warnings.mjs", import.meta.url);

function warning(message, rule = "noExcessiveCognitiveComplexity") {
	return {
		severity: "warning",
		location: { path: "src/example.ts" },
		category: `lint/complexity/${rule}`,
		message,
	};
}

const complexity = (value) =>
	warning(`Excessive complexity of ${value} detected (max: 25).`);
const length = (value) =>
	warning(
		`This function has too many lines (${value}). Maximum allowed is 150.`,
		"noExcessiveLinesPerFunction",
	);

/** Exercise the real command with isolated reports and budgets, without editing the repo. */
function checker(context) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-biome-"));
	context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.copyFileSync(script, path.join(dir, "check-biome-warnings.mjs"));
	fs.writeFileSync(
		path.join(dir, "pnpm"),
		`#!${process.execPath}\nprocess.stdout.write(process.env.BIOME_REPORT);\nprocess.exit(Number(process.env.BIOME_EXIT));\n`,
		{ mode: 0o755 },
	);
	return {
		run(diagnostics, { update = false, exit = 0 } = {}) {
			return spawnSync(
				process.execPath,
				["check-biome-warnings.mjs", ...(update ? ["--update"] : [])],
				{
					cwd: dir,
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
						BIOME_REPORT: JSON.stringify({ diagnostics }),
						BIOME_EXIT: String(exit),
					},
				},
			);
		},
		budget: () =>
			JSON.parse(
				fs.readFileSync(path.join(dir, "biome-warnings.json"), "utf8"),
			),
	};
}

for (const [name, before, after, status] of [
	["accepts complexity 28 to 27", [complexity(28)], [complexity(27)], 0],
	["rejects complexity 28 to 40", [complexity(28)], [complexity(40)], 1],
	["accepts shortening ResumeImport", [length(176)], [length(175)], 0],
	["rejects a longer function", [length(176)], [length(177)], 1],
	["accepts an unchanged warning", [complexity(28)], [complexity(28)], 0],
	["accepts removing a warning", [complexity(28)], [], 0],
	[
		"rejects an increased count",
		[complexity(28)],
		[complexity(27), complexity(27)],
		1,
	],
	["rejects a new warning key", [complexity(28)], [length(176)], 1],
	[
		"keeps the maximum when keys merge",
		[complexity(28), complexity(40)],
		[complexity(39)],
		0,
	],
	[
		"rejects regression even with fewer warnings",
		[complexity(28), complexity(40)],
		[complexity(41)],
		1,
	],
]) {
	test(name, (context) => {
		const check = checker(context);
		assert.equal(check.run(before, { update: true }).status, 0);
		const budget = check.budget();
		const result = check.run(after);
		assert.equal(result.status, status, result.stdout + result.stderr);
		assert.deepEqual(
			check.budget(),
			budget,
			"checks must not raise the budget",
		);
	});
}

test("stores a count and measured maximum under a number-free key", (context) => {
	const check = checker(context);
	assert.equal(
		check.run([complexity(28), complexity(40)], { update: true }).status,
		0,
	);
	assert.deepEqual(check.budget(), {
		"src/example.ts :: lint/complexity/noExcessiveCognitiveComplexity :: Excessive complexity of  detected (max: ).":
			{
				count: 2,
				max: 40,
			},
	});
});

test("still fails on errors and a failing Biome command", (context) => {
	const check = checker(context);
	assert.equal(check.run([], { update: true }).status, 0);
	assert.equal(check.run([{ ...complexity(28), severity: "error" }]).status, 1);
	assert.equal(check.run([], { exit: 1 }).status, 1);
});
