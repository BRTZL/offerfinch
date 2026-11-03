import {
	icsFileName,
	interviewIcs,
	isDay,
	localDay,
	STAGE_LABEL,
	stageClock,
	sweepDecision,
	type TrackingStage,
} from "@offerfinch/core/domain/tracking";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "./client";
import type { Tx } from "./repository";
import { applications, companies, jobs } from "./schema/pipeline";
import { applicationStages, jobNotes } from "./schema/tracking";

/**
 * After Applied (`core/domain/tracking.ts`): stage entries and private notes. These are read
 * only by the Applied screen, the export and the follow-up sweep; no model input is built from
 * them (a test proves the chat and pipeline paths never see a note).
 */

type Db = Database | Tx;
type StageRow = typeof applicationStages.$inferSelect;

export type StageEntry = Pick<
	StageRow,
	| "id"
	| "seq"
	| "stage"
	| "occurredOn"
	| "interviewRound"
	| "interviewAt"
	| "automatic"
	| "createdAt"
>;

export type JobNote = Pick<
	typeof jobNotes.$inferSelect,
	"id" | "stageId" | "body" | "createdAt" | "updatedAt"
>;

/** A note's text: trimmed, never empty, at most 5,000 characters. */
export const NOTE_MAX = 5_000;

/**
 * A stage's calendar day (YYYY-MM-DD), kept as a day: never an instant, so it is the same day in
 * every time zone. Default: today on this computer. Never in the future.
 */
function stageDay(day: string | undefined, now: Date): string {
	const today = localDay(now);
	if (!day) return today;
	if (!isDay(day)) throw new Error("Refusing: not a valid date (YYYY-MM-DD)");
	if (day > today)
		throw new Error(
			"Refusing: that date is in the future. Give the day it happened",
		);
	return day;
}

/**
 * The day an application was sent. "I submitted this" stores the picked day at noon UTC, so its
 * UTC date is that day; a board's confirmation is a real instant, read as the local day.
 */
function sentDay(app: {
	appliedAt: Date | null;
	appliedVia: string | null;
	stateChangedAt: Date;
}): string {
	const at = app.appliedAt ?? app.stateChangedAt;
	return app.appliedVia === "manual" && app.appliedAt
		? at.toISOString().slice(0, 10)
		: localDay(at);
}

async function ownedApplication(t: Db, userId: string, applicationId: string) {
	const [row] = await t
		.select({
			id: applications.id,
			state: applications.state,
			appliedAt: applications.appliedAt,
			appliedVia: applications.appliedVia,
			stateChangedAt: applications.stateChangedAt,
		})
		.from(applications)
		.where(
			and(eq(applications.id, applicationId), eq(applications.userId, userId)),
		);
	if (!row) throw new Error("Not found");
	return row;
}

async function stagesOf(t: Db, applicationId: string): Promise<StageRow[]> {
	return t
		.select()
		.from(applicationStages)
		.where(eq(applicationStages.applicationId, applicationId))
		.orderBy(asc(applicationStages.seq));
}

/**
 * The Applied entry an application past Applied starts from, dated when it was sent. Written
 * on first use, so applications sent before this existed get one too.
 */
async function ensureApplied(
	t: Db,
	userId: string,
	app: {
		id: string;
		appliedAt: Date | null;
		appliedVia: string | null;
		stateChangedAt: Date;
	},
): Promise<StageRow[]> {
	const rows = await stagesOf(t, app.id);
	if (rows.length > 0) return rows;
	const [row] = await t
		.insert(applicationStages)
		.values({
			userId,
			applicationId: app.id,
			seq: 1,
			stage: "applied",
			occurredOn: sentDay(app),
			createdAt: app.appliedAt ?? app.stateChangedAt,
		})
		.returning();
	return row ? [row] : [];
}

