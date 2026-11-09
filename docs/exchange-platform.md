# Exchange platform APIs

The API host is `https://api.openvibe.exchange` (OpenVibe.AI). Exchange is the human site.

- `GET/POST /api/v1/exchange/keys`: own Network user token; create with `name`, `monthly_cap_usd`, `allowed_models`.
  Creation returns `{key, secret}` once. Lists contain metadata and prefixes only; SHA-256 digests are stored.
- `DELETE /api/v1/exchange/keys/:id`: revoke only a key owned by the signed-in person.
- `GET /api/v1/exchange/key-usage`: private key/model/day usage, at most 1,000 grouped rows.
- `/api/v1/exchange/deployments` aliases the existing private `/api/v1/own-endpoints` APIs and owner gates.
- `POST /v1/search`, `/v1/search/images`, `/v1/search/icons`: `{q, engine?: "auto", limit?: 10}`.
  Receipts contain engine, cost in USD and elapsed milliseconds. Openverse, Commons and Iconify need no key;
  SearXNG requires `EXCHANGE_SEARXNG_URL` on an HTTPS host with JSON search enabled. OpenVibe Search uses its public index.
  Paid engines are not enabled. Unsupported filters return an error rather than silently broadening a licence search.
- `POST /v1/fetch {url}` uses guarded HTTPS egress with pinned public DNS, no redirects, an 8 MB transfer cap and a
  10-second timeout; scripts/styles/HTML tags are removed and output is capped at 200,000 characters.

Exchange inference keys authorize model listing, chat completions, search and fetch only. They cannot manage keys,
read another account's usage, edit operator settings, or create deployments. Inference admission reserves the remaining
monthly cap atomically, allowing one inference call per key at a time. The native `max_cost_usd` liability limit is passed
to the run. A completed receipt settles the reservation; an unreported/failed request consumes the conservative reservation
until reconciled. A disconnected process leaves its reservation locked. Usage labels these rows `reserved` or `unresolved`;
they are not a Billing charge. Free search is zero-cost and limited to 60 calls/minute per authenticated principal.

## GPU supply preview

`GET /api/v1/admin/console/supply` compares yesterday's measured demand with the cheapest recorded reseller rate,
dated GPU prices, measured output throughput (at least 20 requests for that model/GPU), required VRAM and owner ceilings.
The output is always `dry_run: true`; actions are proposals. Both adapter mutations reject even with keys and ceilings.
No provider account is created and no rental API is called by this manager.

`POST /api/v1/admin/console/supply` saves model, runtime (`vllm` or `sglang`), `input_per_million`, `output_per_million`,
`hourly_ceiling_usd`, `monthly_ceiling_usd`, `required_vram_mb`, and `idle_minutes`. Fixed rates update GPU model rate cards,
which are the source for routing, billing estimates, and every catalog listing. Registration of a GPU also reads them.
The runtime and idle timeout are the proposed configuration, not a launched deployment.

The price-book recording endpoint `POST /api/v1/admin/console/supply/quotes {quotes:[...]}` accepts dated public listing
records: `provider` (vast/runpod), `gpu`, `region`, `hourly_usd`, `vram_mb`, `source` (HTTPS), `observed_at` (ISO timestamp).
It requires the same operator capability as provider configuration. The parser reads bytes only. Stale quotes (over seven
days) and missing throughput never cause a rent proposal. Recording listings does not rent anything or contact providers.

Migration 0052 is expand-only. These changes need money/security review before deployment; this PR does not deploy.

## Public market observations

`GET https://api.openvibe.exchange/api/v1/exchange/market` returns
`exchange.market@1` with a 60-second public/process cache. The existing nginx
`/api/v1/exchange/` prefix serves this read. `limit` is 1–500 (default 100);
`next_cursor` continues a page with the same filters (`maker`, `open_weights`,
`kind`). Counts describe the filtered offers; model counts use Report's normalized
model identity (maker prefix and date/channel suffix removed).

The feed combines provider presets, pricebook-owned registry rows and every
own-page observation in `exchange_market_prices`, including disabled and
unregistered models. The weekly pricebook writes observations without enabling
models or approving routing prices. Unknown prices stay null; a pending routing
price change can already be the provider's current advertised price. OpenRouter
cross-reference prices do not become another provider's own-page prices.

Model metadata comes from https://models.dev/api.json (MIT), refreshed on the
first read each day. `exchange_model_metadata` persists the last successful copy;
failed refreshes retain it with `metadata.stale: true` and retry no more than once
per minute. Every known metadata field carries its own source URL. Provider-page
facts take precedence over models.dev. Tests disable live refresh and inject
recorded responses. The market projects public fields explicitly; credentials,
account ids, internal provider metadata and price-change actors are never returned.
