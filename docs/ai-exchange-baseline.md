# OpenVibe AI Inference Exchange — P0 Baseline & Gap Matrix

> Research checkpoint: 2026-11-03  
> Source documents: `plan-state-2026-10-22/ai-exchange/PLAN.md` and `CHECKPOINT.md`  
> Scope: documentation-only baseline. No code changes, no deployments, no money enabled.

This document records the current state of the repositories that implement (or will implement) the AI Inference Exchange, and a gap matrix against the PLAN.md / CHECKPOINT.md requirements.  
"EXISTS" means the feature is present in source on `origin/main` at the recorded SHA. "MISSING" means it is not present or is materially incomplete. No inference is made about production deployment.

---

## 1. Repository baseline

| Repository | Default branch | HEAD SHA (`origin/main`) | Version | openvibe-contracts pin | openvibe-sdk pin | openvibe-shared pin |
|---|---|---|---|---|---|---|
| OpenVibe.AI | `main` | `c17cabb2e898683a83672d598f1bd00774e8446d` | 0.1.0 | v0.262.0 | v0.82.0 | v4.109.2 |
| OpenVibe.Billing | `main` | `5dd4d99eb88b10c915a0aeb80274229d32e822db` | 0.1.0 | v0.222.0 | v0.82.0 | v4.109.2 |
| OpenVibe.Network | `main` | `5c485e66913a2b2123d797b5f66276e7dac9257f` | 1.0.0 | v0.280.0 | v0.82.0 | v4.109.2 |
| OpenVibe.Services | `main` | `29916bc1fe000536efca3573d88f04c11ed2d604` | 0.1.0 | v0.222.0 | v0.82.0 | v4.109.2 |
| OpenVibe.SDK | `main` | `8be2ecdce7c7450e48c88cf533fddb259f96960e` | 0.82.0 | — | — | — |
| OpenVibe.Contracts | `main` | `6ae82ddbdf2927d7c55cc5c0e8d0ba5d48c7a215` | 0.283.0 | — | — | — |
| OpenVibe.Bench | `main` | `74ee1a527ffb9ff9aa1d9f6dbe06c534efef7335` | 0.1.0 | v0.247.0 | v0.82.0 | v4.109.2 |
| OpenVibe.Report | `main` | `ecbd3f1f641dd74d5316a5ad8700be90d28e8bb8` | 0.1.0 | v0.275.0 | v0.82.0 | v4.109.2 |
| OpenVibe.Exchange | `main` | `b562b0fd7d018dfa036219585a7d591330a50f3a` | 0.1.0 | v0.235.0 | v0.82.0 | v4.109.2 |
| OpenVibe.Host | `main` | `46421d082f7d38c370cd9050df2135d7800e24f8` | 0.3.0 | v0.272.0 | v0.82.0 | v4.109.2 |
| OpenVibe.Run | `main` | `1bacc978ab25d7294a6f5f75a339645b47fe6406` | 0.1.0 | v0.250.0 | v0.82.0 | v4.109.2 |
| OpenVibe Link | `main` | `c8564f0b58f567dd909daaadd2f2a7b91f29a7a7` | v0.38.0 (tag) | N/A (Go) | N/A | N/A |
| OpenVibe.Watch | `main` | `52bfa57a83fdf3cb1b0879071c02ae6f5c601fa4` | 0.1.0 | v0.222.0 | v0.82.0 | v4.109.2 |
| OpenVibe.Sources | `main` | `7b40905dd943a7ed33ed7afe4ed637f547f48df5` | 0.1.0 | v0.224.0 | v0.82.0 | v4.109.2 |
| OpenVibe.Codes | `main` | `f955eebafd2d71c5660037cfe5f98631d4160c65` | 0.7.0 | v0.261.0 | v0.82.0 | v4.109.2 |
| OpenVibe.Actor | `main` | `41d802a8f1140fa979185a4528ec59d12d888bfa` | 0.1.0 | v0.269.0 | v0.82.0 | v4.109.2 |

Notes:
- All repos except Node use npm `package.json` versions and tarball pins.
- Node uses Go modules; the latest tag at refresh was `v0.38.0`.
- Shared and SDK are pinned uniformly at v4.109.2 and v0.82.0 respectively across the matrix repos that consume them.
- Contracts pins diverge by repo (Network v0.280.0, AI v0.262.0, Billing/Services v0.222.0, etc.). This is consistent with the PLAN note that repos deliberately pin different versions.

---

## 2. Per-authority EXISTS / MISSING matrix

