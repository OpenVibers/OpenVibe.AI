# Provider registry

The existing providers table is the authority for provider state, credentials, protocol, priority and capability membership. The seed in server/providers/pool-providers.js and its derived console presets describe defaults; they are not another routing list. An operator can add an OpenAI-compatible endpoint through the existing provider API without writing an adapter.

New provider rows start disabled, including keyless search providers. Existing configured rows keep their status, endpoint, authentication mode and secret reference; legacy catalogue rows without a key are disabled and receive current documented endpoints; keys remain bound to the same origin. Existing model rows, prices, adult policy and routing gates are unchanged. Protocol metadata expands the existing JSON metadata field, so this stage needs no SQL migration. Search adapter identifiers are recorded here; search execution is integrated in the later ordering stage.

Required-provider documentation was checked on 2026-11-10. Meta now documents Model API at api.meta.ai/v1 and explicitly says it does not host Llama; Llama remains available through existing inference vendors. Perplexity uses the Responses-compatible Agent API at /v1. Novita now documents /openai, Together /v1 on api.together.ai, and Hyperbolic /inference/v1 on api.hyperbolic.ai. Existing endpoint bindings are preserved for explicit owner migration. Qwen recommends a workspace-specific Singapore hostname; the legacy international base remains the configurable default. No provider keys or paid calls were used in this verification.

