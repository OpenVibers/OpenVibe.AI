# AGENTS.md — OpenVibe.AI

## Project overview

The AI authority of the OpenVibe network: providers, models, routing, versioned prompt templates and
workflows, runs, citations, scoped cache, quotas, free allowance, abuse limits, BYO keys and the public
AI Exchange API. Node.js/Express, PostgreSQL (`ov_ai`), CommonJS, **no build step**. Extracted from
OpenVibe.Live's AI subsystem; Live now runs with `AI_SERVICE=remote`.

- Service id `ai`, port `4700`, public origin `https://ai.openvibe.services`, API host
  `https://api.openvibe.exchange`, unit `openvibe-ai.service`.
- The reusable rule: a run returns a **draft/evidence package** (structured output + citations +
  provenance) attributed to a workflow version, model and run id — never to a person. AI never owns
  publication truth; Wiki, Blog, News, Live, Report and the rest decide what to publish.

## What it owns, and what it must not touch

Owns the eleven record groups in `migrations/`: providers, models, routing profiles, prompt
templates, workflow definitions, runs, the request log (hashes, not prompts), citations, cache,
quotas/usage and audit. Also owns people's provider keys (`server/credentials.js`,
`server/vault.js`), people's own machines as providers (`server/machines.js`), free allowance
(`server/free-allowance.js`), tiers/budgets (`server/govern.js`, `server/run-budgets.js`), abuse
prevention (`server/abuse/`), the public price book and Exchange APIs (`server/api/exchange.js`,
`server/pricebook/`), GPU supply/provisioning (`server/gpu/`, `server/platform/supply.js`),
batches, deep dives, memory and the `ai.run.*` events.

Does **not** own: publication (it drafts/evidences), the recordings it analyses (OpenVibe.Media),
identity (OpenVibe.Network), or the meaning of a product's prompt (each workflow's owner).

## Who calls it, and whom it calls

- Callers: every first-party product, with an OpenVibe.Network **service token** audience
  `openvibe.ai` and the route's capability (`ai.run.create`, `ai.workflow.manage`, `ai.app.run`, …).
  Live (`AI_SERVICE=remote`), Network (footer site copy), Actor (model routing), Blog (devblog
  agent), Exchange pages and developer apps are the current callers.
- Depends on: PostgreSQL 18 through `openvibe-sdk/db`; Network (`server/auth.js`: JWKS, service
  tokens, SSO for the console); Events (`ai.run.queued|succeeded|failed|cached` outbox, and the
  `bench.rating.changed` subscription); Bench (ratings/cost boards for routed evidence); Media
  (recordings read over allow-listed https/signed URLs); Bot (`bot.machine.ai` for a person's own
  machine); provider APIs, whisper.cpp and `openvibe-llm.service` on this host.

## Repository map

- **Entry:** [server/index.js](server/index.js) — `start()` wires config, database, registry, provider
  pool, cache, quotas, runs, engine, auth, subscriptions and telemetry; also what tests call.
- **App:** [server/app.js](server/app.js) — Express middleware, CSP headers, CORS for the public
  reads, the `/api/v1`, `/internal`, `/you`, `/console` mounts, `/shared`, legal pages.
- **Config:** [server/config.js](server/config.js) — pure `load(env)`; secrets are only ever read by
  **name** through `secretRef()`.
- **Database:** [server/db.js](server/db.js) opens/migrates `ov_ai`; schema in
  [migrations/](migrations/) (currently `0001_initial.sql` … `0081_deep_dives.sql`).
- **Auth:** [server/auth.js](server/auth.js) — `openvibe-contracts` `serviceAuth` + capabilities; the
  JWKS key comes from `openvibe-sdk/auth`. Person sessions in [server/person-session.js](server/person-session.js).
- **API:** [server/api/](server/api/) — `runs.js`, `admin.js`, `exchange.js`, `openai.js`,
  `messages.js` (Anthropic-compatible), `models.js`, `credential.js`, `batches.js`, `actions.js`.
