-- Plan billing the way T3 Code does it (2026-11-04): a subscription call is never held for an
-- unknown payment. A stop is kept only where a paid row of its vendor (re-labelled `api`) was
-- recorded in the hour before it; any other stop was for an unknown payment, and is lifted.
DELETE FROM `subscription_pauses` WHERE NOT EXISTS (
	SELECT 1 FROM `llm_usage` AS `u`
	WHERE `u`.`user_id` = `subscription_pauses`.`user_id`
		AND `u`.`billing` = 'api'
		AND `u`.`provider` LIKE (CASE `subscription_pauses`.`vendor` WHEN 'openai' THEN 'codex-subscription:%' ELSE 'claude-subscription:%' END)
		AND `u`.`created_at` BETWEEN `subscription_pauses`.`paused_at` - 3600000 AND `subscription_pauses`.`paused_at`
);
--> statement-breakpoint
-- Held or orphaned subscription calls settle on the plan at $0. Paid rows (`api`) and API-key
-- holds stay as they are.
UPDATE `llm_usage` SET
	`status` = 'settled',
	`cost_micros` = 0,
	`settled_at` = `created_at`,
	`price_basis` = 'subscription: included in the user''s plan; settled at $0 when holds for an unknown payment were removed (2026-11-04)'
WHERE `status` = 'reserved' AND `billing` = 'subscription';