### 2.1 OpenVibe.AI — Inference authority

| Requirement area | Status | Evidence / citation |
|---|---|---|
| OpenAI-compatible `POST /v1/chat/completions` | **EXISTS** | `server/api/openai.js` (lines 121-191) |
| Anthropic-compatible `POST /v1/messages` | **EXISTS** | `server/api/messages.js` (lines 136-195) |
| Streaming support with backpressure/abort | **EXISTS** | `server/api/openai.js:createLiveStream` (lines 48-88); `server/api/messages.js:createEventStream` (lines 51-91); `server/providers/index.js` executes with timeout/cancellation |
| Provider/model registry with versioning and audit | **EXISTS** | `server/registry.js` (providers, models, routes, templates, workflows with append-only versions and audit log) |
| Provider kinds: stub, openai, responses, anthropic, http, whisper | **EXISTS** | `server/registry.js:16` (`PROVIDER_KINDS`); adapters in `server/providers/{openai,responses,anthropic,gemini,http,whisper,stub}.js` |
| BYOK / person credentials with AES-256-GCM sealing | **EXISTS** | `server/credentials.js` (seal/open with owner+subject+provider AAD); `server/console/presets.js` for provider defaults; test on save |
| Project-owned provider via `x_openvibe.provider` | **EXISTS** | `server/api/openai.js:137-138`; `server/runs.js:projectProviderOf` (lines 69-76) |
| User-owned machine inference (`node`) | **EXISTS** | `server/credentials.js:41-42`; `server/machines.js`; `server/providers/index.js:135` |
| Routing via `openvibe-sdk/placement` | **EXISTS** | `server/providers/index.js:23,291-395` (`poolCandidates`) |
| `explain` (objective, selected, rejected candidates, cost, latency) | **EXISTS** | `server/providers/index.js:378-385`; returned as `x_openvibe` in `server/api/openai.js:171` |
| Circuit breaker per provider | **EXISTS** | `server/providers/index.js:168-191` |
| Rate cards with provenance (`platform.rate-card@1`) | **EXISTS** | `server/providers/rate-cards.js` |
| Quotas (pre-call reserve) | **EXISTS** | `server/quota.js` |
| Tier budgets / governance (Valkey-based, flag off) | **EXISTS** | `server/govern.js` (`AI_GOVERN_TIERS` default off) |
| Bench integration (`bench.rating.changed` events) | **EXISTS** | `server/bench/events.js`, `server/bench/evidence.js`; `server/providers/index.js:440-447` |
| Usage samples (`platform.usage-sample@1`) | **EXISTS** | `server/usage-samples.js` |
| Truthful `GET /v1/models` with real model/revision catalog | **MISSING** | Both `server/api/openai.js:194-196` and `server/api/messages.js:199-201` return only a single synthetic `openvibe` model. No artifact/revision/versioned catalog endpoint exists. |
| Exact model id `<org>/<model>[:<quant>]@<revision>` | **MISSING** | No exact-id parser or artifact registry in `server/registry.js`. `ModelArtifact`, exact pinning, and SHA256 provenance are not present. |
| Dynamic aliases (`openvibe/auto`, `economy`, `balanced`, `fast`, `private`) | **MISSING** | The router returns `x_openvibe` metadata but the only public model is `openvibe`; no alias resolution or policy selection logic exists. |
| `POST /v1/responses` and embeddings | **MISSING** | Only `chat/completions` and `messages` are implemented; no Responses or embeddings endpoints. |
| Inference-specific sub-cent billing (nano-USD) | **MISSING** | `server/quota.js` and `server/govern.js` still use floating-point USD / Vibes-bit style holds. AI delegates cost to Billing but does not yet use nano-USD precision internally. |
| `max_cost_usd` / reservation hold coordination with Billing | **MISSING** | Runs accept `max_tokens` but not `max_cost_usd`; no hold/settle protocol with Billing. |
| Provider commercial-rights eligibility check (`OWN_DEPLOYMENT`, `AUTHORIZED_WHOLESALE`, etc.) | **MISSING** | `registry.js` has `billing_profile` (`metered`, `subscription`, `payg`, `free`, `byok`) but no `provider_access` / commercial-rights field. `poolCandidates` does not filter by resale authority. |
| Versioned supply vs retail rate cards | **PARTIAL** | `rate-cards.js` builds `platform.rate-card@1` cards with `source`/`verified_at`, but has no `side: supply|retail` or immutable versioned snapshots. |
| Per-route Bench opt-in and blind/private handling | **PARTIAL** | Routes have `learn_from_bench` / `bench_kind` columns (`server/registry.js:197`) and `bench.select` is called, but private-benchmark isolation is not verified in this baseline. |

