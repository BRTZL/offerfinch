ALTER TABLE `scan_runs` ADD `flow_run_id` text;--> statement-breakpoint
ALTER TABLE `scan_runs` ADD `sources` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `scan_runs` ADD `progress` text;--> statement-breakpoint
CREATE UNIQUE INDEX `scan_runs_flow_run_unique` ON `scan_runs` (`flow_run_id`);--> statement-breakpoint
CREATE INDEX `scan_runs_user_started_idx` ON `scan_runs` (`user_id`,`started_at`);