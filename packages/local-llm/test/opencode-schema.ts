/** The 2.2.5 tables the scrub touches, with their foreign keys, as OpenCode creates them. */
export const OPENCODE_SCHEMA = `
CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text NOT NULL DEFAULT '[]', time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0);
CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL DEFAULT '', directory text NOT NULL DEFAULT '', title text, version text NOT NULL DEFAULT '2.2.5', time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0,
  CONSTRAINT fk_project FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0, data text NOT NULL,
  CONSTRAINT fk_sm FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
CREATE TABLE session_part (message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL, type text NOT NULL, time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0, data text NOT NULL,
  PRIMARY KEY (message_id, ordinal),
  CONSTRAINT fk_sp_m FOREIGN KEY (message_id) REFERENCES session_message(id) ON DELETE CASCADE,
  CONSTRAINT fk_sp_s FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
CREATE TABLE session_inbox (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, payload text NOT NULL, delivery text NOT NULL, enqueued_seq integer NOT NULL, time_created integer NOT NULL DEFAULT 0,
  CONSTRAINT fk_si FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL, created integer NOT NULL DEFAULT 0,
  CONSTRAINT fk_ev FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE);
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL DEFAULT '', directory text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '', version text NOT NULL DEFAULT '', time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0,
  CONSTRAINT fk_s FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0, data text NOT NULL,
  CONSTRAINT fk_m FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE);
CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL);
`;
