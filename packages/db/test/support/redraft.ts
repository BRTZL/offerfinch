import type { LocalWorkflowStarter } from "@offerfinch/core/pipeline/local";
import {
	type Database,
	DrizzlePipelineRepository,
	RESTARTABLE_STATES,
} from "@offerfinch/db";
import { user } from "@offerfinch/db/schema/auth";
import { applications, questions } from "@offerfinch/db/schema/pipeline";
import { and, eq, sql } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RedraftFrom = "preparing" | "scored";

export interface RedraftResult {
	applicationId: string;
	jobId: string;
	from: string;
	to: RedraftFrom;
	answered: number;
	dismissed: number;
	/** Null on a dry run. */
	state: string | null;
	outcome: unknown;
}

/**
 * `application:redraft <id>`: restart one application's preparation from `preparing` (draft
 * again now) or `scored` (re-check the spending cap and the minimum score first), keeping every
 * answer, then run its workflow inline. A dry run reads and changes nothing.
 */
export async function redraftApplication(
	db: Database,
	workflows: LocalWorkflowStarter,
	input: {
		userId: string;
		applicationId: string;
		from: RedraftFrom;
		dryRun?: boolean;
		/** False when the user is the default (PIPELINE_USER_ID): no --user or --email was given. */
		userGiven?: boolean;
	},
): Promise<RedraftResult> {
	if (!UUID.test(input.applicationId))
		throw new Error(
			`"${input.applicationId}" is not an application id (a UUID, as on the application page's URL).`,
		);
	const [app] = await db
		.select({ state: applications.state, jobId: applications.jobId })
		.from(applications)
		.where(
			and(
				eq(applications.id, input.applicationId),
				eq(applications.userId, input.userId),
			),
		);
	if (!app) throw await notOwned(db, input);
	const counts = await db
		.select({ status: questions.status, n: sql<number>`count(*)` })
		.from(questions)
		.where(
			and(
				eq(questions.userId, input.userId),
				eq(questions.applicationId, input.applicationId),
			),
		)
		.groupBy(questions.status);
	const count = (status: string) =>
		counts.find((c) => c.status === status)?.n ?? 0;
	const base = {
		applicationId: input.applicationId,
		jobId: app.jobId,
		from: app.state,
		to: input.from,
		answered: count("answered"),
	};
	if (input.dryRun) {
		if (!RESTARTABLE_STATES.includes(app.state))
			throw new Error(
				`Refused: the application is ${app.state}; only ${RESTARTABLE_STATES.join(", ")} can be re-drafted`,
			);
		return { ...base, dismissed: count("open"), state: null, outcome: null };
	}
	const repo = new DrizzlePipelineRepository(db);
	const restarted = await repo.restartPreparation(
		input.userId,
		input.applicationId,
		input.from,
		`Restarted from ${app.state} by application:redraft; answers kept`,
	);
	await workflows.restart({ userId: input.userId, jobId: app.jobId });
	return {
		...base,
		dismissed: restarted.dismissed,
		state: await repo.getState(input.userId, input.applicationId),
		outcome: workflows.outcomes.get(app.jobId) ?? null,
	};
}

/** Why the application was not found for this user, and how to name its owner. */
async function notOwned(
	db: Database,
	input: { userId: string; applicationId: string; userGiven?: boolean },
): Promise<Error> {
	const [owner] = await db
		.select({ id: applications.userId, email: user.email })
		.from(applications)
		.leftJoin(user, eq(user.id, applications.userId))
		.where(eq(applications.id, input.applicationId));
	const who =
		input.userGiven === false
			? `the default user "${input.userId}" (PIPELINE_USER_ID; no --user or --email was given)`
			: `user "${input.userId}"`;
	if (!owner)
		return new Error(
			`No application ${input.applicationId} in this database (looked for it under ${who}).`,
		);
	return new Error(
		`Application ${input.applicationId} is not owned by ${who}. It belongs to ${owner.email ?? owner.id}: run again with --email ${owner.email ?? "<address>"} or --user ${owner.id}.`,
	);
}
