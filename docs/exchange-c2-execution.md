# Exchange compatible requests

POST `/v1/chat/completions` and `/v1/messages` accept `provider` with `order`,
`only`, `ignore`, `allow_fallbacks`, `sort`, `max_price`, `data_collection`, and `zdr`.
`models` is an ordered list of model fallbacks (at most eight distinct models,
including `model`). Each model's eligible providers are tried before the next
model. A streamed answer cannot be followed by another model after output starts.
All attempts remain one run and one Exchange key hold. Idempotent replays do not
reserve or call a provider again. Every requested fallback must be allowed by the key.

Sorts are `price`, `throughput`, `latency`, `quality`, `value`. Quality reads the
Bench board ratings shown by Report, through AI's existing `bench.rating.changed`
evidence store. Value divides that rating by the sum of input and output USD per
million tokens. Provisional ratings and ratings without confidence intervals are excluded. Throughput and latency use measured decode tokens/second and TTFT. Missing
quality or speed evidence excludes the offer. Price and privacy limits fail closed.
`max_price.prompt` and `max_price.completion` are USD per million tokens.
`data_collection: "deny"` requires declared no-training; `zdr: true` requires no retention.
`:free` requires both prices to be zero, `:floor` sorts by price, and `:nitro` by throughput.
Explicit credentials and only-my-keys mode cannot currently combine with this routing;
they return a validation error. Network routing does not silently bypass those policies.

`usage: { "include": true }` adds `cost` (USD), `latency` (milliseconds), and `provider`
to token usage, including the final chat stream usage. `GET /v1/generation?id=<id>`
returns `{ data: { id, model, provider, cost, total_cost, latency, tokens_prompt,
tokens_completion, created_at } }` only to the original requester. It accepts the run
id or the chat/message response id; another owner's id returns 404.

A person token can save via `POST /v1/presets/import` or
`POST /api/v1/exchange/presets`, list via `GET /api/v1/exchange/presets`, and delete
via `DELETE /api/v1/exchange/presets/:name`. Exchange inference keys never authorize
provisioning. Names are per person and invoked as `model: "@preset/name"`.
The saved model, fallbacks, system prompt, provider policy, and sampling defaults
are applied before key model checks and billing admission. Request fields override
saved sampling/routing fields. Preset edits change the idempotent request fingerprint.
`POST /v1/presets/import/preview` remains write-free and redacts submitted values.

`POST /v1/completions` supports one string prompt and streaming through chat completions.
`POST /v1/embeddings` supports strings/string arrays with float vectors (no token-id
arrays or dimension override). `POST /v1/images/generations` uses the existing image
adapter and requires a configured non-metered image route; paid image calls are
refused until per-image accounting is wired; no provider is enabled by this change.
`GET /v1/models` adds pricing as USD per token strings, context length, architecture,
and top-provider limits to catalogue model entries. Unknown prices remain null.

Tests use loopback fixture servers only. No production data or paid provider calls.
