ALTER TABLE `applications` ADD `announce_ready` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `read_status` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `read_error` text;