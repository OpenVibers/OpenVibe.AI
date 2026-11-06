# Managed provider adapters (the Exchange remake, stage 2)

OpenVibe.AI can buy capacity from ten OpenAI-compatible providers. They are ordinary registry providers of kind
`openai` (the existing adapter in `server/providers/openai.js`): no second adapter, no second model list, no second
price table. What is new is the catalogue of providers, models, prices, privacy labels and data policies
(`server/providers/pool-providers.js`) and its seed into the registry (`server/providers/pool-seed.js`).

## Providers

| key | provider | base URL | default model | timeout | privacy |
|---|---|---|---|---|---|
| `qwen` | Qwen (Alibaba Model Studio, compatible mode) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3.8-max` | 60 s | anonymized |
| `kimi` | Kimi (Moonshot) | `https://api.moonshot.ai/v1` | `kimi-k3.1-pro` | 60 s | anonymized |
| `glm` | GLM (Z.ai) | `https://api.z.ai/api/paas/v4` | `glm-5.3-flash` | 60 s | anonymized |
| `minimax` | MiniMax | `https://api.minimax.io/v1` | `MiniMax-M3.1-Flash` | 60 s | anonymized |
| `deepinfra` | DeepInfra | `https://api.deepinfra.com/v1/openai` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 90 s | private |
| `novita` | Novita AI | `https://api.novita.ai/v3/openai` | `deepseek/deepseek-v4.1-flash-1017` | 90 s | anonymized |
| `featherless` | Featherless AI | `https://api.featherless.ai/v1` | `Qwen/Qwen3-14B` | 90 s | anonymized |
| `refuseless` | Refuseless (the uncensored tier) | `https://api.refuseless.com/v1` | `deepseek-v4.1-flash-abliterated` | 60 s | anonymized |
| `abliteration` | Abliteration.ai (the uncensored tier) | `https://api.abliteration.ai/v1` | `abliterated-model-large-flash` | 60 s | private |
| `openrouter` | OpenRouter (the last fallback) | `https://openrouter.ai/api/v1` | `openrouter/auto` | 120 s | anonymized |

`server/workflows/seed.js` seeds them on every boot (idempotent: an owner-edited provider is never overwritten).
Each row's `secret_ref` is `vault:<key>`, so the owner's key goes in Network → owner settings → AI provider keys
(D11 `ai.provider_keys`), bound to the provider's origin. The pool skips a provider whose key does not resolve
(`no_credentials`): a provider without a key is never offered, called or billed. `GET /api/v1/providers`/the console
show the ten; pasting a key turns the adapter on.

## Prices, models and the catalogue

Every price is read on the **provider's own page** — its pricing page or its own model list — never on an
aggregator's. Each price carries that page in `source` and the day it was read in `checked` (2026-11-06). A price
nobody publishes is `null`, never a guess: Refuseless publishes no price at all, so its models carry a null price
rather than a number we cannot stand behind. A tiered price (Alibaba's `qwen3.7-flash`, MiniMax's `MiniMax-M3`)
records the first tier, with the whole ladder written down in the model's `note`.

OpenRouter's hundreds of models are **not** seeded: the catalogue sync reads OpenRouter's own list with the owner's
key (`server/providers/catalog.js` → `applyCatalogPrices`), which prices a row the catalogue knows and retires the
seeded row when the provider lists the same model under its own id.

`streaming`, `tools`, `json` and `vision` are recorded per model; the OpenAI adapter already streams, calls tools and
steps structured output down (`json_schema` → `json_object` → prose). Two more fields travel with every model:

- `quantization` — what the provider states the weights are served in. It is `null` unless the provider says so, and
  none of the ten states it on the pages read on 2026-11-06;
- `refusal_rate` — `null`. It stays null until a provider publishes its own rate or a measurement job of ours owns the
  number. An invented rate is worse than none.

## Privacy

Each provider row carries a privacy label in `metadata.privacy`:

- `private` — the provider's own terms say it keeps nothing and trains on nothing. The wording and the page it was
  read from are recorded next to it. Today that is **DeepInfra** ("We will not store, sell, or train using this data
  unless we have our explicit consent", plus "input data is not stored to disk during inference") and
  **Abliteration.ai** ("Customer prompts, outputs, and attachments are not used to train our models. Prompts and
  responses are processed transiently and are not stored.");
- `anonymized` — everyone else, including the providers whose privacy page could not be read at all. Featherless is
  here even though it says it does not store prompts or completions: its policy never says they are not trained on,
  and the rule is that a provider is `private` only when its terms say both.

The prompt is never published under the person's name, whoever the provider is.

## Data policy

Each provider row records what the provider says it does with a prompt, in `metadata.data_policy`. The facts are the
ones the house reads (`server/exchange/privacy.js`, `server/exchange/catalog.js`): `retention`
(`none` / `limited` / `standard`), `trains` and `training` (a boolean), `region`, `anonymized` and `trust`
(`first-party` / `community`). A fact the provider did not state is null, never a guess: an offer that declares
nothing is labelled `anonymized` and says that it is unknown. Beside them the catalogue keeps its own record:
`retention_note` (the provider's own words), `terms_url`, `resale`, `checked` and `source`. The pages are in
`server/providers/pool-providers.js` next to each provider; the catalogue surfaces them on a model's page.

These facts are what the label on every answer is built from: DeepInfra and Abliteration.ai keep nothing and train
on nothing, so their answers are `private`; the rest are `anonymized`.

## Errors

Errors are the adapter's typed `ProviderError`s (`provider.auth`, `provider.rate_limited`, `provider.timeout`,
`provider.output`, …), and the pool's circuit breaker and fallback chain handle them unchanged. One state has its own
name: a provider that says the account has run out of money is **exhausted** (Refuseless answers 402
`insufficient_credits`; the others say it in their own words). Reading that answer is the empty-failover work's,
which is on main now (#315): it opens the long circuit, fails over and answers 503 `ai.resting`. This catalogue
records the prices, the models and the labels; it does not repeat that circuit.

## Commercial access

`provider_access` is the existing gate (`server/providers/model-catalog.js`): only `OWN_DEPLOYMENT` and
`AUTHORIZED_WHOLESALE` offers may serve managed paid routes. The seed records the commercial position from the
2026-11-03 provider matrix:

- `featherless` — `AUTHORIZED_WHOLESALE`, Scale plans only (it needs the executed Scale agreement);
- `deepinfra` — `RESTRICTED` (its terms §11(a)(viii) forbid resale without an agreement);
- every other provider — `UNVERIFIED`.

The owner raises a provider's access mode only after the agreement that allows it. Until then the provider can be
catalogued and its key stored, but the router does not resell it.

## The uncensored offers

Refuseless, Abliteration.ai and the abliterated models Featherless lists are marked `uncensored: true` in the
catalogue. The tier that lets an 18+ account ask for such an offer — the gate, the hard floor and the label on every
answer — is a separate change (its own PR); this one only records which offers are marked.
