# OpenVibe.AI

> Providers, models, routing, prompt templates, workflows, runs, citations, cache and quotas for every product.

**Status:** alpha (roadmap Wave 13). Deployed on the host since 2026-09-23 on `127.0.0.1:4700`
(loopback only) and in production use: OpenVibe.Live runs with `AI_SERVICE=remote` and Network's
footer copy runs `network.site_copy` here. It is not a public product: the domain keeps its placeholder
page until the launch rule below is met.
**Domain:** `ai.openvibe.network` · **Port:** 4700 · **Unit:** `openvibe-ai.service`
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.1, §12.13, §15.14, §33, §34.
**License:** AGPL-3.0 (same as every OpenVibe service).

The reusable AI authority extracted from OpenVibe.Live. Products run registered, versioned
workflows; every run returns a **draft/evidence package** (structured output + citations +
provenance) attributed to a workflow, its version, a model and a run id — never to a person. AI never
owns publication truth: Wiki, Blog, News, Live, … decide what to publish.

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
| `POST /api/v1/{chat,generate,summarize,classify,extract,enrich,embed}` — each a run of workflow `ai.<op>` | `ai.run.create` |
| `GET /api/v1/runs`, `GET /runs/:id` (+ citations, request-log metadata), `GET /runs/:id/citations` | `ai.run.read` (own runs) |
| `GET /api/v1/workflows\|templates\|routes[/:key]` | `ai.run.create`, `ai.workflow.manage` or `ai.usage.read` |
| `POST /api/v1/{templates,workflows,routes}/:key/versions`, `…/versions/:v/status` | `ai.workflow.manage` |
| `POST/PATCH /api/v1/providers…`, `…/disable\|enable\|reset`, `POST/PATCH /api/v1/models…`, `POST /api/v1/quotas`, `DELETE /api/v1/cache` | `ai.provider.manage` |
| `GET /api/v1/status\|usage\|quotas\|requests\|audit\|cache\|providers\|models` | `ai.usage.read` |
| `GET /api/health`, `GET /api/ready`, `GET /release.json` | public |
| `GET /metrics` | direct loopback callers only (a request carrying X-Forwarded-For gets 404) |

`/api/ready` (openvibe-shared/ready) is 503 when the database, the active workflows or the Network
key fail; provider configuration (an active provider without its credentials, or with an open
circuit) degrades it. `/metrics` (openvibe-shared/metrics) carries golden signals by route template,
`ai_runs{state="queued"|"running"}` and `ai_provider_circuit{provider,state}`.

