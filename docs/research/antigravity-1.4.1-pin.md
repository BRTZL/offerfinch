# agy-acp-server 1.4.1 pin spike (2026-11-05/06)

## Verdict

**1.4.1 passes the lockdown, with caveats. Login reuse of the user's `agy` sign-in fails, by design.**

- The lockdown recipe from the 1.3.0 spike holds unchanged on 1.4.1:
  - `mcpServers: []` plus `enabledTools: []`, under either the legacy `_meta.agy` or the new `_meta.antigravity`.
  - Private `HOME` and `GEMINI_HOME`, an empty cwd, and no fs or terminal capabilities.
- The 1.4.1 server cannot use the `agy` CLI's Keychain login (`gemini`/`antigravity`). It reads its own account, `gemini`/`antigravity-acp`, and with a private `HOME` it does not use the Keychain at all.
- OfferFinch needs its own sign-in (see "Login reuse").

## 1. Release table (T3 Code bundle, `src/provider/antigravityRelease.ts`, `ANTIGRAVITY_RELEASE_VERSION = "1.4.1"`)

All six entries are version 1.4.1. Base URL is `https://dl.google.com/agy-extensions/releases/`.

| key | url path | sha256 | archive bytes | executable (bytes) | harness (bytes) |
|---|---|---|---|---|---|
| darwin-arm64 | macos/agy-acp-server-1.4.1-darwin-arm64.zip | f9bdd68291ae78c38d2141e63bc86b84e6cc7b9f60f71652c68435a7943deb17 | 112737434 | agy_acp_server.par (280996576) | localharness_external (120246928) |
| darwin-x64 | macos/agy-acp-server-1.4.1-darwin-x86_64.zip | 27e31f096874704f14167b07ef9e84cc77134615ee41d024f7b1c957add85307 | 118349036 | agy_acp_server.par (285186624) | localharness_external (124910048) |
| linux-x64 | linux/agy-acp-server-1.4.1-linux-x86_64.zip | 2e37012ceb2a5c7fc7309b6e6596234fb637ee3c62a5199f65d4cbe777871384 | 336170339 | agy_acp_server.par (930826753) | localharness_external (131187512) |
| linux-arm64 | linux/agy-acp-server-1.4.1-linux-arm64.zip | 609336a1c97545487e3ddd55dbd153dc0f40f4e6534486cc1c5f4c0ebb85c2da | 321922507 | agy_acp_server.par (933416796) | localharness_external (124895000) |
| win32-x64 | windows/agy-acp-server-1.4.1-windows-x86_64.zip | 5f5b7d0328df17c128b2be338d4567b0d24e56ace8196e88794fec37d1372554 | 129599308 | agy_acp_server.exe (86098784) | localharness_external.exe (146036888) |
| win32-arm64 | windows/agy-acp-server-1.4.1-windows-arm64.zip | 24c52bbc12aae20f55eb53d373669412d95a9c44fd59be4ea4e355918b91fbf7 | 132507344 | agy_acp_server.exe (93197744) | localharness_external.exe (136970904) |

- Map keys are `${process.platform}-${process.arch}`. Asset file names use `x86_64`.
- **darwin-arm64 checked:**
  - HTTP 200, 3.0 s.
  - Archive sha256 and size match the table.
  - The zip holds exactly 2 files, and both sizes match.
  - `_version.py` says `1.4.1`.
- T3's installed runtime (`~/.t3/tools/antigravity-acp/darwin-arm64/versions/7cd97045…`) is the older 1.3.0 build, at par 278535456 bytes. So T3 pins 1.4.1 but has not updated its install yet.

## 2. Login reuse without T3

Source (1.4.1, `oauth/credential_store.py` and `ccpa_connection/oauth_manager.py`):

- The Keychain service is `gemini`.
- The account is **`antigravity-acp`** (business: `antigravity-acp-business`). A comment says it is "Distinct from the Antigravity CLI's own 'antigravity' account so this server never clobbers it."
- No migration or import from the CLI exists.
- The Keychain is used only if `security default-keychain` succeeds and a set/get/delete probe (`__acp_probe__<hex>`) passes. Otherwise the server falls back to the file `GEMINI_HOME/antigravity-acp/acp_token.json`.
- The OAuth client ID is the same one the Go CLI uses.

Runs (no `AGY_ACP_FORCE_FILE_STORAGE`, private `GEMINI_HOME` containing only the `oauth-personal` settings, `BROWSER` stub that logs and exits 1):

