/**
 * Public repository facade: area modules retain the original protected method bodies.
 * Forwarders pass the same instance and arguments, preserving transaction context and
 * state access without rewriting those bodies.
 */
import type { SubmissionStore } from "@offerfinch/core/apply/submit";
import type { PipelineRepository } from "@offerfinch/core/pipeline/ports";
import type { Database } from "./client";
import { applicationsMethods } from "./repository/applications";
import { approvalMethods } from "./repository/approval";
import type { DrizzlePipelineRepositoryContext } from "./repository/context";
import { documentsMethods } from "./repository/documents";
import { eventsMethods } from "./repository/events";
import { formsMethods } from "./repository/forms";
import { jobsMethods } from "./repository/jobs";
import { profileMethods } from "./repository/profile";
import { questionsMethods } from "./repository/questions";
import { redraftMethods } from "./repository/redraft";
import { submissionMethods } from "./repository/submission";

export {
	ensureUser,
	firstPer,
	importProfile,
	RESTARTABLE_STATES,
	removeCompany,
	saveFilterSettings,
	seedCompanies,
	type Tx,
} from "./repository/shared";

export class DrizzlePipelineRepository
	implements PipelineRepository, SubmissionStore
{
	constructor(protected readonly db: Database) {}

	listActiveCompanies(
		...args: Parameters<typeof jobsMethods.listActiveCompanies>
	) {
		return jobsMethods.listActiveCompanies.apply(this, args);
	}

	setCompanyHealth(...args: Parameters<typeof jobsMethods.setCompanyHealth>) {
		return jobsMethods.setCompanyHealth.apply(this, args);
	}

	upsertJob(...args: Parameters<typeof jobsMethods.upsertJob>) {
		return jobsMethods.upsertJob.apply(this, args);
	}

	listUnstartedJobIds(
		...args: Parameters<typeof jobsMethods.listUnstartedJobIds>
	) {
		return jobsMethods.listUnstartedJobIds.apply(this, args);
	}

	markWorkflowsStarted(
		...args: Parameters<typeof jobsMethods.markWorkflowsStarted>
	) {
		return jobsMethods.markWorkflowsStarted.apply(this, args);
	}

	listStuckFoundJobIds(
		...args: Parameters<typeof jobsMethods.listStuckFoundJobIds>
	) {
		return jobsMethods.listStuckFoundJobIds.apply(this, args);
	}

	getApplicationByJob(
		...args: Parameters<typeof jobsMethods.getApplicationByJob>
	) {
		return jobsMethods.getApplicationByJob.apply(this, args);
	}

	getFilterSettings(
		...args: Parameters<typeof profileMethods.getFilterSettings>
	) {
		return profileMethods.getFilterSettings.apply(this, args);
	}

	getProfile(...args: Parameters<typeof profileMethods.getProfile>) {
		return profileMethods.getProfile.apply(
			this as unknown as DrizzlePipelineRepositoryContext,
			args,
		);
	}

	protected currentHashes(
		...args: Parameters<typeof approvalMethods.currentHashes>
	) {
		return approvalMethods.currentHashes.apply(this, args);
	}

	protected approvalVerdict(
		...args: Parameters<typeof approvalMethods.approvalVerdict>
	) {
		return approvalMethods.approvalVerdict.apply(this, args);
	}

	saveDraft(...args: Parameters<typeof documentsMethods.saveDraft>) {
		return documentsMethods.saveDraft.apply(this, args);
	}

	chosenAnyway(...args: Parameters<typeof applicationsMethods.chosenAnyway>) {
		return applicationsMethods.chosenAnyway.apply(this, args);
	}

	prepareRequested(
		...args: Parameters<typeof applicationsMethods.prepareRequested>
	) {
		return applicationsMethods.prepareRequested.apply(this, args);
	}

	protected lockOwned(...args: Parameters<typeof eventsMethods.lockOwned>) {
		return eventsMethods.lockOwned.apply(this, args);
	}

	protected insertVersion(
		...args: Parameters<typeof documentsMethods.insertVersion>
	) {
		return documentsMethods.insertVersion.apply(this, args);
	}

	latestDocuments(
		...args: Parameters<typeof documentsMethods.latestDocuments>
	) {
		return documentsMethods.latestDocuments.apply(
			this as unknown as DrizzlePipelineRepositoryContext,
			args,
		);
	}

	askQuestions(...args: Parameters<typeof questionsMethods.askQuestions>) {
		return questionsMethods.askQuestions.apply(this, args);
	}

	restartPreparation(
		...args: Parameters<typeof applicationsMethods.restartPreparation>
	) {
		return applicationsMethods.restartPreparation.apply(this, args);
	}

	protected restartIn(
		...args: Parameters<typeof applicationsMethods.restartIn>
	) {
		return applicationsMethods.restartIn.apply(this, args);
	}

	questionHistory(
		...args: Parameters<typeof questionsMethods.questionHistory>
	) {
		return questionsMethods.questionHistory.apply(this, args);
	}

	recordReview(...args: Parameters<typeof approvalMethods.recordReview>) {
		return approvalMethods.recordReview.apply(this, args);
	}

	completeReview(...args: Parameters<typeof approvalMethods.completeReview>) {
		return approvalMethods.completeReview.apply(this, args);
	}

	flagReview(...args: Parameters<typeof approvalMethods.flagReview>) {
		return approvalMethods.flagReview.apply(this, args);
	}

	latestReview(...args: Parameters<typeof approvalMethods.latestReview>) {
		return approvalMethods.latestReview.apply(
			this as unknown as DrizzlePipelineRepositoryContext,
			args,
		);
	}

	saveExport(...args: Parameters<typeof documentsMethods.saveExport>) {
		return documentsMethods.saveExport.apply(this, args);
	}

	pendingRedraft(...args: Parameters<typeof redraftMethods.pendingRedraft>) {
		return redraftMethods.pendingRedraft.apply(this, args);
	}

	documentVersions(
		...args: Parameters<typeof redraftMethods.documentVersions>
	) {
		return redraftMethods.documentVersions.apply(this, args);
	}

	saveRedraft(...args: Parameters<typeof redraftMethods.saveRedraft>) {
		return redraftMethods.saveRedraft.apply(this, args);
	}

	setRedraftProblem(
		...args: Parameters<typeof redraftMethods.setRedraftProblem>
	) {
		return redraftMethods.setRedraftProblem.apply(this, args);
	}

	setCheckError(...args: Parameters<typeof applicationsMethods.setCheckError>) {
		return applicationsMethods.setCheckError.apply(this, args);
	}

	setPrepareAttempts(
		...args: Parameters<typeof applicationsMethods.setPrepareAttempts>
	) {
		return applicationsMethods.setPrepareAttempts.apply(this, args);
	}

	checkApproval(...args: Parameters<typeof approvalMethods.checkApproval>) {
		return approvalMethods.checkApproval.apply(this, args);
	}

	protected revokeApproval(
		...args: Parameters<typeof approvalMethods.revokeApproval>
	) {
		return approvalMethods.revokeApproval.apply(this, args);
	}

	protected move(...args: Parameters<typeof eventsMethods.move>) {
		return eventsMethods.move.apply(this, args);
	}

	recordScore(...args: Parameters<typeof applicationsMethods.recordScore>) {
		return applicationsMethods.recordScore.apply(this, args);
	}

	dismissalSignals(
		...args: Parameters<typeof applicationsMethods.dismissalSignals>
	) {
		return applicationsMethods.dismissalSignals.apply(this, args);
	}

	claimAlert(...args: Parameters<typeof applicationsMethods.claimAlert>) {
		return applicationsMethods.claimAlert.apply(this, args);
	}

	releaseAlert(...args: Parameters<typeof applicationsMethods.releaseAlert>) {
		return applicationsMethods.releaseAlert.apply(this, args);
	}

	getState(...args: Parameters<typeof eventsMethods.getState>) {
		return eventsMethods.getState.apply(this, args);
	}

	transition(...args: Parameters<typeof eventsMethods.transition>) {
		return eventsMethods.transition.apply(this, args);
	}

	consumeEvent(...args: Parameters<typeof eventsMethods.consumeEvent>) {
		return eventsMethods.consumeEvent.apply(this, args);
	}

	protected refuseEmptyRequired(
		...args: Parameters<typeof eventsMethods.refuseEmptyRequired>
	) {
		return eventsMethods.refuseEmptyRequired.apply(this, args);
	}

	recordUserAction(...args: Parameters<typeof eventsMethods.recordUserAction>) {
		return eventsMethods.recordUserAction.apply(this, args);
	}

	submissionsPaused(
		...args: Parameters<typeof submissionMethods.submissionsPaused>
	) {
		return submissionMethods.submissionsPaused.apply(
			this as unknown as DrizzlePipelineRepositoryContext,
			args,
		);
	}

	submissionContext(
		...args: Parameters<typeof submissionMethods.submissionContext>
	) {
		return submissionMethods.submissionContext.apply(this, args);
	}

	beginSubmission(
		...args: Parameters<typeof submissionMethods.beginSubmission>
	) {
		return submissionMethods.beginSubmission.apply(this, args);
	}

	protected nextAttempt(
		...args: Parameters<typeof submissionMethods.nextAttempt>
	) {
		return submissionMethods.nextAttempt.apply(this, args);
	}

	protected blockingAttempt(
		...args: Parameters<typeof submissionMethods.blockingAttempt>
	) {
		return submissionMethods.blockingAttempt.apply(this, args);
	}

	resolveInterrupted(
		...args: Parameters<typeof submissionMethods.resolveInterrupted>
	) {
		return submissionMethods.resolveInterrupted.apply(this, args);
	}

	claimSubmission(
		...args: Parameters<typeof submissionMethods.claimSubmission>
	) {
		return submissionMethods.claimSubmission.apply(this, args);
	}

	finishSubmission(
		...args: Parameters<typeof submissionMethods.finishSubmission>
	) {
		return submissionMethods.finishSubmission.apply(this, args);
	}

	protected insertStop(
		...args: Parameters<typeof submissionMethods.insertStop>
	) {
		return submissionMethods.insertStop.apply(this, args);
	}

	stopSubmission(...args: Parameters<typeof submissionMethods.stopSubmission>) {
		return submissionMethods.stopSubmission.apply(this, args);
	}

	protected appendFormAnswers(
		...args: Parameters<typeof questionsMethods.appendFormAnswers>
	) {
		return questionsMethods.appendFormAnswers.apply(this, args);
	}

	protected resumeWithFormAnswers(
		...args: Parameters<typeof questionsMethods.resumeWithFormAnswers>
	) {
		return questionsMethods.resumeWithFormAnswers.apply(this, args);
	}

	stopForQuestions(
		...args: Parameters<typeof questionsMethods.stopForQuestions>
	) {
		return questionsMethods.stopForQuestions.apply(this, args);
	}

	recordDryRun(...args: Parameters<typeof submissionMethods.recordDryRun>) {
		return submissionMethods.recordDryRun.apply(this, args);
	}

	handOverStuck(...args: Parameters<typeof submissionMethods.handOverStuck>) {
		return submissionMethods.handOverStuck.apply(this, args);
	}

	savedAnswers(...args: Parameters<typeof questionsMethods.savedAnswers>) {
		return questionsMethods.savedAnswers.apply(this, args);
	}

	formRead(...args: Parameters<typeof formsMethods.formRead>) {
		return formsMethods.formRead.apply(this, args);
	}

	protected missingRequiredFields(
		...args: Parameters<typeof formsMethods.missingRequiredFields>
	) {
		return formsMethods.missingRequiredFields.apply(this, args);
	}

	saveFormRead(...args: Parameters<typeof formsMethods.saveFormRead>) {
		return formsMethods.saveFormRead.apply(this, args);
	}

	addFormAnswers(...args: Parameters<typeof formsMethods.addFormAnswers>) {
		return formsMethods.addFormAnswers.apply(this, args);
	}

	protected writeFormRead(
		...args: Parameters<typeof formsMethods.writeFormRead>
	) {
		return formsMethods.writeFormRead.apply(this, args);
	}

	protected mergeFormAnswers(
		...args: Parameters<typeof formsMethods.mergeFormAnswers>
	) {
		return formsMethods.mergeFormAnswers.apply(this, args);
	}

	markEventSent(...args: Parameters<typeof eventsMethods.markEventSent>) {
		return eventsMethods.markEventSent.apply(this, args);
	}
}
