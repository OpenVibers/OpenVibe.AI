# C2 implementation status

This is an independently reviewable first slice, not a completed parity release. It builds on current main, including the merged AI #379 platform and its bounded holds.

Implemented:

- Optional expires_at in the private key provisioning API and metadata. Expiry is checked at resolution and again at a spend reservation; an already admitted request may finish.
- Idempotency-Key forwarding for OpenAI Chat Completions and Anthropic Messages. The existing run store enforces ownership and rejects different inputs under one key. Replayed responses carry x-openvibe-replayed: 1. Opaque requests claim (owner, Idempotency-Key) in the database before reserving; replays reuse the original ceiling and stored run without another hold or usage row. A concurrent request still being admitted gets 409 idempotency.in_progress and can retry. Claims with a stored run survive restarts; an interrupted admission without a stored run remains refused rather than risking another hold.
- Authenticated, no-inference POST /v1/routing/preview: validates OpenRouter-shaped provider constraints, lists excluded offers, fails closed on unknown price/privacy/evidence, and never returns secrets or hidden/restricted/BYOK providers. It is explicitly not an execution policy.
- Authenticated POST /v1/presets/import/preview: validates an explicit exported JSON subset without fetching an account, storing a preset or executing a request. Success and error responses never echo submitted values; the importer returns only a validation summary. Model-level hidden/restricted/BYOK metadata is filtered as well as provider-level access.

Outstanding: compatible legacy Completions/Embeddings/Images endpoints, full routing execution and model variants/fallbacks, persistent presets, generation lookup, web grounding/citations, live Report ratings, per-provider BYOK policy, tasks/choices and agent workflow step streams. The existing engine's features do not establish parity for those public endpoints.

Contracts and SDK release changes are outside this first slice. Task-choice OpenAPI work remains in its separate job; this change only edits Exchange key schema fields.

Migration 0054 is expand-only, after the applied 0052 platform and 0053 Link credential migration; neither applied migration is changed. No production data, provider execution, accounts or money were involved. Full-suite and focused results are recorded in the PR.
