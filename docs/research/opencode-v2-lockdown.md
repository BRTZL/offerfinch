# OpenCode v2 provider spike (opencode 2.2.5, 2026-11-05)

Verdict: **passes with caveats.** The no-tools, no-user-config and no-persistence bar holds on the wire with a new v2 recipe. Caveats:

- **The real success path is unproven.** All 4 real calls (all $0) returned upstream 429 `FreeUsageLimitError` on the anonymous free tier.
- **No valid key exists.** The stored Zen and Go API keys both answer `401 api_key_expired`, so no Go call was made.
- **The user's re-login is OAuth.** It created an OAuth device credential on integration `opencode`, not a Go API key, and OAuth stays excluded.
- **The relay is mandatory.** The session path retries 429/5xx, and `generate/text` retries 429.

Nothing of the 1.x HTTP recipe survives (`POST /session` now gives 405). The env and config layer had to be rebuilt.

## 1. What changed in v2, mapped from the 1.x recipe

| 1.x element | v2 |
|---|---|
| `serve --pure` | Gone. Use `serve --stdio --port 0`. It still serves HTTP on TCP, but prints `{"url":"http://127.0.0.1:<port>"}` on stdout and **exits when stdin closes** (`exitedOnStdinClose: true` in every run). Without `--port`, it binds a **fixed 4096**. `--port 0` gives a random port (56066, 56074). It is not JSON-RPC (that is `opencode acp`). |
| `OPENCODE_SERVER_PASSWORD` | Kept. `OPENCODE_PASSWORD` is also accepted. In stdio mode the server deletes the password from its env, so children do not see it. Unauthenticated `GET /api/session` gives 401. |
| `OPENCODE_CONFIG_CONTENT` | Kept, but the schema is new (v2 config below). 1.x-format files are still read (`compatibility` plugin): the control loaded both the 1.x `mcp.canaryv1` and the 1.x instructions. |
| `OPENCODE_AUTH_CONTENT` | **Gone.** Credentials now live in the SQLite `credential` table. Replacement: `providers.<id>.settings.apiKey` in `OPENCODE_CONFIG_CONTENT`. |
| `OPENCODE_DB=:memory:` | Kept, and it also skips `opencode-next.db`. |
| `OPENCODE_DISABLE_PROJECT_CONFIG`, `_CLAUDE_CODE`, `_AUTOUPDATE`, `_MODELS_FETCH` | Kept. New: `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`, `OPENCODE_CONFIG_PROJECT_DISABLE` (alias), `OPENCODE_DISABLE_FILEWATCHER`, `OPENCODE_CONFIG_DIR`. |
| `_EXTERNAL_SKILLS`, `_DEFAULT_PLUGINS`, `_SHARE`, `_LSP_DOWNLOAD`, `_AUTOCOMPACT`, `_PRUNE`, `OPENCODE_TEST_MANAGED_CONFIG_DIR` | **Gone.** Config keys (`policies`, `share`, `compaction.auto`) and HOME/XDG isolation cover them. The managed plist (`/Library/Managed Preferences/<user>/ai.opencode.managed.plist`) and the system dir (`/Library/Application Support/opencode`) are **not redirectable**. Both are absent on this Mac, and sandbox-exec denies them. `~/.agents` is always read, so HOME must be private. |
| `POST /session` + `/session/{id}/message` with `tools`, `format`, `agent`, `model` | **Gone.** Now `POST /api/session {title, agent, model:{id,providerID,variant}, permissions, location}`, then `POST /api/session/{id}/prompt {text}`, which returns an inbox item. The answer comes from `/api/event` or `GET /api/session/{id}/message`. There is no per-message tools map and no `format`. |
| New | `POST /api/experimental/generate/text {prompt, model}` returns `{"data":{"text":...}}`. It has **no system prompt, no tools, no session**, and no token or cost info. |
| `format: json_schema` / StructuredOutput tool | **Gone.** Replacement: `providers.<id>.models.<m>.body.response_format` (or `providers.<id>.body`), which goes on the wire as native `response_format: {type:"json_schema",...}`. Agent `request.body` is **not** sent. |
| `variant` | `model.variant` on the session or generate call. Built-in models carry their own variants. A custom model needs `capabilities.reasoning.supported` and `variants:[{id,body}]`. Test: `variant:"low"` gives `reasoning_effort:"low"` on the wire. |
| abort | `POST /api/session/{id}/interrupt` gives `session.execution.interrupted`. |
| Events | `session.retry.scheduled`, `session.step.ended {tokens,cost}`, `session.usage.updated`, `session.execution.{succeeded,failed,interrupted}`. |