### 2.2 OpenVibe.Billing — Financial authority

| Requirement area | Status | Evidence / citation |
|---|---|---|
| Production money ledger (Vibes bits) | **EXISTS** | `server/ops/rating.js`, `server/ops/usage.js`, `server/config.js`, `server/ledger.js`; ADR-012 |
| `chargeFor()` rounds each reading up to one Vibes bit | **EXISTS** | `server/ops/rating.js:52-68` performs rational arithmetic then rounds up once to whole vibes-bits (`(num + den - 1n) / den`). Default `BILLING_BITS_PER_USD=100` in `server/config.js:103`. |
| `platform.rate-card@1` loading/validation | **EXISTS** | `server/ops/rating.js:245` `loadCards()` validates `platform.rate-card@1`; `migrations/0004_rating.sql:16-31` creates `rate_cards` table. |
| Promo-allowance / hard-budget integration | **EXISTS** | `server/ops/rating.js:170-190` calls `promo.consume`, `requireFunds`, `spendBudgets` inside serializable `money()` transaction; `usage_budgets` in `migrations/0004_rating.sql:37-47`. |
| Idempotent usage ingestion | **EXISTS** | `server/ops/usage.js:57` `record()` stores `platform.usage-sample@1` by `idempotency_key`; `usage.js:31` refuses conflicting replays. |
| Double-entry ledger | **EXISTS** | `server/ledger.js:81` `post()`; `ledger.js:142` `money()` uses serializable isolation; `ledger.js:147` `requireFunds()`. |
| Sub-cent inference accounting / nano-USD subledger | **MISSING** | Money is integer vibes-bits only; no nano-USD ledger, no `billing.inference-hold@1` / `billing.inference-settlement@1` schemas, no `POST /internal/inference/holds` endpoints. |
| Reservation/hold/settle/release for inference | **MISSING** | `chargeFor()` is post-hoc; no pre-execution hold, no `max_nano_usd`, no idempotent hold/settle, no separate hold account. |
| BYOK no-double-bill routing fee | **MISSING** | Rating prices against loaded cards and credits promo/Vibes ledger; no passthrough or zero-rating when caller supplies their own provider key or machine. |
| Reconciliation / crash recovery leases | **MISSING** | Not present in inspected files. |
| Automatic rate-card ingestion | **MISSING** | `BILLING_RATING_INTERVAL_MS` defaults to `0` (`server/config.js:175`); card loading is manual/offline. |

### 2.3 OpenVibe.Network — Identity & credential authority

| Requirement area | Status | Evidence / citation |
|---|---|---|
| Users, OAuth/OIDC, projects, developer apps | **EXISTS** | `server/developer/routes.js:151-206` mounts project-scoped routes for apps, credentials, grants, quotas, agents, budgets, export tokens. |
| Apps / OAuth clients | **EXISTS** | `server/developer/store.js:457` `createApp` with `client_id == app_<ULID>`, environment (`sandbox`/`production`), `client_type`; `store.js:513` `revokeApp`. |
| Project-scoped credentials (secrets hashed) | **EXISTS** | `server/developer/store.js:432` `newSecret()` creates `ovsec_…`; `store.js:436` stores SHA-256 hashes only; `store.js:592` constant-time verification. |
| Credential rotation / revocation | **EXISTS** | `server/developer/store.js:544` `rotateCredential` with overlap; `store.js:575` `revokeCredential`; app revocation cascades to credentials/agents. |
| Grants / capability scopes | **EXISTS** | `server/developer/store.js:632` `requestGrant`, `store.js:656` `decideGrant`; `policy.js` defines grantability; `tokens.js:50` `effectiveGrants`; `tokens.js:96` `mint`. |
| Agent tokens / delegated grants with confirmation | **EXISTS** | `server/developer/agents.js:285` `putGrant` with `auto`/`confirm`; `server/developer/agent-tokens.js:38` mints `agent:agt_…`; `confirmations.js:127` owner-approval flow. |
| Agent budgets / project quotas | **EXISTS** | `server/developer/agents.js:348` `setBudget` / `agents.js:338` `listBudgets`; `store.js:696` `setQuota` / `store.js:683` `listQuotas`. |
| Long-lived personal API key resource separate from OAuth | **MISSING** | System is OAuth-client-centric; no standalone personal API key concept. |
| App-level budgets | **MISSING** | `dev_agent_budgets` exists but no `dev_app_budgets`; routes expose only per-agent budgets. |
| Fine-grained OAuth scopes separate from capability ids | **PARTIAL** | `scope` is parsed as whitespace-separated capability ids (`tokens.js:67`); no separate scope namespace. |

