CREATE TABLE `application_stages` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text NOT NULL,
	`seq` integer NOT NULL,
	`stage` text NOT NULL,
	`occurred_on` text NOT NULL,
	`interview_round` integer,
	`interview_at` integer,
	`automatic` integer DEFAULT false NOT NULL,
	`reminded_at` integer,
	`reminder_tried_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_application_stages_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_application_stages_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `job_notes` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text NOT NULL,
	`stage_id` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_job_notes_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_job_notes_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_job_notes_stage_id_application_stages_id_fk` FOREIGN KEY (`stage_id`) REFERENCES `application_stages`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_stages_app_seq` ON `application_stages` (`application_id`,`seq`);--> statement-breakpoint
CREATE INDEX `application_stages_user_idx` ON `application_stages` (`user_id`);--> statement-breakpoint
CREATE INDEX `job_notes_app_idx` ON `job_notes` (`application_id`,`created_at`);