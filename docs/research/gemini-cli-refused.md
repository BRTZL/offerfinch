# Gemini CLI provider spike (gemini-cli 0.66.0, 2026-11-05)

## Verdict

**Fails for this user, today. The boundary passes with caveats on the capture server.**

- **The account is the blocker.** The user's Google login has no usable Code Assist tier.
  - The real `loadCodeAssist` returns no `currentTier` and no `paidTier`.
  - The free tier is listed as ineligible: `UNSUPPORTED_CLIENT: "This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products"`.
  - The only tier offered is `standard-tier`. It carries `usesGcpTos: true` and `userDefinedCloudaicompanionProject: true`, which means a paid Google Cloud project and licence.
  - The CLI then tries `onboardUser {"tierId":"standard-tier"}`. The test gate refused that call, because it would change the account.
  - No model call was possible, so the 2-call budget went unused.
  - Unconfirmed: whether an account with Google AI Pro/Ultra would still get a tier. Proof would be a `paidTier` id such as `g1-pro-tier`.
- **The boundary itself works.** With the recipe below, the request carries no tools, our system prompt only, and none of the planted text; nothing planted ran. Several CLI defaults resend the prompt or switch models, so extra layers are mandatory.

## Recipe

Q1: headless `gemini -p … --output-format json` is enough. ACP (`--acp`) was not wire-tested.

