# OpenVibe GPUs (the GPU provisioner)

The design (§2 "Our own GPUs", the Exchange remake) asks for a provisioner that rents a GPU from a
marketplace, serves a model on it, registers the endpoint as an offer for the router and scales the
whole thing to zero when nobody is using it - under an owner-set monthly reservation cap.

This is that provisioner. It lives in AI (server/gpu/) and it is **off until the owner has set a
marketplace API key, a monthly cap and a confirmed bound on extra storage/network costs**.

## The owner settings (the namespace `ai.gpus`)

| Key | Class | What it is |
| --- | --- | --- |
| `vast.origin` / `vast.key` | internal / secret (bound to the origin) | the owner's Vast.ai API key, sealed to `https://console.vast.ai` |
| `runpod.origin` / `runpod.key` | internal / secret (bound to the origin) | the owner's RunPod API key, sealed to `https://api.runpod.io` |
| `monthly_cap` | money (`x-danger`, `nano_usd`) | the hard monthly cap. It needs a fresh sign-in to change |
| `idle_minutes` | internal | how long an unused instance stays up (default 10) |
| `max_runtime_minutes` | internal | how long one instance may run at most (default 720) |
| `warm_window` | internal | an optional UTC window ("19:00-23:00") in which idle instances stay up |
| `region` | internal | the region the offers must be in (default US) |

The owner changes them the way every other AI setting changes: through Network's admin panel, which
proxies to AI's `/internal/config/ai.gpus`. The keys are write-only (the panel never shows a value
again), the origins are written by AI, and the cap is a money key.

Without a key **or** without a cap no new instance is rented. Read-only quotes work separately; cleanup of existing instances continues even if the cap is disabled.

## What it does

1. **Cheapest fit.** It searches the marketplace for the offers that fit the model (VRAM, disk,
   reliability, region) and takes the cheapest one. The order is deterministic: the same offers in
   the same order always give the same instance.
2. **Serve.** It rents the offer with the model's image and command (vLLM or llama.cpp with the
   chosen weights) and waits for the endpoint to answer.
3. **Register.** The endpoint becomes a normal provider (`kind: openai`, `provider_access:
   OWN_DEPLOYMENT`) with the model on it, so the router, the Exchange catalogue, the health checks,
   the breaker and the failover all work as they do for every other offer. Nothing new was written
   for the router.
4. **Health.** The endpoint is checked (`/v1/models`). After two failed checks the instance is dead:
   the offer leaves the pool (the router fails over), the instance is given back and a new one is
   rented.
5. **Scale to zero.** An instance that served nobody for `idle_minutes` is given back (unless it is
   inside the warm window). An instance that has run for `max_runtime_minutes` is given back too.
6. **Cold start.** The time from the launch to the first answered request is measured and shown on the
   console page (the design asks for the cold start to be said up front).

## Orphans: an instance we paid for is never lost

The row is written **before** the marketplace is called, and the instance is given the label of that
row (`openvibe-<row id>`). Every pass:

- the marketplace instances that carry our label are listed (Vast: `GET /api/v1/instances`, RunPod:
  `GET /v2/pods`);
- one whose label is a live row of ours is left alone - and **linked** when the row does not know its
  marketplace id yet (a crash between the marketplace's answer and the row's update costs nothing: the
  instance is found by its label and adopted);
- one that no live row of ours owns is an **orphan**: it is given back and the fact is logged
  (`gpu.orphan.destroyed` on the audit log).