function entryOf(row: StageRow): StageEntry {
	return {
		id: row.id,
		seq: row.seq,
		stage: row.stage,
		occurredOn: row.occurredOn,
		interviewRound: row.interviewRound,
		interviewAt: row.interviewAt,
		automatic: row.automatic,
		createdAt: row.createdAt,
	};
}

/**
 * One application's stages (oldest first; only once it is applied) and its private notes
 * (newest first, on any job).
 */
export async function trackingFor(
	db: Database,
	userId: string,
	applicationId: string,
): Promise<{
	applied: boolean;
	stage: TrackingStage | null;
	stages: StageEntry[];
	notes: JobNote[];
}> {
	// The first read writes the Applied entry: in a transaction (which holds the database's
	// lock), so two reads at once cannot both write entry 1.
	const { applied, stages } = await db.transaction(async (tx) => {
		const app = await ownedApplication(tx, userId, applicationId);
		const sent = app.state === "applied";
		return {
			applied: sent,
			stages: sent ? await ensureApplied(tx, userId, app) : [],
		};
	});
	const notes = await db
		.select({
			id: jobNotes.id,
			stageId: jobNotes.stageId,
			body: jobNotes.body,
			createdAt: jobNotes.createdAt,
			updatedAt: jobNotes.updatedAt,
		})
		.from(jobNotes)
		.where(
			and(
				eq(jobNotes.applicationId, applicationId),
				eq(jobNotes.userId, userId),
			),
		)
		.orderBy(desc(jobNotes.createdAt), desc(sql`${jobNotes}.rowid`));
	return {
		applied,
		stage: stages.at(-1)?.stage ?? null,
		stages: stages.map(entryOf),
		notes,
	};
}

function cleanNote(body: string | undefined): string | null {
	const text = body?.trim() ?? "";
	if (!text) return null;
	if (text.length > NOTE_MAX)
		throw new Error(`Refusing: a note holds at most ${NOTE_MAX} characters`);
	return text;
}

/**
 * Moves an applied application to a stage. Interviewing again is the next round; any other
 * stage it is already at is refused. Ghosted can be left for any stage, by the user only.
 */
export async function moveStage(
	db: Database,
	input: {
		userId: string;
		applicationId: string;
		stage: TrackingStage;
		/** The day it happened (YYYY-MM-DD); default today. */
		occurredOn?: string;
		/** Interviewing: when the interview is (an ISO instant). */
		interviewAt?: string | null;
		/** Interviewing: the round; default the one after the last. */
		interviewRound?: number | null;
		note?: string;
		now?: Date;
	},
): Promise<StageEntry> {
	const now = input.now ?? new Date();
	const occurredOn = stageDay(input.occurredOn, now);
	const note = cleanNote(input.note);
	const interviewing = input.stage === "interviewing";
	const interviewAt =
		interviewing && input.interviewAt ? new Date(input.interviewAt) : null;
	if (interviewAt && Number.isNaN(interviewAt.getTime()))
		throw new Error("Refusing: not a valid interview time");
	return db.transaction(async (tx) => {
		const app = await ownedApplication(tx, input.userId, input.applicationId);
		if (app.state !== "applied")
			throw new Error(
				"Refusing: only an application you sent can move to a stage after Applied",
			);
		const rows = await ensureApplied(tx, input.userId, app);
		const current = rows.at(-1);
		if (current?.stage === input.stage && !interviewing)
			throw new Error(`Refusing: it is already at ${STAGE_LABEL[input.stage]}`);
		const lastRound = Math.max(
			0,
			...rows.map((r) =>
				r.stage === "interviewing" ? (r.interviewRound ?? 1) : 0,
			),
		);
		const [row] = await tx
			.insert(applicationStages)
			.values({
				userId: input.userId,
				applicationId: input.applicationId,
				// The order of record, whatever the clock says (it can be set back).
				seq: (current?.seq ?? 0) + 1,
				stage: input.stage,
				occurredOn,
				interviewRound: interviewing
					? (input.interviewRound ?? lastRound + 1)
					: null,
				interviewAt,
				createdAt: now,
			})
			.returning();
		if (!row) throw new Error("Stage not saved");
		if (note)
			await tx.insert(jobNotes).values({
				userId: input.userId,
				applicationId: input.applicationId,
				stageId: row.id,
				body: note,
				createdAt: now,
				updatedAt: now,
			});
		return entryOf(row);
	});
}

