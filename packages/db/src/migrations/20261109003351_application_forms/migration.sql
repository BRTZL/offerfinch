CREATE TABLE `application_forms` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text NOT NULL,
	`status` text NOT NULL,
	`board` text,
	`url` text,
	`schema` text,
	`note` text,
	`read_at` integer NOT NULL,
	CONSTRAINT `fk_application_forms_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_application_forms_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_forms_app_unique` ON `application_forms` (`application_id`);