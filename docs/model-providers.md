# Model providers: any model for any step

Plan and contract for the change that adds OpenCode and Gemini (through Antigravity), lets each
step use any available model, and removes API keys. Decisions are dated in
[decisions.md](decisions.md) ("Model providers, 2026-11-05"); the wire proofs are in
[research/](research/).

## What the user gets

- Four providers, all on the user's own sign-ins: Claude (Claude Code), Codex, OpenCode, Gemini
  through Antigravity. No API keys anywhere in the app.
- Setup's Connect AI step detects which providers are installed and signed in, lists the models
  they offer, and requires at least one available model to continue (no Skip).
- Settings › Models (design: version A, `docs/design/models/`): one picker per step (Finding
  matches, Drafting, Checking drafts), T3 Code style: search, models grouped by provider (OpenCode
  grouped by billing source: plan groups first, pay-per-use groups labeled), effort in the same
  menu; an Accounts list below with each provider's state and how to fix it.
- Any model can do any step, including the same model for all three. The rule that a draft is
  checked by another company is dropped.

## Providers

| Id | Runs | Login | Billing | Windows |
| --- | --- | --- | --- | --- |
| `claude` | Claude Code through the Agent SDK (unchanged) | the user's Claude Code login | plan | as #128 |
| `codex` | `codex app-server` (unchanged) | the user's Codex login | plan | off, macOS only (#128) |
| `opencode` | `opencode serve --stdio --port 0`, one process per call, v2 HTTP API | the user's OpenCode login, in place (T3 Code's way) | per source: plan or pay-per-use | off, unverified |
| `antigravity` | Google's `agy_acp_server` 1.4.1, ACP over stdio, one process per call | OfferFinch's own Google sign-in (as T3 Code does), kept in its own folder | plan (Google AI Pro/Ultra) | off, unverified |

Gemini CLI is not a provider: Google refuses it for individual accounts
([research/gemini-cli-refused.md](research/gemini-cli-refused.md)).

### Model ids

A stored choice is a model reference `<provider>:<model>`:

- `claude:claude-opus-5-5`, `codex:gpt-6.1-sol`
- `opencode:<source>/<model>`, e.g. `opencode:opencode-go/glm-5.1`, `opencode:opencode/deepseek-v4.1-flash-free`
- `antigravity:<model>`, e.g. `antigravity:gemini-3.8-flash` (effort is a separate field; the
  provider maps it to the runtime's `-low|-medium|-high` slug)

Effort is `low | medium | high | xhigh | max`, offered per model as the provider reports it; a
model without effort levels shows none.

### Billing

- `claude`, `codex`, `antigravity`: `subscription` (unchanged rules: pauses, daily call budget,
  breaker, paid-extra-usage detection where the vendor reports it).
- `opencode`: decided per source. Plan sources (allowlist: `opencode-go`, `zai-coding-plan`, and
  the `*-free` models of `opencode`) are `subscription`; every other source is pay-per-use:
  `billing: "api"`, priced from `opencode models --verbose` before the call, reserved and
  settled under the spending cap. A pay-per-use model without a known price is not offered.
- Pauses, plan usage and the extra-usage confirmation are keyed by vendor string (free text in
  `subscription_pauses.vendor` and `plan_usage.vendor`, no migration). New vendors: `opencode:<source>`
  and `google`.

## Safety bar (same as Claude and Codex)

Every provider call: no tools offered, none of the user's own config or instruction files sent,
nothing of the prompt left on disk, at most one model request per call, version gated. Proven per
provider by an in-repo boundary test that runs the real CLI against a local capture server
(skipped when the CLI is not installed), like `local-llm/test/claude-boundary.test.ts`.

Errors never carry what the model wrote or a provider's error body (both can hold the user's
text, and the spending ledger and workflows keep error messages): fixed words plus bounded facts
(the answer's length, whether it had braces, the schema paths and zod issue codes that failed, a
record key shown as `*`, an HTTP status, an error type or code). See `local-llm/src/answer.ts`.
This holds for every provider: Claude keeps a result's subtype and error count (never its text or
errors), the CLI's schema check by error count and the schema's own missing property names, a
stream or start failure by the error's name; Codex keeps its error kind (`codexErrorInfo`'s tag)
and HTTP status, a JSON-RPC error by its code, item types, event methods, turn statuses and tool
names, and never the app-server's stderr. A name is kept only when it is one of the values the
tested protocol defines (`knownName`: Claude's lists are checked against the SDK's types with
`satisfies`, Codex's come from `codex app-server generate-ts` for the tested version); anything
else is kept as `other`, since an identifier such as `PRIVATE_CV_CANARY` can be the user's text as
well as a sentence can. Pause classification (usage limit, logged out) reads the structured kind,
not the text. Canary tests (sentences and bare identifiers) run each path through `MeteredLlm`
and check the recorded rows and logs.

### OpenCode recipe (2.2.5)

From [research/opencode-v2-lockdown.md](research/opencode-v2-lockdown.md) and
[research/opencode-v2-shared-login.md](research/opencode-v2-shared-login.md):

1. Version gate before `serve` (it opens the user's DB): `opencode --version` with a private data
   home, plus the binary's sha256, against a tested allowlist (`2.2.5`). Refuse anything else.
2. Env from the allowlist; `XDG_DATA_HOME` is the user's real data home (login in place);
   `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `TMPDIR` and cwd in a stable
   private root; all `OPENCODE_DISABLE_*` switches; `OPENCODE_LOG_LEVEL=ERROR`;
   `OPENCODE_CONFIG_CONTENT` with deny-all permissions and policies, empty MCP, plugins, skills and
   instructions, an `offerfinch` agent with our system prompt, updates off, the relay as the
   source's `baseURL`, and the per-call JSON schema as `response_format`. Never `OPENCODE_API_KEY`,
   never `agents.*.steps`.
3. `GET /api/config`: abort unless it holds only our document (per-call nonce), our config dir
   and at most one Console org document of the known shape (a stored well-known integration can
   inject instructions that lockdown does not remove).
4. `POST /api/session`, `POST /api/session/{id}/prompt`, watch `/api/event`; interrupt on the
   first `session.retry.scheduled`. The relay forwards exactly one POST and turns 429/5xx into 400.
   Output limit: the call's reserved `maxTokens` (the cap's own default, 16,000, when unset) goes
   into the model's config `body` as `max_completion_tokens`, which overrides the model's own
   limit that 2.2.5 sends otherwise (32,000 on the tested model; checked on the wire by the
   boundary test). The relay lowers any larger limit field to it, adds it when none is sent, and
   refuses unsent a body that is not a JSON object.
5. After: close stdin (SIGKILL fallback), then on our own SQLite connection to the user's
   `opencode.db`: `foreign_keys=ON; secure_delete=ON`, delete the call's `session_v2`,
   `event_sequence` and legacy `session` rows, `PRAGMA wal_checkpoint(TRUNCATE)`. The same sweep at
   app start for sessions a crash left. Schema-dependent: part of the version gate.
   The checkpoint is finished only when it is not busy and the `-wal` file is empty: while another
   connection (the user's OpenCode) holds a read transaction, the rows are gone but the prompt
   stays in the WAL. An unfinished cleanup leaves a marker in OfferFinch's data folder
   (`<userData>/opencode`, never the temp folder; the private root stays in the temp folder because
   its path is in OpenCode's `<env>` block) holding when it became due, attempts, whether rows may
   be left; no ids, no text. A crash must not lose it: before OpenCode starts, each call writes an
   intent file there (pid and start time; fsync'd, renamed into place, folder fsync'd) and removes
   it only after its scrub finished or the marker was written durably in its place. An intent whose
   process is gone, or older than 30 minutes, is adopted as an unfinished cleanup (rows possibly
   left) at start and on every retry; a live one of another process keeps the sweep to a
   checkpoint. At start, a checkpoint that cannot finish with no marker or intent is marked too
   when OfferFinch's own project is in the database (an older build may have crashed without an
   intent); with no project of OfferFinch's nothing of its calls can be there, so the user's busy
   OpenCode alone never stops calls. The cleanup is retried, sweep and
   checkpoint even with no rows left, on a timer with backoff, before each call and at start;
   while another OfferFinch call runs, only the checkpoint (its session is not swept). After a
   2-minute grace period OpenCode calls are refused (a local `boundary` refusal that does not trip
   the source's breaker) until the cleanup finishes. Once a truncating checkpoint has finished,
   the user's service writing afterwards appends only current page versions, which no longer hold
   the prompt (tested: 20 writes after the cleanup, no canary in db, `-wal` or `-shm`).

### Antigravity recipe (1.4.1)

From [research/antigravity-acp-lockdown.md](research/antigravity-acp-lockdown.md) and
[research/antigravity-1.4.1-pin.md](research/antigravity-1.4.1-pin.md):

1. OfferFinch downloads Google's ACP server release 1.4.1
   (`dl.google.com/agy-extensions/releases/{macos|linux|windows}/agy-acp-server-1.4.1-<os>-<arch>.zip`)
   into its own app-data folder and runs it only if the archive's sha256 and size match the pinned
   table (all six platforms are in the pin report). Every pin bump re-runs the lockdown proof: the
   switches below are undocumented and were renamed between 1.3.0 and 1.4.1.
2. Login: 1.4.1 cannot reuse the `agy` CLI's login (its Keychain entry is separate, with no
   import). OfferFinch signs in once with Google (`authenticate oauth-personal`, the sign-in URL
   opened in the user's browser) in file mode (`AGY_ACP_FORCE_FILE_STORAGE=1`) with a
   `GEMINI_HOME` in OfferFinch's app-data folder that holds only the auth file and
   `{"auth":{"type":"oauth-personal"}}`.
3. Per call: private root (mode 700, per-user temp folder) with an empty cwd, `HOME` and `TMPDIR`;
   the token file copied in (no rotation seen); env from the allowlist.
4. ACP: `initialize` without fs or terminal capabilities; `authenticate oauth-personal`;
   `session/new` with `mcpServers: []` and `_meta.antigravity.enabledTools: []` (ACP MCP servers
   are not filtered, so the list must be empty); set the model family, then `thinking_level`
   (`low | medium | high`, default high); prompt; cancel every permission request, refuse fs and
   terminal requests, kill on any tool call.
5. `AGY_ACP_CCPA_BASE_URL` points at a local gate on the consumer endpoint (`daily-cloudcode-pa`):
   it forwards `fetchAvailableModels` and exactly one model request, checks that request has no
   tools, and refuses the rest (the server retries `unknown_tool` and 503s).
6. No JSON schema over ACP: the answer is prompted as JSON, fences stripped, parsed against the
   schema. About 3.7k tokens of Antigravity's own prompt ride on every call. Delete the private
   root after the call; sweep stale roots at start.

Built in `packages/local-llm/src/antigravity*.ts` and `apps/desktop/src/worker/antigravity.ts`:
the runtime and the sign-in live in `<app data>/antigravity/` (`runtime/1.4.1-<platform>-<arch>/`,
`gemini-home/antigravity-acp/` with only `acp_token.json` and `settings.json`); `ai.install` and
`ai.signIn` (`{ provider: "antigravity" }`) drive them, and main opens only an
`accounts.google.com` page that returns to a loopback port. Model families come from
`session/new` (efforts: the family's `-low|-medium|-high` slugs in the legacy model list; none for a
family without them). Proof: `local-llm/test/antigravity-boundary.test.ts` runs the real server,
opt-in with `OFFERFINCH_AGY_TOKEN=<a signed-in acp_token.json>` and the runtime installed in
`OFFERFINCH_AGY_RUNTIME` (default `$TMPDIR/offerfinch-test-agy-cache`; `OFFERFINCH_AGY_DOWNLOAD=1` downloads it).

## Contract (code)

- `apps/desktop/src/shared/providers.ts`: `ProviderId`, `ModelRef` parse and format, `Effort`,
  provider display names, `PROVIDER_PLATFORMS` (Windows availability).
- Settings `ai` (worker/settings.ts): `{ scoring, tailoring, claims }`, each
  `{ model: ModelRef | null, effort?: Effort }`. Older settings migrate on read: `claude-subscription`
  → `claude:<model or default>`, `codex-subscription` → `codex:<model or default>`, `api` → null
  (the role asks for a model), `fake` stays a test-only `fake:` reference.
- `LocalLlmFactory` input: `{ role, provider: ProviderId, model: string, effort?, ownerUserId }`.
  The worker's subscriptions service gains `opencode` and `antigravity`, and per provider:
  `state(): ProviderState` (installed, version, tested, login, fix) and `models(): ModelInfo[]`
  (`{ ref, name, provider, source?, billing, efforts, price? }`), cached, read in parallel with a
  timeout.
- Removed: `api` mode, `KeyField`, desktop secrets for model keys, the key branches in
  `model-factories.ts`, `unavailable()`, `assertOtherVendor`, the claims-author company rule.
  `AnthropicProvider` and `OpenAiProvider` stay in core only if something outside the desktop
  still imports them.

## Build order

1. Contract commit: providers module, settings schema and migration, provider-agnostic
   factories, API paths and the vendor rule removed, Claude and Codex unchanged in behaviour.
2. In parallel on top of it: OpenCode provider; Antigravity provider; renderer (picker, Models
   page, Connect AI, key removal in main and renderer).
3. Fakes for e2e (`fake-clis.ts`), docs (decisions, README warning, CHANGELOG), Codex review.

## Not verified yet

- A successful real OpenCode call (free-tier limit hit during the spikes).
- OfferFinch's own Antigravity sign-in flow end to end (it reaches Google's page; the return
  from the browser is not exercised).
- Prompted JSON on Antigravity beyond one call.
- Anything on Windows beyond unit tests in CI.