## 2. Leak proof (capture server, cwd = planted `fakehome/work/proj`)

Plants, in both 1.x and v2 formats:

- AGENTS.md and CLAUDE.md: global, `~/.claude`, `~/.agents`, above cwd, cwd.
- Instructions files.
- 6 plugin dirs plus an explicit plugin.
- 3 MCP servers.
- Skills in 8 places.
- Agent and command markdown.
- Agent `system` entries in JSON.

| run | POSTs | tools | planted text | executed |
|---|---|---|---|---|
| control (no lockdown) | 1 | 12: edit glob grep question read shell skill subagent webfetch websearch write execute | CFG_AGENTS, CWD_AGENTS, INSTRUCTIONS_FILE, INSTRUCTIONS_FILE_V1, DOTAGENT, all 6 skill canaries | 3 MCP + 6 plugins |
| control-generate | 1 | 0 | none (no system prompt) | 3 MCP + 6 plugins |
| layer-session-perm | 1 | 0 | instructions and AGENTS | all |
| layer-agent-deny | 1 | **1 (`skill`)** | instructions | all |
| layer-policy (`tool.use` etc. deny) | 1 | **12** | instructions | none |
| layer-isolation | 1 | 12 | none | none |
| **prod** | **1** | **0** | **none** | **none** (0 child spawns) |
| prod under sandbox-exec (deny $HOME except the binary, deny non-localhost network) | 1 | 0 | none | none |

- **Each layer alone is insufficient.** The policy `tool.use` deny does not strip tools. Agent deny alone leaves `skill`. Session `permissions` deny gives 0 tools but still leaks text and executes plugins.
- **Prod system prompt** is our prompt plus:
  - a "# Your Model" block,
  - the date,
  - an `<env>` block (cwd, the private tmp path),
  - one line suggesting `execute` / `tools.opencode.session_move` (boilerplate; no tool is offered).
- **Do not set `agents.*.steps`.** `steps:1` injects an assistant message: "CRITICAL - MAXIMUM STEPS REACHED".
- **Headers sent upstream:** `x-opencode-session`, `x-opencode-project`, `x-session-affinity`, UA `opencode/latest/2.2.5/cli`.
- **Persistence:**
  - With `:memory:`, R holds only `data/opencode/log/opencode.log` and Bun's `tmp/*.dylib`, and neither contains the canary.
  - Without it, the canary lands in R's `opencode.db`.
  - The user's DB copy has 0 canary hits, and the credential rows hash is identical before and after (3703bbc4…).
  - User files: see section 7.

## 3. Structured output, effort, retry

- Schema per request via the model `body.response_format`, which is in the wire body on both paths (one process per call, so one schema per call). The app must still validate the JSON.
- **Session path:**
  - 500 or 429 leads to `session.retry.scheduled` and a second POST.
  - Interrupt on the first retry event gives 1 POST, 6 of 6 times, including with `retry-after-ms: 0`.
  - 401 gives `session.execution.failed {type:"provider.auth"}` with no retry.
- **generate/text:**
  - 500 gives one POST and HTTP 502 `ProviderRequestError`.
  - **429 is retried: 4 POSTs**, and there is no handle to interrupt it.
- **Relay (`scripts/relay.mjs`, used as `settings.baseURL`):**
  - Forwards one POST and refuses later ones with 400.
  - Maps upstream 429/5xx to 400.
  - Real 429 calls gave forwarded=1, refused=0, and no retry.
  - The relay is required.

## 4. Credentials

- In-memory keys work: `providers.opencode.settings.apiKey` and `providers.opencode-go.settings.apiKey` reach the wire as `Authorization: Bearer <key>`.
- The Go provider is enabled only with a key (30 models).
- **Free models need no key:** the built-in `apiKey:"public"`, at `https://opencode.ai/inference/openai/v1`.
- Avoid `OPENCODE_API_KEY`, which both integrations claim.
- **The user's state:**
  - The DB `credential` table has `opencode` OAuth (device, active, expires 2026-12-05). This is the re-login.
  - It also has the old `opencode` key, which is expired.
  - There is no `opencode-go` row.
  - auth.json is unchanged since Aug 25. Its `opencode-go` key is expired.
  - OAuth refresh would write into the private DB (inferred from code and 1.x behaviour, not observed on v2), so it stays excluded.