- **Workflows:** [server/workflows/engine.js](server/workflows/engine.js), definitions and seed in
  [server/workflows/](server/workflows/).
- **Providers:** [server/providers/](server/providers/) — adapters, pool, circuits, fallbacks.
- **Registry/run state:** [server/registry.js](server/registry.js), [server/runs.js](server/runs.js),
  [server/cache.js](server/cache.js), [server/quota.js](server/quota.js).
- **Public pages:** [server/home.js](server/home.js), [server/openapi.js](server/openapi.js);
  server-rendered run receipts in [server/run-pages.js](server/run-pages.js).
- **Console:** [server/console/](server/console/) — operator console, Network staff only.
- **Capture worker:** [server/capture/worker.js](server/capture/worker.js) — headless Chrome for deep
  dives, separate unit `openvibe-ai-capture.service` on `127.0.0.1:4711`.

## Commands

```bash
npm install                # or npm ci
cp .env.example .env
npm run dev                # NODE_ENV=development, http://localhost:4700
npm start                  # node server/index.js
npm test                   # every test/*.test.js
npm test -- quota cache    # only files whose name contains one of the words
ov test                    # the harness's sharded run of what the change reaches
node --check <file.js>     # syntax check; no linter/formatter configured
```

Without a provider key everything falls back to the deterministic stub provider, so no test needs the
network or a paid key.

## Database and migrations

PostgreSQL database `ov_ai` on the host's data role (ADR-035). Without `DATABASE_URL`, development and
tests use embedded PGlite. Every read/write is async through `openvibe-sdk/db`; an INSERT that needs
its id uses `RETURNING id`. Migrations are `migrations/NNNN_name.sql`, applied at boot; **never edit a
migration that has run** — `ov_migrations` records its checksum (see
[docs/cutover-pr-openvibe-ai-15.md](docs/cutover-pr-openvibe-ai-15.md)). Add a new number instead.
Migrations only add tables and columns.

## Auth and capabilities

Every API route needs a Network service token for audience `openvibe.ai`, the route's capability and,
for runs, a namespace the token's `ns` claim allows (namespaces fail closed). Capability ids are
decided by the **pinned** `openvibe-contracts` release: an unknown id is refused, never allowed. The
operator console is Network staff only and needs `AI_CONSOLE_SESSION_SECRET` and
`OV_OAUTH_CLIENT_SECRET`; person routes under `/api/v1/me/*` accept only the person's own token or
AI's same-origin session — never a service token or `on_behalf_of`. Developer-app tokens
(`sub app:app_<ULID>`) are accepted **only** on `ai.app.run` routes and act as their project.

## HTTP surface (short)

- Service-to-service: `POST /api/v1/runs`, `GET /api/v1/runs/:id`, workflows, providers, models,
  credentials, quotas, usage and audit under `/api/v1/*`.
- Developer apps: `POST /api/v1/{chat,generate,summarize,classify,extract,embed}` and
  `GET /api/v1/runs/:id`, rate-limited per address on the public vhost.
- Exchange: the OpenAI-compatible `POST /v1/chat/completions` and Anthropic-compatible
  `POST /v1/messages`, model lists, read APIs and `/openapi.json`, served on
  `api.openvibe.exchange`.
- Health: `/api/health`, `/api/ready`; `/metrics` for direct loopback callers only.

## Frontend loading model

There is **no SPA and no build step**. Human pages are server-rendered strings with the console's
classes and CSP (no external script on run receipts); the public human pages moved to
OpenVibe.Exchange in 2026-11-07 and this service 301s them by name. `/shared/*` is served from the
pinned `openvibe-shared` package in `node_modules` by `openvibe-shared/serve`. Never edit
`node_modules`; change the package and bump the pinned release.

## Deploy

