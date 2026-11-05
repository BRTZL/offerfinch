# OpenCode v2 hybrid spike: in-place user data dir (opencode 2.2.5, 2026-11-05)

## Verdict

**The hybrid meets the bar for this user's current DB, but only with four extra steps.** With the API delete alone, it leaves residue.

The four steps:

1. **Pre-prompt config gate**, tested. Abort if `/api/config` carries any document we did not expect.
2. **Own-connection secure scrub** after the server exits.
3. **Stable private root** (cwd and TMPDIR).
4. **`OPENCODE_LOG_LEVEL=ERROR`.**

**Users with a well-known integration in their DB:** the gate refuses the call, and nothing is sent. The app needs a fallback for them: the v2 private root with an API key, or refusing.

**Wire results:**

| Check | Result |
|---|---|
| Tools | 0 |
| User text in the request | none |
| MCP servers or plugins executed | none |
| Credential used | the user's own OAuth credential, in place |

**Production provider checked:** the real-provider wire bodies (`real-zen-1`, `real-zen-2`, `providers.opencode` merged with the org document) match the capture run:

- no `tools` key;
- the same `response_format`;
- the same body keys;
- a system message of 916 and 888 chars, against 867 for capture. The difference is the model-name block.

**Real success path:** still unproven. Both real calls returned upstream 429 `FreeUsageLimitError` (`retry-after` 19975 s and 19844 s, about 5.5 h).

## What OpenCode reads from XDG_DATA_HOME/opencode

**Method.** Read the binary's strings, then tested every file location below.

**Path consumers** (`Global.Path.data`):

- `opencode.db` (and `opencode-<channel>.db`)
- `log/opencode.log`
- `auth.json` (legacy credential import migration; it also imports `wellknown` entries)
- `snapshot/<project>/…`
- `artifacts/`
- `worktree/<project>`
- `tool-output/`
- `shell/<projectId>/`
- `repos/`

**File-based config discovery never reads the data dir.** It reads only the system dir, `XDG_CONFIG_HOME`, `~/.claude`, `~/.agents`, and the project dirs.

**The real vector is the DB.** It can inject config in two ways:

- **`kv` `wellknown:sources` plus a `credential` row for that origin.** OpenCode fetches `<origin>/.well-known/opencode` and its `remote_config`, both at startup. These become config documents: instructions, skills, plugins, MCP, agents and permissions.
- **The `opencode` Console OAuth credential.** It pulls an org integration document from opencode.ai. For this user, that document has `{websearch:{provider:"opencode"}, providers:{opencode:{name, headers:{x-opencode-org-id}, models(42)}}}`. It has no `mcp` and no `policies`.

The user's real DB today:

- `kv` has no wellknown sources.
- `account` and `control_account` are empty.
- `schedule` and `job` are empty.
- There are 7 credentials: opencode OAuth (active) and API key (inactive), anthropic, openai OAuth, xai OAuth, cerebras, zai.

## Leak proof

**Setup:**

- The fake data home (`fakedata/`) copies the real layout.
- Planted files: plugin(s), skill(s), agent(s), command(s), AGENTS.md, opencode.json/jsonc/config.json, `repos/` plugin, `storage/skills`.
- Also planted: old `shell/` and `tool-output/` files, plus a `wellknown` auth.json.
- The DB-borne well-known source was planted as a kv entry plus a credential. Its local server serves a manifest and a `remote_config` with instructions, a plugin, skills, 2 local MCP servers, agent systems, `permissions:allow`, and `auth.command`.

**Results** (capture server):

| run | tools | planted text on wire | executed |
|---|---|---|---|
| fake control (no lockdown), files only | 12 | none | none |
| fake control + well-known | 12 | WK_BUILD_SYSTEM, WK_INSTRUCTIONS, WK_REMOTE_INSTRUCTIONS, WK_SKILL | mcp-WK, mcp-WKREMOTE |
| fake lockdown + well-known | **0** | **WK_INSTRUCTIONS, WK_REMOTE_INSTRUCTIONS** | none |
| fake lockdown + `integration.use` deny | 0 | same 2 | none |
| **real data dir, lockdown** | **0** | **none** (system 850 chars) | none |

**Well-known instructions leak through the lockdown.**

- `instructions` are unioned across documents (`ConfigInstructionPlugin`), so our `instructions:[]` cannot cancel them.
- The `integration.use` deny policy does not stop well-known documents. No env switch exists for this.
- Our agent `system` still wins over a well-known agent system, because our document is loaded last.
- `/api/config` lists every document before any prompt is sent, but shows no `integrationID`, so the gate goes by **shape**. It is implemented in `scripts/hybrid.mjs`.
- **Gate rules:**
  - Our document must carry a per-call nonce in `agents.offerfinch.description`.
  - Our cfg dir is allowed.
  - At most one org document is allowed. Its keys must be within `{providers:{opencode:{name,headers:{x-opencode-org-id},models:{*:{disabled}}}},websearch:{provider},policies(deny only)}`.
  - Anything else is rejected.
- **Gate results:**
  - Planted fake: verdicts `REJECT-doc, REJECT-doc, own-dir, own-doc`. It aborted before creating a session, with **0 upstream requests**.
  - Real data dir: `org-doc, own-dir, own-doc` passed, and the call answered `{"ok":true}`.
- Neither the planted plugin nor `auth.command` executed, even in control.
- Startup cleanup deleted the planted 2026-01-01 files in `tool-output/` and `shell/` (7-day retention).

## Session delete and residue

Delete endpoint: `DELETE /api/session/{sessionID}`. It returns 204. A later GET of the session or its messages returns 404.

