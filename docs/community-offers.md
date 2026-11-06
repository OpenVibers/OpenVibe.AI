# Community AI offers ("Offer to the network")

The design's community machines (`EXCHANGE-REMAKE-2026-11-06.md`, plan §3, stage 4): a person turns on **Offer to the
network** in OpenVibe.Node's `ai` plugin and their local models (Ollama, LM Studio, llama.cpp) or GPU become capacity
OpenVibe.AI can place inference on. It is opt-in twice — the owner turns the offer on, and the caller asks for community
capacity per request — because the machine sees the prompt.

## The chain

1. **Node** (`plugins/ai`, 0.3.0) advertises `status.capabilities.ai.offer`: `enabled`, `models`, `hours`,
   `concurrency`, `price` (credits per million in/out), `audience`, `open_now`, `ready`. It enforces `enabled`, `hours`,
   `models` and `concurrency` on the machine, and accepts a community command only as a `community/<model>` request,
   which it strips before the local server sees it.
2. **Bot** stores the Node's capabilities and reports every machine with an enabled offer to Network:
   `POST /internal/ai/offers/report` (source `bot`, `network.resource.report`). A community run reaches a machine even
   with "Let my AI use this computer's models" off, because the offer itself is the opt-in; the machine still only
   accepts `kind: ai`.
3. **Network** (`server/registry/ai-offers.js`, `migrations/0039_ai_offers.sql`) validates the offer strictly and keeps
   it as a user-owned offer: owner required, no public route, `network.registry.read` to read the whole set. It is a
   dedicated table because `platform.resource-offer@1` closes `detail` for kind node/provider and cannot carry models,
   hours, a credit price and an audience.
4. **AI** (`server/community/`) reads `GET /internal/ai/offers`, verifies the machine, and places only opted-in requests.

## Opting in

`POST /v1/chat/completions` / `POST /v1/messages` (and the direct runs API) take either header
`x-openvibe-community: 1` or body `x_openvibe: { "community": true }`. Without it the community layer is never called.
An exact model id (`org/model@revision`) and a BYOK run never go to a community machine; only free/auto routes may.

The answer carries `x_openvibe.community` (machine, owner, model, price, verification, reputation, credits) and the
response header `X-OpenVibe-Community: 1`. A failure on the community machine falls back to the ordinary network, and
that answer carries no community label.

## Trust before traffic

- **Canaries**: three known-answer prompts. A wrong answer marks the offer `failed`, reputation 0, and it is never
  chosen again until an operator resets it.
- **Model fingerprint**: the model id the machine's own server reports must match the declared model (a quantization
  suffix is allowed).
- **Spot re-runs**: about 1% (`AI_COMMUNITY_SPOT_RATE`, default 0.01) of answers are re-run on a verified machine
  serving the same model and compared by token overlap. A mismatch fails the offer and the request falls back.
- **Reputation**: canaries 40, spot pass rate 40, observed uptime 20.
- **New machines** serve the free tier only (`ctx.creditsRequired`: a run with no Balance payer) until verified.
  Verified tokens earn credits; new/free-tier tokens are recorded with 0 credits.

## Earnings and /sell

`community_usage` records tokens in/out, latency, the price used and `credits_micro` (1 credit = 1,000,000 micro), only
for verified tokens.

- **Self-dealing is zero.** A run whose requester is the offer's owner, or an account merged into it (Network
  `identity.subject.resolve`), is `self_served`: 0 credits, labelled in the receipt and in `/sell`.
- **Pending, not spendable.** Credits are earned only against a charge to the requester's Balance in the same request.
  Until requester charging exists, every verified row is `pending`; `spendable` is reserved for a future Balance charge
  id. `/sell` shows both and says plainly that pending credits cannot be spent.
- **Daily cap until trusted.** Until a machine has 7 days of verified service (`AI_COMMUNITY_TRUST_DAYS`), its seller
  earns at most `AI_COMMUNITY_DAILY_CAP_CREDITS` (100) a day; the row is `capped` when the cap binds.
- **Reputation resets on failures.** A canary/spot failure rate over 10% sets reputation to 0; a failed offer is 0.
- **Kudos for volunteers.** A price-0 offer earns kudos per 1,000 verified tokens (`AI_COMMUNITY_KUDOS_PER_1K`), in an
  append-only `community_kudos_ledger` with the same who/why/request audit shape as the credits. Kudos never expire and
  are never cash: they buy queue priority (`sqrt(balance)`, capped at 10) and a larger free output allowance
  (10 tokens per kudo, capped at 1M), both read by the router.

`GET /api/v1/community/sell` (a service with `ai.run.read` or `ai.usage.read`, acting for the owner in `X-OV-Subject`)
returns the owner's offers with tokens served, tokens/s per model, uptime, verification, reputation, pending/spendable
credits, self-served requests, the daily cap, kudos and the seller card. `GET /api/v1/community/offers` is the public
list (models, price, hours, health; never an owner subject or machine id).

## Configuration

- `AI_COMMUNITY` (default on): with no `OV_OAUTH_CLIENT_SECRET` or `OV_BOT_INTERNAL_URL` the list is empty.
- `AI_COMMUNITY_REFRESH_MS` (30000), `AI_COMMUNITY_CANARY_MAX_AGE_MS` (6h), `AI_COMMUNITY_CANARY_TIMEOUT_MS` (30000),
  `AI_COMMUNITY_SPOT_RATE` (0.01).
- Network grants AI `network.registry.read` and `network.follows.read` (the `followers` audience).

## Tests

- `node test/community.test.js` — opt-in, free-tier-only, canaries, fingerprint, followers/groups, earnings and /sell.
- `node test/community-run.test.js` — the run path: no opt-in reaches nothing; with it the answer is labelled; a failed
  machine falls back to the network.
- `node test/community-api.test.js` — the dashboard route and the public offers route.
- Network: `node test/run.js ai-offers`; Bot: `node test/community-ai.test.js`; Node: `python3 -m unittest discover -s
  plugins/ai/tests`.
