CREATE TABLE `user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `flow_events` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`delivered_to` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `flow_runs` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`params` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`run_after` integer NOT NULL,
	`lease_owner` text,
	`lease_until` integer,
	`executions` integer DEFAULT 0 NOT NULL,
	`wait_step` text,
	`wait_event_type` text,
	`wait_until` integer,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE TABLE `flow_steps` (
	`run_id` text NOT NULL,
	`key` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`wait_started_at` integer,
	`wait_until` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `flow_steps_pk` PRIMARY KEY(`run_id`, `key`),
	CONSTRAINT `fk_flow_steps_run_id_flow_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `flow_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `application_transitions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_application_transitions_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_application_transitions_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`state` text DEFAULT 'found' NOT NULL,
	`filter_decision` text,
	`filter_result` text,
	`flags` text NOT NULL,
	`score` integer,
	`fit` text,
	`scored_at` integer,
	`ended_reason` text,
	`alerted_at` integer,
	`workflow_instance_id` text,
	`workflow_runtime` text,
	`workflow_started_at` integer,
	`prepare_attempts` integer DEFAULT 0 NOT NULL,
	`check_error` text,
	`current_role` text,
	`applied_at` integer,
	`applied_via` text,
	`approved_at` integer,
	`state_changed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_applications_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_applications_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text NOT NULL,
	`document_hashes` text NOT NULL,
	`approved_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_reason` text,
	CONSTRAINT `fk_approvals_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_approvals_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`scrape_parser` text,
	`status` text DEFAULT 'active' NOT NULL,
	`health` text DEFAULT 'ok' NOT NULL,
	`health_reason` text,
	`discovered_from` text,
	`removed_at` integer,
	`last_scanned_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_companies_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text NOT NULL,
	`kind` text NOT NULL,
	`format` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content` text,
	`created_by` text DEFAULT 'workflow' NOT NULL,
	`source_version` integer,
	`meta` text,
	`storage_key` text,
	`claims_check` text,
	`claims_passed` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_documents_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_documents_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `filter_settings` (
	`user_id` text PRIMARY KEY,
	`settings` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_filter_settings_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`company_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`url_normalized` text NOT NULL,
	`title` text NOT NULL,
	`locations` text NOT NULL,
	`workplace_type` text DEFAULT 'unknown' NOT NULL,
	`department` text,
	`employment_type` text,
	`description_text` text DEFAULT '' NOT NULL,
	`apply_url` text,
	`published_at` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_jobs_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_jobs_company_id_companies_id_fk` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `linkedin_pages` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`run_id` text,
	`opened_at` integer NOT NULL,
	CONSTRAINT `fk_linkedin_pages_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_linkedin_pages_run_id_linkedin_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `linkedin_runs`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `linkedin_runs` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`trigger` text NOT NULL,
	`pages_used` integer DEFAULT 0 NOT NULL,
	`listings_read` integer DEFAULT 0 NOT NULL,
	`jobs_inserted` integer DEFAULT 0 NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`outcome` text,
	`stop_reason` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT `fk_linkedin_runs_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `linkedin_seen` (
	`user_id` text NOT NULL,
	`linkedin_job_id` text NOT NULL,
	`outcome` text NOT NULL,
	`seen_at` integer NOT NULL,
	CONSTRAINT `fk_linkedin_seen_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `linkedin_settings` (
	`user_id` text PRIMARY KEY,
	`search_urls` text NOT NULL,
	`daily_page_cap` integer DEFAULT 15 NOT NULL,
	`min_gap_seconds` integer DEFAULT 20 NOT NULL,
	`max_gap_seconds` integer DEFAULT 60 NOT NULL,
	`blocked_at` integer,
	`blocked_kind` text,
	`blocked_reason` text,
	`cleared_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_linkedin_settings_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `llm_usage` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text,
	`task` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`status` text NOT NULL,
	`estimate_micros` integer NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`model_calls` integer DEFAULT 0 NOT NULL,
	`price_basis` text,
	`billing` text DEFAULT 'api' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	CONSTRAINT `fk_llm_usage_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_llm_usage_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `profile_facts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`question_id` text,
	`application_id` text,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`source` text NOT NULL,
	`question_source` text DEFAULT 'pipeline' NOT NULL,
	`board` text,
	`answered_at` integer NOT NULL,
	CONSTRAINT `fk_profile_facts_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_profile_facts_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_profile_facts_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`source_path` text,
	`files` text NOT NULL,
	`imported_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_profiles_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text,
	`key` text NOT NULL,
	`question` text NOT NULL,
	`context` text,
	`answer` text,
	`status` text DEFAULT 'open' NOT NULL,
	`profile_path` text,
	`form_field` text,
	`answered_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_questions_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_questions_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `review_checks` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text NOT NULL,
	`document_hashes` text NOT NULL,
	`provider` text NOT NULL,
	`passed` integer NOT NULL,
	`claims` text NOT NULL,
	`issues` text NOT NULL,
	`ats_checked_at` integer,
	`status` text,
	`flags` text NOT NULL,
	`segments` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_review_checks_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_review_checks_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `scan_runs` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`trigger` text NOT NULL,
	`stats` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT `fk_scan_runs_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `spending_settings` (
	`user_id` text PRIMARY KEY,
	`enabled` integer DEFAULT true NOT NULL,
	`monthly_cap_micros` integer DEFAULT 20000000 NOT NULL,
	`extra_usage_off_confirmed_at` integer,
	`subscription_daily_calls` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_spending_settings_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `submission_attempts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text DEFAULT 'started' NOT NULL,
	`mode` text DEFAULT 'auto' NOT NULL,
	`board` text,
	`url` text,
	`screenshot_before_key` text,
	`screenshot_after_key` text,
	`proof` text,
	`error` text,
	`resolution` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT `fk_submission_attempts_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_submission_attempts_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `submission_settings` (
	`user_id` text PRIMARY KEY,
	`paused` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_submission_settings_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `workflow_events` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text NOT NULL,
	`type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload` text NOT NULL,
	`sent_at` integer,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_workflow_events_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workflow_events_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `flow_events_run_idx` ON `flow_events` (`run_id`,`delivered_to`);--> statement-breakpoint
CREATE INDEX `flow_runs_ready_idx` ON `flow_runs` (`status`,`priority`,`run_after`);--> statement-breakpoint
CREATE INDEX `flow_runs_user_kind_idx` ON `flow_runs` (`user_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `application_transitions_app_idx` ON `application_transitions` (`application_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `applications_user_job_unique` ON `applications` (`user_id`,`job_id`);--> statement-breakpoint
CREATE INDEX `applications_user_state_idx` ON `applications` (`user_id`,`state`);--> statement-breakpoint
CREATE INDEX `applications_unstarted_idx` ON `applications` (`user_id`) WHERE "applications"."workflow_started_at" is null;--> statement-breakpoint
CREATE INDEX `approvals_app_idx` ON `approvals` (`application_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_one_active_unique` ON `approvals` (`application_id`) WHERE "approvals"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `companies_user_source_key_unique` ON `companies` (`user_id`,`source`,`source_key`);--> statement-breakpoint
CREATE INDEX `companies_user_name_key_idx` ON `companies` (`user_id`,`name_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `documents_app_kind_format_version_unique` ON `documents` (`application_id`,`kind`,`format`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_user_source_external_unique` ON `jobs` (`user_id`,`source`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_user_url_unique` ON `jobs` (`user_id`,`url_normalized`);--> statement-breakpoint
CREATE INDEX `jobs_company_idx` ON `jobs` (`company_id`);--> statement-breakpoint
CREATE INDEX `linkedin_pages_user_opened_idx` ON `linkedin_pages` (`user_id`,`opened_at`);--> statement-breakpoint
CREATE INDEX `linkedin_runs_user_started_idx` ON `linkedin_runs` (`user_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `linkedin_seen_user_job_unique` ON `linkedin_seen` (`user_id`,`linkedin_job_id`);--> statement-breakpoint
CREATE INDEX `llm_usage_user_created_idx` ON `llm_usage` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `llm_usage_app_idx` ON `llm_usage` (`application_id`);--> statement-breakpoint
CREATE INDEX `profile_facts_user_idx` ON `profile_facts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_user_unique` ON `profiles` (`user_id`);--> statement-breakpoint
CREATE INDEX `questions_user_status_idx` ON `questions` (`user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `questions_app_key_unique` ON `questions` (`application_id`,`key`);--> statement-breakpoint
CREATE INDEX `review_checks_app_idx` ON `review_checks` (`application_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `submission_attempts_app_attempt_unique` ON `submission_attempts` (`application_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `submission_attempts_one_started` ON `submission_attempts` (`application_id`) WHERE "submission_attempts"."status" = 'started';--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_events_idempotency_unique` ON `workflow_events` (`user_id`,`idempotency_key`);