| Provider | API family / adapter | Default base | Models list | Documentation |
|---|---|---|---|---|
| Qwen (Alibaba Model Studio) (qwen) | openai / openai | https://dashscope-intl.aliyuncs.com/compatible-mode/v1 | https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models | [Source](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope) |
| Kimi (Moonshot) (kimi) | openai / openai | https://api.moonshot.ai/v1 | https://api.moonshot.ai/v1/models | [Source](https://platform.moonshot.ai/docs/guide/start-using-kimi-api) |
| GLM (Z.ai) (glm) | openai / openai | https://api.z.ai/api/paas/v4 | https://api.z.ai/api/paas/v4/models | [Source](https://docs.z.ai/guides/overview/quick-start) |
| MiniMax (minimax) | openai / openai | https://api.minimax.io/v1 | https://api.minimax.io/v1/models | [Source](https://platform.minimax.io/docs/api-reference/text-openai-api) |
| DeepInfra (deepinfra) | openai / openai | https://api.deepinfra.com/v1/openai | https://api.deepinfra.com/v1/openai/models | [Source](https://deepinfra.com/docs/openai_api) |
| Novita AI (novita) | openai / openai | https://api.novita.ai/openai | https://api.novita.ai/openai/models | [Source](https://novita.ai/docs/api-reference/model-apis-llm-list-models) |
| Featherless AI (featherless) | openai / openai | https://api.featherless.ai/v1 | https://api.featherless.ai/v1/models | [Source](https://api.featherless.ai/v1/models) |
| Refuseless (the uncensored tier) (refuseless) | openai / openai | https://api.refuseless.com/v1 | https://api.refuseless.com/v1/models | [Source](https://docs.refuseless.com/api/models.md) |
| Abliteration.ai (the uncensored tier) (abliteration) | openai / openai | https://api.abliteration.ai/v1 | https://api.abliteration.ai/v1/models | [Source](https://docs.abliteration.ai/pricing.md) |
| OpenRouter (the last fallback) (openrouter) | openai / openai | https://openrouter.ai/api/v1 | https://openrouter.ai/api/v1/models | [Source](https://openrouter.ai/docs/api-reference/overview) |
| Venice AI (venice) | openai / openai | https://api.venice.ai/api/v1 | https://api.venice.ai/api/v1/models | [Source](https://docs.venice.ai/overview/pricing) |
| abliteratedmodels.cc (abliteratedmodels) | openai / openai | https://api.abliteratedmodels.cc/v1 | https://api.abliteratedmodels.cc/v1/models | [Source](https://abliteratedmodels.cc/es/) |
| UplinkSwitch (uplinkswitch) | openai / openai | https://api.uplinkswitch.ai/v1 | https://api.uplinkswitch.ai/v1/models | [Source](https://uplinkswitch.ai/acceptable-use) |
| Chutes (chutes) | openai / openai | https://llm.chutes.ai/v1 | https://llm.chutes.ai/v1/models | [Source](https://www.chutes.ai/pricing) |
| SiliconFlow (siliconflow) | openai / openai | https://api.siliconflow.com/v1 | https://api.siliconflow.com/v1/models | [Source](https://docs.siliconflow.com/) |
| Nebius Token Factory (nebius) | openai / openai | https://api.tokenfactory.nebius.com/v1 | https://api.tokenfactory.nebius.com/v1/models | [Source](https://docs.tokenfactory.nebius.com/quickstart) |
| Together AI (together) | openai / openai | https://api.together.ai/v1 | https://api.together.ai/v1/models | [Source](https://docs.together.ai/docs/openai-api-compatibility) |
| Fireworks AI (fireworks) | openai / openai | https://api.fireworks.ai/inference/v1 | https://api.fireworks.ai/inference/v1/models | [Source](https://docs.fireworks.ai/tools-sdks/openai-compatibility) |
| Groq (groq) | openai / openai | https://api.groq.com/openai/v1 | https://api.groq.com/openai/v1/models | [Source](https://console.groq.com/docs/openai) |
| Cerebras (cerebras) | openai / openai | https://api.cerebras.ai/v1 | https://api.cerebras.ai/v1/models | [Source](https://inference-docs.cerebras.ai/api-reference/models) |
| SambaNova (sambanova) | openai / openai | https://api.sambanova.ai/v1 | https://api.sambanova.ai/v1/models | [Source](https://docs-prod.sambanova.ai/docs/api-reference/endpoints/model-list) |
| Baseten (baseten) | openai / openai | https://inference.baseten.co/v1 | https://inference.baseten.co/v1/models | [Source](https://www.baseten.co/pricing/) |
| Hyperbolic (hyperbolic) | openai / openai | https://api.hyperbolic.ai/inference/v1 | https://api.hyperbolic.ai/inference/v1/models | [Source](https://docs.hyperbolic.ai/inference/quickstart) |
| Meta Model API (meta) | openai / openai | https://api.meta.ai/v1 | https://api.meta.ai/v1/models | [Source](https://dev.meta.ai/docs/api-reference) |
| DeepSeek (deepseek) | openai / openai | https://api.deepseek.com/v1 | https://api.deepseek.com/v1/models | [Source](https://api-docs.deepseek.com/) |
| Anthropic (anthropic) | anthropic / anthropic | https://api.anthropic.com/v1 | https://api.anthropic.com/v1/models | [Source](https://platform.claude.com/docs/en/api/overview) |
| OpenAI (openai) | openai / openai | https://api.openai.com/v1 | https://api.openai.com/v1/models | [Source](https://platform.openai.com/docs/api-reference/models/list) |
| Google Gemini (gemini) | google / openai | https://generativelanguage.googleapis.com/v1beta/openai | https://generativelanguage.googleapis.com/v1beta/openai/models | [Source](https://ai.google.dev/gemini-api/docs/openai) |
| xAI (xai) | openai / openai | https://api.x.ai/v1 | https://api.x.ai/v1/models | [Source](https://docs.x.ai/docs/api-reference) |
| Mistral (mistral) | openai / openai | https://api.mistral.ai/v1 | https://api.mistral.ai/v1/models | [Source](https://docs.mistral.ai/api) |
| Cohere (cohere) | openai / openai | https://api.cohere.com/compatibility/v1 | https://api.cohere.com/v1/models | [Source](https://docs.cohere.com/docs/compatibility-api) |
| Perplexity (perplexity) | responses / responses | https://api.perplexity.ai/v1 | https://api.perplexity.ai/v1/models | [Source](https://docs.perplexity.ai/docs/agent-api/openai-compatibility) |
| Brave Search (brave) | adapter / http | https://api.search.brave.com/res/v1 | Not applicable | [Source](https://api-dashboard.search.brave.com/documentation/services/web-search) |
| Tavily (tavily) | adapter / http | https://api.tavily.com | Not applicable | [Source](https://docs.tavily.com/documentation/api-reference/endpoint/search) |
| Exa (exa) | adapter / http | https://api.exa.ai | Not applicable | [Source](https://docs.exa.ai/reference/search) |
| Serper (serper) | adapter / http | https://google.serper.dev | Not applicable | [Source](https://serper.dev/) |
| Jina (jina) | adapter / http | https://s.jina.ai | Not applicable | [Source](https://jina.ai/reader/) |
| SearXNG (searxng) | adapter / http | Owner-configured | Not applicable | [Source](https://docs.searxng.org/dev/search_api.html) |
| Openverse (openverse) | adapter / http | https://api.openverse.org/v1 | Not applicable | [Source](https://api.openverse.org/) |
| Wikimedia Commons (commons) | adapter / http | https://commons.wikimedia.org/w/api.php | Not applicable | [Source](https://www.mediawiki.org/wiki/API:Search) |
| Parasail (parasail) | openai / openai | https://api.parasail.io/v1 | https://api.parasail.io/v1/models (key required) | [Source](https://docs.parasail.io/parasail-docs/products/overview/models) |
| Particle AI (particle-ai) | openai / openai | https://api.particle.ai/v1 | https://api.particle.ai/v1/models (key required) | [Source](https://docs.particle.ai/) |
| Inference.net (inference-net) | openai / openai | https://api.inference.net/v1 | https://api.inference.net/v1/models (keyless) | [Source](https://docs.inference.net/) |
| AtlasCloud (atlas-cloud) | openai / openai | https://api.atlascloud.ai/v1 | https://api.atlascloud.ai/v1/models (keyless) | [Source](https://www.atlascloud.ai/docs) |
| Avian (avian) | openai / openai | https://api.avian.io/v1 | https://api.avian.io/v1/models (keyless) | [Source](https://avian.io/docs/) |
| NanoGPT (nanogpt) | openai / openai | https://api.nano-gpt.com/v1 | https://api.nano-gpt.com/v1/models (keyless, no prices) | [Source](https://nano-gpt.com/pricing) |
| Infermatic (infermatic) | openai / openai | https://api.totalgpt.ai/v1 | https://api.totalgpt.ai/v1/models (key required) | [Source](https://ui.infermatic.ai/docs) |
| ArliAI (arliai) | openai / openai | https://api.arliai.com/v1 | https://api.arliai.com/model/all (keyless) | [Source](https://www.arliai.com/) |
| Friendli (friendli) | openai / openai | https://api.friendli.ai/serverless/v1 | https://api.friendli.ai/serverless/v1/models (keyless) | [Source](https://friendli.ai/docs/guides/model-apis/introduction) |
| Scaleway (scaleway) | openai / openai | https://api.scaleway.ai/v1 | https://api.scaleway.ai/v1/models (key required) | [Source](https://www.scaleway.com/en/developers/api/generative-apis) |

Search capabilities use web-search and image-search, matching the shared placement capability syntax. Brave web and images share one provider/key, as do Serper web and images. Openverse and Wikimedia Commons require no key. SearXNG has no invented public address; the owner supplies their self-hosted base.

Cheap hosted inference (2026-11-10, owner request): the ten providers added at the end of the table are seeded disabled with a `vault:<key>` slot and no key, exactly like the existing pool rows, so they take part in model sync, circuits, failover order and capability memberships as soon as the owner puts a key in the console and enables them. The catalogue sync (`server/providers/catalog.js`) reads the per-token prices each model list carries and imports them into new models (Inference.net, AtlasCloud and Friendli carry per-token strings; the price book only reads per-1M figures, so it stays out of these lists). Parasail, Particle AI, Infermatic and Scaleway need a key for their model lists, so sync runs after the owner adds one; NanoGPT's list carries no prices, and Avian publishes per-million figures the existing parsers cannot read — both stay on the owner's price panel. Skipped, not guessed: kluster.ai (services sunset 2026-06-09), Lambda's hosted inference (winding down; `api.lambda.com` does not answer), Targon (`api.targon.com/v1/models` answers 410 Gone), GMI Cloud, nCompass and Crusoe (no docs-confirmed plain OpenAI chat base URL today), Mancer (its model list carries credit-unit prices whose dollar value nobody has verified; sync would import them as per-token dollars), and OVHcloud AI Endpoints (per-model regional URLs under `endpoints.kepler.ai.cloud.ovh.net`, no single base URL). Two research notes disagree with the live docs and the docs win: Infermatic's base is `api.totalgpt.ai/v1`, not `ui.infermatic.ai/v1` (prices.json), and Friendli's serverless base `api.friendli.ai/serverless/v1` is published in its docs today.

For Fable: the existing providers console now receives all seeded provider rows and protocol metadata. Its visual grouping and capability presentation remain for the main session.

Owner key controls use the existing encrypted `ai.provider_keys` store. The console JSON exposes only presence,
the last four characters and the stored date. Saving or replacing a key makes no provider request. Deleting a key
disables the provider and clears its secret reference before removing the encrypted value; it does not fall back
to an environment key. The separate Setup panel retains its existing environment-fallback behavior.

`POST /api/v1/admin/console/providers/:key/check` performs at most one request and never enables the provider.
It uses the model-list endpoint, a minimal search for search-only adapters, or a registered read-only account
endpoint: [OpenRouter's current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
and [Tavily usage](https://docs.tavily.com/documentation/api-reference/endpoint/usage). There are no retries,
redirects, generated tokens or automatic checks when a key is saved. Only HTTP status, a safe error code,
latency and check time are stored; no upstream response text is logged or returned. A model-list check confirms
endpoint access, not that a particular model can run. Missing keys result in zero requests.

For Fable: key marker/date, explicit check button, check status/latency and remove-and-disable controls in each provider.

Model discovery uses the existing `providers/catalog.js` sync and the existing `models` table. The registered
models endpoint is authoritative, uses the provider's authentication on its bound origin, and must return a complete
list before removals are considered. A provider can sync from the console or on an hourly, six-hour or daily
schedule. Schedules start off and only run for active providers. Duplicate syncs for one provider are refused.
`provider_model_syncs` records results, counts and safe error codes, never upstream bodies. Console reads return
the most recent 50 results. Lists support root arrays and token pagination, including
[Cohere's page token protocol](https://docs.cohere.com/reference/list-models).

New models are disabled unless the owner selects `auto_list_new_models`. Uncensored models always arrive disabled,
carry their 18+ floor and continue through the existing adult policy gate. Previously listed models that disappear
are retained disabled with `missing_since`; a model that returns stays disabled until explicitly enabled. Invalid
or incomplete listings never retire models. Owner names, content tiers, prices and price-book decisions survive
sync and boot-time seeding. The existing owner price override remains the charged rate.

The provider list can supply token prices directly. Missing prices and context use the already cached
[models.dev data](https://models.dev/) and [OpenRouter public list](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
Prices are taken only from the matching provider, retain their source and date, and never replace a known price.
Another reseller's price is not used as a provider's cost. Missing fields stay null; stale enrichment never fills a
price. The public metadata cache is reused for both sources and never receives a provider key.

Owner API: `POST /api/v1/admin/console/providers/:key/sync`, `POST .../:key/model-settings`,
`GET /api/v1/admin/console/models?provider=:key`, and `GET /api/v1/admin/console/sync`. Model settings use the existing
`PATCH /api/v1/models/:provider/:model` with display name, status, content tier and owner price override.

For Fable: provider model links, sync button/schedule and automatic-listing preference; per-provider models with
name, content tier, gone state and price provenance; the model sync log. Added controls are plain kit markup.