- **L1, private HOME:**
  - `env -i HOME=<private> security default-keychain` returns "A default keychain could not be found".
  - The server logs "No default macOS keychain; using file credential storage."
  - `authenticate` blocked, and the stub got `https://accounts.google.com/o/oauth2/v2/auth?…client_id=1071006060591-…&redirect_uri=http://127.0.0.1:<port>/`.
  - Killed at 30 s.
- **L2/L3, private HOME plus a symlink `HOME/Library/Keychains` pointing to the real one:**
  - `security default-keychain` now resolves to the login keychain.
  - The Keychain backend was **inferred** to be selected: the source logs only on fallback, and no fallback line appeared. In L3, `login.keychain-db` mtime moved during the run. That fits the probe write, but it is weak evidence, since other apps write that file too.
  - Result: "Credentials missing or invalid. Launching browser login flow…", and the stub hit again.
- **Keychain metadata:**
  - `gemini`/`antigravity` mdat stayed at `20261105142004Z` after both runs.
  - No `antigravity-acp` item was created.
  - No probe item was left.
- **agy afterwards:** `agy models` (agy 1.5.1, run from a neutral dir) listed 13 models, so it still works.
  - Running it moved its own item's mdat to `20261105205535Z`, which is when it ran, after the post-server snapshot. agy also rewrote files under `~/.gemini/antigravity-cli/{builtin,cache,log,…}`.
  - `settings.json` is unchanged.
  - So the server did not log agy out, and could not, because it never touches that account.

**What's needed:**

- OfferFinch should own its sign-in, in file mode (`AGY_ACP_FORCE_FILE_STORAGE=1`) in its own `GEMINI_HOME`, with the BROWSER stub capturing the URL. This is what T3 does.
- Keychain mode is a poor fit:
  - It needs the real HOME's Keychain.
  - `gemini`/`antigravity-acp` is per user, not per `GEMINI_HOME`, so it is shared with every non-forced ACP client.
  - Hybrid `clear()` means a logout anywhere wipes it.
  - Per the source, every spawn writes and deletes a probe item (not observed directly).
- Step 2 of the "Antigravity recipe" in `docs/model-providers.md` is therefore wrong as written. Not edited.

## 3. Lockdown on 1.4.1

Wire captured with a local MITM. Model POSTs go through `AGY_ACP_CCPA_BASE_URL` to the gate. The server ran under `sandbox-exec`, with only localhost reachable.

- **Default (D1):** 15 tools, including a new `run_workflow`. System prompt 16.4k chars.
- **Control (C1, planted `GEMINI_HOME`/HOME/cwd):**
  - 15 tools. Leaked `CANARY_SKILL_DESC_GH` and `CANARY_SKILL_DESC_CWD`.
  - The global `config/hooks.json` PreInvocation hook **executed** (marker `hook-GH-pre-config-hooks.json`).
  - The workspace hook raised a "Do you trust the authors…" permission request, which was cancelled. This is the same as 1.3.0.
- **Locked (C2, D2 `_meta.antigravity`, D3 `_meta.agy`):** no `tools` key, `toolConfig AUTO`, system prompt about 14.4k chars, no canaries, no markers, no permission requests.
- **Injected calls under `enabledTools: []`** (fake backend, replayed 1.4.1 handshake):
  - 15 tools were injected with `_meta.antigravity`: view_file on a canary file in `GEMINI_HOME/antigravity-acp/`, view_file in cwd, run_command, schedule, define_subagent, send_message, manage_task, manage_subagents, invoke_subagent, run_workflow, read_url_content, write_to_file, create_file, ask_question and finish.
  - All 15 were rejected with `unknown_tool`. There were no tool_call updates, no permission requests, no markers, no URL hits, and no file content in the follow-up.
  - 5 more were injected with `_meta.agy` (legacy): all rejected.
  - Each rejection still causes a second model POST. The tool response says "Retries remaining", so the gate cap is needed.
  - **Positive control** (no meta): view_file read the `GEMINI_HOME` canary silently, with no permission request. It is now reported as a `tool_call` update.
- **ACP `mcpServers` with `enabledTools: []` (X1):** the MCP server was spawned and added `call_mcp_tool`, `list_resources` and `read_resource`. `mcpServers: []` is still mandatory.
- **Gate:**
  - `loadCodeAssist` goes direct to prod `cloudcode-pa`.
  - **New in 1.4.1:** `fetchAvailableModels` also goes through the base URL. It carries the bearer token and is needed for model listing.
  - So the recipe's gate (step 4: "forwards one model request … refuses the rest") must also pass `fetchAvailableModels` through to `daily-cloudcode-pa`. Refusing it was not tested.
  - The gate forwarded exactly 1 `streamGenerateContent` per real call, to `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent` (upstream recorded for R2/R3).

