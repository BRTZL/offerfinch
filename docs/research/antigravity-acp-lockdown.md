# Antigravity ACP server spike (agy-acp-server 1.3.0, 2026-11-05)

## Verdict

**Passes with caveats.**

The server can be told to offer zero tools. `session/new` accepts `_meta: {agy: {enabledTools: []}}`:

- With it, the real model request carries **no `tools` key at all**.
- If the model emits a function call anyway, the harness rejects it as `unknown_tool` and runs nothing. This was tested on 9 tools, including `view_file` on the token file, `run_command`, `schedule` and `invoke_subagent`.

A private `GEMINI_HOME` + `HOME` + empty cwd keeps planted skills and hooks out. Both were proven: they leaked or ran in the control run and were absent in the locked run.

Planted rules (`GEMINI.md`/`AGENTS.md` in the cwd, parent and data dir) and `config/mcp_config.json` never appeared even in control, so for those the boundary is unexercised. Rules are injected when the agent opens files, which zero tools prevents.

`enabledTools` does **not** govern MCP tools. An MCP server passed via ACP `mcpServers` was spawned and added `call_mcp_tool`, `list_resources` and `read_resource` despite `enabledTools: []` (`t10-acp-mcp`). So `mcpServers: []` and a `GEMINI_HOME` with no `config/mcp_config.json` or `config/hooks.json` are required, not incidental.

The default config (what T3 runs) **fails** the bar. All 14 tools are offered, and these run with **no** permission request:

- `view_file` inside the allowed roots. The roots include `GEMINI_HOME`, so it read `acp_token.json` (refresh token) into the model context.
- `define_subagent`, `schedule` (it started an extra model turn on its own), `send_message`, `manage_task` and `manage_subagents`.

T3's safety comes from aborting on `tool_call` updates. That arrives after the read has already happened, and `define_subagent`/`schedule` send no `tool_call` update at all. **`enabledTools: []` is mandatory.**

Caveats:

1. The fixed Antigravity agent system prompt (11.3k chars, about 2.9k tokens) can't be replaced.
2. Errors arrive as in-band answer text.
3. A 503 or a generic 429 is resent with backoff.
4. An `unknown_tool` reply triggers one more model POST.
5. Runtime 1.4.x (which T3 pins) is untested.
6. Google's data terms for this tier say human reviewers may read prompts (see Risks).

## Recipe (one call)

Use a private root `R` (0700) under the per-user `os.tmpdir()`, one process per call.

```
R/cwd/              empty, never written
R/home/             HOME (the server writes home/.gemini/antigravity/bin/webm_encoder here even with GEMINI_HOME set)
R/tmp/              TMPDIR (the .par extracts cacerts here)
R/gh/antigravity-acp/acp_token.json   copy of OfferFinch's own login (0600)
R/gh/antigravity-acp/settings.json    {"auth":{"type":"oauth-personal"}}
```

Spawn with `cwd=R/cwd`, a process group of its own (`detached`), and no args on macOS (T3 adds `--uid=` on Linux only):

```
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin USER LANG HOME=R/home TMPDIR=R/tmp/ \
  GEMINI_HOME=R/gh AGY_ACP_FORCE_FILE_STORAGE=1 \
  ANTIGRAVITY_HARNESS_PATH=<dir>/localharness_external PYTHONUNBUFFERED=1 BROWSER=<stub> \
  [AGY_ACP_CCPA_BASE_URL=http://127.0.0.1:<gate>]   # optional one-POST gate, see Q7
  <dir>/agy_acp_server.par
```

- `AGY_ACP_FORCE_FILE_STORAGE=1` is required. Without it the token goes to the macOS Keychain under service `"gemini"`, which every instance shares.

JSON-RPC over stdio (newline-delimited):

1. `initialize {protocolVersion:1, clientInfo:{name:"zed",version:"0.0.0"}, clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}}`
2. `authenticate {methodId:"oauth-personal"}`. Check first that the token file exists; when logged out this call hangs on a browser sign-in.
3. `session/new {cwd:R/cwd, mcpServers:[], _meta:{agy:{enabledTools:[]}}}`
4. `session/set_mode {sessionId, modeId:"default"}`
5. `session/set_config_option {sessionId, configId:"model", value:"gemini-3.8-flash-low"}`
6. `session/prompt {sessionId, prompt:[{type:"text",text}]}`. Collect `agent_message_chunk` text until the result `{stopReason:"end_turn"}`. Never send exactly `/logout`, which is a built-in logout command.

Client handlers:

