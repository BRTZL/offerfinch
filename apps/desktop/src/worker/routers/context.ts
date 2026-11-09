import type { LlmStatus } from "@offerfinch/core/scoring/llm-status";

/** Desktop supplies the one local user; tests may supply isolated fixture users. */
type Session = { user: { id: string; email: string; name: string } };

import type { Database, PendingEvent } from "@offerfinch/db";

export type Context = {
	session: Session | null;
	db: Database;
	/**
	 * Sends a workflow event after its change was committed. Must be safe to call twice: the
	 * payload is the event id only and the workflow re-reads SQLite.
	 */
	sendEvent: (event: PendingEvent) => Promise<void>;
	/**
	 * Fills the approved application's form with the network closed and screenshots it, never
	 * clicking submit. Absent where no browser is available.
	 */
	dryRun?: (userId: string, applicationId: string) => Promise<unknown>;
	/**
	 * Reads the application's form again, read-only, after a stop on a changed form, and plans
	 * its fields; saves nothing (the router stores it). Absent where no browser is available.
	 */
	readFormAgain?: (
		userId: string,
		applicationId: string,
	) => Promise<import("@offerfinch/core/pipeline/reread-form").FormReadAgain>;
	/**
	 * Structures pasted resume text into profile fields with the user's model, metered for that
	 * user with no application, under their spending cap. Absent where no model is configured.
	 */
	structureProfile?: (
		userId: string,
		text: string,
	) => Promise<import("@offerfinch/core/profile/structure").StructuredProfile>;
	/**
	 * Each model role's provider and, for a subscription, its login from the desktop worker.
	 * Absent when the caller does not supply model status.
	 */
	llmStatus?: () => Promise<LlmStatus>;
};
