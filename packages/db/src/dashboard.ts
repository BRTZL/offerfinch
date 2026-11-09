/**
 * Public repository facade: area modules retain the original protected method bodies.
 * Forwarders pass the same instance and arguments, preserving transaction context and
 * state access without rewriting those bodies.
 */
import type { Database } from "./client";
import { applicationsMethods } from "./dashboard/applications";
import { documentsMethods } from "./dashboard/documents";
import { flagsMethods } from "./dashboard/flags";
import { inboxMethods } from "./dashboard/inbox";
import { profileMethods } from "./dashboard/profile";
import { questionsMethods } from "./dashboard/questions";
import { redraftMethods } from "./dashboard/redraft";
import { spendingMethods } from "./dashboard/spending";
import { submissionMethods } from "./dashboard/submission";
import { DrizzlePipelineRepository } from "./repository";

export {
	appliedDate,
	EditConflictError,
	INBOX_VIEWS,
	type PendingEvent,
	StaleAttemptError,
	subscriptionPauseOf,
} from "./dashboard/shared";

/**
 * Reads and actions behind the dashboard. Every read and write is scoped to the signed-in user.
 * Actions commit their change and a `workflow_events` row in one transaction, then return the
 * event for the caller to send; repeating an action is a no-op.
 */
export class DashboardRepository extends DrizzlePipelineRepository {
	constructor(protected readonly database: Database) {
		super(database);
	}

	countsByState(...args: Parameters<typeof inboxMethods.countsByState>) {
		return inboxMethods.countsByState.apply(this, args);
	}

	inboxCounts(...args: Parameters<typeof inboxMethods.inboxCounts>) {
		return inboxMethods.inboxCounts.apply(this, args);
	}

	listApplications(...args: Parameters<typeof inboxMethods.listApplications>) {
		return inboxMethods.listApplications.apply(this, args);
	}

	protected runStatus(...args: Parameters<typeof inboxMethods.runStatus>) {
		return inboxMethods.runStatus.apply(this, args);
	}

	getApplication(...args: Parameters<typeof documentsMethods.getApplication>) {
		return documentsMethods.getApplication.apply(this, args);
	}

	applicationCost(...args: Parameters<typeof spendingMethods.applicationCost>) {
		return spendingMethods.applicationCost.apply(this, args);
	}

	spending(...args: Parameters<typeof spendingMethods.spending>) {
		return spendingMethods.spending.apply(this, args);
	}

	setSpendingCap(...args: Parameters<typeof spendingMethods.setSpendingCap>) {
		return spendingMethods.setSpendingCap.apply(this, args);
	}

	protected addEvent(...args: Parameters<typeof applicationsMethods.addEvent>) {
		return applicationsMethods.addEvent.apply(this, args);
	}

	requestRedraft(...args: Parameters<typeof redraftMethods.requestRedraft>) {
		return redraftMethods.requestRedraft.apply(this, args);
	}

	retryRedraft(...args: Parameters<typeof redraftMethods.retryRedraft>) {
		return redraftMethods.retryRedraft.apply(this, args);
	}

	cancelRedraft(...args: Parameters<typeof redraftMethods.cancelRedraft>) {
		return redraftMethods.cancelRedraft.apply(this, args);
	}

	documentHistory(...args: Parameters<typeof redraftMethods.documentHistory>) {
		return redraftMethods.documentHistory.apply(this, args);
	}

	documentVersion(...args: Parameters<typeof redraftMethods.documentVersion>) {
		return redraftMethods.documentVersion.apply(this, args);
	}

	editDocument(...args: Parameters<typeof documentsMethods.editDocument>) {
		return documentsMethods.editDocument.apply(this, args);
	}

	protected lockFlag(...args: Parameters<typeof flagsMethods.lockFlag>) {
		return flagsMethods.lockFlag.apply(this, args);
	}

	resolveFlagByEdit(
		...args: Parameters<typeof flagsMethods.resolveFlagByEdit>
	) {
		return flagsMethods.resolveFlagByEdit.apply(this, args);
	}

	retryCheck(...args: Parameters<typeof flagsMethods.retryCheck>) {
		return flagsMethods.retryCheck.apply(this, args);
	}

	updatePosting(...args: Parameters<typeof applicationsMethods.updatePosting>) {
		return applicationsMethods.updatePosting.apply(this, args);
	}

	keepAddedJob(...args: Parameters<typeof applicationsMethods.keepAddedJob>) {
		return applicationsMethods.keepAddedJob.apply(this, args);
	}

