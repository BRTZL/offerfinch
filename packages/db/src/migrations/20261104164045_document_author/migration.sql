-- The model that wrote each document version (2026-11-04), so the claims check never runs on
-- the company that wrote a saved draft, even after Drafting changes. Existing rows stay null:
-- they were written when only Anthropic could draft, and core reads null as Anthropic.
ALTER TABLE `documents` ADD `author_provider` text;