/** A private note on any job; while it is past Applied, it belongs to the current stage. */
export async function addNote(
	db: Database,
	input: { userId: string; applicationId: string; body: string; now?: Date },
): Promise<JobNote> {
	const body = cleanNote(input.body);
	if (!body) throw new Error("Refusing: the note is empty");
	const now = input.now ?? new Date();
	return db.transaction(async (tx) => {
		const app = await ownedApplication(tx, input.userId, input.applicationId);
		const stageId =
			app.state === "applied"
				? ((await ensureApplied(tx, input.userId, app)).at(-1)?.id ?? null)
				: null;
		const [row] = await tx
			.insert(jobNotes)
			.values({
				userId: input.userId,
				applicationId: input.applicationId,
				stageId,
				body,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		if (!row) throw new Error("Note not saved");
		return {
			id: row.id,
			stageId: row.stageId,
			body: row.body,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	});
}

export async function updateNote(
	db: Database,
	input: { userId: string; noteId: string; body: string; now?: Date },
): Promise<void> {
	const body = cleanNote(input.body);
	if (!body) throw new Error("Refusing: the note is empty");
	const done = await db
		.update(jobNotes)
		.set({ body, updatedAt: input.now ?? new Date() })
		.where(
			and(eq(jobNotes.id, input.noteId), eq(jobNotes.userId, input.userId)),
		)
		.returning({ id: jobNotes.id });
	if (done.length === 0) throw new Error("Not found");
}

export async function deleteNote(
	db: Database,
	input: { userId: string; noteId: string },
): Promise<void> {
	await db
		.delete(jobNotes)
		.where(
			and(eq(jobNotes.id, input.noteId), eq(jobNotes.userId, input.userId)),
		);
}

/** Each applied application's current stage, for the Applied list's chips and counts. */
export async function currentStages(
	db: Database,
	userId: string,
): Promise<
	Map<
		string,
		{
			stage: TrackingStage;
			since: string;
			round: number | null;
			automatic: boolean;
		}
	>
> {
	const rows = await db
		.select({
			applicationId: applicationStages.applicationId,
			stage: applicationStages.stage,
			occurredOn: applicationStages.occurredOn,
			round: applicationStages.interviewRound,
			automatic: applicationStages.automatic,
		})
		.from(applicationStages)
		.where(eq(applicationStages.userId, userId))
		.orderBy(asc(applicationStages.seq));
	const out = new Map<
		string,
		{
			stage: TrackingStage;
			since: string;
			round: number | null;
			automatic: boolean;
		}
	>();
	// In order of record, so the last write per application is its current stage.
	for (const r of rows)
		out.set(r.applicationId, {
			stage: r.stage,
			since: r.occurredOn,
			round: r.round,
			automatic: r.automatic,
		});
	return out;
}

/**
 * The periodic look at every applied application: 21 days with no change in Applied or Heard
 * back sets Ghosted (automatic; the user can move it on), and 7 days makes a follow-up
 * reminder due for the stage entry. A due reminder is not marked here: the caller marks it with
 * `markReminded` once the notification has gone out, so a quit or crash before then reminds
 * again on the next start (a repeat beats a reminder lost).
 */
export async function sweepTracking(
	db: Database,
	userId: string,
	now: Date = new Date(),
): Promise<{
	ghosted: string[];
	reminders: FollowUp[];
}> {
	const applied = await db
		.select({
			id: applications.id,
			appliedAt: applications.appliedAt,
			appliedVia: applications.appliedVia,
			stateChangedAt: applications.stateChangedAt,
			title: jobs.title,
			company: companies.name,
		})
		.from(applications)
		.innerJoin(jobs, eq(jobs.id, applications.jobId))
		.innerJoin(companies, eq(companies.id, jobs.companyId))
		.where(
			and(eq(applications.userId, userId), eq(applications.state, "applied")),
		);
	const ghosted: string[] = [];
	const reminders: FollowUp[] = [];
	for (const app of applied)
		await db.transaction(async (tx) => {
			const current = (await ensureApplied(tx, userId, app)).at(-1);
			if (!current) return;
			const decision = sweepDecision({
				stage: current.stage,
				clock: stageClock(current),
				remindedAt: current.remindedAt,
				triedAt: current.reminderTriedAt,
				now,
			});
			if (decision === "ghost") {
				await tx.insert(applicationStages).values({
					userId,
					applicationId: app.id,
					seq: current.seq + 1,
					stage: "ghosted",
					occurredOn: localDay(now),
					automatic: true,
					createdAt: now,
				});
				ghosted.push(app.id);
			} else if (decision === "remind") {
				reminders.push({
					stageId: current.id,
					applicationId: app.id,
					title: app.title,
					company: app.company,
				});
			}
		});
	return { ghosted, reminders };
}

/** A reminder that is due: for which stage entry of which application. */
export type FollowUp = {
	stageId: string;
	applicationId: string;
	title: string;
	company: string;
};

/**
 * What macOS did with these stage entries' reminder: shown, so none is due again for the same
 * entry; or not shown (blocked, failed, no answer), so it is tried again after a day.
 */
export async function markReminded(
	db: Database,
	userId: string,
	stageIds: string[],
	outcome: "shown" | "not_shown",
	now: Date = new Date(),
): Promise<void> {
	if (stageIds.length === 0) return;
	await db
		.update(applicationStages)
		.set(outcome === "shown" ? { remindedAt: now } : { reminderTriedAt: now })
		.where(
			and(
				eq(applicationStages.userId, userId),
				inArray(applicationStages.id, stageIds),
			),
		);
}

/** Which of these stage entries' reminders were already shown (reminded_at set). */
export async function remindedStages(
	db: Database,
	userId: string,
	stageIds: string[],
): Promise<Set<string>> {
	if (stageIds.length === 0) return new Set();
	const rows = await db
		.select({ id: applicationStages.id, at: applicationStages.remindedAt })
		.from(applicationStages)
		.where(
			and(
				eq(applicationStages.userId, userId),
				inArray(applicationStages.id, stageIds),
			),
		);
	return new Set(rows.filter((r) => r.at).map((r) => r.id));
}

/** An Interviewing entry with a time, as an .ics file to save (`core/domain/tracking.ts`). */
export async function interviewEvent(
	db: Database,
	userId: string,
	stageId: string,
): Promise<{ name: string; text: string }> {
	const [row] = await db
		.select({
			id: applicationStages.id,
			stage: applicationStages.stage,
			interviewAt: applicationStages.interviewAt,
			round: applicationStages.interviewRound,
			title: jobs.title,
			url: jobs.url,
			company: companies.name,
		})
		.from(applicationStages)
		.innerJoin(
			applications,
			eq(applications.id, applicationStages.applicationId),
		)
		.innerJoin(jobs, eq(jobs.id, applications.jobId))
		.innerJoin(companies, eq(companies.id, jobs.companyId))
		.where(
			and(
				eq(applicationStages.id, stageId),
				eq(applicationStages.userId, userId),
			),
		);
	if (!row) throw new Error("Not found");
	if (row.stage !== "interviewing" || !row.interviewAt)
		throw new Error("Refusing: this stage has no interview time");
	return {
		name: icsFileName(row.company, row.round),
		text: interviewIcs({
			uid: row.id,
			start: row.interviewAt,
			company: row.company,
			title: row.title,
			round: row.round,
			url: row.url,
		}),
	};
}
