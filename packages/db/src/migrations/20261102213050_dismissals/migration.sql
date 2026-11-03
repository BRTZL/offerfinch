CREATE TABLE `dismissals` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`application_id` text NOT NULL,
	`company_id` text NOT NULL,
	`reasons` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dismissals_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_dismissals_application_id_applications_id_fk` FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_dismissals_company_id_companies_id_fk` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `hidden_companies` (
	`user_id` text NOT NULL,
	`company_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `hidden_companies_pk` PRIMARY KEY(`user_id`, `company_id`),
	CONSTRAINT `fk_hidden_companies_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_hidden_companies_company_id_companies_id_fk` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `dismissals_user_created_idx` ON `dismissals` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `dismissals_app_idx` ON `dismissals` (`application_id`);