ALTER TABLE `jobs` ADD `valid_through` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `closed_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `closed_reason` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `open_checked_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `open_confirmed_at` integer;