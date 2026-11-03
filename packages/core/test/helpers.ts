import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExportInput, ExportResult } from "../src/export/export";
import { parseFilterSettings } from "../src/filter/settings";
import type { FetchLike } from "../src/sources/types";

export const FIXTURES = join(import.meta.dirname, "fixtures");

export function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

/** Serves recorded responses by URL substring; anything else is a 404. */
export function fakeFetch(
	routes: Record<string, { status?: number; body: string }>,
): FetchLike & { calls: string[] } {
	const calls: string[] = [];
	const impl = async (input: string) => {
		calls.push(input);
		const match = Object.entries(routes).find(([key]) => input.includes(key));
		if (!match) return new Response("not found", { status: 404 });
		return new Response(match[1].body, { status: match[1].status ?? 200 });
	};
	return Object.assign(impl, { calls });
}

/** Stands in for browser export: records what it was asked to export, finds no ATS problems. */
export function fakeExporter(exported: string[] = []) {
	return async (input: ExportInput): Promise<ExportResult> => {
		exported.push(...input.documents.map((d) => `${d.kind}-v${d.version}`));
		return {
			records: input.documents.map((d) => ({
				kind: d.kind,
				format: "pdf" as const,
				sourceVersion: d.version,
				storageKey: `${input.applicationId}/${d.kind}-v${d.version}.pdf`,
				meta: { pages: 1 },
			})),
			atsIssues: [],
		};
	};
}

/**
 * The fabricated test persona's job rules: right to work in Turkey, English and Turkish. The
 * product's defaults name no country; tests that exercise location rules use these.
 */
export const PERSONA_FILTER_SETTINGS = parseFilterSettings({
	rightToWork: ["Turkey"],
	keepOnsiteIn: ["Turkey"],
	languages: ["English", "Turkish"],
});