## 5. Real calls (4, all free, through the relay)

| label | path | model | upstream | result |
|---|---|---|---|---|
| zen-flash-prompt | session | opencode/deepseek-v4.1-flash-free (`/zen/v1`) | 429 | `provider.free-limit` "Free usage limit reached…" |
| zen-flash-generate | generate | the same (`/inference/openai/v1`) | 429, `retry-after: 32682` | 502 `ProviderRequestError reason:"rate_limit"` |
| zen-pickle-prompt | session | opencode/big-pickle | 429 | same |
| zen-flash-prompt-hdrs | session | deepseek-v4.1-flash-free, relay now forwards all OpenCode headers (x-opencode-*, x-session-affinity, traceparent) | 429, `retry-after: 32406` (~9 h) | same, so the limit is upstream (anonymous free tier exhausted for this client/IP), not caused by the relay |

- `opencode/crouton-alpha-free` is not in the v2 catalog. It is only `kilo` `stealth/crouton-alpha`.
- The success event shape (from capture):
  - `session.step.ended {finish:"stop", tokens:{input:11,output:3,reasoning:0,cache:{read:0,write:0}}, cost:0}`,
  - then a message `{type:"assistant", content:[{type:"text",text:"{\"ok\":true}"}], tokens, cost}`.

## 6. Version drift

- `OPENCODE_DISABLE_AUTOUPDATE=1` stops updates in our process.
- (Code-derived, not tested:) the updater reads `~/.config/opencode/{config.json,opencode.json,opencode.jsonc}` key `update` (`disable`, `notify`, `auto`) or the 1.x `autoupdate`. The v2 default is `notify` (not confirmed that `notify` never installs).
- The user's TUI and service share the binary, so the app can't stop them updating it. **Recommendation:**
  - after the `{"url"}` line, `GET /api/info` and refuse unless `version` is in a tested allowlist (now `2.2.5`), optionally also checking the binary sha256;
  - suggest the user set `"update":"disable"`.


## Recipe (v2.2.5)

Use the **session path**. It is the only one with a system-prompt slot, token and cost events, and interrupt. `generate/text` has none of those and still retries 429. The whole `/api` surface calls itself "Experimental HttpApi", so the version gate is mandatory.

**Process.** One per call: `~/.opencode/bin/opencode serve --stdio --port 0`.

- Spawn it with `stdio: [pipe, pipe, pipe]` and keep stdin open.
- cwd is an empty private dir with a neutral path, because the `<env>` block reveals it.
- Pre-create `R/cfg/opencode` with mode 0555.
- When done, close stdin. SIGKILL after 1 s as a fallback.
- Recommended outer layer: `sandbox-exec` with this profile. The call works with all of it denied.

```
(version 1)(allow default)
(deny file-read* file-write* (subpath "$HOME"))(allow file-read* (subpath "$HOME/.opencode/bin"))(allow file-read-metadata (literal "$HOME"))
(deny file-read* (subpath "/Library/Managed Preferences"))(deny file-read* (subpath "/Library/Application Support/opencode"))
(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))
```

**Env.** Use `env -i` with this allowlist only:

```
PATH=/usr/bin:/bin HOME=R/home USER=$USER TMPDIR=R/tmp
XDG_CONFIG_HOME=R/cfg XDG_DATA_HOME=R/data XDG_STATE_HOME=R/state XDG_CACHE_HOME=R/cache
OPENCODE_PASSWORD=<random 32 bytes>        # removed from the server env in stdio mode
OPENCODE_DB=:memory:
OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1
OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_FILEWATCHER=1
OPENCODE_CONFIG_CONTENT=<config below>
```

Never set `OPENCODE_API_KEY`.

**`OPENCODE_CONFIG_CONTENT`.** `<pid>` is `opencode` or `opencode-go`. `<key>` is `"public"` for anonymous free models, or the user's API key (an `api` key only, never OAuth).

