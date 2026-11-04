CREATE TABLE `plan_usage` (
	`user_id` text NOT NULL,
	`vendor` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_plan_usage_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_usage_user_vendor` ON `plan_usage` (`user_id`,`vendor`);