`sudo ovhost deploy ai` (strategy `git-checkout`): fetch, fast-forward `/opt/openvibe.ai`, install on
a lockfile change, restart, wait for `/api/ready`, roll back automatically on failure. Unit
`openvibe-ai.service`, env `/etc/openvibe/ai.env` (0600), vhost
[deploy/nginx/ai.openvibe.services.conf](deploy/nginx/ai.openvibe.services.conf). The release migrates
`ov_ai` at boot. `sudo ovhost rollback ai --to <sha>`; `sudo ovhost drill ai` for a restore drill.
Never put a secret in a command line, a file or a log.

## Tests

`npm test` runs `test/run.js`, which executes each `test/*.test.js` in its own process through
`openvibe-shared/test-runner` (PGlite by default; `npm run test:pg` uses PostgreSQL). Local servers on
random ports, generated signing keys, the stub provider. A test that cannot run prints
`<label>: skipped (<why>)` and is not counted as passed; `-- --strict` makes a skip fail. Read
`test/README`-style guarantees in the README's "Acceptance" table: every guarantee names its test.
`ov test` is the harness wrapper for the same suite.

## Conventions

- CommonJS (`require`/`module.exports`), 4-space indent, single quotes, semicolons.
- `camelCase` JS, `snake_case` PostgreSQL columns/tables.
- Errors are RFC 9457 `application/problem+json` from `openvibe-contracts` `http`; never return raw
  provider errors or secrets.
- The request log keeps hashes, not prompts; raw prompts and inline images are not stored; cache
  entries never cross requester/actor/target/attribution scope.
- `openvibe-contracts`, `openvibe-sdk` and `openvibe-shared` are pinned release tarballs in
  `package.json`; bump by changing the tag, never by editing installed files.
- CORS: exact origins for `/stats` and `/release.json`, `*` only for the public creation catalogue;
  token and console routes never use that list.

## Key pitfalls

- **Capabilities come from the pinned contracts release.** A feature that adds a capability must bump
  `openvibe-contracts` first, or the route refuses every caller.
- **Namespaces fail closed.** A service token without `ns` runs nothing; do not add a fallback.
- **The public pages are Exchange's.** Do not re-grow HTML here; redirect instead.
- **Never edit an applied migration** (checksum recorded) and never create a table at runtime.
- **Secrets by name only.** `env:NAME` references, AES-256-GCM for people's keys with
  `AI_CREDENTIALS_KEY`; a response or log must never carry a value.
- **Egress is allow-listed.** Media is fetched only from approved OpenVibe https hosts with every DNS
  answer and redirect hop re-checked (`test/ssrf.test.js`).
- **Quotas refuse before any provider call**, with 429 + `Retry-After`; abuse limits and the free
  allowance run before metered capacity.
- **`/metrics` is host-local.** Do not expose it on the public vhost.
- **The capture worker is separate on purpose** (memory cap, one browser); a page that eats memory
  must not take the API down.
- **Docs drift:** the README's "Depends on" version list can lag `package.json`; `package.json` is
  what runs.

## Documentation

- [README.md](README.md) — the full product, API and acceptance record.
- [docs/migration.md](docs/migration.md) — cutover from Live and the `ov_ai` layout.
- [docs/abuse-prevention.md](docs/abuse-prevention.md) — trust tiers, device cookie, proof of work.
- [docs/provider-matrix.md](docs/provider-matrix.md) — what may be resold and what is UNVERIFIED.
- [docs/provider-adapters.md](docs/provider-adapters.md), [docs/provider-registry.md](docs/provider-registry.md).
- [docs/ai-exchange-baseline.md](docs/ai-exchange-baseline.md), [docs/exchange-platform.md](docs/exchange-platform.md).
- [docs/memory-m5.md](docs/memory-m5.md), [docs/private-ai.md](docs/private-ai.md),
  [docs/measured-metrics.md](docs/measured-metrics.md), [docs/deep-dive.md](docs/deep-dive.md).
- Contracts live in OpenVibe.Contracts; the service's own schemes are documented in `README.md`.
