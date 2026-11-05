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
| `antigravity` | Google's `agy_acp_server`, ACP over stdio, one process per call | the user's `agy` login (shared Keychain entry), in place | plan (Google AI Pro/Ultra) | off, unverified |

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
5. After: close stdin (SIGKILL fallback), then on our own SQLite connection to the user's
   `opencode.db`: `foreign_keys=ON; secure_delete=ON`, delete the call's `session_v2`,
   `event_sequence` and legacy `session` rows, `PRAGMA wal_checkpoint(TRUNCATE)`. The same sweep at
   app start for sessions a crash left. Schema-dependent: part of the version gate.

### Antigravity recipe

From [research/antigravity-acp-lockdown.md](research/antigravity-acp-lockdown.md):

1. OfferFinch downloads Google's ACP server release (as T3 Code does) into its own app-data
   folder and runs it only if the archive's sha256 matches the pinned release. The lockdown proof
   is re-run on exactly that release before it is enabled.
2. Private root per call (mode 700, per-user temp folder): empty cwd, `HOME`, `TMPDIR`,
   `GEMINI_HOME` with only `{"auth":{"type":"oauth-personal"}}`; no forced file storage, so the
   server uses the user's shared `agy` Keychain login (to be proven on the pinned release; if it
   rotates or needs a copy, fall back to an OfferFinch sign-in in its own `GEMINI_HOME`).
3. ACP: `initialize` without fs or terminal capabilities; `authenticate oauth-personal`;
   `session/new` with `mcpServers: []` and `_meta.agy.enabledTools: []`; set the model; prompt;
   cancel every permission request, refuse fs and terminal requests, kill on any tool call.
4. `AGY_ACP_CCPA_BASE_URL` points at a local gate that forwards one model request, checks it has
   no tools, and refuses the rest.
5. No JSON schema over ACP: the answer is prompted as JSON, fences stripped, parsed against the
   schema. Delete the private root after the call; sweep stale roots at start.

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
- Antigravity on the pinned release, and its shared-Keychain login.
- Prompted JSON on Antigravity beyond one call.
- Anything on Windows beyond unit tests in CI.
