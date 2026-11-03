CREATE TABLE `profile_records` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`data` text NOT NULL,
	`source` text NOT NULL,
	`source_date` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_profile_records_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `profile_records_user_idx` ON `profile_records` (`user_id`,`kind`,`position`);