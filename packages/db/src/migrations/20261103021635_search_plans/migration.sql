CREATE TABLE `search_plans` (
	`user_id` text PRIMARY KEY,
	`ai` text NOT NULL,
	`user` text NOT NULL,
	`basis` text,
	`generated_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_search_plans_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
