# Managed provider adapters (the Exchange remake, stage 2)

OpenVibe.AI can buy capacity from nine OpenAI-compatible providers. They are ordinary registry providers of kind
`openai` (the existing adapter in `server/providers/openai.js`): no second adapter, no second model list, no second
price table. What is new is the catalogue of providers, models, prices and data policies
(`server/providers/pool-providers.js`) and its seed into the registry (`server/providers/pool-seed.js`).

## Providers

| key | provider | base URL | default model | timeout |
|---|---|---|---|---|
| `qwen` | Qwen (Alibaba Model Studio, compatible mode) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3.8-max` | 60 s |
| `kimi` | Kimi (Moonshot) | `https://api.moonshot.ai/v1` | `kimi-k3.1-pro` | 60 s |
| `glm` | GLM (Z.ai) | `https://api.z.ai/api/paas/v4` | `glm-5.3-flash` | 60 s |
| `minimax` | MiniMax | `https://api.minimax.io/v1` | `MiniMax-M3.1-Flash` | 60 s |
| `deepinfra` | DeepInfra | `https://api.deepinfra.com/v1/openai` | `deepseek-v4.1-flash-1017` | 90 s |
| `novita` | Novita AI | `https://api.novita.ai/v3/openai` | `deepseek-v4.1-flash-1017` | 90 s |
| `featherless` | Featherless AI | `https://api.featherless.ai/v1` | `Qwen/Qwen3-14B` | 90 s |
| `refuseless` | Refuseless (the uncensored tier) | `https://api.refuseless.com/v1` | `deepseek-v4.1-flash-abliterated` | 60 s |
| `openrouter` | OpenRouter (the last fallback) | `https://openrouter.ai/api/v1` | `openrouter/auto` | 120 s |

`server/workflows/seed.js` seeds them on every boot (idempotent: an owner-edited provider is never overwritten).
Each row's `secret_ref` is `vault:<key>`, so the owner's key goes in Network → owner settings → AI provider keys
(D11 `ai.provider_keys`), bound to the provider's origin. The pool skips a provider whose key does not resolve
(`no_credentials`): a provider without a key is never offered, called or billed. `GET /api/v1/providers`/the console
show the nine; pasting a key turns the adapter on.

## Prices, models and the catalogue

Every price carries the page it was read from and the day it was read (the price book, 2026-10-30; Watch's recorded
lists, 2026-11-04). A model whose price we did not read is left out rather than invented. OpenRouter's hundreds of
models are **not** seeded: the catalogue sync reads OpenRouter's own list with the owner's key
(`server/providers/catalog.js` → `applyCatalogPrices`), which prices a row the catalogue knows and retires the
seeded row when the provider lists the same model under its own id.

`streaming`, `tools`, `json` and `vision` are recorded per model; the OpenAI adapter already streams, calls tools and
steps structured output down (`json_schema` → `json_object` → prose). Errors are the adapter's typed
`ProviderError`s (`provider.auth`, `provider.rate_limited`, `provider.timeout`, `provider.output`, …), and the pool's
circuit breaker and fallback chain handle them unchanged.

## Data policy

Each provider row records what the provider says it does with a prompt, in `metadata.data_policy`:
`trains_on_prompts` (`no` / `not_stated` / `unknown` / `provider_dependent`), `retention`, `region`, `terms_url`,
`resale`, `checked` and `source`. The pages are in `server/providers/pool-providers.js` next to each provider; the
catalogue surfaces them on a model's page. A provider whose policy is unknown is still recorded as unknown, never as
"no training".

## Commercial access

`provider_access` is the existing gate (`server/providers/model-catalog.js`): only `OWN_DEPLOYMENT` and
`AUTHORIZED_WHOLESALE` offers may serve managed paid routes. The seed records the commercial position from the
2026-11-03 provider matrix:

- `featherless` — `AUTHORIZED_WHOLESALE`, Scale plans only (it needs the executed Scale agreement);
- `deepinfra` — `RESTRICTED` (its terms §11(a)(viii) forbid resale without an agreement);
- every other provider — `UNVERIFIED`.

The owner raises a provider's access mode only after the agreement that allows it. Until then the provider can be
catalogued and its key stored, but the router does not resell it.

## The uncensored tier

`policy: "uncensored"` is accepted on `POST /v1/chat/completions`, `POST /v1/messages` and `POST /api/v1/runs` (with
`on_behalf_of`). `server/policy/tier.js` admits it only when:

1. the run names the person it is for (`on_behalf_of`, a `usr_` subject) — a developer app never gets it;
2. OpenVibe.Network says that account confirmed it is 18+ (`GET /internal/identity/adult`;
   `server/policy/adult-status.js` caches the answer five minutes and fails closed);
3. the route has an offer marked `uncensored` (Refuseless, or any synced model whose id says `abliterated`);
4. the hard floor (`server/policy/floor.js`) passes on the request **and** the answer: no sexual content involving
   minors, no non-consensual sexual content of real people, no help with weapons of mass harm or attacks on others.
   The floor applies to standard requests too. A streamed answer is checked before each chunk goes out.

An uncensored answer carries the label `Uncensored model — adults only (18+)`: in the run's `output.label` and
`output.policy`, in `x_openvibe.label`/`x_openvibe.policy` on both public APIs, and in the `X-OpenVibe-Content-Policy`
header. A standard request never runs an uncensored offer, even when it is the cheapest.

Network owns the flag: `users.adult_confirmed_at`, set by the person on `/my` → Content (18+ confirmation, with the
hard floor stated), read by AI through `/internal/identity/adult` under `identity.subject.resolve`.