```json
{"$schema":"https://opencode.ai/v2/config.json",
 "update":"disable","share":"disabled","snapshots":false,"warming":false,"compaction":{"auto":false},
 "instructions":[],"skills":[],"plugins":[],"references":{},"commands":{},"mcp":{"servers":{}},
 "providers":{"<pid>":{"settings":{"baseURL":"http://127.0.0.1:<relayPort>","apiKey":"<key>"},
   "models":{"<model>":{"body":{"response_format":{"type":"json_schema","json_schema":{"name":"out","strict":true,"schema":{...}}}}}}}},
 "model":"<pid>/<model>","default_agent":"offerfinch",
 "permissions":[{"action":"*","resource":"*","effect":"deny"}],
 "policies":[{"action":"tool.use","resource":"*","effect":"deny"},{"action":"mcp.use","resource":"*","effect":"deny"},
   {"action":"skill.use","resource":"*","effect":"deny"},{"action":"plugin.use","resource":"*","effect":"deny"},
   {"action":"integration.connect","resource":"*","effect":"deny"}],
 "agents":{"offerfinch":{"mode":"primary","system":"<our system prompt>","permissions":[{"action":"*","resource":"*","effect":"deny"}]}}}
```

Do not set `agents.*.steps`.

**HTTP.** Basic auth `opencode:<password>` on every request.

1. Read stdout until the line `{"url":"http://127.0.0.1:<port>"}`.
2. Call `GET /api/info`. Refuse unless `version` is in the tested allowlist (`2.2.5`).
3. Open `GET /api/event` (SSE) and keep it open.
4. `POST /api/session` with this body:
   `{"title":"offerfinch","agent":"offerfinch","model":{"id":"<model>","providerID":"<pid>","variant":"low"},"permissions":[{"action":"*","resource":"*","effect":"deny"}],"location":{"directory":"<cwd>"}}`
   The session id is in `data.id`.
5. `POST /api/session/{id}/prompt` with `{"text":"<prompt>"}`. It returns the inbox item.
6. On the first `session.retry.scheduled` event, call `POST /api/session/{id}/interrupt` and fail the call.
7. Wait for `session.execution.succeeded` or `session.execution.failed`. The failure carries `{type:"provider.auth"|"provider.free-limit"|"provider.go-limit"|...,status,response.body}`.
8. `GET /api/session/{id}/message`. The assistant entry has `content[].text`, `tokens` and `cost`. Validate the JSON in the app.
9. Close stdin, then SIGKILL as a fallback. Delete R.

**Relay contract.** This is `scripts/relay.mjs`, in the app process, on a random localhost port.

- It accepts only `POST …/chat/completions`.
- It forwards exactly one request to `https://opencode.ai/inference/openai/v1` (Zen) or `https://opencode.ai/inference/go/openai/v1` (Go). It forwards all request headers except host, connection, content-length, accept-encoding, transfer-encoding and keep-alive.
- It streams the response back.
- It maps an upstream 429 or 5xx to 400, which OpenCode does not retry.
- It answers every later POST with 400.
- It records the raw upstream status and `retry-after` for the app's error mapping.

## 7. User files

`scripts/snapshot.sh` recorded the sha256, mtime and size of every file under `~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode` and `~/.cache/opencode`. It skipped node_modules, the live DB and the logs. The before and after snapshots match on all **22,732 files**, with 0 diff lines (`snapshot-diff.txt`). That includes `auth.json`, `opencode.json` and `service.json`.

Other checks:
- The user's DB was copied before and after (copies deleted after the check, since they hold credentials). Both copies have 0 `PROMPT_CANARY_` or planted-canary hits, and the same credential-row hash.
- `grep -r` over all four dirs (minus `bin` and the DB) finds no canaries.

## Paths

All paths are under /tmp/opencode-v2-spike.

Scripts:
- `scripts/lib.mjs`: private root, `serve --stdio` launcher, SSE.
- `scripts/run-v2.mjs`: capture variants.
- `scripts/plant-v2.sh`: fake home with 1.x and v2 plants.
- `scripts/capture-server.mjs`
- `scripts/mcp-canary.mjs`
- `scripts/analyze-v2.py`
- `scripts/relay.mjs`: the single-request relay.
- `scripts/real.mjs`: real calls.
- `scripts/inspect.mjs`
- `scripts/port0.mjs`
- `scripts/preflight.mjs` and `scripts/preflight-zen.mjs`: key checks, status only.
- `scripts/snapshot.sh`

Outputs:
- `captures/<variant>/`
- `results/<variant>/{summary,events,messages,lists}.json`
- `results/real-*/{response,events,relay}.json`
- `openapi.json`: v2, 138 paths.
- `inspect/*/`
- `snapshot-{before,after,diff}.txt`