### 2.4 OpenVibe.Services — Developer portal

| Requirement area | Status | Evidence / citation |
|---|---|---|
| Portal pages (projects, apps, credentials, grants, quotas) | **EXISTS** | `server/http/portal.js:180-200` projects list; `portal.js:513-574` ADR-048 resources page; `portal.js:577` usage/cost/quotas via `usageBody`; `portal.js:872-920` playground page. |
| Playground (Events / Media) | **EXISTS** | `server/domain/playground.js:35` `KINDS = { events, media }`; `playground.js:159` `run()` enforces app active & sandbox, grant check, token mint/verify, SDK call, audit log. |
| Generic usage/cost views | **EXISTS** | `server/http/portal.js:577` renders Network usage API via `server/render/usage.js`. |
| Model explorer / AI inference playground | **MISSING** | `playground.js` hard-codes `events` and `media`; no AI/model explorer or inference playground. |
| Inference-specific usage/cost views (tokens-in/out, per-model, explain) | **MISSING** | Usage page is generic service rollups; no per-model/token-kind/explain breakdown. |
| BYOK credential / AI budget / fund UI | **MISSING** | No UI for adding provider credentials, setting AI usage budgets, or viewing inference budgets. |

### 2.5 OpenVibe.SDK — Placement engine

| Requirement area | Status | Evidence / citation |
|---|---|---|
| Generic `placement` module | **EXISTS** | `src/placement.js:127` `plan()` with hard-constraints → objective → hysteresis; `placement.js:54` `marginalCost()`; `placement.js:70` `ownedLoadCost()` for prepaid/user-owned capacity; `placement.js:258` `TRUST_CLASSES` includes `user-owned`. |
| Signed plans / plan holder | **EXISTS** | `src/placement.js:214` `signPlan()` / `verifyPlan()`; `placement.js:240` `createPlanHolder()` keeps last valid plan. |
| Cost estimation helpers | **EXISTS** | `src/cost.js:14` `rateCard()`; `src/cost.js:36` `costSnapshot()`; `src/cost.js:55` `estimate()`. |
| AI client | **EXISTS** | `src/ai.js:23` `createAiClient()` with runs and direct chat/generate/embed/etc. |
| Governance / quota primitives | **EXISTS** | `src/govern.js:147` `createGovernor()` with reserve/commit/release/lease; `src/usage.js:40` `usageSample()`; `src/usage.js:124` `createUsageReporter()`. |
| Hysteresis / stable route affinity | **PARTIAL** | `placement.js:167` hysteresis keeps current placement unless gain ≥ `minGain` (default 0.15) or current ineligible; no adaptive hysteresis by workload class or cost volatility. |
| Cost-per-successful-task ranking | **PARTIAL** | `placement.js:270+` `place()`, `successOf()`, `learn()` produce cost-per-success explanation; Bench-linked quality confidence and explicit cost-per-solved ranking not verified. |
| `explain` with excluded reasons | **PARTIAL** | `placement.js:88` `excluded()` gives reasons; `ai.run@1` embeds explain but no standalone `ai.route-explain@1` schema. |
| AI-specific deployment input transform | **MISSING** | Placement handles generic `platform.workload-requirements@1`; no AI-specific wrapper converting model/provider into requirements. |
| `explain` client helper in `src/ai.js` | **MISSING** | `ai.js` returns the run object but has no dedicated `ai.route.explain` helper. |
| Inference-specific units in governor | **MISSING** | `govern.js:24` `UNITS` has `ai-token`/`ai-usd` but no `inference-task` or per-model unit link to model pricing. |

### 2.6 OpenVibe.Contracts — Schema authority

| Requirement area | Status | Evidence / citation |
|---|---|---|
| Existing `ai.*`, `billing.*`, `platform.*` schemas | **EXISTS** | `contracts/ai/`, `contracts/billing/`, `contracts/platform/` |
| `ai.model@1` | **EXISTS** | `contracts/ai/model.v1.json` catalogued as `ai.model` v1.0.0 (provider_key, model_key, type, status, cost, supports). |
| `ai.model-artifact@1`, `ai.inference-deployment@1`, `ai.route-explain@1` | **MISSING** | No files or catalog entries; `ai.run@1` embeds an `explain` field but it is not a standalone schema. |
| `billing.inference-hold@1`, `billing.inference-settlement@1` | **MISSING** | Not present in inspected `contracts/billing/`. |
| `platform.rate-card@1` extended with `side`, `version`, `effective_from/to` | **MISSING** | Existing `platform.rate-card@1` does not include these fields in the inspected version. |