	migrateAddedJobs(
		...args: Parameters<typeof applicationsMethods.migrateAddedJobs>
	) {
		return applicationsMethods.migrateAddedJobs.apply(this, args);
	}

	clearStaleFlags(...args: Parameters<typeof flagsMethods.clearStaleFlags>) {
		return flagsMethods.clearStaleFlags.apply(this, args);
	}

	requestPrepare(
		...args: Parameters<typeof applicationsMethods.requestPrepare>
	) {
		return applicationsMethods.requestPrepare.apply(this, args);
	}

	confirmFlag(...args: Parameters<typeof flagsMethods.confirmFlag>) {
		return flagsMethods.confirmFlag.apply(this, args);
	}

	approve(...args: Parameters<typeof flagsMethods.approve>) {
		return flagsMethods.approve.apply(this, args);
	}

	reject(...args: Parameters<typeof flagsMethods.reject>) {
		return flagsMethods.reject.apply(this, args);
	}

	protected existingEvent(
		...args: Parameters<typeof applicationsMethods.existingEvent>
	) {
		return applicationsMethods.existingEvent.apply(this, args);
	}

	setSubmissionsPaused(
		...args: Parameters<typeof submissionMethods.setSubmissionsPaused>
	) {
		return submissionMethods.setSubmissionsPaused.apply(this, args);
	}

	markSubmittedManually(
		...args: Parameters<typeof submissionMethods.markSubmittedManually>
	) {
		return submissionMethods.markSubmittedManually.apply(this, args);
	}

	retrySubmission(
		...args: Parameters<typeof submissionMethods.retrySubmission>
	) {
		return submissionMethods.retrySubmission.apply(this, args);
	}

	confirmNotSent(...args: Parameters<typeof submissionMethods.confirmNotSent>) {
		return submissionMethods.confirmNotSent.apply(this, args);
	}

	formLinkAttempt(
		...args: Parameters<typeof submissionMethods.formLinkAttempt>
	) {
		return submissionMethods.formLinkAttempt.apply(this, args);
	}

	readFormAgainRefusal(
		...args: Parameters<typeof submissionMethods.readFormAgainRefusal>
	) {
		return submissionMethods.readFormAgainRefusal.apply(this, args);
	}

	readFormAgain(...args: Parameters<typeof submissionMethods.readFormAgain>) {
		return submissionMethods.readFormAgain.apply(this, args);
	}

	getProof(...args: Parameters<typeof submissionMethods.getProof>) {
		return submissionMethods.getProof.apply(this, args);
	}

	listApplied(...args: Parameters<typeof inboxMethods.listApplied>) {
		return inboxMethods.listApplied.apply(this, args);
	}

	listQuestions(...args: Parameters<typeof questionsMethods.listQuestions>) {
		return questionsMethods.listQuestions.apply(this, args);
	}
	setQuestionSuggestion(
		...args: Parameters<typeof questionsMethods.setQuestionSuggestion>
	) {
		return questionsMethods.setQuestionSuggestion.apply(this, args);
	}

	answerQuestion(...args: Parameters<typeof questionsMethods.answerQuestion>) {
		return questionsMethods.answerQuestion.apply(this, args);
	}

	profileFiles(...args: Parameters<typeof profileMethods.profileFiles>) {
		return profileMethods.profileFiles.apply(this, args);
	}

	addFact(...args: Parameters<typeof profileMethods.addFact>) {
		return profileMethods.addFact.apply(this, args);
	}

	updateFact(...args: Parameters<typeof profileMethods.updateFact>) {
		return profileMethods.updateFact.apply(this, args);
	}

	removeFact(...args: Parameters<typeof profileMethods.removeFact>) {
		return profileMethods.removeFact.apply(this, args);
	}

	listFacts(...args: Parameters<typeof profileMethods.listFacts>) {
		return profileMethods.listFacts.apply(this, args);
	}

	listRejected(...args: Parameters<typeof inboxMethods.listRejected>) {
		return inboxMethods.listRejected.apply(this, args);
	}

	listCompanies(...args: Parameters<typeof inboxMethods.listCompanies>) {
		return inboxMethods.listCompanies.apply(this, args);
	}

	getExport(...args: Parameters<typeof documentsMethods.getExport>) {
		return documentsMethods.getExport.apply(this, args);
	}

	getFilterSettingsRaw(
		...args: Parameters<typeof profileMethods.getFilterSettingsRaw>
	) {
		return profileMethods.getFilterSettingsRaw.apply(this, args);
	}

	documentsByKind(
		...args: Parameters<typeof documentsMethods.documentsByKind>
	) {
		return documentsMethods.documentsByKind.apply(this, args);
	}
}
