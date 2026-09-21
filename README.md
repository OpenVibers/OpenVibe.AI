# OpenVibe.AI

> Providers, models, routing, prompt templates, workflows, runs, citations, cache and quotas for every product.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `ai.openvibe.network`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.1, §12.13, §34.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

The reusable AI authority extracted from OpenVibe.Live. Products invoke registered, versioned workflows that produce draft/evidence packages; AI never owns publication truth.

## Owns

- providers, models, routing profiles, prompt templates, workflow definitions, runs/jobs, request/completion metadata logs, source documents/citations, cache, quotas/usage, audit (the 11 model groups)
- deterministic no-key stub provider, local HTTP seam, bounded external adapters

## Does not own

- publication decisions (Wiki/Blog/News/… own their revisions)
- source registry policy (shared Sources contract; adapters registered here)

## Planned surfaces

- status/admin, provider/model/route/template/workflow CRUD, run create/list/detail/cancel/retry
- `chat|generate|summarize|classify|extract|enrich|embed` conveniences
- seed workflows: `wiki.generate_*`, `blog.draft_post`, `news.summarize_story|compare_perspectives`, `reviews.summarize_entity`, `deals.enrich_deal`, `coupons.extract_coupon`, `trade.summarize_market_context`, `codes.generate_docs`, `games.generate_lore`, `moderation.classify`

## Data (authority tables / families)

- see above

## Capabilities and events

- `ai.run.create|get|cancel`, `ai.workflow.invoke`, `ai.template.*`

Events: ``ai.run.queued|succeeded|failed|cached``

## Depends on

- OpenVibe.Contracts
- OpenVibe.Events
- OpenVibe.Network (quotas per actor)

## Acceptance (must be true before "done")

- every workflow has versioned input/output schemas and citations
- source failures are explicit states, never fabricated content
- private cache never crosses actor/resource scope
- a degraded primary provider falls back and records that it did

## Bootstrap / extraction source

Live's AI subsystem (chat AI, moments, captions/translation, slogans, SQL/analysis jobs) migrated as workflow adapters; Network's generated-copy dependency on Live is reversed.

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