Errors are `application/problem+json` (openvibe-contracts `http.problem`): `input.invalid` (with the
schema errors), `workflow.not_found`, `idempotency.conflict`, `quota.exceeded` (429 +
`Retry-After`), `queue.full` (429 + `Retry-After`: the run would wait behind `AI_MAX_QUEUED_RUNS`
runs, or `AI_MAX_QUEUED_RUNS_PER_CALLER` of this caller's), `capability.denied`, `capability.namespace_denied`, `token.*`. A run that cannot
produce a real answer ends `failed` with an explicit code — `provider.unavailable`,
`route.unavailable`, `fetch.refused`, `source.unavailable`, `input.insufficient`, `output.empty`,
`output.invalid`, `run.interrupted` — and never with filler content.

The capability ids and the `ai` service manifest are released in openvibe-contracts v0.29.0 (the
drafts stay in `docs/capabilities-proposal/`); `server/auth.js` checks them with the contracts grant
rule (exact id or `family.*`). A token's `ns` claim limits which
workflow namespaces it may run (`live.*`, `wiki.*`, …), and namespaces fail closed: a token with
no `ns` runs nothing outside a documented fallback. A first-party service token (`svc:<id>`) without
`ns` gets its `AI_NS_FALLBACK` entry (default `live=live.*|network.site_copy`, because Network grants
Live's `ai.run.create` with no namespaces), else `<id>.*`; app and module tokens without `ns` get
nothing. `AI_NS_FALLBACK=none` removes the fallback; `AI_NS_REQUIRED=false` is a rollback lever to
the old rule (no `ns` = every namespace).

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
| `openai` | Any OpenAI-compatible API (OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, llama.cpp): chat with structured-output step-down, embeddings, Whisper-style transcription. Ported from Live's `llm.js` / `ai-provider.js`. | `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_MODEL_<ROLE>` — Live's setting names |
| `anthropic` | Messages API with cached system blocks and forced-tool JSON. Ported from Live's `llm.js`. | same, with `AI_PROVIDER=anthropic` |
| `http` | The local HTTP seam: `POST {operation, …}` → `{text, json, usage}` | `AI_HTTP_SEAM_URL` or the admin API |
| `whisper` | whisper.cpp on this host, with Live's VAD, hallucination filter, multilingual model and live/batch lanes | `WHISPER_*` — Live's names |

Routing tries the route's primary, then each fallback; a provider that is disabled, missing
credentials, circuit-open or unable to do the operation is **skipped and logged**; every call has a
strict timeout, cancellation and one retry on a transient failure; a fallback that answers is
recorded on the run (`fallback_used`), in the request log (`fallback = 1`) and in the audit log. The
stub joins every route as a last resort outside production only (`AI_STUB_FALLBACK`).

## Workflows

- **Seed product workflows** — `wiki.generate_space`, `wiki.generate_page`, `blog.draft_post`,
  `news.summarize_story`, `news.compare_perspectives`, `reviews.summarize_entity`,
  `deals.enrich_deal`, `coupons.extract_coupon`, `trade.summarize_market_context`,
  `codes.generate_docs`, `games.generate_lore`, `moderation.classify`. They take numbered
  `sources`, return `citations` (indices the engine bounds to the sources given) and `gaps`, and
  never invent facts: Reviews has no rating field, a Deals price is null unless cited, a Coupons
  expiry stays unknown unless stated, Trade carries its informational-only disclaimer. The
  historical route keys (`wiki.generate`, `news.summarize`, …) are explicit aliases of `default.json`.
- **Live's features** — `live.translate`, `live.paste.describe_image`, `live.paste.summarize_text`,
  `live.stream.describe_frame`, `live.stream.summarize`, `live.streamer.overview`,
  `live.media.overview`, `live.stream.recap`, `live.media.transcribe`, `network.site_copy`
  (prompts moved verbatim), plus passthrough workflows for the features whose prompts Live still
  renders (`live.viewers.*`, `live.chat.insight`, `live.moments.*`, `live.hero.slogans`,
  `live.arena.*`, …). See `docs/migration.md`.
- **Direct operations** — `ai.chat|generate|summarize|classify|extract|enrich|embed`.

## Guarantees and where they are tested

| Guarantee | Test |
|---|---|
| Every workflow has versioned, compiling input/output schemas, runs on the stub and validates | `test/workflows.test.js` |
| Edits are new versions; runs pin versions; lifecycle; admin versions survive reseeding | `test/versioning.test.js` |
| A degraded primary falls back and records it; breaker; skips; timeouts; explicit `provider.unavailable` | `test/fallback.test.js` |
| Quotas refuse with 429 + Retry-After **before** any provider call; per-service, attribution, cost caps | `test/quota.test.js` |
| The cache never crosses requester, actor, target or attribution scope | `test/cache.test.js` |
| Queue caps: one caller cannot fill the run queue (per-caller and global 429 `queue.full` + Retry-After) | `test/queue.test.js` |
| Idempotency, cancel (running and queued), retry, async polling, audit rows, restart recovery, no raw prompts or inline images kept | `test/runs.test.js` |
| Media fetched only from allow-listed https OpenVibe hosts; DNS answers and every redirect hop re-checked (a public hop never reaches internal Media); size caps | `test/ssrf.test.js` |
| The shared compiled-schema cache (caller-supplied schemas) is an LRU bounded by count and bytes, in Ajv too | `test/schemas.test.js` |
| Token and capability denial, namespaces, no secret values in any response, runs private to the requester | `test/auth.test.js` |
| Ported adapters against fake OpenAI/Anthropic servers, stub determinism, whisper filter, templates | `test/providers.test.js` |
| Import from a Live snapshot: dry run, holds, idempotent re-run | `test/import.test.js` |
| Capability proposals are valid contracts documents matching what is enforced | `test/proposals.test.js` |

## Live and Network

`docs/live-patch.diff` added `AI_SERVICE=remote` to Live (deployed as Live `fa22de5`; production runs
with `AI_SERVICE=remote` since 2026-09-23): Live's shared-key AI calls become runs here, authenticated
with `serviceHeaders('openvibe.ai')` from Live's `server/net/network-principal.js`. Without the flag
Live's behaviour is unchanged. `scripts/import-from-live.js`
moves the AI records that belong here (`--dry-run` first); it ran on production on 2026-09-23 at
18:29 UTC (79,657 ledger rows, 11 holds recorded with their reasons).
Network's footer copy calls the `network.site_copy` workflow (Network `422f8e9`), but the deployed Network still
falls back to Live's `/internal/ai/site-copy`, and Live still serves that route. The full plan, holds
and rollback are in `docs/migration.md`.

## Deploy

Deployed: `/opt/openvibe.ai`, env `/etc/openvibe/ai.env` (0600), unit `deploy/systemd/openvibe-ai.service`
(`StateDirectory=openvibe-ai`, database `/var/lib/openvibe-ai/ai.db`), principal `ai`. The nginx vhost
`deploy/nginx/ai.openvibe.network.conf` (only health/ready public; the API is host-local) is not
installed: `ai.openvibe.network` still serves the Sites placeholder.

## Not done yet

- `ai.run.*` events to OpenVibe.Events (and their schemas in Contracts); per-actor (BYO) provider
  secrets; moving Live's local transcription (whisper) and the passthrough prompts into AI templates;
  removing Network's fallback to Live's `/internal/ai/site-copy`; a server-rendered status page.
- Import holds from the 2026-09-23 run: a streamer's own provider key stays in Live, and 3,021 Live
  translations cannot become cache entries (they have no source text) and stay in Live.
- No fallback is declared on any production route, so an outage of the one real provider fails every
  Live AI feature; `live.*` and `network.site_copy` outputs carry no citations or gaps (0 citation rows).
- The host has a backup of `ai.db` but no restore drill has run for it; `/metrics` is built but not
  deployed yet.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
