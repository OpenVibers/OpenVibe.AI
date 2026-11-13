# Exchange search engines

`POST /v1/search`, `/v1/search/images`, `/v1/search/icons`, `/v1/search/reverse-image`, `/v1/search/images/unsplash/download` and `/v1/fetch` use the existing Exchange key, person, service or app authentication. The routes and JSON schemas are in `/openapi.json`. Search responses validate against `exchange.search-result@1` and `exchange.image-result@1`. Contracts **0.399.0** carries the search receipts and their optional ordered attempts. Reverse-image and download responses validate against the existing `exchange.image-result@1` and a small `{tracked, already}` object; no new catalog schema is added here.

The icons route also takes the first-party capability `exchange.search.icons` (Contracts **0.407.0**): a service holding it and nothing else reaches `/v1/search/icons` and gets its own free-search bucket (`AI_EXCHANGE_ICONS_RPM`, 60 calls a minute by default), never web, image or fetch search. OpenVibe.Design holds it for the references shown beside a glyph draft, so no Exchange key is needed there.

```json
{"q":"solar lantern","engine":"auto","freshness":"month","limit":10,"max_cost_usd":0.01}
```

Search requires a nonblank query of up to 500 characters (DeepSeek supports 128, including its date operator). Limit is 1–50; provider result limits may be lower. Freshness is `day`, `month` or `year`; auto considers only engines that support it. Image filters include `license`, `commercial`, `size`, `orientation`, `format`, `color`, `after`, `type: "icon"`, icon `set` and `style`; web adds `freshness`, and `safe_search: "strict"` is available where an engine can honour it. Network/language filters are not yet part of the request shape. Size uses the longest side: small below 800px, medium 800–1999px, large at least 2000px. Unknown dimensions or licences never satisfy corresponding filters.

Each engine card carries a `filters` map whose values are `native` (the provider applies it), `local` (the router filters the returned rows) or `unsupported`. A requested filter an explicit engine cannot honour is refused with 422 and the filter name; on auto it is skipped and the receipt has `unsupported`. A licence or safe-search filter is never silently dropped. `GET /api/v1/exchange/search/engines` also names `upstreams` (Google, Bing, Yandex, SearXNG, etc.), `included_allowance`, `onboarding` and whether an engine accepts an image `uploads`.

Every response has `receipt: {engine, cost_usd, time_ms, attempts?}`. Every result has `rank` (OpenVibe's order) and `upstream_rank` (the provider's own position); image rows also name their `upstream`. Cost is the provider cost in USD, and time includes fallback attempts. `attempts` lists each engine in the order it was considered: `provider`, `engine`, `status` (`ok`, `error` or `skipped`), a safe `reason` (`disabled`, `unsupported`, `no_credentials`, `circuit_open`, `daily_cap`, `budget`, `timeout`, `upstream_error` or `invalid_response`), its `time_ms` and its `cost_usd`. Never an upstream error body or a credential. A provider turned off by its owner, one in cooldown and one over `max_cost_usd` stay in that list as skipped with their reason. A personal key has **zero Exchange charge and zero fee**, even though the receipt still shows the upstream cost. Shared-key cost is settled against the Exchange key's monthly cap; concurrent searches reserve their potential costs before calling. `max_cost_usd` caps provider cost for either key source. Free allowances and volume discounts are excluded from the baseline tariff. A timeout or malformed successful response can already have cost money: its ceiling is conservatively counted before any fallback; known HTTP rejections cost zero. If all attempts fail, the known/conservative charge still settles. No test or key-save operation makes a paid call.

Auto first selects the authenticated person's eligible stored keys, then sorts by price and skips unhealthy engines. Without a personal key, it sorts configured shared engines by price. A failure cools that engine/key down for 60 seconds; a person's bad key cannot poison shared-engine health. Once personal keys are selected, failure never switches to shared keys. An explicit engine may be retried during cooldown. Free engines are therefore usually preferred for unrestricted shared-key searches; select an engine explicitly to compare providers.

## Configuration and prices

Prices checked **2026-11-09** (the new image adapters **2026-11-13**), USD per 1,000 requests unless qualified. `GET /api/v1/exchange/search/engines` exposes availability of shared keys, BYOK capability, supported freshness, health, tariff, source and check date, plus the filter support map, upstreams, included allowance and onboarding state. A keyed adapter is unavailable without its own key. Provider accounts and keys must already exist. The new migrations only add the provider-side event table and widen the existing encrypted credential store's provider allowlist.

