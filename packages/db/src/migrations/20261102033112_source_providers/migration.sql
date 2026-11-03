CREATE TABLE `source_providers` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`last_run_at` integer,
	`last_run` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_source_providers_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_providers_user_provider` ON `source_providers` (`user_id`,`provider`);