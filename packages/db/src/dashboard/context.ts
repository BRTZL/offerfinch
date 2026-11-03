import type { DashboardRepository } from "../dashboard";

/** The existing repository instance, including members used by its moved method bodies. */
export type DashboardRepositoryContext = Pick<
	DashboardRepository,
	keyof DashboardRepository
> & {
	database: DashboardRepository["database"];
	runStatus: DashboardRepository["runStatus"];
	addEvent: DashboardRepository["addEvent"];
	lockFlag: DashboardRepository["lockFlag"];
	existingEvent: DashboardRepository["existingEvent"];
	db: DashboardRepository["db"];
	currentHashes: DashboardRepository["currentHashes"];
	approvalVerdict: DashboardRepository["approvalVerdict"];
	lockOwned: DashboardRepository["lockOwned"];
	insertVersion: DashboardRepository["insertVersion"];
	restartIn: DashboardRepository["restartIn"];
	revokeApproval: DashboardRepository["revokeApproval"];
	move: DashboardRepository["move"];
	nextAttempt: DashboardRepository["nextAttempt"];
	blockingAttempt: DashboardRepository["blockingAttempt"];
	insertStop: DashboardRepository["insertStop"];
	appendFormAnswers: DashboardRepository["appendFormAnswers"];
	resumeWithFormAnswers: DashboardRepository["resumeWithFormAnswers"];
};
