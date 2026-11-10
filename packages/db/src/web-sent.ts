import { sql } from "drizzle-orm";
import { applications, submissionAttempts } from "./schema/pipeline";

/**
 * 1 when the application's unresolved attempt is an employer's form that was sent and waits for
 * the user to say whether the employer's email came ("Sent — check your email", decision
 * 2026-11-09: `proof.outcome` is "web_sent"); else 0. For list rows that show its status.
 */
export const sentCheckEmail = sql<number>`exists(select 1 from ${submissionAttempts} s where s.application_id = ${applications.id} and s.status = 'needs_human' and json_extract(s.proof, '$.outcome') = 'web_sent')`;
