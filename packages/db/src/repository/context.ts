import type { DrizzlePipelineRepository } from "../repository";

/** The existing repository instance, including members used by its moved method bodies. */
export type DrizzlePipelineRepositoryContext = Pick<
	DrizzlePipelineRepository,
	keyof DrizzlePipelineRepository
> & {
	db: DrizzlePipelineRepository["db"];
	currentHashes: DrizzlePipelineRepository["currentHashes"];
	approvalVerdict: DrizzlePipelineRepository["approvalVerdict"];
	lockOwned: DrizzlePipelineRepository["lockOwned"];
	insertVersion: DrizzlePipelineRepository["insertVersion"];
	restartIn: DrizzlePipelineRepository["restartIn"];
	revokeApproval: DrizzlePipelineRepository["revokeApproval"];
	move: DrizzlePipelineRepository["move"];
	nextAttempt: DrizzlePipelineRepository["nextAttempt"];
	blockingAttempt: DrizzlePipelineRepository["blockingAttempt"];
	insertStop: DrizzlePipelineRepository["insertStop"];
	appendFormAnswers: DrizzlePipelineRepository["appendFormAnswers"];
	resumeWithFormAnswers: DrizzlePipelineRepository["resumeWithFormAnswers"];
	writeFormRead: DrizzlePipelineRepository["writeFormRead"];
	mergeFormAnswers: DrizzlePipelineRepository["mergeFormAnswers"];
};