| Engine ID | Shared key environment variable | Baseline tariff | Public source |
|---|---|---|---|
| deepseek | SEARCH_DEEPSEEK_KEY | $0.75 search; $0.75 fetch; empty searches are free | [DeepSeek](https://api-docs.deepseek.com/guides/search/) |
| brave | SEARCH_BRAVE_KEY | $5 | [Brave](https://api-dashboard.search.brave.com/app/plans) |
| exa | SEARCH_EXA_KEY | $7 auto search with up to 10 results; $1 per 1,000 additional results | [Exa](https://exa.ai/docs/admin/pricing) |
| tavily | SEARCH_TAVILY_KEY | $8 basic, one credit; pay as you go | [Tavily](https://www.tavily.com/pricing) |
| serper | SEARCH_SERPER_KEY | $1, starter prepaid $50/50,000 pack | [Serper](https://serper.dev/) |
| serpapi | SEARCH_SERPAPI_KEY | $25, starter $25/month for 1,000 | [SerpAPI](https://serpapi.com/pricing) |
| jina | SEARCH_JINA_KEY | Search from $0.50; reader $0.05/M tokens | [Jina Reader](https://jina.ai/reader/#apiform), [public product table](https://dash.jina.ai/api/v1/product) |
| perplexity | SEARCH_PERPLEXITY_KEY | No flat answer price: Sonar $0.25/M input, $2.50/M output, $0.0625/M cached; web search $2.50/1,000 tool calls | [pricing](https://docs.perplexity.ai/docs/getting-started/pricing), [Sonar model rates](https://docs.perplexity.ai/docs/agent-api/models) |
| kagi | SEARCH_KAGI_KEY | $25 on the documented legacy v0 API | [Kagi](https://help.kagi.com/kagi/api/search-legacy.html) |
| google | SEARCH_GOOGLE_KEY | $5 after the daily free allowance; also requires SEARCH_GOOGLE_CX | [Google](https://developers.google.com/custom-search/v1/overview) |
| unsplash | SEARCH_UNSPLASH_KEY | $0 | [Unsplash](https://unsplash.com/developers) |
| pexels | SEARCH_PEXELS_KEY | $0 | [Pexels](https://www.pexels.com/api/) |
| pixabay | SEARCH_PIXABAY_KEY | $0 | [Pixabay](https://pixabay.com/api/docs/) |
| brave-images | SEARCH_BRAVE_IMAGES_KEY | $5 | [Brave](https://api-dashboard.search.brave.com/app/plans) |
| serper-images | SEARCH_SERPER_KEY | $1, shares the Serper pack | [Serper](https://serper.dev/) |
| meta | SEARCH_META_KEY | Muse Spark 1.3 tokens plus $2.50/1,000 queries | [Meta](https://dev.meta.ai/docs/pricing-rate-limits) |
| serpapi-images | SEARCH_SERPAPI_KEY | $25; shares the SerpApi allowance | [SerpApi](https://serpapi.com/google-images-api) |
| serpapi-reverse | SEARCH_SERPAPI_KEY | $25; separate Google Reverse Image operation | [SerpApi](https://serpapi.com/google-reverse-image) |
| searchapi-images | SEARCH_SEARCHAPI_KEY | $4 ($40/month for 10,000); 100 trial | [SearchAPI](https://www.searchapi.io/docs/google-images) |
| tineye | SEARCH_TINEYE_KEY | $40 (example $200 per 5,000; verify) | [TinEye](https://api.tineye.com/python/docs/) |

Jina's current displayed $50/1B token pack is $0.05/M; search starts at 10,000 tokens. Receipts use returned usage, with a 100,000-token request budget ($0.005 ceiling). Perplexity uses the current Agent API with `perplexity/sonar`, web search enabled, at most three steps and 1,024 output tokens; its conservative admission ceiling is $0.10. The receipt uses `usage.cost.total_cost`. Its answer is retained in the snippet of each returned source. Google is closed to new customers and ends 2027-01-01; Pexels currently pauses new key issuance. Kagi uses the still-documented v0 endpoint and its corresponding tariff.

Meta web search uses the Responses API with Muse Spark 1.3, one built-in query and `store: false`; it is explicit selection only (`engine: "meta"`) and reserves a $4 ceiling for the bounded call. Serper image search uses `/images`, shares the Serper credential, and is also explicit selection only (`engine: "serper-images"`).

The existing free engines remain: Openverse, Wikimedia Commons, Iconify, OpenVibe Search, and operator-configured SearXNG (`EXCHANGE_SEARXNG_URL`). Free direct fetching is `openvibe-egress`. Each adapter provides its own metadata instead of the router inventing a zero price or disabling BYOK.

## Personal keys

Use the same person authentication and origin rules as `/api/v1/me/credentials`:

- `PUT /api/v1/me/search-credentials/:engine` with `{"key":"<your existing engine key>"}` stores/replaces a key without testing it or spending a search.
- `GET /api/v1/me/search-credentials` lists stored engine IDs and update dates, never keys.
- `DELETE /api/v1/me/search-credentials/:engine` removes it.

Keys use the existing AES-256-GCM store and encryption configuration, bound to `self|subject|search-engine`. The new provider IDs `search-searchapi` and `search-tineye` are added by migration `0086_search_image_credentials.sql`; SerpApi Images and its reverse operation reuse `search-serpapi`. Brave web/images share the personal `brave` credential. Search keys are excluded from model credential listings/routing. A service/app cannot choose somebody else's key by submitting `subject` or `on_behalf_of`; only an authenticated person or their Exchange key reaches their own search keys. Secret-bearing management routes stay outside the public OpenAPI document, following the existing credential-route rule.

## Images and fetch

Image rows carry a source page, thumbnail, full image URL, width/height where supplied, licence, licence URL, author and attribution. Missing rights/creator data is null, especially for Brave's, Serper's, SerpApi's and SearchAPI's indexed images. Preserve provider attribution and links.

**Unsplash.** Use `POST /v1/search/images/unsplash/download` with the result's `download_location` when a person chooses or imports a picture, never for every search result. The subject and URL are the idempotency key (`search_asset_events`), so a repeat returns `already: true` without a second upstream event. The server uses the person's stored Unsplash key when present, otherwise the shared key, and only calls `api.unsplash.com/photos/…/download`.

**Pixabay.** The adapter caches the parsed answer for 24 hours per key (hashed) and query. Its result URLs point at `GET /v1/search/images/pixabay/:id`, a short-lived byte proxy backed by the cached Pixabay image record; no permanent Pixabay CDN URL is returned. **Pexels.** Existing keys still work, but it is marked `onboarding: "paused"` and the pages say new keys are not offered while issuance is paused.

**SerpApi Images and reverse.** `serpapi-images` is Google Images; `serpapi-reverse` is Google Reverse Image as a separate `reverse_image` operation, sharing the `search-serpapi` personal key. **SearchAPI.io** is one supplier (`searchapi-images`) with `upstream: google|bing|yandex`; the chosen engine is sent and every row names it. **TinEye** (`tineye`) accepts `image_url` or a base64 image `image` upload (PNG/JPEG/GIF/BMP/TIFF/WebP, 5 MB decoded) and returns matches with their backlink pages. Reverse image is explicit selection only and is never a keyword search.

Fetch accepts `{"url":"https://example.org/article","engine":"auto"}`; choose `deepseek`, `jina` or `openvibe-egress` explicitly. Auto prefers an eligible personal reader key, otherwise free local egress. The local reader returns stripped text; Jina/DeepSeek return Markdown. Output is capped at 200,000 characters.

Every provider API call uses a module-owned host allowlist, HTTPS, disabled redirects, a deadline, and the existing guarded fetcher (public addresses checked at connect time, 8 MiB response limit). Only `/v1/fetch` accepts a target URL; remote-reader targets pass the same public DNS/address guard before submission. Remote fetch redirects and page execution take place at the provider and remain subject to that provider's security rules. SearXNG's fixed origin is operator configuration, never request input. Keys, upstream error bodies and credential-bearing query strings are never returned in errors.

`ov test search-adapters search-image-adapters search-download-event search-routing search-attempts exchange-platform openapi me-credentials credentials ssrf` uses saved synthetic answers in `test/fixtures/search/` and injected transports; it needs no provider accounts, keys or internet access.