| real DB, after API DELETE | small prompt | 14 KB prompt |
|---|---|---|
| logical (`.dump`) | 0 | 0 |
| `-wal` (old frames) | 7 canary hits, 71 sid | 10 hits (8 `_START`, 2 `_END`), 75 sid |
| latest page versions (`.backup`, `strings`) | 0 | **`_END` + filler in freed overflow pages** |
| `opencode.db` / `-shm` | 0 | 0 (until checkpoint) |
| log | 2 lines with sid (404 responses) | same |
| other files | 0 | 0 |

**Fix, tested 5 times on the real DB with the user's service running:**

- Do not call the API DELETE.
- Close stdin, then open our own connection and run:
  - `PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;`
  - `DELETE FROM session_v2 WHERE id=?; DELETE FROM event_sequence WHERE aggregate_id=?; DELETE FROM session WHERE id=?`
  - `PRAGMA wal_checkpoint(TRUNCATE)`
- The script is `scripts/scrub.sh`. It deletes 6 rows per session.
- Result: the checkpoint returned busy=0 every time. db, wal and shm all had 0 hits. `.dump` had 0 hits. Latest pages had 0 hits for all test canaries.

**Rows still left after the scrub:**

- 1 `project` row (the private cwd path).
- 1 `instruction_blob` (the `<env>` block with cwd and tmp path).
- 1 empty `shell/<projectId>/` dir.

None of these holds prompt text. The env blob includes TMPDIR, so cwd **and** TMPDIR must both be stable.

**Stable root test:** two gated runs with the same root changed the `project`/`iblob` counts by +1/+1 on the first run, then +0/+0. `session_v2` stayed at 226.

I removed all of my test rows (9 `project`, 9 blob) and 8 empty `shell/` dirs afterwards.

**Crash recovery:** if the app dies between the prompt and the scrub, the session and its prompt stay in the user's DB and show in their session list. With a stable root, the project id is fixed. At startup, scrub every `session_v2` row for that `project_id`.

**Logs.**

- At INFO, a run appended 3.9 KB (14 lines) with no prompt text.
- With `OPENCODE_LOG_LEVEL=ERROR`, three successful runs appended 0 bytes.
- A failed call still writes an ERROR line ("Failed to drain Session" with the provider error and the session id). The prompt is not in it.
- **This spike left lines in the user's `opencode.log` that can't be removed:**
  - 6 lines with my session ids (4 INFO, 2 ERROR);
  - 72 INFO lines with private-root paths;
  - 0 lines with prompt canaries.

## Real calls (2, through the relay)

**Call 1:** `deepseek-v4.1-flash-free`.
**Call 2:** `big-pickle`.

Both calls:

- forwarded=1, refused=0, no retry;
- Authorization `Bearer` present, not `public`, length 39. That matches the active OAuth row's `access` (39), not the inactive API key (67);
- `x-opencode-org-id` sent;
- upstream 429, so the session failed with `provider.free-limit`.

## Deltas from the v2 recipe

**Env:**

- Set `XDG_DATA_HOME=$HOME/.local/share`.
- Drop `OPENCODE_DB`.
- Add `OPENCODE_LOG_LEVEL=ERROR`.
- Version gate before spawn: run `opencode --version` with a private data home, plus a sha256 allowlist (`abe4d885…`).

**Config:**

- `providers.opencode.settings` gets only `baseURL: relay`. No `apiKey`.
- Optionally, `policies += integration.use deny *`, `allow opencode`, `allow opencode#*`. Real calls still reach upstream with these set.

**Root:** one stable private root for cwd and TMPDIR (for example under the app's support dir).

**Gate before the prompt.** Abort unless `/api/config` contains exactly:

- our document,
- our cfg directory,
- at most one integration document whose keys are a subset of `{providers, websearch, policies}`.

**After the call:** close stdin, then run the scrub above.

**At app start:** run the crash sweep, a secure scrub of the stable project's `session_v2` rows.

**Sandbox:** if used, the profile must allow `~/.local/share/opencode`. This is untested in hybrid.

## Safety

- **Credential row hashes:** identical before and after.
- **DB table counts:** identical to baseline.
- **`kv models-dev:v2:catalog:meta`:** `time_updated` moved from 15:30:15Z to 15:35:15Z. The writer is not identified; this is cache churn.
- **WAL:** truncated to 0 bytes.
- **File snapshot:** 22,732 files in `~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode` and `~/.cache/opencode`, excluding node_modules, the DB and logs. Before and after are identical: 0 diff lines.
- **DB copies:** made by `.backup` to inspect page residue, then deleted.
- **Processes:** none of my spawned processes remain. The user's service, pid 8561, is untouched.

## Open risks

1. **The success path is unproven.**
2. **OAuth refresh write-back is not observed.** The token expires 2026-12-05. A concurrent refresh by our process and the service could race on a rotating refresh token.
3. **The scrub writes directly to the user's DB.** It is coupled to the 2.2.5 schema, and OpenCode's docs say not to edit the DB.
4. **Well-known manifest and `remote_config` are fetched at startup**, even under lockdown. That is network egress outside the relay.
5. **The Console org document can change on the server side.** For example, an org could add remote MCP servers. The gate must re-check it on every call.
6. **Code-derived, untested:** a second server on the shared DB may compete for `schedule:leader`. The user has 0 schedules.
7. **Retention cleanup** can delete the user's week-old `tool-output/` and `shell/` files.
8. **The gate is shape-based.** A malicious well-known document that mimics the org shape could still pass. It could only disable models or add a header for `opencode`; it can't carry text or tools.
9. **Hybrid under `sandbox-exec` is untested.