- `session/request_permission` replies `{outcome:{outcome:"cancelled"}}`.
- Any `fs/*`, `terminal/*` or other request gets `-32601`.
- Any `tool_call`/`tool_call_update`/permission request is a hard fail: kill the group.
- More than 1 `usage_update` means a second turn: fail. This catches only `unknown_tool` and `schedule` re-turns. `usage_update` arrives only on success, so the 503 and 429 resends (up to 6 POSTs) emit none. Only the `AGY_ACP_CCPA_BASE_URL` gate (Q7) enforces one POST. It is **required** if the bar is "one POST per call"; otherwise set a hard 60–90 s kill timeout.

Afterwards, kill the process group and `rm -rf R`. The prompt sits in `gh/antigravity-acp/brain/<id>/…/transcript*.jsonl` and `conversations/<id>.db`.

Timings, real flash-low call: init 2.1 s, auth 1.3 s, `session/new` 1.2 s, set model 0.6 s, prompt 13.5 s; 18.7 s total.

## Evidence (captures/<label>, results/<label>)

The model requests were captured on the wire by a local TLS MITM. The proxy was trusted via `HTTPLIB2_CA_CERTS`/`REQUESTS_CA_BUNDLE`, and the server ran under `sandbox-exec` with only localhost reachable.

**Control** (`t04-control-refused`, planted `GEMINI_HOME` + cwd):
- 14 tools; system prompt 15.0k chars.
- Planted skill descriptions leaked: `CANARY_SKILL_DESC_GH`, `CANARY_SKILL_DESC_CWD`.
- The global `GEMINI_HOME/config/hooks.json` hook **executed** (marker file, no prompt). The workspace hooks asked "Do you trust the authors…" and the denial held.

**Planted HOME, private `GEMINI_HOME`** (`t06-half-refused`): no canaries. `~/.gemini` is ignored once `GEMINI_HOME` is set.

**Locked** (`t05-locked-refused`): no canaries, but still 14 tools.

**Locked + `enabledTools:[]`** (`t08-enabled-empty`, `R3-flash-low-daily`):
- The request has no `tools` key, only `toolConfig AUTO`.
- The system prompt is Antigravity's own (`<identity>`, `<user_information>` with the R paths, `<artifacts>`, `<guidelines>`…).
- The user turn is `<USER_REQUEST>` + prompt + local time.
- No canaries.

**Tool matrix, default config** (`tt-*`, fake backend):

| Tool | Permission asked? | Outcome |
|---|---|---|
| `view_file` in cwd | no | read; `CANARY_INSIDE_CWD_4410` sent to the model |
| `view_file` on `acp_token.json` | no | read; refresh token sent to the model |
| `view_file` outside the roots | no | silently denied by the harness; no `tool_call` update |
| `define_subagent`, `send_message`, `manage_task`, `manage_subagents` | no | ran |
| `schedule` | no | ran, then fired a 3rd model POST |
| `run_command`, `write_to_file`, `replace_file_content`, `read_url_content`, `search_web`, `generate_image`, `ask_question` | yes | denied; no marker, no URL hit |

**Global PreToolUse deny hook** (`tt-L-*`): blocks `view_file`, `run_command`, `read_url_content` and `ask_question`. It does **not** block `define_subagent`, `schedule`, `send_message` or `manage_task`.

**`enabledTools:[]`** (`tt-M-*`): all 9 injected calls failed with `unknown_tool`; no permission request, no markers.

**Real call** (`R3-flash-low-daily`):
- Answer: `{"ok":true}`.
- 1 POST to `daily-cloudcode-pa`.
- usage: prompt 2876, output 5, thoughts 1209, total 4090.
- `modelVersion gemini-3.8-flash-n`.

**Egress.**
- `sandbox-exec` does not log denials (a positive-control curl showed nothing), so the sandboxed runs prove nothing about direct connections.
- Unsandboxed fake-backend run (`t11-egress`), `lsof` sampled every 250 ms: only localhost sockets (gate, server↔harness websocket, a local listener). External hosts, all via the proxy: `oauth2.googleapis.com` and `cloudcode-pa.googleapis.com`; on a real call, model POSTs went to `daily-cloudcode-pa`.
- `telemetry.py` is the BAIC (Enterprise) client.
- Sub-250 ms direct connections cannot be ruled out.
- Neither binary reads `ANTIGRAVITY_DATA_DIR`; it is a T3-side name.

**User files:**
- `snap.sh` shows `~/.gemini` and `~/.t3` unchanged by size and mtime. The only diff is T3's own `caches/antigravity.json` mtime (T3's periodic probe; size identical).
- T3's `acp_token.json` sha256 is identical before and after.
- No leftover processes.
- The real prompt phrase was not found in `DARWIN_USER_TEMP_DIR`/`DARWIN_USER_CACHE_DIR`, `~/Library/{Caches,Logs}`, `~/.gemini` or `~/.t3`.

## Answers