### 2.7 Other authorities (high-level)

| Authority | EXISTS | MISSING |
|---|---|---|
| **OpenVibe.Bench** | Pinned evaluation rounds, Elo/Pareto/cost-per-solved rankings, blind judgments, MCP (`docs/api.md`, `docs/benchmarks.md`, `server/pick/pick.js`, `server/rating/*`). | Model-variant family schemas, throughput/TTFT quantitative evidence types, inference-specific benchmark gates. |
| **OpenVibe.Report** | Time-series/aggregation views, consumes Bench AI boards. | Supply-side profitability summaries tied to the new inference subledger; real model-catalog analytics. |
| **OpenVibe.Host / Run** | Worker/deployment orchestration, async jobs. | Pinned GGUF/vLLM/SGLang inference worker images, GPU rental orchestration with budget gates. |
| **OpenVibe Link / Bot** | Owner-machine inference path in AI (`server/machines.js`). | Commercial node-pool isolation, DNS-rebinding/SSRF tests for node routing. |
| **OpenVibe.Exchange** | v1 free/swap-only marketplace (`README.md`, `STATUS.json`, migrations). | Paid listing v2; inference API/model-pack marketplace (explicitly out of scope per D6). |
| **OpenVibe.Codes / Actor** | Coding harness, provider integrations, proof-of-work. | Hosted runner completion; integration with new catalog/aliases. |
| **OpenVibe.Watch / Sources** | Market-data sourcing, rate/model change alerts. | Official provider price/terms ingestion for inference providers; stale-data warnings. |
| **OpenVibe.SDK** | Generic placement, cost, AI client, govern/usage reporters (`src/placement.js`, `src/cost.js`, `src/ai.js`, `src/govern.js`, `src/usage.js`). | AI-specific deployment transform, explain client helper, inference task units, adaptive hysteresis. |
| **OpenVibe.Contracts** | Existing `ai.*`, `billing.*`, `platform.*` schemas; `ai.model@1` exists (`contracts/ai/model.v1.json`). | `ai.model-artifact@1`, `ai.inference-deployment@1`, standalone `ai.route-explain@1`, `billing.inference-hold@1`, `billing.inference-settlement@1`, `platform.rate-card@1` side/version extensions. |

---

## 3. Critical blockers identified

1. **Billing precision (launch blocker per PLAN F and CHECKPOINT D1-D2).** `OpenVibe.Billing/server/ops/rating.js` still rounds each usage reading up to one Vibes bit. A nano-USD inference subledger with reservation/hold/settle is missing.
2. **Model catalog truth.** `GET /v1/models` lies — it returns a synthetic `openvibe` model. Exact artifact ids, revision pinning, and dynamic aliases are not implemented.
3. **Commercial eligibility.** No `provider_access` classification (`OWN_DEPLOYMENT`, `AUTHORIZED_WHOLESALE`, etc.) is enforced in routing; paid managed routes cannot be safely enabled.
4. **Contract schemas.** `ai.model@1` exists, but `ai.model-artifact@1`, `ai.inference-deployment@1`, standalone `ai.route-explain@1`, `billing.inference-hold@1`, `billing.inference-settlement@1`, and the extended `platform.rate-card@1` (with `side`/`version`) do not exist yet.

---

## 4. Next work ordered by dependency

Per PLAN section G and CHECKPOINT jobs:

1. **P1 Contracts** (`cx:aix-p1-contracts`) — add D4 schemas and invalid fixtures.
2. **P2 Billing** (`dsh:aix-p2-billing`) — nano-USD subledger, holds/settlements, reconciliation proofs.
3. **P3 Network keys** (`cc:aix-p3-keys`) — one-time reveal, scopes, budgets, rotation.
4. **P4 AI catalog** (`mm:aix-p4-catalog`) — truthful `/v1/models`, exact ids, aliases.
5. **P5 Worker** (`pg:aix-p5-worker`) — llama.cpp/vLLM worker image and cost model.
6. **P1 Placement** (`cm:aix-p1-placement`) — cost-per-success, explain, exclusions.
7. **P8 Services UX** (Claude/Opus) — model explorer, playground, usage/cost views against fixtures.

This baseline leaves all PRs open for orchestrator review; nothing is deployed or merged.
