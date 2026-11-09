# Agent effort, defaults and accounting

S1 is [Contracts PR 396](https://github.com/OpenVibers/OpenVibe.Contracts/pull/396),
version 0.381.0. This PR pins its green commit SHA because neither PR is to be merged
or tagged by this job. Reconcile the pin to the eventual release when merging.

POST `/v1/chat/completions`, `/v1/messages`, `/api/v1/chat`, `/api/v1/generate` and
`/api/v1/runs` accept `effort: auto|low|medium|high|max`. Other direct text operations
also accept it. Omission means auto. Auto uses the selected `agent_role` default,
or the owner's task-default `effort`, then the workflow's `metadata.effort`, then medium. Receipts record the request and the
portable level actually applied; unsupported controls record null. Cache and
idempotency identities include the resolved policy, so changing effort cannot reuse
an answer computed with another policy. Ordinary provider fallback keeps that policy.

Mappings were checked on provider documentation on 2026-11-09. Budget numbers are
OpenVibe choices rather than provider-defined effort presets:

| Provider | Native request | Source |
| --- | --- | --- |
| OpenAI reasoning models | `reasoning_effort` (or Responses `reasoning.effort`): low/medium/high; max becomes max on GPT-6, xhigh on GPT-5.2+, high on older reasoning models | [Reasoning](https://developers.openai.com/api/docs/guides/reasoning?api-mode=chat) |
| Current Claude | `thinking: {type: adaptive}`, `output_config.effort`; Opus/Sonnet 5.5 refuse `budget_tokens` | [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), [effort](https://platform.claude.com/docs/en/build-with-claude/effort) |
| Gemini 3/4 | `generationConfig.thinkingConfig.thinkingLevel`; max clamps to HIGH; Gemini 3 Pro medium clamps to HIGH | [Thinking](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking) |
| Gemini 2.5 | `thinkingBudget`: 1024 / 4096 / 16384 / 24576 tokens (Pro max 32768) | [Thinking](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking) |
| Qwen 3 hybrid on DashScope | low disables `enable_thinking`; others enable with `thinking_budget` 4096 / 16384 / 32768; thinking-only models omit the toggle and use 1024 for low | [Deep thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking) |
| DeepSeek | low disables thinking; other efforts enable it (applied medium: the portable binary-on level) | [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/) |
| Others | ignored, applied null | No native support asserted |

Streaming uses the same request builders. Automatic OpenAI-compatible provider batches
apply the same mappings. Role-specific work stays on the ordinary background path
rather than entering a batch route that cannot preserve the role's model choice.

## Owner defaults

GET `/api/v1/agent-role-defaults` and PUT `/api/v1/agent-role-defaults/:role` require
`ai.config.manage`. Roles are router, gate, assessor, worker, subagent, reviewer.
PUT takes `{model: "provider/model", effort: "high"}` or
`{choice_order: ["provider/model", "provider/other"], effort: "medium"}`.
Defaults must specify a concrete effort. Choice order selects the first eligible model
from that order; existing route admission, provider access, cost caps and billing still
apply. Explicit model pins take precedence. Unavailable role models fail explicitly.

Router/gate and subagent start low, assessor/worker medium, reviewer high. The worker
starts on DeepSeek V4 Flash and the reviewer on Claude Sonnet 5.5. Setting a Claude
worker without a saved reviewer switches the default reviewer to OpenAI. A saved
reviewer may not share a provider family with any worker choice. Updates and before/after
audit records share one transaction, serialized to prevent conflicting role updates.
No default provisions a key or enables a provider.

## Estimates and ladders

GET `/api/v1/exchange/estimate?model=&effort=&kind=&input_tokens=` is public and cached
for 30 seconds with bounded cache entries. Effort must be concrete. The result is
`{low_usd, high_usd, n, basis}`. Fewer than 20 eligible samples returns both prices null
and `basis.status: "no_data"`. Eligible samples are successful, non-synthetic run
receipts from the last 30 days with current offer prices. Kind is an exact optional
receipt label. Effort cohorts use requested effort, or applied effort for auto/legacy
receipts. No account or receipt identities are returned.

The range is the 25th–75th percentiles of observed input/output/reasoning/cache token counts
priced at each answering route's current prices, excluding historical charges/fees.
When input_tokens is supplied, each sample scales by its output/input and cache/input
ratios. This is empirical usage, not a guaranteed quote or a price cap.

A caller may pass `ladder_id` plus zero-based `rung`; both are required together.
Receipts retain them as ladder_id/effort_rung, with model, effort, cost and outcome.
GET `/api/v1/me/ladders/:id` returns `{ladder_id, cost_usd, rungs: [{rung,n,cost_usd}]}`
only for the caller's receipts (or its token's on-behalf-of user). Reusing another
caller's id reveals nothing. Failed attempts also get receipts; cost totals include
recorded successful provider usage before the run failed. No automatic escalation is
introduced, and a ladder never grants permission to spend.

Catalog offers expose `cache_hit_share_7d`: cached input tokens / total input tokens
from successful, non-synthetic provider attempts in seven days, clamped to [0,1]. No
samples yields null. This is provider token-cache usage, distinct from whole-run reuse.

Migration 0058 is expand-only, above main's 0056 and open PR #409's 0057 at validation.
It adds only role policy storage and a receipt time index. Tests use fixture responses
and temporary databases; no paid provider calls, production writes or deployment.
