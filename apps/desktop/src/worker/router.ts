import { answerHelperRouter } from "./answer-helper";
import { chatRouter } from "./chat";
import { dismissalRouter } from "./dismissals";
import { jobSearchSettingsRouter } from "./job-search";
import { aiRouter } from "./routers/ai";
import { applicationRouter } from "./routers/application";
import { dataRouter } from "./routers/data";
import { desktopStatusRouter } from "./routers/desktop";
import { holdsRouter } from "./routers/holds";
import { inboxRouter } from "./routers/inbox";
import { jobsRouter } from "./routers/jobs";
import { notificationsRouter } from "./routers/notifications";
import { onboardingRouter } from "./routers/onboarding";
import { pipelineRouter } from "./routers/pipeline";
import { profileRouter } from "./routers/profile";
import { worker } from "./routers/shared";
import { sourcesRouter } from "./routers/sources";
import { spendingBreakdownRouter } from "./routers/spending-breakdown";
import { storageRouter } from "./routers/storage";
import { trackingRouter } from "./routers/tracking";
import { whatsNewRouter } from "./routers/whats-new";
import { scanHistoryRouter } from "./scan-history";

export { bindApp } from "./routers/shared";

export const desktopAppRouter = {
	...pipelineRouter,
	/** The chat beside an application and beside the profile. */
	chat: chatRouter(worker),
	/**
	 * Settings › Job search: filled from the profile's location the first time; a save filters
	 * the open matches again.
	 */
	settings: { ...pipelineRouter.settings, ...jobSearchSettingsRouter(worker) },
	/** Questions, with the answer helper (Suggest and Improve) beside Save answer. */
	questions: { ...pipelineRouter.questions, ...answerHelperRouter(worker) },
	/** Scan history: what each scan searched, found and set aside, and why. */
	scanHistory: scanHistoryRouter(worker),
	/** Not interested on matches, its undo, the Inbox's view counts and hidden companies. */
	dismissals: dismissalRouter(worker),
	desktop: desktopStatusRouter,
	storage: storageRouter,
	spendingBreakdown: spendingBreakdownRouter,
	profile: profileRouter,
	application: applicationRouter,
	/** After Applied: stages, their history, private notes. Never part of a model's input. */
	tracking: trackingRouter,
	jobs: jobsRouter,
	sources: sourcesRouter,
	inbox: inboxRouter,
	ai: aiRouter,
	holds: holdsRouter,
	notifications: notificationsRouter,
	onboarding: onboardingRouter,
	data: dataRouter,
	whatsNew: whatsNewRouter,
};

export type DesktopRouter = typeof desktopAppRouter;
