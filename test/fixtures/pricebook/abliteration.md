> ## Documentation Index
> Fetch the complete documentation index at: https://docs.abliteration.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Pricing

> Per-token API pricing for Abliteration models. Input and output have model-specific rates; cached input (prompt-cache reads) is billed at 10% of input.

## Per-token rates

Rates are per 1M tokens in USD.

| Model | Input / 1M | Cached input / 1M | Output / 1M |
| - | - | - | - |
| **Abliterated Model**abliterated-model | \$1.00 | \$0.10 | \$3.00 |
| **Abliterated Large Flash**abliterated-model-large-flash | \$1.00 | \$0.10 | \$2.00 |
| **Abliterated Large v2**abliterated-model-large-v2 | \$3.00 | \$0.30 | \$5.00 |
| **Abliterated Large**!abliterated-model-large | \$3.00 | \$0.30 | \$5.00 |

**Deprecated**

See [models](https://docs.abliteration.ai/models.md) for context windows and capabilities.

## Prompt caching

When a request reuses a prefix that's already cached, those **cache-read** input tokens are billed at **10% of the model's standard input rate**. **Cache creation** (processing tokens and making them eligible for possible later reuse) is charged at the standard input rate — there's no cache-write premium, and a cache write does not guarantee a later cache read. Output tokens are always billed at the standard rate.

Caching is automatic; cached and uncached input tokens are reported separately in the response `usage`. Cache hits are best-effort, and cached-token counts are measured per request rather than accumulated across a conversation. Use the reported cache-read tokens to determine whether the discount applied. See [prompt caching](https://docs.abliteration.ai/capabilities/prompt-caching.md).

## Billing and balance

Usage is billed in USD against a single prepaid balance that works across every model. You pay the per-token rates above; cache-read input tokens are billed at the discounted rate, so they draw down your balance proportionally less. Image inputs on `abliterated-model` and `abliterated-model-large-flash` are metered as tokens on the same per-token scale.

## Subscriptions and credit packs

Monthly subscriptions and prepaid credit packs are available, along with custom volume and enterprise pricing. See the [pricing page](https://abliteration.ai/pricing) for current plans and to buy credits.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.