A destroy the marketplace refuses leaves the instance running and still being paid for. The try is
counted on the row, the next pass tries again, and after **three** tries the operator is alerted: the
audit row `gpu.orphan.destroy_failed`, the log, and the gauge `ai_gpu_destroy_failures` that the
Host rule `OpenVibeAiGpuInstanceNotDestroyed` pages on
([OpenVibe.Host #303](https://github.com/OpenVibers/OpenVibe.Host/pull/303)).

## The money

The money is integer nano-USD in BigInt, never a float (the same rule AI's Credits follow). Every
instance holds a **reservation** - the budget it may cost - before it starts, and the reservation
is part of the month's committed spend. A new instance is only started when its reservation still
fits under the cap; if it does not, the launch is refused and the reason is returned. The instance is
scheduled for release when its reservation runs out. New reservations cannot pass the cap;
provider deletion failures can continue billing beyond it and require operator intervention.

Vast and RunPod bill **per second**, so the money is charged for the seconds an instance really ran
(the ledger rounds up to the nano, so it never charges less than the GPU was paid for). The console page
shows the price per hour and the price per second next to it.

The ledger is `gpu_spend` (one row per settled instance); the instances, their reservations, their spent
money, their destroy failures and their measured cold start are in `gpu_instances` (migration
`0033_gpu.sql`).

## The console page

`GET https://openvibe.exchange/console/gpus` (the "GPUs" entry in the console) shows whether the provisioner is on and why not,
the spend this month, the committed worst case and the cap, the models with their weights and their
state, the measured cold start (from the launch to the first answered request), and every instance
with its price (the hour and the second), endpoint, cold start and money. "Start" and "Stop" write a request row;
the reconciler (one implementation, the same one the service runs) does the work.

## Public marketplace prices, and what a token costs

The console's GPUs and supply sections also show what the cards cost on the public marketplaces, read from the
providers' own pages by `server/gpu/market.js` (migration `0061_gpu_market_prices.sql`):

| Source | Public page | What it publishes |
| --- | --- | --- |
| Vast.ai | `POST https://console.vast.ai/api/v0/bundles/` | the offer search (on demand and the minimum interruptible bid), with region and reliability |
| RunPod | `https://www.runpod.io/pricing` | the Secure and Community Cloud on-demand columns (neither is a spot quote) |
| Salad | `https://salad.com/pricing/` | High (never preempted) and Lowest (most interruptible) priority tiers |
| TensorDock | `https://www.tensordock.com/` | the public "from" prices for its most popular enterprise cards |
| CloudRift | `https://www.cloudrift.ai/pricing` | on-demand rates; H100 and H200 are quoted on request |

The cards are RTX 3090, RTX 4090, RTX 5090, A100 80GB, H100 and H200. For each one the report gives the lowest
on-demand and the lowest interruptible/spot hour, the provider, the region when the provider states it, the
reliability words or score it publishes, and when it was read. The job signs in nowhere, rents nothing and stops
nothing. It refreshes when due (six hours by default) and is off in tests and under a restore drill. A source that
fails keeps its last rows and is marked `stale`; the console can still show the last known price, labelled.

Both readings and the per-token cost they imply are on the admin API:

- `GET /api/v1/admin/console/gpus`: `state` (the provisioner) plus `market` and `token_costs`;
- `GET /api/v1/admin/console/supply`: the supply report plus the same `market` and `token_costs`;
- `POST /api/v1/admin/console/gpus/prices/refresh`: read the public pages now (operator capability; still no rent).

`token_costs` is one row per catalog model, GPU it fits, price kind and provider reading:

```
USD per million output tokens = hourly USD × 1,000,000 / throughput tokens per hour
```

The throughput and its source are on the row (the catalog's planning estimate today;
`server/gpu/catalog.js`). `is_cheapest` marks the fresh floor for that model, card and kind. Each row also carries
`cheapest_api`: the cheapest published API price for the same model, the same model family and weights
(`same_family_weights`), the same family, or the same uncensored weights. If no comparable API model has a price,
it is `null` rather than a guess. The console only renders this data; the page design stays in Exchange.

Test coverage is `test/gpu-market.test.js` with saved pages in `test/fixtures/gpu-market/`; it makes no live call.

## Your own endpoint (the private rent)

The Exchange's product line 6, "your own endpoint", is the same provisioner with a private rent on top
(`server/gpu/endpoints.js`, migration `0042_own_endpoints.sql`):

- a person picks one of the models above, or brings their own Hugging Face `.gguf` (and an optional
  LoRA), from OpenVibe.Exchange's `/own` page or the person API (`/api/v1/own-endpoints`);
- the reconciler starts it on the cheapest offer that fits, exactly like the shared models, and **never
  registers it as an offer**: the router and the catalogue never see it, and the GPU is reached only
  through AI's proxy at `/api/v1/own-endpoints/:id/v1` with the owner's own Network user token;
- the person's Balance pays for it. Before the marketplace is called, a Billing hold is taken for the
  worst case the rent may cost (the reservation); when it stops, the exact seconds are settled:
  `usage.input_tokens` carries the milliseconds, `retail.version` is `gpu-second@1`, and the per-request
  remainder carries the last nano so the Billing charge equals the GPU ledger's `spent_nano` to the
  nano. Billing is the only place the person is charged; the `gpu_spend` rows are the owner's cost
  record, never the person's charge;
- the idle timer is the endpoint's own (`idle_minutes`, 1-120, default the owner's `idle_minutes`),
  measured from the last proxied request (`gpu_instances.last_used_at`). The maximum run is 120 minutes
  (or the owner's `max_runtime_minutes` when lower), so a start's hold is bounded;
- the owner's monthly cap is checked before the hold: a new start that would pass it is refused with a
  plain reason and nothing is rented.

The feature is off while **any** of the three is missing, and the public
`GET /api/v1/exchange/endpoints` answers the plain reason the Exchange page shows:

1. `ai.gpus` `vast.key` or `runpod.key` (the owner's GPU provider key),
2. `ai.gpus` `monthly_cap` (the monthly reservation cap), plus `costs_bounded=true` and an explicit `extra_hourly_nano`,
3. Balance billing (`AI_CREDITS` and Billing), because an endpoint is paid for per second.

The first two are `x-owner-input` fields (group `GPUs`, `x-required-for: "own endpoints"`) so the admin
panel's Setup tab lists them with what they turn on and where to get them.

## The tests

`test/gpu.test.js` runs the provisioner against the recorded marketplace answers
(`test/fixtures/gpu/vast.json`) and a fake clock:

- it is off without a key and without a cap,
- the cheapest offer that fits is rented, registered as an offer and health-checked,
- a launch that would exceed the monthly reservation cap is refused with a reason,
- an idle instance scales to zero and the money is settled,
- an instance that dies is replaced and the router gets the new endpoint,
- an instance the marketplace accepted before the row knew its id is recovered, not thrown away,
- an instance with our label and no row of ours is found and given back,
- a destroy that keeps failing is tried again every pass and the operator is alerted.

`test/own-endpoints.test.js` covers the private rent with the same recorded marketplace, a fake clock, a
local fake Billing and a canned GPU answer:

- off without a GPU key or a cap, and off without Balance billing, each with its plain reason;
- the Billing hold is taken before the marketplace is called;
- a private rent is never registered as an offer, and the owner's OpenAI-compatible call is proxied;
- a service token cannot manage or call a person's endpoint;
- the endpoint's own idle timer scales it to zero, and the settle charge equals the GPU `spent_nano`;
- the monthly cap refuses a new start with a plain reason and moves no money;
- own weights and a LoRA produce the right container command, and a non-Hugging-Face address is refused.

## What the owner has to check before the first launch

The weights URL, the image and the container command are data in `server/gpu/catalog.js` - they are
what the first launch really runs, and the console page shows them. The owner checks them (and
corrects them there) before the first rented instance starts.


## Compute broker strategies and quote previews

`ai.gpus.strategy` selects `cheapest` (default), `fastest`, or `automatic` across configured
Vast and RunPod marketplaces. `private` and `own` refuse third-party GPU rentals; those need
an existing Link/OpenVibe endpoint. Region remains a hard constraint. Without measured
latency, Fastest explicitly reports that it falls back to price within the required region.
`ai.gpus.dry_run=true` makes shared-model launch requests quote-only and disables new private
endpoints. Keys and the positive `monthly_cap` (nano-USD) are still required for live rentals.
Also explicitly set `ai.gpus.extra_hourly_nano` to a conservative per-instance hourly bound
for disk/network charges (including zero if appropriate), and `ai.gpus.costs_bounded=true`
only after enforcing those limits in the runtime/network. Both default to blocking live
rentals. The allowance is added to reservations, hourly prices and metered cost estimates;
these estimates are not a reconciliation against the provider invoice. Existing paid
instances continue cleanup when these switches are unset. Quote previews show the base GPU
price; the live placement audit records base, allowance and total separately.
No new accounts, payment methods or provider keys are created.

`GET https://openvibe.exchange/console/gpus/:model/quote?strategy=cheapest` previews without a Billing hold or provider
purchase. Exchange uses the public, minute-cached `/api/v1/exchange/gpu-quotes/:model` and can
preview even when rentals are disabled. A private-endpoint create may include `strategy`;
the choice persists on the endpoint. Every live GPU choice is recorded as `gpu.placement`
in the existing audit log, including marketplace, offer, strategy, reasons and hourly cost.

Reservations are serialized through `gpu_budget_lock`. An uncertain creation result keeps
its row and reservation for label recovery, including across month boundaries; an empty or
failed instance listing cannot prove a purchase never happened. Disabling the cap continues
remote cleanup. Metering splits elapsed time at UTC month boundaries and avoids counting
already-charged runtime twice in the live summary. Release begins a minute before the runtime
limit; an accepted DELETE retains the reservation until a follow-up lookup confirms absence.
Failed or pending deletion remains a billable risk;
the existing destroy-failure alert must be monitored.

RunPod uses the official v2 catalogue (`/v2/catalog/gpus?include=AVAILABILITY&product=POD`),
GiB-to-MiB conversion, secure-cloud GPU counts, region filtering, numeric disk size and an env
map. Vast rents with PUT, not POST. Tests stub both APIs; no live purchase was made.

Source: https://github.com/runpod/runpod-plugins-official/blob/main/plugins/runpod/skills/runpod-migrate/reference/graphql-to-v2.md
