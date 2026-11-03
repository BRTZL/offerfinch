CREATE TABLE `subscription_pauses` (
	`user_id` text NOT NULL,
	`vendor` text NOT NULL,
	`paused_at` integer NOT NULL,
	`reason` text NOT NULL,
	CONSTRAINT `fk_subscription_pauses_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_pauses_user_vendor` ON `subscription_pauses` (`user_id`,`vendor`);