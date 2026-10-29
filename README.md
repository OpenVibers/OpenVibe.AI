# OpenVibe.AI

> Providers, models, routing, prompt templates, workflows, runs, citations, cache and quotas for every product.

**Status:** alpha (roadmap Wave 13). Deployed on the host since 2026-09-23 on `127.0.0.1:4700` and in
production use: OpenVibe.Live runs with `AI_SERVICE=remote` and Network's footer copy runs
`network.site_copy` here. Public since 2026-10-07 at [ai.openvibe.services](https://ai.openvibe.services):
the home (`server/home.js`), `/stats` and the developer-app API (`ai.app.run`).
**Domain:** `ai.openvibe.services` · **Port:** 4700 · **Unit:** `openvibe-ai.service`
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.1, §12.13, §15.14, §33, §34.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

The reusable AI authority extracted from OpenVibe.Live. Products run registered, versioned
workflows; every run returns a **draft/evidence package** (structured output + citations +
provenance) attributed to a workflow, its version, a model and a run id — never to a person. AI never
owns publication truth: Wiki, Blog, News, Live, … decide what to publish.

## Owns

- the eleven record groups ([below](#the-eleven-record-groups)): providers, models, routing profiles,
  prompt templates, workflow definitions, runs, the request log (hashes, not prompts), citations, the
  cache, quotas and usage, and the audit log, in AI's own PostgreSQL database (`ov_ai`, ADR-035; schema in
  [migrations/](migrations/))
- people's own provider keys (`ai.credential.manage`), encrypted at rest, and per-streamer
  attribution quotas (`ai.quota.attribution.manage`)
- a person's own computer as their provider (credential provider `node`, contracts 0.220.0): a model on their own
  machine (Ollama, LM Studio, llama.cpp through the OpenVibe Node), reached through OpenVibe.Bot with `bot.machine.ai`
  for that person only, free and with no key (`server/machines.js`; Bot on this host by default, `OV_BOT_INTERNAL_URL`);
  machine `any` (contracts 0.221.0) uses the fastest of their machines that is on with the model, then the next
- the `ai.run.queued|succeeded|failed|cached` events and the `ai.preferences` / `ai.usage_summary`
  user modules' AI side

## Does not own

- publication: every run is a draft/evidence package; Wiki, Blog, News, Live and the rest decide what is
  published
- the recordings it analyses (OpenVibe.Media), identity (OpenVibe.Network), the products' prompts'
  meaning (each workflow's owner)

## Depends on

- PostgreSQL 18 (OpenVibe.Host `roles/data/`, ADR-035): every read and write is async through `openvibe-sdk/db`
- OpenVibe.Network (JWKS, service tokens, SSO for the operator console, user modules)
- OpenVibe.Events (the `ai.run.*` outbox relay, and the signed `bench.rating.changed` subscription; off without `EVENTS_URL`)
- OpenVibe.Bench (`bench.rating.changed` and `GET /api/v1/boards/:kind?type=elo|cost`, for opted-in routes)
- OpenVibe.Media (recordings `media.analyze` reads, over allow-listed https URLs or signed URLs)
- provider APIs configured by the operator (OpenAI-compatible, OpenAI Responses, Anthropic, the HTTP seam), whisper.cpp
  and the local model server `openvibe-llm.service` on this host
- `openvibe-contracts` v0.86.0, `openvibe-sdk` v0.67.0 (service tokens, events outbox),
  `openvibe-shared` v2.3.1, pinned by release tarball

## Capabilities

Implemented here (the service manifest's `capabilities`, audience `openvibe.ai`; routes under
[API](#api)): `ai.run.create`, `ai.run.read`, `ai.workflow.manage`, `ai.provider.manage`,
`ai.usage.read`, `ai.credential.manage` (`/api/v1/credentials/:subject`),
`ai.quota.attribution.manage` (per-streamer quotas) and `ai.app.run` (developer apps, ADR-014; public,
registered since openvibe-contracts 0.109.0). A service token's `ns`
claim limits which workflow namespaces it may run; an app token is fixed to its project's.

Called elsewhere, as the service principal `ai`: `events.event.publish` (Events, the outbox relay) and
`events.subscription.manage` (Events, creating AI's own `bench.rating.changed` subscription), and
`network.modules.read` / `network.modules.write` for `ai.preferences` and `ai.usage_summary`
(Network). Other services grant `ai` their own draft capabilities (for example
`blog.post.create`, `news.story.revise`, `reviews.summary.propose`) to receive drafts.

## Run it

```bash
npm install
cp .env.example .env        # no key needed: without one every route falls back to the stub provider
npm run dev                 # http://localhost:4700
npm test                    # stub provider, temp databases, local servers only — no network
```

Node 22 (CI pins 22.22.1). Callers need an OpenVibe.Network service token with audience
`openvibe.ai`; the Network public key is fetched from `/api/.well-known/jwks` (or pinned with
`OV_NETWORK_PUBLIC_KEY`).

## API

```http
POST /api/v1/runs?wait=10000
Authorization: Bearer <service token, aud openvibe.ai, cap ai.run.create>
Idempotency-Key: live-translate-8812

{ "workflow": "live.translate",
  "input": { "text": "みなさん、こんにちは", "from": "ja", "to": "en", "context": "chat" },
  "target": { "service": "live", "type": "chat_message", "id": "8812" },
  "attribution": { "service": "live", "type": "user", "id": "42" } }
```

answers `201` with the finished run (or `202` + `Location` while it is still running; `200` for an
idempotent replay):

```json
{ "run": { "id": "run_01…", "status": "succeeded", "output": { "text": "Hello everyone", "unchanged": false },
  "synthetic": false, "provenance": { "origin": "ai", "workflow": "live.translate", "workflow_version": 1,
  "template_version": 1, "route": "live.chat", "route_version": 1, "provider": "shared", "model": "gpt-5-nano",
  "fallback_used": false, "run_id": "run_01…" }, "citations_count": 0, "…": "…" } }
```

| Route | Capability |
|---|---|
| `POST /api/v1/runs` (`?wait=ms`, `Idempotency-Key`), `POST /runs/:id/cancel`, `POST /runs/:id/retry`, `POST /runs/:id/citations` | `ai.run.create` |
| `POST /api/v1/{chat,generate,summarize,classify,extract,enrich,embed,image}` — each a run of workflow `ai.<op>` | `ai.run.create` |
| `POST /api/v1/research` — a run of `research.gather` ([MegaSource](#megasource-research)) | `ai.run.create` (namespace `research.*`) or `ai.app.run` (free sources only) |
| `POST /api/v1/{chat,generate,summarize,classify,extract,embed,image}` (no `enrich`), `GET /runs/:id` (the app's own runs) | `ai.app.run` for a developer-app token ([Developer apps](#developer-apps)) |
| `GET /api/v1/runs`, `GET /runs/:id` (+ citations, request-log metadata), `GET /runs/:id/citations` | `ai.run.read` (own runs) |
| `GET /api/v1/actions?subject=usr_…` — one person's Action Center items (`common.action-list-result@1`, runs whose `on_behalf_of` is that person) | `ai.actions.read` (first-party service) |
| `GET /api/v1/workflows\|templates\|routes[/:key]` | `ai.run.create`, `ai.workflow.manage` or `ai.usage.read` |
| `GET /api/v1/routes?operation=generate` | the same read: every route's `offers` (`{provider, model}`), plus the operation's deduplicated `offers` |
| `POST /api/v1/{templates,workflows,routes}/:key/versions`, `…/versions/:v/status` | `ai.workflow.manage` |
| `POST/PATCH /api/v1/providers…`, `…/disable\|enable\|reset`, `POST/PATCH /api/v1/models…`, `POST /api/v1/quotas`, `DELETE /api/v1/cache` | `ai.provider.manage` |
| `GET /api/v1/status\|usage\|quotas\|requests\|audit\|cache\|providers\|models` | `ai.usage.read` |
| `GET /api/health`, `GET /api/ready`, `GET /release.json` | public |
| `GET /metrics` | direct loopback callers only (a request carrying X-Forwarded-For gets 404) |
| `GET /console…`, `/auth/login\|callback`, `POST /auth/logout` | Network staff, signed in (see [Operator console](#operator-console)) |
| `GET /runs/:id` — one run's receipt (status, workflow, model, cost, times, output or error; never the input) | the run's person, signed in (see [Run receipts](#run-receipts)) |
| `GET /auth/person/login\|callback` | any Network person, for a run receipt |
| `GET /robots.txt` | public: disallows `/console`, `/runs`, `/auth/`, `/api/` |
| `GET /stats` | public: p50/p95 latency, success rate and rate-card price per registered provider and model over the last 7 days (server-rendered, `openvibe-shared/cache-policy` HTML headers, nothing per caller) |

Browser reads of `GET /stats` and `GET /release.json` allow exact origins from `AI_CORS_ORIGINS`
(comma-separated; default `https://ai.openvibe.services,https://openvibe.services`). Their `OPTIONS`
preflight allows GET. Responses never allow credentials; `/api/v1/*`, `/console` and `/auth/*`
have no CORS access. Service callers do not need CORS.

`/api/ready` (openvibe-shared/ready) is 503 when the database, the active workflows or the Network
key fail; provider configuration (an active provider without its credentials, or with an open
circuit) degrades it. `/metrics` (openvibe-shared/metrics) carries golden signals by route template,
`ai_runs{state="queued"|"running"}` and `ai_provider_circuit{provider,state}`.

Each HTTP request is aggregated by route template, method and status class, never by raw URL; `/shared`
files, static assets, health, readiness and `/metrics` are not counted. Once a minute one `http.request`
sample per key, plus the active-requests, p95 latency and event-loop-lag gauges, is written to this
service's own `telemetry_samples` table (openvibe-sdk 0.46 telemetry, the `platform.telemetry-sample@1`
shape); rows older than 14 days are deleted daily. `server/app.js` mounts openvibe-sdk's
`telemetryMiddleware` (a no-op until init) and `server/index.js` calls `telemetry.init()` at production
start, runs the 14-day retention and flushes on stop. The table is created by migration
`migrations/0009_telemetry.sql`.

Errors are `application/problem+json` (openvibe-contracts `http.problem`): `input.invalid` (with the
schema errors), `workflow.not_found`, `idempotency.conflict`, `quota.exceeded` (429 +
`Retry-After`), `govern.exceeded` (429 + `Retry-After`: a tier budget) and `govern.unavailable` (503: Valkey
unreachable for a paid or staff run), `queue.full` (429 + `Retry-After`: the run would wait behind `AI_MAX_QUEUED_RUNS`
runs, or `AI_MAX_QUEUED_RUNS_PER_CALLER` of this caller's), `capability.denied`, `capability.namespace_denied`, `token.*`. A run that cannot
produce a real answer ends `failed` with an explicit code — `provider.unavailable`,
`route.unavailable`, `fetch.refused`, `source.unavailable`, `input.insufficient`, `output.empty`,
`output.invalid`, `run.interrupted` — and never with filler content.

The capability ids and the `ai` service manifest are released in openvibe-contracts v0.76.0 (the
drafts stay in `docs/capabilities-proposal/`); `server/auth.js` checks them with the contracts grant
rule (exact id or `family.*`). A token's `ns` claim limits which
workflow namespaces it may run (`live.*`, `wiki.*`, …), and namespaces fail closed: a token with
no `ns` runs nothing. Every caller's Network grant names its namespaces (Live: `live.*`,
`network.site_copy`, `media.analyze`). The fallback for service tokens without `ns` (`AI_NS_FALLBACK`)
and its rollback lever (`AI_NS_REQUIRED`) were retired on 2026-09-28 (shims C-22 and C-23).

## OpenAI-compatible endpoint

`POST /v1/chat/completions` and `GET /v1/models` (`server/api/openai.js`), so a client built for OpenAI's API (the SDKs,
coding agents, Codes' harnesses) points its base URL at `https://ai.openvibe.services/v1`.

- **Tokens:** the same as the direct operations: an app's Network token (`ai.app.run`; its project pays and owns the
  run) or a first-party service's (`ai.run.create`). Network tokens last five minutes: a client refreshes it with the
  client-credentials grant (the SDKs take a token function).
- **Request:** Chat Completions, as written: `messages` (system, developer, user, assistant with `tool_calls`, and `tool`
  results), `tools`, `tool_choice`, `parallel_tool_calls`, `response_format`, `stop`, `seed`, `temperature`, `top_p`,
  `max_tokens` or `max_completion_tokens`, `stream`. `n` must be 1. `model` may be anything: AI's router picks the
  upstream for `default.chat` by price and health, and a request with `tools` goes only to a provider that declares
  `tools`. The answer's `model` names the model that ran.
- **Answer:** `chat.completion` with the upstream's `choices` and `usage`, plus `x_openvibe` (`run_id`, `provider`,
  `fallback_used`, `cost_usd`) and the `X-OpenVibe-Run-Id` header.
- **Streaming:** `stream: true` answers server-sent events in the chunk format **as the upstream streams them**.
  - An OpenAI-format upstream (the router's, or the project's own) is asked with `stream: true` and
    `stream_options.include_usage`, and each delta goes out when it arrives: text, and a tool call's id, name and
    argument pieces.
  - Then come the finish reason, `usage` (with `stream_options.include_usage`), `x_openvibe`, and `[DONE]`.
  - The run itself ends with the whole answer put back together, the upstream's usage (estimated when it sends none)
    and its cost, as without streaming.
  - Once a delta has gone out, a failure is final: an `error` event, then `[DONE]`. It is never retried or handed to a
    fallback whose words would follow the first one's.
  - An answer that came back in one piece (a replayed idempotent run) is sent as one delta.
- **Each request is a run** of workflow `ai.complete` (step kind `complete`): the run's quota, free allowance, cost,
  audit and explain apply, and the prompt is not kept. Errors are OpenAI's shape (`{ error: { message, type, code } }`).
- **Upstreams:** OpenAI-format providers (`kind: openai`) pass the request through (`complete()`; a reasoning model
  takes `max_completion_tokens` and its default sampling). Anthropic is not used for it yet.
- **An app's own provider** (`x_openvibe.provider`, ADR-056). An app may name its project's own OpenAI-format API
  instead of the router: `{ "base_url": "https://api.openai.com/v1", "model": "gpt-5-mini", "secret": "openai-key" }`.
  - `secret` is the name of a project secret (OpenVibe.Services → project → Secrets) that the project granted to `ai`
    for reveal to that base URL's origin.
  - OpenVibe.Network reveals the key for that one run, from the app's environment (sandbox or production). The key is
    sent to that origin only, through the public-address guard, and is never stored, cached or logged. The run keeps
    the secret's name.
  - The project pays its provider directly, so no tier budget holds the run (the app's quotas still count it). Tools,
    tool results and every other field pass through.
  - Refusals: a secret that does not exist or is not granted answers 403 `project_secret.refused`, a base URL that is
    not https answers 400, and a first-party service token naming a provider answers 403.
  - Production app runs that use the router are limited to free and local capacity (see Developer apps). Today that is
    a small local model without tools, so a coding agent's loop needs its project's own provider.

## Developer apps

Roadmap Wave 20, ADR-014. A developer app gets a token from OpenVibe.Network (`POST /oauth/token`,
`grant_type=client_credentials` with its `app_<ULID>` client, `audience=openvibe.ai`): `sub
app:app_<ULID>`, `project_id prj_<ULID>`, `env sandbox|production`, ns `[project_id,
app.<project_id>.*]`, five minutes. AI accepts one capability for it, `ai.app.run` (public). A
sandbox app holds it without asking (Network's default sandbox allowance); a production app holds it
once OpenVibe staff add it to the project's allowance. Create the project and its app at
[openvibe.services/projects](https://openvibe.services/projects):

| Route | What |
|---|---|
| `POST /api/v1/{chat,generate,summarize,classify,extract,embed,image}` | the direct operations; `enrich` is first-party only |
| `GET /api/v1/runs/:id` | the app's own runs (404 for another project's) |

Every other route refuses an app token (403 `capability.denied`), whatever its grant carries. An
app's runs are its **project's**: the run's requester is `project:prj_<ULID>` and its attribution is
the project EntityRef `{service: 'network', type: 'project', id: 'prj_<ULID>'}`, so two apps of one
project share their runs, and the project is the budget unit — the free allowance's subject is the
attribution (`network:project:prj_<ULID>`), the tier budgets ([Providers](#providers)) name the
project (`project:prj_<ULID>`), and a quota can cap it on the service scope id `project:prj_<ULID>`.

**Billing.** Every run's `platform.usage-sample@1` readings carry the app's `project`
(`prj_<ULID>`) with subject `project:prj_<ULID>`, so Billing bills the project's use: the project's
bounded free allowance is claimed first (`free_allowance_used` on the reading), the rest is priced
under the project's tier budget (`AI_GOVERN_TIERS`, keyed `project:prj_<ULID>`). **Free and local
capacity only** (the stub, the local model, a free server or a pooled subscription — never a metered
provider) for every sandbox run, and for every app run while no tier budget governs its project
(`AI_GOVERN_TIERS` off): metered capacity is only ever spent under a project budget.

**Workflows.** An app runs the six direct operations (the fixed `ai.*` workflows) and nothing else:
`POST /api/v1/runs`, which takes a workflow by key, stays first-party, and the workflow check refuses
anything outside `ai.*` and the app's own `app.<project_key>.*` (`project_key` = `p` + the project's
ULID in lowercase, Events' rule for `app.<project_key>.<name>` event types). An app never reads another
project's runs and never uses a person's BYO provider key: the `byok` provider profile is never
offered to an app run, and `credential` on its request is refused.

```bash
AI=https://ai.openvibe.services
APP=app_01JAB…                      # the app's client id; SECRET is its client secret
TOKEN=$(curl -s -X POST https://openvibe.network/oauth/token \
  -d grant_type=client_credentials -d client_id=$APP -d client_secret=$SECRET \
  -d audience=openvibe.ai | jq -r .access_token)
curl -s -X POST "$AI/api/v1/chat" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "messages": [ { "role": "user", "content": "hello" } ] }' | jq .run.provenance
curl -s "$AI/api/v1/runs/$RUN" -H "Authorization: Bearer $TOKEN" | jq .run.status
```

A sandbox token is issued only for an audience that opted in (Network's `DEV_SANDBOX_AUDIENCES`);
AI takes one on these routes alone, and every other route refuses `env: sandbox` with 401
`token.sandbox_refused`, as before.

## Operator console

`/console` on ai.openvibe.services (roadmap WS-O task 4) is a server-rendered staff console: no
JavaScript, one inline stylesheet allowed by its CSP hash, `noindex` (meta and `X-Robots-Tag`),
`no-store`, disallowed in `robots.txt`, in no sitemap. It does not load the OpenVibe Frame (the Frame
needs scripts and inline styles), like Billing's staff console. Code: `server/console/`.

| Page | What it shows |
|---|---|
| `/console` | providers needing attention, runs and failures of the last 24 h by error code, today's spend, the queue, the busiest quota windows |
| `/console/providers` | every provider (kind, status, **secret reference name and whether it resolves, never a value**, circuit, base URL without query/user info, default model, priority/timeout) and the models; for the owner, per provider: replace its key, register a model (with prices typed from the provider's own price page, which the form requires) |
| `/console/providers/new` | the owner adds a provider in a few clicks: DeepSeek, OpenRouter, Groq, Gemini, Mistral, Together, Fireworks, Cerebras, xAI, OpenAI, Anthropic or any OpenAI-compatible API (`server/console/presets.js`), with its API key, which is kept encrypted (`vault:<provider>`, below) |
| `/console/routes/:key` (owner form) | **use another provider**: a new route version whose primary is the provider and model chosen, with the previous primary kept as the first fallback; **back to the default** writes the newest seeded version again |
| `/console/routes`, `/templates`, `/workflows` (`/:key[?version=]`) | every key's newest version and the version in use; per key every version with its status and content (primary and fallbacks in order, prompts, steps, schemas) |
| `/console/runs` | runs newest first, filtered by status (tabs), workflow, requester (`live` = `service:live`), error code and a UTC time range; failed runs grouped by error code |
| `/console/runs/:id` | versions used, provider/model, fallback, attempts, tokens, cost, the Billing reading with its delivery state, free share and last send error, error code and detail, requester/attribution/target, grounding, citations, the request log (hashes only), and the stored input/output **bounded**: strings cut at 240 characters, lists at 20 items, 6 KB in all, credential-named keys blanked; raw debug fields never |
| `/console/quotas`, `/console/usage` | active quotas with their current windows and counters, every quota; usage by day, requester, workflow and provider/model over a day range (`quotas.usage`); the **free allowance this period** per subject × provider × metric (free used, allowance, remaining, period end; `quotas.freeAllowance.current()`); the `platform.usage-sample@1` readings by delivery state (queued, retrying, sent, failed) and the last send errors with their run. Staff only: the public `/stats` page never shows a subject |
| `/console/cache` | live entries and hits by workflow |
| `/console/audit` | the `audit_log`, filtered by kind (configuration changes by default, runs, console, everything), action, actor, target |

**Who may use what.** Sign-in is OpenVibe.Network SSO (authorization code + PKCE S256 as OAuth client
`ai`; the refresh token is revoked at once). The staff claims of the Network token (contracts staff
map, `policy.staff-role-map@1`) are mapped to AI's own capability ids, and each page and action needs
the same one the admin API does:

| Network staff capability | Held by | Console capability | Allows |
|---|---|---|---|
| `staff.site.view` | admin, owner | `ai.usage.read` | open the console, read every page |
| `staff.ai.manage` | admin, owner | `ai.workflow.manage` | set a route/template/workflow version's status; cancel a queued or running run |
| `staff.secrets.manage` | owner | `ai.provider.manage` | add a provider with its key, replace a key, register a model, choose a route's provider and model, enable/disable a provider, reset its circuit, add/change a quota, purge the cache (one workflow, or all with a confirmation) |

A `global_mod` (only `staff.console.access`), a user or a token without a `usr_` subject is refused
(403, no session, audited as `console.sign_in.refused`). The session (`__Host-ovai_staff`, host-only,
HttpOnly, Secure, SameSite=Strict, `AI_CONSOLE_SESSION_TTL_MIN` = 60 min absolute; only its hash is
stored in `console_sessions`) keeps the sign-in token's staff claims and the mapping is applied again
on every request. Every POST needs the session's CSRF token and a same-origin request. Writes go
through the same functions as the admin API (`server/ops.js`, `registry.setStatus`, `quotas.upsert`,
`runs.cancel`), so each writes the same `audit_log` row with the person's `usr_…` subject as actor
(API changes show `svc:…`); sign-ins, sign-outs and refused requests are audited as `console.*`. New
versions of routes, templates and workflows, models and provider records are still created through
the admin API only. There is no drill mode in AI; the console starts nothing (no timer, no outbound
call) until someone signs in.

## Run receipts

`GET /runs/:id` is the person-facing page the Action Center's AI item links to (plan 2026-10-28
§3.10). It shows one run's status, workflow, model, cost, created/started/finished times and the
output or the error — never the stored input, the request log, the trace or another person's run.
It is server-rendered with the console's classes and CSP (no script, no form, no external resource),
`noindex`, `no-store`, `Referrer-Policy: no-referrer`.

A person signs in through the same Network OAuth client and callback as the console, but
`GET /auth/person/login` marks the flow as a person flow: the callback stores a read-only session
(`__Host-ovai_person`, host-only, HttpOnly, Secure, SameSite=Lax, `AI_PERSON_SESSION_TTL_MIN` = 24 h;
only its hash in `person_sessions`) and redirects only to the exact `/runs/run_<ULID>` page asked
for. It grants no capability and never opens `/console`. The page shows a run only when the run's
`on_behalf_of` is that session's `usr_…` subject; any other run is a 404. `GET /api/v1/actions` for
the Action Center is separate: a first-party service token with `ai.actions.read` names the person.

### Provider keys added from the console (`vault:`)

A provider the owner adds from the console keeps its key in `provider_secrets` (migration `0010_provider_secrets.sql`,
`server/vault.js`): AES-256-GCM with `AI_CREDENTIALS_KEY`, bound to the provider's key so a row copied to another
provider does not decrypt, with only a four-character hint ever shown. The provider's `secret_ref` is
`vault:<provider key>`, which `util.resolveSecret` reads from this process's decrypted copy (loaded at boot and after
every change; providers resolve secrets synchronously). Audit rows say a key was replaced, never what it is. Without
`AI_CREDENTIALS_KEY` the form says keys cannot be stored and nothing is added.

## The eleven record groups

| Group | Table(s) |
|---|---|
| Providers | `providers` (+ `provider_health`: circuit breaker) — secrets only as `env:NAME` references |
| Models | `models` (type, limits, cost per Mtok, JSON/tools/streaming/vision support) |
| Routing profiles | `routes` — versioned; primary + fallbacks, options, output limit, format, timeout, explicit aliases |
| Prompt templates | `templates` — versioned; input/output schema, system/user prompt, default route, owner, visibility, `draft\|active\|deprecated\|archived` |
| Workflow definitions | `workflows` — versioned; namespace, input/output schema, steps, default route, cache mode |
| Workflow runs | `runs` — `queued\|running\|succeeded\|failed\|cancelled\|cached`, requester, on-behalf-of subject, attribution, source service, target EntityRef, idempotency key, trace id, pinned versions |
| Request/completion log | `requests` — provider, model, route, status, skip reason, fallback flag, prompt/input/output **hashes**, tokens, cost, latency; raw prompts only with `AI_DEBUG_RAW_LOG` and a caller opt-in |
| Sources/citations | `citations` |
| Cache | `cache_entries` — scoped (below) |
| Quotas/usage | `quotas`, `usage_counters`, `usage_daily` |
| Audit | `audit_log` — every run create/cancel/retry, every provider/model/route/template/workflow/quota change, circuit changes, fallbacks |

Edits to templates, workflows and routes always create a new version; old versions stay readable
and every run records the versions it used. Boot seeding adds a new version when the code changes a
definition, but never over an admin's version.

## Providers

| Kind | What | Configured by |
|---|---|---|
| `stub` | Deterministic, no key, realistically shaped output (schema-shaped JSON, sentences, unit-vector embeddings, timed transcript segments), clearly marked synthetic (`(synthetic)` text, `synthetic: true` on the run). Never cached. | always present |
| `openai` | Any OpenAI-compatible API (OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, llama.cpp): chat with structured-output step-down, embeddings, Whisper-style transcription, image generation (`POST {base}/images/generations`). Ported from Live's `llm.js` / `ai-provider.js`. | `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` — Live's setting names |
| `responses` | The OpenAI Responses API (`POST {base}/responses`) for GPT-family models that only speak it, at any OpenAI-compatible `base_url` (default `https://api.openai.com/v1`): chat and every text operation, structured output through `text.format` with the same step-down, vision; no embeddings or transcription. | the admin API (`kind: "responses"`, `base_url`, `secret_ref`) |
| `anthropic` | Messages API with cached system blocks and forced-tool JSON. Ported from Live's `llm.js`. | same, with `AI_PROVIDER=anthropic` |
| `http` | The local HTTP seam: `POST {operation, …}` → `{text, json, usage}` | `AI_HTTP_SEAM_URL` or the admin API |
| `whisper` | whisper.cpp on this host, with Live's VAD, hallucination filter, multilingual model and live/batch lanes; NVIDIA Parakeet TDT 0.6B v3 (`parakeet-cli`) for English and 24 European languages when `PARAKEET_MODEL` is set, falling back to whisper | `WHISPER_*`, `PARAKEET_*`, `ASR_ENGINE` — Live's names |
| `openai`, key `local` | A model server on this host speaking the OpenAI API (llama.cpp's `llama-server`, Ollama's `/v1`): no key, never paid; route `media.local` | `AI_LOCAL_LLM_URL`, `AI_LOCAL_LLM_MODEL`, `AI_LOCAL_LLM_TIMEOUT_MS` |

Routing: a route either names a `capability` and the router builds its pool from every provider that
can serve it, ordered by `openvibe-sdk/placement` (objective, price, measured latency, health, with
hysteresis through the route's current placement), or pins a `[primary, ...fallbacks]` list. A
provider that is disabled, missing credentials, circuit-open or unable to do the operation is
**skipped and logged**; every call has a strict timeout, cancellation and one retry on a transient
failure; a fallback that answers is recorded on the run (`fallback_used`), in the request log
(`fallback = 1`) and in the audit log. Every run response and `GET /api/v1/runs/:id` carry `explain`
(objective, reasons, selected, and every candidate with its estimated cost, latency and excluded
reason).

### Bench evidence (BENCH-11, plan §4.12 and §4.7)

AI consumes OpenVibe.Bench's `bench.rating.changed` (through the signed `/internal/events` webhook, subscribed
at boot with `events.subscription.manage`) and keeps a small `bench_evidence` table: per kind and category, the
model, provider, Elo rating, confidence interval, games and Bench's cost per solved. A sparse event (Bench's
current outbox names only `subjects`) is filled from `GET /api/v1/boards/:kind?type=elo|cost`.

A route learns from that only when it opts in — `learn_from_bench: true` on the route, default off; `bench_kind`
names the board (when absent AI infers it from the route key or operation, e.g. `chat.reply`), and
`bench_category` defaults to `all`. Among the route's eligible offers, placement then prefers the **cheapest**
offer whose rating interval overlaps the leader's (the highest non-provisional rating): statistically tied with
the best, so price decides. A provisional rating (under 10 games) never decides. With no evidence the order is
exactly the one placement produced. `GET /api/v1/routes/:key` carries a `bench` object with the evidence, the
leader, the tied offers, the selected offer and the reason; the operator console shows the same read-only.

`GET /api/v1/routes?operation=generate` lists each route's eligible offers as `{ provider, model }`.
A first-party service holding `ai.run.create` may pin one on `POST /api/v1/generate` (and on
`POST /api/v1/runs` for `ai.generate`) with `"route": { "provider": …, "model": … }`. The run tries
that offer alone, never a fallback; a provider/model the routing does not list for `generate` is
`422 input.invalid` in words, and the caller's `ns` is still checked first (a workflow outside it is
`403 capability.namespace_denied`). Developer-app tokens (`ai.app.run`) cannot pin. Quotas, tier budgets and Billing readings are exactly as for an unpinned
run, and a pinned run is never served from the shared cache.

`GET /api/v1/runs/:id` adds `explain.usage_readings` when the run has a Billing reading: per
reading its `idempotency_key`, `state` (`queued` until Billing accepts it, `sent`, or `failed` when Billing
refused it), `attempts`, `queued_at`, `sent_at`, `rejected_at`, `next_attempt_at`, `last_error` (the
outbox's last send error, also while a queued reading is retried) and `free_allowance_used` when some
was free; a sent reading the relay has pruned reads `{ state: 'sent', pruned: true }`. Speech and embeddings use placement pools of registered `stt` and `embedding` models; until
a second upstream exists, an unavailable sole provider answers `503 provider.unavailable`. Media
uses separate local and paid pools so paid work still requires its explicit budget. The synthetic
stub can join general text routes as a last resort outside production only (`AI_STUB_FALLBACK`).

Free allowance (§2.1.8): a rate card's `free_allowance` (tokens per metric, from a models row or
`AI_PRICING_JSON`) is free provider capacity for **each subject** (the run's attribution, else its
actor, else its requester) per provider, metric and `reset_period` (`day` and `month` reset at the UTC
boundary; `none` never resets for the card's terms). An accounted run claims it first, atomically, in
the same transaction as its usage (`free_allowance_usage`, `server/free-allowance.js`); the free tokens
are the reading's `free_allowance_used` on its `platform.usage-sample@1`, and its `cost_estimate` leaves
their price out. It is pricing, never admission: quotas, request counting and the run's own cost are
unchanged, and no call is ever refused because the allowance is used up. Every card defaults to 0, so
nothing is free and the field is absent until an operator configures an allowance.

Tier budgets (T6 step 8, decision D5; `server/govern.js`, off unless `AI_GOVERN_TIERS=1`): the SaaS tiers
`free`, `paid` and `staff` on `openvibe-sdk/govern`, counted in Valkey. Before a run touches a provider
(and before `reserve()` counts it), it holds an estimate of the units `ai-token` and `ai-usd` against two
budgets: its **subject** (attribution, else actor, else requester) inside its **project** (the calling
product, e.g. `service:live`), and the **project** as a whole. Each hold is one atomic step, so two runs
never both take the last unit; a hold that does not fit refuses the run with `govern.exceeded` (429 +
`Retry-After`). When the run is accounted the hold becomes its real tokens and its priced cost (the free
allowance's share left out, so a fully free run spends no `ai-usd`); a run that spent nothing gives it back.
Like the quotas, a run that spends more than its hold bounds the next run, not itself. A subject's tier is
its own `AI_GOVERN_TIER_MAP` entry, else its project's, else `AI_GOVERN_DEFAULT_TIER`. With the tiers on,
the free allowance's counter lives in the same Valkey (same numbers, one atomic claim per metric);
`free_allowance_usage` keeps its total for the console and is the floor a lost key restarts from. Each
`platform.usage-sample@1` comes from the `onUsage` record of an in-process govern meter, with the same
idempotency key (`ai:<run>:tokens`), whether the tiers are on or off. **Valkey unreachable:** a run with
any budget on `paid` or `staff` is refused with `govern.unavailable` (503, fail closed); an all-`free` run
is admitted on the PostgreSQL quotas alone (today's behaviour) and its tokens are priced in full (nothing is
free while the counter cannot be read). Reads never touch the tiers. With the flag off nothing here runs and
the service boots without Valkey; with it on, production refuses to boot without `VALKEY_URL`.

| Setting | Default | Meaning |
|---|---|---|
| `AI_GOVERN_TIERS` | `0` | `1` turns the tier budgets on |
| `AI_GOVERN_POLICY_JSON` | free: 200,000 `ai-token`/day and 2,000,000/month, $0.50 `ai-usd`/day and $5/month; paid: 5,000,000 `ai-token`/day, $50/day; staff: unlimited | govern policy `{ unit: { tier: { minute?, hour?, day?, month? } } }` for `ai-token` and `ai-usd`; a missing tier or window is unlimited, 0 refuses |
| `AI_GOVERN_TIER_MAP` | empty | `subject=tier` pairs, comma separated (`service:live=paid,user:usr_1=staff`) |
| `AI_GOVERN_DEFAULT_TIER` | `free` | the tier of a subject or project not in the map |
| `AI_GOVERN_HOLD_TOKENS`, `AI_GOVERN_HOLD_USD` | `4000`, `0.02` | the estimate a run holds before its provider call |
| `AI_GOVERN_TIMEOUT_MS` | `1000` | longest wait for Valkey before it counts as unreachable |
| `VALKEY_URL`, `VALKEY_PREFIX` | empty | the shared Valkey (ADR-035) the counters live in |

## Workflows

- **Seed product workflows** — `wiki.generate_space`, `wiki.generate_page` (both on route `wiki.write`, see [MegaSource](#megasource-research)), `blog.draft_post`,
  `news.summarize_story`, `news.compare_perspectives`, `reviews.summarize_entity`,
  `deals.enrich_deal`, `coupons.extract_coupon`, `trade.summarize_market_context`,
  `codes.generate_docs`, `games.generate_lore`, `moderation.classify`, `food.suggest_recipes`,
  `rent.screen_listing` (a rental listing's scam signs for Rent's staff: `allow` or `review`, quoting the words). They take numbered
  `sources`, return `citations` (indices the engine bounds to the sources given) and `gaps`, and
  never invent facts: Reviews has no rating field, a Deals price is null unless cited, a Coupons
  expiry stays unknown unless stated, Trade carries its informational-only disclaimer. The
  historical route keys (`wiki.generate`, `news.summarize`, …) are explicit aliases of `default.json`.
  `blog.write_digest` writes an OpenVibe.Blog desk's digest from its sources' items, every section cited.
- **Satire** — `blog.write_satire` (Blog's "Is This Real?" desk) is invented on purpose and takes no sources: absurd
  mock-explainers that never name or quote a real person or put words in a real organisation's mouth, never joke about
  tragedies, minors or groups of people, and never give steps for anything dangerous. Blog labels each post as satire
  written by AI.
- **Live's features** — `live.translate`, `live.paste.describe_image`, `live.paste.summarize_text`,
  `live.stream.describe_frame`, `live.stream.summarize`, `live.streamer.overview`,
  `live.media.overview`, `live.stream.recap`, `live.media.transcribe`, `network.site_copy`
  (prompts moved verbatim), plus passthrough workflows for the features whose prompts Live still
  renders (`live.viewers.*`, `live.chat.insight`, `live.moments.*`, `live.hero.slogans`,
  `live.arena.*`, …). See `docs/migration.md`.
- **Media** — `media.analyze` (roadmap WS-O task 5), local-first analysis of a VOD, clip or audio file by `media_url`
  or MediaRef, fetched like any media input (allow-listed hosts) into `media-tmp` beside the database
  (`AI_MEDIA_ANALYSIS_DIR`; never `/tmp`, which is memory on the production host). The file cap is
  `AI_MEDIA_ANALYSIS_MAX_BYTES` (4 GB), also bounded by that disk's free space minus
  `AI_MEDIA_ANALYSIS_DISK_RESERVE_BYTES` (3 GB). Otherwise the run is refused with `media.no_space` before downloading. Everything runs on this host, one analysis at a time, at nice 15:
  1. **Signals**, one FFmpeg pass with video decoded at keyframes only: scene changes (`scdet`, threshold
     `AI_MEDIA_SCENE_THRESHOLD`), black and frozen picture, silence, and loudness. Loudness has the integrated level
     and range, the typical level (the median audible second) and loud moments at least 6 LU above it.
  2. **Scenes** from the scene changes (at most 300).
  3. **Speech**: whisper.cpp through `live.stt`, with another registered STT model eligible for fallback.
  4. **Highlights**: windows scored by loud, scene changes and speech, each with its reasons and transcript excerpt.
  5. **An overview** from a local model (`media.local`), else extractive from the measured facts. A paid provider
     (`media.paid`, including the shared provider) writes it only with `allow_paid: true` **and** an active quota with
     `workflow_prefix` `media.paid` and `max_cost_usd` > 0, while today's `media.*` spend is under it. That quota
     gates only this call, never whole runs.

- **Chat's AI members** ([server/workflows/chat.js](server/workflows/chat.js)): `chat.member.reply` (namespace `chat`, route
  `chat.member`, an alias of `default.chat`, text out). A room on OpenVibe.Chat adds an AI member with a name and how
  it should be; when someone names it, Chat sends the recent messages, the room's notes and any shared context a linked
  service gave the room (Food: a household's pantry and plan), and posts the reply. The prompt forbids inventing facts
  about the people or their things and claiming actions beyond writing in the chat.
  `chat.member.turn` is the same member with tools: a Chat Completions request (Chat's system message, the transcript,
  the tools Chat runs) passed through like `ai.complete` (the prompt is not kept) on route `chat.member`, so Chat's grant
  and quota apply and a person's own key reaches only their provider; the choices come back with any tool calls, and
  Chat sends the results in its next turn.
- **Space's spaces** ([server/workflows/space.js](server/workflows/space.js), namespace `space`): `space.app.build`
  is the AI builder of OpenVibe.Space. From what a person asks for (and a space's current files when changing one),
  it returns a working space: name, description, the instructions its AI follows, the SDK features it uses, and up to
  six files with an `index.html`. Paths are relative and safe, and an answer without a real page is no answer. It runs
  on route `space.build` (the creative model, 180 s, 16,000 output tokens), on behalf of the builder. `space.app.ask`
  is a space's own AI (`OV.ai.ask` in the space SDK): the maker's instructions under the platform's rules, on route
  `space.ask` (an alias of `default.chat`), on behalf of the visitor, so it counts against their daily allowance.

  `overview.source` says which (`local_model`, `paid`, `extractive`), and `gaps` lists what is missing (no local
  model, no speech-to-text, no budget). The output is not cached: callers keep it. Live's grant names
  `media.analyze`.
- **Direct operations** — `ai.chat|generate|summarize|classify|extract|enrich|embed|image`.

## MegaSource research

`research.gather` (namespace `research`, `server/research/`, `server/workflows/research.js`) answers one question from
many sources at once and returns one ranked, de-duplicated evidence pack the product workflows cite by number. No model
is called; a run is recorded like a provider call (provider `research`, model `megasource`), so the web route's per-call
price counts against the cost quotas and the daily usage.

| Source | What it gives | Terms |
|---|---|---|
| Wikipedia | the best articles' full text, their pictures (each with its licence; an article's own non-free files are marked) and the Wikidata id | CC BY-SA 4.0 |
| Fandom | the topic's own community wiki when it has one (from the web results' hosts, else the topic as a subdomain, confirmed by the wiki's name): pages read through its MediaWiki API, infobox rows kept as "Label: value" | CC BY-SA 3.0; pictures marked not free |
| Wikidata | the top article's key statements as labelled facts, and its picture | CC0 |
| Search Fabric | the web through OpenVibe.Search's web scope (`POST /api/v1/query`, capability `search.fabric.query`) first: the open index, then the providers Search routes to; every page keeps its provider, URL and dates | per provider Search used |
| DeepSeek | the fallback web search when the fabric is off, refuses or answers nothing: page text (Search API) and full text for short results (Fetch API), fetched by DeepSeek, never from this host | $0.75 per 1,000 successful calls each |
| Commons, Openverse | freely licensed pictures (CC0, public domain, CC BY, CC BY-SA; NonCommercial and NoDerivatives are not counted as free), kept only when their title or description names the subject | per picture |

Input: `query` (required), `topic` (the subject it belongs to: finds the topic's wiki), `focus` (one subject inside the
topic), `lang`, `max_sources` (≤ 20), `max_images` (≤ 24), `content_chars` (≤ 12,000), `providers` (a subset). Output:
`sources` (each with `url`, `title`, `content`, `published_at`, `retrieved_at` and `provenance.provider|site|via|license`),
`images` (each with `license`, `free`, `author`, `source_url`, `provider`), `facts`, `topic_wiki`, `providers` (per route:
ok, ms, count, cost, or why it was skipped or failed) and `usage` (requests, DeepSeek calls, fabric calls and the fabric's
`search_fabric_cost_usd`; `cost_usd` is this run's own DeepSeek calls, so a paid fabric step is not billed twice —
Search and its nested AI run pay it). Cached for a day per calling service.

Web search asks the Search Fabric first, as AI's own service principal (audience `openvibe.search`). Search's viewer
requires `search.query.delegate` of a service token, so Network must grant `ai` that capability on `openvibe.search`
(the route's `search.fabric.query` is public). The token is requested with exactly that scope; without
`OV_OAUTH_CLIENT_SECRET` or with `AI_RESEARCH_SEARCH=0` the fabric is skipped. When Search's own web ladder calls this
endpoint for DeepSeek or Wikipedia, research keeps DeepSeek direct, so Search is never asked back in a loop. DeepSeek is
used only when its key resolves (`AI_RESEARCH_DEEPSEEK_KEY_REF`, default `env:DEEPSEEK_API_KEY`;
`AI_RESEARCH_DEEPSEEK=0` turns it off), only for first-party callers (a developer app's run reads the free sources),
within `AI_RESEARCH_DEEPSEEK_DAILY` calls a day (1500), and it stands down on its own answers: 402 (balance used up) for
30 minutes, 401 for an hour, 429 for a minute. Tests read a canned web (`test/fixtures/research-fetch.js`); none reaches
the internet.

OpenVibe.Wiki's "vibe a wiki" uses it with `wiki.generate_space` (plans the pages: main page first, each with a kind,
an outline and a search phrase) and `wiki.generate_page` (writes one page: lead, sections, infobox, `[[links]]` to the
planned pages, and up to three of the numbered pictures by heading), both on route `wiki.write` (the creative model,
7,000 output tokens, 170 s, past the provider's chat timeout).

## Image generation

Off unless `AI_IMAGE_MODEL` names the shared provider's image model (`dall-e-3`, `gpt-image-1`; OpenAI-shaped
providers only). Then boot gives `shared` the `image` capability, registers the model as type `image` and seeds
route `default.image` (a capability pool of registered `image` models, objective `correctness`,
`provider_scope: paid`, timeout 120 s, above `AI_PROVIDER_TIMEOUT_MS`; a timed-out image is not retried, so it is never paid for twice). Without it no route is seeded and `POST /api/v1/image` answers
`503 route.unavailable`, like any operation whose route is not configured.

`POST /api/v1/image` (`ai.run.create`, or `ai.app.run` for an app) takes `{ prompt, size?, n? }` (`n` 1–4, 1 for `dall-e-3`;
`size` defaults to `AI_IMAGE_SIZE`, `1024x1024`) and answers `output: { images: [{ b64, url }], count }`
(`dall-e-*` is asked for `b64_json`; `gpt-image-1` answers base64 already). A missing prompt is
`422 input.invalid`, a provider that returns no image `502 output.invalid`, no provider `503 provider.unavailable`.
Outside production the stub answers a 1×1 PNG as the last resort (`AI_STUB_FALLBACK`).

Images are metered per image, never per token: the request log's `operation` is `image` and `tokens_out` the
image count, and each attempt is one `platform.usage-sample@1` reading (`resource` `output-images:<model>`,
`unit` `image`, `quantity` the images returned), queued like every other reading. No rate card prices an image
yet (an owner/T5 item, never AI-written), so an image costs 0 in AI's usage and cost quotas; Billing stores the
reading unrated until a per-image card exists and its `unitFits()` accepts `image`.

## Local model

`deploy/systemd/openvibe-llm.service` runs llama.cpp's `llama-server` on `127.0.0.1:8090` (OpenAI API, no key),
which AI reaches as the provider `local` and the route `media.local` (`AI_LOCAL_LLM_URL=http://127.0.0.1:8090/v1`,
`AI_LOCAL_LLM_MODEL`). On the production host since 2026-09-27: llama.cpp b11222 (the CPU build, checked against
the release's sha256) in `/opt/llama.cpp/b11222` with `/opt/llama.cpp/current`, and Qwen2.5-1.5B-Instruct Q4_K_M
(Apache-2.0, checked against Hugging Face's sha256) in `/var/lib/openvibe-llm/models`. It is held back so live
streams always win: 2 threads, at most 1.5 CPUs, nice 19, 3 GB. It uses about 0.9 GB and generates about
28 tokens/s. Without it, `media.analyze` writes an extractive overview and says so. To swap the model, put the
file beside it, change `--model`/`--alias` and `AI_LOCAL_LLM_MODEL`, and restart both units.

Local embeddings are off unless `AI_LOCAL_EMBED_MODEL` names an embedding model the server at `AI_LOCAL_LLM_URL`
answers at `/embeddings`. Then `local` advertises `embed`, the model is registered as an `embedding` model, and
`default.embedding` (a capability pool) offers it beside the shared provider's `AI_EMBEDDING_MODEL`; `local` is
billing profile `free`, so its readings carry no cost. llama.cpp's `llama-server` answers `/embeddings` only when
started with `--embedding` and a GGUF that supports embeddings (a chat-only model answers 400, and every embedding
call then fails over to the shared provider with an error in the request log). That flag restricts llama-server
to embeddings, so the Qwen chat unit above runs without it: embeddings need a server that serves both on one URL
(Ollama's `/v1`, for example), or `AI_LOCAL_LLM_URL` given over to an embedding-only server. **Vector dimensions
differ per upstream**: a run says which provider and model made its vectors, and a consumer must never compare or
mix vectors from different providers (re-embed when the provider changes).

## Acceptance: guarantees and where they are tested

`npm test` runs every `test/*.test.js` with the stub provider, temp databases and local servers only.

| Guarantee | Test |
|---|---|
| Every workflow has versioned, compiling input/output schemas, runs on the stub and validates | `test/workflows.test.js` |
| Edits are new versions; runs pin versions; lifecycle; admin versions survive reseeding | `test/versioning.test.js` |
| A degraded primary falls back and records it; breaker; skips; timeouts; explicit `provider.unavailable` | `test/fallback.test.js` |
| Quotas refuse with 429 + Retry-After **before** any provider call; per-service, attribution, cost caps | `test/quota.test.js` |
| Free allowance: free up to the card's allowance then fully priced, reset per day/month (never for `none`), per subject, never past the cap under concurrent claims, absent at 0 | `test/free-allowance.test.js` |
| Tier budgets: enforced per subject and per project and reset per window, two concurrent runs never both take the last unit, the free allowance's numbers unchanged on the Valkey store, one reading per accounted run from govern's `onUsage`, Valkey unreachable (paid 503, free admitted), off by default | `test/govern-tiers.test.js` |
| The cache never crosses requester, actor, target or attribution scope | `test/cache.test.js` |
| Queue caps: one caller cannot fill the run queue (per-caller and global 429 `queue.full` + Retry-After) | `test/queue.test.js` |
| Idempotency, cancel (running and queued), retry, async polling, audit rows, restart recovery, no raw prompts or inline images kept | `test/runs.test.js` |
| Media fetched only from allow-listed https OpenVibe hosts; DNS answers and every redirect hop re-checked (a public hop never reaches internal Media); size caps | `test/ssrf.test.js` |
| The shared compiled-schema cache (caller-supplied schemas) is an LRU bounded by count and bytes, in Ajv too | `test/schemas.test.js` |
| Token and capability denial, namespaces, no secret values in any response, runs private to the requester | `test/auth.test.js` |
| Developer apps: `ai.app.run` on the six direct operations and `GET /runs/:id`, 403 on every other route, project-scoped runs, readings and free allowance per project, govern tiers keyed by the project, sandbox and ungoverned runs free/local capacity only, a byok profile and `credential` never selected | `test/app-access.test.js` |
| Operator console: SSO + PKCE, staff-only (anonymous → sign-in, non-staff 403), the staff → AI capability map, CSRF on every write, no script/secret on any page, noindex/robots, failed-run filters, audit rows from API and console changes | `test/console.test.js` |
| Public price/latency page: 200 without auth, rows from seeded stats and rate cards, the empty state, no caller ids, own-key providers, URLs or secrets | `test/stats-page.test.js` |
| The OpenAI Responses adapter (`kind: responses`) with a stubbed fetch: request shape, output and usage parsing, `text.format`, error mapping, the key never in an error | `test/provider-responses.test.js` |
| Ported adapters against fake OpenAI/Anthropic servers, stub determinism, whisper filter, templates | `test/providers.test.js` |
| Parakeet: engine by language, 30 s pieces past 45 s, fallback to whisper, `ASR_ENGINE=whisper` | `test/parakeet.test.js` |
| `media.analyze` on a real 28 s fixture: signals, scenes and loud moments measured, highlights with evidence, the local model's overview from the facts only; the local model down → extractive and said; paid only with `allow_paid` and a `media.paid` budget, never past it; too little disk refused before downloading | `test/media-analysis.test.js` |
| Import from a Live snapshot: dry run, holds, idempotent re-run | `test/import.test.js` |
| Capability proposals are valid contracts documents matching what is enforced | `test/proposals.test.js` |

## Security

Reporting a vulnerability: [SECURITY.md](SECURITY.md). The rules the code keeps:

- **Auth.** Every API route needs a Network service token for audience `openvibe.ai`, with the route's
  capability and, for runs, a namespace its `ns` claim allows. Runs are private to their requester.
  A developer-app token is accepted only on `ai.app.run`'s routes ([Developer apps](#developer-apps)),
  where it acts as its project; every other route refuses it. The operator console is Network staff
  only, signed in with SSO and PKCE, with CSRF on every write.
- **Secrets.** Shared provider keys are `env:NAME` references, never values; a person's own key is
  AES-256-GCM encrypted with `AI_CREDENTIALS_KEY`, bound to its owner and subject, and never returned
  (a four-character hint only). No response, log or console page carries a secret value.
- **Private data.** The request log keeps hashes, not prompts; raw prompts and inline images are not
  kept; the cache never crosses requester, actor, target or attribution; `history: false` keeps
  neither input nor cache entry.
- **Egress.** Provider calls go only to configured providers. Media is fetched only from allow-listed
  https OpenVibe hosts, with every DNS answer and redirect hop re-checked and size caps
  (`test/ssrf.test.js`); ffmpeg reads through a loopback proxy that applies the same rules.
- **Abuse.** Quotas refuse with 429 before any provider call; queue caps per caller and overall.
  `/metrics` answers direct loopback callers only.

## Live and Network

`docs/live-patch.diff` added `AI_SERVICE=remote` to Live (deployed as Live `fa22de5`; production runs
with `AI_SERVICE=remote` since 2026-09-23): Live's shared-key AI calls become runs here, authenticated
with `serviceHeaders('openvibe.ai')` from Live's `server/net/network-principal.js`. Without the flag
Live's behaviour is unchanged. The one-time `scripts/import-from-live.js` moved the AI records that belong here;
it ran on production on 2026-09-23 at 18:29 UTC (79,657 ledger rows, 11 holds recorded with their reasons, kept in
`import_ledger` and `import_holds`) and was retired with the move to PostgreSQL (it is in git history).
Network's footer copy calls the `network.site_copy` workflow (Network `422f8e9`), but the deployed Network still
falls back to Live's `/internal/ai/site-copy`, and Live still serves that route. The full plan, holds
and rollback are in `docs/migration.md`.

## Deploy

Production deploys with `sudo ovhost deploy ai` on the host (strategy `git-checkout`: fetch,
fast-forward `/opt/openvibe.ai`, install on a lockfile change, restart, wait for `/api/ready`).
The unit is `openvibe-ai.service` on `127.0.0.1:4700`, the env file `/etc/openvibe/ai.env`. The database is
`ov_ai` on the host's data role (`sudo /opt/openvibe.host/roles/data/add-service.sh ai` writes its settings); the
release migrates it at boot. The local model
runs as `openvibe-llm.service` on 127.0.0.1:8090 ([Local model](#local-model)).
Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the
restart; afterwards `sudo ovhost rollback ai --to <sha>`. Migrations only add tables and columns.

Backups and drills: `ov_ai` is in the host's nightly backup (pgBackRest to B2, plus a weekly logical dump), and a
restore drill (`sudo ovhost drill ai`) restored a fresh dump and passed on 2026-10-15: models, routes, templates,
workflows, quotas and citations counted equal, and `/api/health` matched production. `/metrics` is scraped by the
host's Prometheus on 127.0.0.1:4700 and refused on the public vhost.

Deployed: `/opt/openvibe.ai`, env `/etc/openvibe/ai.env` (0600; `BASE_URL=https://ai.openvibe.services`), unit
`deploy/systemd/openvibe-ai.service` (`StateDirectory=openvibe-ai`; database `ov_ai` on the host's data role),
principal `ai`. The vhost `deploy/nginx/ai.openvibe.services.conf` (on the `*.openvibe.services` certificate)
serves the home, `/stats`, `/shared/*`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`, health/ready, the operator
console `/console` with its sign-in `/auth/`, and exactly the developer-app routes (the six operations by POST,
`/api/v1/runs/:id` by GET, rate-limited per address); every other `/api/` path and `/metrics` stay host-local.
The old `ai.openvibe.network` address was retired on 2026-10-10. The console needs
`AI_CONSOLE_SESSION_SECRET` (32+ random characters) and `OV_OAUTH_CLIENT_SECRET` in the env file (without them it
answers 503 in production); Network client `ai` lists `https://ai.openvibe.services/auth/callback`.

Sitemap entries use the release commit for home and the newest recorded stats day for `/stats` when available.

## Not done yet

- Live's VOD and clip overviews calling `media.analyze` instead of extracting frames and transcribing
  themselves; moving the remaining passthrough prompts into AI templates (most `live.*` workflows are
  versioned templates since 2026-09-27);
  removing Network's fallback to Live's `/internal/ai/site-copy`; a public server-rendered status page.
- Metered models for developer apps: production app runs use free and local capacity until a tier budget
  governs their project (`AI_GOVERN_TIERS` is off in production) and OpenVibe.Billing charges project subjects.
- Import holds from the 2026-09-23 run: a streamer's own provider key stays in Live, and 3,021 Live
  translations cannot become cache entries (they have no source text) and stay in Live.
- Text routes now run a capability pool (`shared` plus a local model when one is configured) instead
  of a declared fallback, but speech and embeddings still have a single upstream, so an outage there
  fails that feature until O9 adds a second provider. On 2026-09-23 `live.*` and `network.site_copy`
  outputs carried no citations or gaps
  (0 citation rows); runs record grounding (cited sources and named gaps) since 2026-09-25.

## Launch

Launched 2026-10-07 under the launch rule (plan §12.12): the runtime with health, readiness and metrics; Network
subjects and scoped service principals; server-rendered public routes useful without JavaScript (the home,
`/stats`); PostgreSQL persistence and end-to-end workflows; capabilities and events registered in
`OpenVibe.Contracts` (`ai.app.run` since 0.109.0, the service live since 0.110.0); migrations at boot,
robots/sitemap/llms.txt; acceptance tests ([above](#acceptance-guarantees-and-where-they-are-tested), and
`test/home.test.js` for the public routes and vhosts). The same release removed ai.openvibe.services and the
ai.openvibe.network notice from OpenVibe.Sites.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.229.0
- openvibe-sdk: v0.67.0
- openvibe-shared: v4.43.0
<!-- versions:end -->
