import { normalizeLineEndings } from "@offerfinch/core/domain/line-endings";
import type { ApplicationState } from "@offerfinch/core/domain/states";
import type { JobSourceKind } from "@offerfinch/core/domain/types";
import { companyNameKey } from "@offerfinch/core/domain/url";
import { parseFilterSettings } from "@offerfinch/core/filter/settings";
import type { ProfileSnapshot } from "@offerfinch/core/profile/types";
import {
	ASKED_QUESTION_PREFIX,
	BOARD_QUESTION_PREFIX,
	confirmationLine,
} from "@offerfinch/core/tailor/profile-rules";
import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { user } from "../schema/auth";
import { companies, filterSettings, profiles } from "../schema/pipeline";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Postgres' `DISTINCT ON`: the first row per key, from rows already ordered so the wanted one
 * comes first (latest version first).
 */
export function firstPer<T>(rows: T[], key: (row: T) => string): T[] {
	const seen = new Set<string>();
	return rows.filter((row) => {
		const k = key(row);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/** States `restartPreparation` accepts: scored and preparation, never approval or submission. */
export const RESTARTABLE_STATES: readonly ApplicationState[] = [
	"scored",
	"preparing",
	"needs_answers",
	"ready_for_review",
	"failed",
	"expired",
];

/** Answers from the question inbox, cited by tailoring and the claims check as this file. */
export const ANSWERS_PATH = "answers.md";

export function questionKey(question: string): string {
	return question
		.toLowerCase()
		.replace(/[^\p{L}\d]+/gu, " ")
		.trim();
}

export function answersMarkdown(
	facts: {
		question: string;
		answer: string;
		source: string;
		answeredAt: Date;
		questionSource?: string;
		board?: string | null;
	}[],
): string {
	const blocks = facts.map((f) => {
		const meta = `- Source: ${f.source}, ${f.answeredAt.toISOString().slice(0, 10)}`;
		// A line confirmed in a flagged review: the exact text is the user's word, with provenance.
		if (f.questionSource === "confirmation")
			// Only the text and its provenance: the flag's reasons are the checker's words, never evidence.
			return `## Confirmed by the user in a review\n\n${confirmationLine(f.question, f.answer)}\n${meta}`;
		// A form's label is the board's text: kept on one marked line, apart from the answer.
		if (f.questionSource === "board")
			return `## Answer to a job board's form question${f.board ? ` (${f.board})` : ""}\n\n${BOARD_QUESTION_PREFIX} ${f.question.replace(/\s+/g, " ").trim()}\n- Answer: ${f.answer.trim()}\n${meta}`;
		// The pipeline's question can presuppose a fact ("mentored mid-level developers"): it is
		// shown for context on a marked line, and only the user's answer is evidence.
		return `## Answer to a question from tailoring\n\n${ASKED_QUESTION_PREFIX} ${f.question.replace(/\s+/g, " ").trim()}\n- Answer: ${f.answer.replace(/\s+/g, " ").trim()}\n${meta}`;
	});
	return `# Answers\n\nThe user's own answers from the question inbox, with date and source. Each question was asked once; its answer settles the topic.\n\n${blocks.join("\n\n")}\n`;
}

/** Postgres implementation of the pipeline port. Postgres is the source of truth for every state. */
/** Attempts that block another click: one may have gone through, or did. */
export const BLOCKING_ATTEMPTS = [
	"started",
	"needs_human",
	"submitted",
] as const;

/** How a form question appears in the question inbox: its label, and the options when it has them. */
export function formQuestionText(label: string, options: string[]): string {
	return options.length > 0
		? `${label} (one of: ${options.slice(0, 12).join(" / ")})`
		: label;
}

/* ------------------------------------------------------------- watchlist */

export interface CompanySeed {
	name: string;
	source: JobSourceKind;
	sourceKey: string;
	scrapeParser?: string | null;
	discoveredFrom: string;
}

/**
 * Adds companies to the watchlist. Existing rows are left untouched (a re-seed never resets
 * status), and a company the user removed is never added again, under any source.
 */
export async function seedCompanies(
	db: Database,
	userId: string,
	seeds: CompanySeed[],
) {
	const result = {
		inserted: [] as string[],
		existing: [] as string[],
		skippedRemoved: [] as string[],
	};
	for (const seed of seeds) {
		const nameKey = companyNameKey(seed.name);
		const [removed] = await db
			.select({ id: companies.id })
			.from(companies)
			.where(
				and(
					eq(companies.userId, userId),
					eq(companies.nameKey, nameKey),
					eq(companies.status, "removed"),
				),
			)
			.limit(1);
		if (removed) {
			result.skippedRemoved.push(seed.name);
			continue;
		}
		const rows = await db
			.insert(companies)
			.values({
				userId,
				name: seed.name,
				nameKey,
				source: seed.source,
				sourceKey: seed.sourceKey,
				scrapeParser: seed.scrapeParser ?? null,
				discoveredFrom: seed.discoveredFrom,
			})
			.onConflictDoNothing()
			.returning({ id: companies.id });
		(rows.length > 0 ? result.inserted : result.existing).push(seed.name);
	}
	return result;
}

/** Marks a company removed (by id or name). Removed companies are skipped by scans and seeding. */
export async function removeCompany(
	db: Database,
	userId: string,
	idOrName: string,
): Promise<number> {
	const isUuid = /^[0-9a-f-]{36}$/i.test(idOrName);
	const rows = await db
		.update(companies)
		.set({ status: "removed", removedAt: new Date() })
		.where(
			and(
				eq(companies.userId, userId),
				isUuid
					? eq(companies.id, idOrName)
					: eq(companies.nameKey, companyNameKey(idOrName)),
			),
		)
		.returning({ id: companies.id });
	return rows.length;
}

export async function ensureUser(
	db: Database,
	input: { id: string; name: string; email: string },
): Promise<void> {
	await db
		.insert(user)
		.values({ ...input, emailVerified: false })
		.onConflictDoNothing();
}

export async function importProfile(
	db: Database,
	userId: string,
	snapshot: ProfileSnapshot,
	sourcePath: string,
): Promise<void> {
	const files = snapshot.files.map((file) => ({
		...file,
		content: normalizeLineEndings(file.content),
	}));
	await db
		.insert(profiles)
		.values({ userId, files, sourcePath })
		.onConflictDoUpdate({
			target: profiles.userId,
			set: { files, sourcePath, importedAt: new Date() },
		});
}

export async function saveFilterSettings(
	db: Database,
	userId: string,
	settings: Record<string, unknown>,
): Promise<void> {
	parseFilterSettings(settings);
	await db
		.insert(filterSettings)
		.values({ userId, settings })
		.onConflictDoUpdate({ target: filterSettings.userId, set: { settings } });
}
