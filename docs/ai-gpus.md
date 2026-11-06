# OpenVibe GPUs (the GPU provisioner)

The design (§2 "Our own GPUs", the Exchange remake) asks for a provisioner that rents a GPU from a
marketplace, serves a model on it, registers the endpoint as an offer for the router and scales the
whole thing to zero when nobody is using it - under a hard monthly cap the owner sets.

This is that provisioner. It lives in AI (server/gpu/) and it is **off until the owner has set a
marketplace API key and a monthly cap**.

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

Without a key **or** without a cap the provisioner does nothing: no search, no instance, no money.

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

## The money

The money is integer nano-USD in BigInt, never a float (the same rule AI's Credits follow). Every
instance holds a **reservation** - the budget it may cost - before it starts, and the reservation
is part of the month's committed spend. A new instance is only started when its reservation still
fits under the cap; if it does not, the launch is refused and the reason is returned. The instance is
given back when its reservation has run out, so the money stops there. The worst case (the
committed spend) therefore never passes the cap.

The ledger is `gpu_spend` (one row per settled instance); the instances and their reservations are
in `gpu_instances`.

## The console page

`GET /console/gpus` (the "GPUs" entry in the console) shows whether the provisioner is on and why not,
the spend this month, the committed worst case and the cap, the models with their weights and their
state, and every instance with its price, endpoint and money. "Start" and "Stop" write a request row;
the reconciler (one implementation, the same one the service runs) does the work.

## The tests

`test/gpu.test.js` runs the provisioner against the recorded marketplace answers
(`test/fixtures/gpu/vast.json`) and a fake clock:

- it is off without a key and without a cap,
- the cheapest offer that fits is rented, registered as an offer and health-checked,
- the monthly cap is never passed: the launch is refused and says why,
- an idle instance scales to zero and the money is settled,
- an instance that dies is replaced and the router gets the new endpoint.

## What the owner has to check before the first launch

The weights URL, the image and the container command are data in `server/gpu/catalog.js` - they are
what the first launch really runs, and the console page shows them. The owner checks them (and
corrects them there) before the first rented instance starts.
