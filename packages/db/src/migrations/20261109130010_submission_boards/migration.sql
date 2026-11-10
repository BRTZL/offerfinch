CREATE TABLE `submission_boards` (
	`user_id` text NOT NULL,
	`board` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `submission_boards_pk` PRIMARY KEY(`user_id`, `board`),
	CONSTRAINT `fk_submission_boards_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