### Differences from 1.3.0

1. **Meta namespace.** `_meta.antigravity` is the new name. `_meta.agy` is still read, but only for `enabledTools`/`disabledTools`.
2. **New `run_workflow` tool.** It is offered by default (15 tools) and filtered by `enabledTools: []`.
3. **Model selection.** `configOptions` now has `model` (families) plus a separate `thinking_level` option (see 4).
4. **`systemPrompt.append`.** `_meta.antigravity.systemPrompt: {append: "…"}` adds a `<user_system_instructions>` block at the end. The base prompt cannot be replaced; it is about 14.4k chars locked, vs 11.3k on 1.3.0.
5. **Gate routing.** `fetchAvailableModels` is now routed through the gate.

## 4. Models and effort

- `session/new` returns two lists:
  - `configOptions`: `model` families `gemini-4-argon`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium` (default `gemini-3.8-flash`), plus `thinking_level` `low|medium|high` (default high) and `mode`.
  - Legacy `models.availableModels` (13 slugs, same as `agy models`).
- **Effort is set by a config option.** Set `model` (a family), then `thinking_level`.
- The level persists when the family changes. D6c: `low`, then family `gemini-4-argon`, stays `low`. A new session defaults to `high`.
- Legacy slugs (`gemini-3.8-flash-medium`) are still accepted and set both values (D6c).
- Recommendation: set both values explicitly on every call.
- The wire model is still the slug, e.g. `gemini-4-argon-medium`.
- Listing (spawn to `session/new` result): median 2.6 s, range 2.2–5.5 s over 32 runs. The first, cold run was the slowest.
- `_meta.antigravity.tier` = Google AI Pro (`g1-pro-tier`).

## 5. Real calls (3, gated, `MAX_GEN=1`, `daily-cloudcode-pa`)

| run | model selection | answer | tokens (prompt/out/thought) | prompt time / total |
|---|---|---|---|---|
| R1 | slug `gemini-3.8-flash-low` | `{"ok":true}` | 3751 / 5 / 29 | 2.5 s / 8.0 s |
| R2 | `gemini-4-argon` + `thinking_level low` (wire `gemini-4-argon-low`, modelVersion `gemini-4-argon-trial`) | `{"ok":true}` | 3745 / 9 / – | 4.6 s / 10.0 s |
| R3 | `gemini-3.8-flash-low`, 3-field schema | `{"score":75,"verdict":"maybe","reasons":[…3]}` | 3873 / 53 / 659 | 7.3 s / 13.3 s |

Each run made 1 POST, had no `tools` key, and got 1 `usage_update`.

## 6. Prompted JSON

- R3 parsed and was schema-valid (integer 0–100, enum, 1–3 strings), with no fences.
- This is a single sample, not a reliability rate.

## Risks

1. **Undocumented, moving meta keys.** The namespace already changed between 1.3 and 1.4.
   - Send `_meta.antigravity` (and optionally `agy` too).
   - Keep the tripwires and the gate.
   - Re-run this proof on every pin bump.
2. **Base prompt overhead.** About 3.7k prompt tokens of fixed Antigravity prompt per call, which cannot be replaced.
3. **Retries.** `unknown_tool` and 503s retry, so the gate's 1-POST cap is required.
4. **Data terms.** The free/Pro-tier data terms (human review) are unchanged from the 1.3 spike and still unconfirmed for Pro.
5. **Version drift.** T3's own installed runtime is 1.3.0 while its pin is 1.4.1.
6. **Alternative not tested.** agy 1.5.1 ships its own `agy acp` server, which may use agy's login. Not tested.

## Hygiene

- No leftover processes.
- T3 `acp_token.json` sha256 is unchanged.
- `~/.gemini/antigravity-cli/settings.json` is unchanged.
- `~/.gemini` diffs come only from the `agy models` check (23:55:35). The `~/.t3/caches/antigravity.json` mtime change is T3's own probe (same size).
- All token copies under `runs/` and the MITM keys were deleted.
- A token-pattern scan of `runs/ results/ captures/ snap/ scripts/` was clean; the only hit is the redaction regex in `tooltest.sh`.
- `carve/` was not scanned. It holds the 1.4.1 sources, which embed Google's public OAuth client secret, not a user token.
- Kept in scratch: `dl/` (zip), `bin141/`, `carve/src` (1.4.1 Python sources), `scripts/`, `captures/`, `results/`, `snap/`.
