-- The jobs each scan run inserted (2026-11-05), recorded as they are inserted, so setup's live
-- first search lists exactly the jobs its scan found. A new, empty table: existing runs keep their
-- per-source newJobIds in scan_runs.sources, which the first search reads when a run has no rows here.
CREATE TABLE `scan_run_jobs` (
	`flow_run_id` text NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `scan_run_jobs_pk` PRIMARY KEY(`flow_run_id`, `job_id`),
	CONSTRAINT `fk_scan_run_jobs_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_scan_run_jobs_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