- **Q2 Login.** It is `GEMINI_HOME/antigravity-acp/acp_token.json` (client_id, client_secret, refresh_token, project_id) when file storage is forced.
  - Each `authenticate` refreshes the token and rewrites this file (`os.replace`), but the content was byte-identical every time (no rotation).
  - A copied token therefore never stales the source. OfferFinch should still own its sign-in (BROWSER stub that captures the URL, loopback redirect), like T3 does.
- **Q4 Structured output.** There is no schema option over ACP: `generationConfig` is only `maxOutputTokens`, and no `_meta` key exists for it. So: prompt, strip code fences, parse.
  - The one real call returned exact JSON.
  - The system prompt asks for "github-style markdown", so expect fences.
  - Error text also lands in the answer, so a parse failure must be treated as an error.
- **Q5 Models.** They come from `session/new` → `configOptions[id=model]`: `gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, Claude Opus/Sonnet 5.5 at three levels, and `gpt-oss-120b-medium`.
  - Default model: `gemini-3.8-flash-high`.
  - Effort is in the slug on 1.3. T3's code says 1.4 lists families plus a `thought_level` option and still accepts the old slugs (unverified).
  - Spawn to model list takes 3.5–5 s.
  - `fetchAvailableModels` also returns per-model `quotaInfo` (Argon resets weekly, Flash every 5 h).
- **Q6 Billing.** `loadCodeAssist` returns `currentTier free-tier` and `paidTier g1-pro-tier` ("Google AI Pro").
  - Project `aicode-consumers`; endpoint `daily-cloudcode-pa`.
  - No credit or overage fields in the request or response (no `enabledCreditTypes`).
  - Tokens are in the wire `usageMetadata`. ACP only sends `usage_update {used,size}`.
- **Q7 Errors** (fake backend, plus 2 real 429s):
  - All errors come back as `agent_message_chunk` text with `stopReason: end_turn`.
  - `QUOTA_EXHAUSTED`: "Usage Limit Reached … reset in 4 hours, 12 minutes", 1 POST.
  - 500/401/403/capacity-429: the backend message, 1 POST.
  - 503: 6 POSTs at 4/7/14/30/57 s.
  - Generic real 429: resent after 4 s.
  - Never a model switch (that only exists on `oauth-business`).
  - Logged out: `authenticate` blocks and calls `BROWSER <google auth URL>`. `-32000 Onboarding failed` was seen once, in runs where the token copy failed; the cause is inferred, not confirmed.
  - `AGY_ACP_CCPA_BASE_URL` redirects only the model POSTs (`loadCodeAssist` still goes direct). A local gate could therefore cap POSTs at 1 and check "no `tools`, right model" before forwarding to the tier endpoint (`daily-cloudcode-pa` for consumer tiers). This forwarding was wire-proven in R3.

## Risks

1. **Data terms.** The free-tier privacyNotice says prompts may be read by human reviewers and used for training. Unconfirmed whether the Pro tier's terms differ. Job and profile data would go there.
2. **Version drift.** The `enabledTools` meta key is undocumented. Pin the release, and keep the tripwires and an optional deny hook as a second layer.
3. **Cost.** About 2.9k prompt tokens of Antigravity system prompt on every call. "Low" still spent 1.2k thinking tokens.
4. **Exposure from this spike.** The `view_file` token test printed T3's refresh token into this agent's transcript (local only, the fake backend was localhost). To rotate it, revoke "Antigravity" at myaccount.google.com/permissions and sign in to Antigravity again in T3.
5. **Not this spike.** `~/.gemini/antigravity-cli/settings.json` changed at 17:22, before this spike started (likely the cancelled `agy -p` attempt). It now lists this worktree in `trustedWorkspaces`. Left untouched.

## Real calls

There were 3. R1 and R2 got 429 because my gate forwarded to prod `cloudcode-pa` instead of the tier's `daily-cloudcode-pa` (my bug; no tokens generated). R3 succeeded.

## Paths

Everything is in `/tmp/agy-acp-spike`:

- **Scripts** (`scripts/`):
  - `client.mjs` (ACP client), `run.sh` (private root, env, sandbox), `gate.mjs` (MITM capture, gate, fake backend), `plant.sh`
  - `tooltest.sh`, `tool-batch.sh`, `lock-batch.sh`, `meta-batch.sh`, `err-batch.sh`, `refused-batch.sh`
  - `mkscript.mjs`, `deny-hook.sh`, `mcp-canary.mjs`, `urlcanary.mjs`, `analyze.py`, `net-deny.sb`
- **Data:** `captures/`, `results/`, `runs/` (token copies deleted), `snap.sh`, `snap-before.txt`, `snap-after.txt`, `token-sha-before.txt`, `t3-slice.js` (T3 adapter excerpt)
- **Binaries:** `bin/` (copies of T3's 1.3.0 install)