- **One process per call.** Use a private root `R` (mode 700) under the per-user `os.tmpdir()`, not `/tmp`, which anyone can write to.
- **Pre-create `R/cwd/.gemini/.env` empty.** The `.env` lookup walks up from cwd and stops at the first file. Without this stopper, an ancestor `.gemini/.env` was loaded.
- **Delete `R` afterwards, and sweep stale roots at startup.** The prompt is written to `home/.gemini/tmp/<id>/chats/session-*.jsonl` (chat recording can't be turned off) and to `tmp/gemini-client-error-*.json` after errors.
- **Kill the process group, not just the pid.**

```
cd R/cwd; env -i PATH=… USER LANG TERM=dumb \
  HOME=R/home GEMINI_CLI_HOME=R/home TMPDIR=R/tmp \
  GEMINI_CLI_SYSTEM_SETTINGS_PATH=R/none.json GEMINI_CLI_SYSTEM_DEFAULTS_PATH=R/none.json \
  GEMINI_SYSTEM_MD=R/system.md GEMINI_CLI_NO_RELAUNCH=true \
  GOOGLE_GENAI_USE_GCA=true GOOGLE_CLOUD_ACCESS_TOKEN=<dummy> CODE_ASSIST_ENDPOINT=http://127.0.0.1:<gate> \
  gemini -p "<prompt>" --output-format json -m <pinned model> -e none --allowed-mcp-server-names offerfinch-none
```

**Settings file.** Write `R/home/.gemini/settings.json` from `lockdown-settings.json`. The keys that matter:

- `tools.core: []`
- `skills.enabled: false`, `hooksConfig.enabled: false`
- `experimental.enableAgents: false`, `experimental.autoMemory: false`
- `context.includeDirectoryTree: false`
- `privacy.usageStatisticsEnabled: false`, telemetry off
- `general.maxAttempts: 1`, `general.retryFetchErrors: false`, plan mode off
- `model.disableLoopDetection: true`
- `billing.overageStrategy: "never"`
- `advanced.ignoreLocalEnv: true`
- `mcp.allowed: ["offerfinch-none"]`
- `modelConfigs.customOverrides` for the pinned model: `responseMimeType`, `responseJsonSchema`, `temperature`, `thinkingConfig`

**Gate (`real.mjs`).** A local forwarding gate that:

- injects the real access token (the CLI only ever holds a dummy);
- forwards an allowlist of methods;
- refuses `onboardUser`, metrics and any second generate POST.

**Settings that do nothing (don't count them as protection):**

- `context.fileName`: it only adds names; `GEMINI.md` is always searched.
- Local `admin.*` keys.
- The system-settings tier: it is ignored unless the file is root-owned. The env var only redirects it away from `/Library/Application Support/GeminiCli`.

Correction to the list above: local `admin.*` was not shown to do nothing in general. What was seen is narrower: `admin.mcp.enabled:false` did not stop the workspace MCP server.

## Evidence (captures/<label>/, results/<label>/)

- **control** (planted HOME, no lockdown):
  - Leaks: 2 model POSTs (a flash-lite router call that also carries the prompt), 8 tools (`read_file`, `glob`, `google_web_search`, `invoke_agent`…), global/cwd/includeDir GEMINI.md, `CANARY_MEMORY_GLOBAL`, extension context, 4 skills, the subagent, and the `.env` project.
  - Executed: hooks (3 markers) and 2 MCP servers.
  - Egress: Clearcut telemetry to `play.googleapis.com`.
- **iso-only** (private root, default settings): nothing planted, but still 8 tools and the router call.
- **prod / prod-final:**
  - 1 POST, `tools:[{functionDeclarations:[]}]`.
  - `systemInstruction` is our 79-char file; the user part is `<session_context>` (date, OS, temp path) plus the prompt.
  - No planted text, no markers, no `enabled_credit_types` (even with 1000 capture credits).
  - Only other egress: `www.googleapis.com` (userinfo, token only).
- **Full prod request (Q3).** `systemInstruction` is exactly `OFFERFINCH_SYSTEM_PROMPT: You are a JSON-only assistant. Answer only with JSON.` The user turn is `<session_context>` (`This is the Gemini CLI…`, date, `My operating system is: darwin`, `The project's temporary directory is: R/home/.gemini/tmp/cwd`) followed by the prompt.
- **Gate (gate-429-g3flash).** `gemini-3-flash-preview` with queued 429s:
  - upstream saw 1 POST;
  - the CLI's retry was refused (`007-REFUSED-streamGenerateContent`);
  - exit 144, no model switch, no process left.
  - gate-ok: 1 POST, `{"ok":true}`.
- **prod-plantedcwd:** the cwd GEMINI.md and the workspace MCP server leak; `--allowed-mcp-server-names` stops the MCP server.
- **prod-ancestors2:** the `.env` stopper blocks an ancestor `CODE_ASSIST_ENDPOINT`/`GOOGLE_CLOUD_PROJECT`.
- **Quota 429 on a pinned model:**
  - 2.5 models: 1 POST, exit 173, no fallback.
  - `gemini-3-flash-preview`: 3 POSTs. The built-in policy chain overrides `maxAttempts`; only the gate caps this.
  - Defaults (without `maxAttempts: 1`): 3 POSTs on a 429, ≥7 on a 500.
- **No preview bucket:** a pinned `gemini-3*` model is silently set to `auto`. The result is a classifier call with the prompt, then the answer comes from `gemini-2.5-pro`.
- **Real login:**
  - Token refresh: 200, `new_refresh_token_returned=false`.
  - `loadCodeAssist`: 626 ms. `retrieveUserQuota`: 403 (no project).
  - `~/.gemini`: 2693 files unchanged by mtime and size; `oauth_creds.json` sha256 identical.
  - No prompt canary anywhere outside the spike dir; no process left.

## Answers

- **Q2 Credentials.** `GOOGLE_CLOUD_ACCESS_TOKEN` keeps the token in memory with no refresh token. The token lasts 1 h and the stored one expired on 2026-08-20, so the app has to refresh in memory. That means reading the refresh token, which differs from the Codex rule. Google did not rotate the refresh token. A private copy of `oauth_creds.json` refreshing would write only that copy.
- **Q4 Structured output.** Yes, `responseJsonSchema` reaches the wire. Unconfirmed: whether the real backend accepts it next to the empty `functionDeclarations`.
- **Q5 Models.** The list comes from the `retrieveUserQuota` buckets; preview access means a preview bucket is present. Thinking: 2.5 models use `thinkingBudget` (default 8192), 3.x models use `thinkingLevel` (default HIGH).
- **Q6 Billing.**
  - G1 AI credits (`GOOGLE_ONE_AI`) are spent only when `overageStrategy` is `always` and the balance is ≥50. `consumedCredits` never reaches stdout.
  - `standard-tier` and `GOOGLE_CLOUD_PROJECT` mean GCP billing.
  - Tokens are reported in `stats.models.*.tokens`.
- **Q7 Errors.**
  - Exit codes: quota 429 = 173 (`TerminalQuotaError`/`RetryableQuotaError` on stderr); 500 = 244; 401 = 145 (`Error when talking to Gemini API`); gate-refused retry = 144; refused onboarding = 1.
  - Each error also writes a `gemini-client-error-*.json`, which contains the prompt.
  - Logout or an expired token surfaces as a 401. With the gate holding the token, expiry is a gate-side refresh.
  - Flash fallback: pin a 2.5 model and set `maxAttempts:1`. Gemini 3 also needs the gate.
- **Tripwire.** `stats.models` must list exactly one model with role `main`, equal to the requested one.

## Risks

1. **Account eligibility.** It fails now (above).
2. **Version drift.** `tools.exclude` is deprecated (Policy Engine in 1.0), so pin 0.66.0.
3. **Retries.** Only the gate (wire-tested on the capture server) holds "one POST": the policy chains and the gaxios `requestPost` retries (`retry: 3`) bypass `maxAttempts`.
4. **Silent model swap.** If the account lacks preview access, a Gemini 3 request becomes `auto`.

## Cleanup

The private roots are deleted. The stray `$TMPDIR/gemini-spike-sec` (one settings copy) was removed; it was the only scratch outside `/tmp/gemini-spike`.

## Paths

All in `/tmp/gemini-spike`:

- Scripts: `capture-server.mjs`, `run.sh`, `plant.sh`, `analyze.py`, `real.mjs` (gate), `net-hook.cjs`, `mcp-canary.mjs`, `lockdown-settings.json`, `system.md`
- Output: `captures/`, `results/`, `connects.log`, `schema.txt`
