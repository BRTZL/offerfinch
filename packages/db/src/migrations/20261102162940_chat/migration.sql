CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'done' NOT NULL,
	`proposals` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_chat_messages_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_chat_messages_thread_id_chat_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`application_id` text,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_chat_threads_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_chat_threads_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `chat_messages_thread_idx` ON `chat_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_threads_user_key_unique` ON `chat_threads` (`user_id`,`key`);