'use strict';
/**
 * The providers whose own batch API this service speaks (BA2).
 *
 * A provider is listed here only when its batch API was read on its own documentation page and the
 * endpoint, the shape of the file and the discount were confirmed there. A provider without a
 * verified batch API is not listed: the network never claims a saving it cannot see, and it never
 * sends a file to an endpoint it has not read.
 *
 * Every entry says three things, and the code uses all three:
 *
 *   discount   the fraction of the provider's OWN list price that its batch tier costs. The batch
 *               price of a model is its retail card multiplied by this, and it is what the run is
 *               recorded at (server/batch/batcher.js). OpenAI's Batch API is half the list price;
 *               Moonshot's is 60% of it; DeepInfra's is 80%.
 *   window     how long the provider promises to have the answers ready ('24h' for all of them).
 *   limits     what the provider accepts: how many requests in one file, how large that file may
 *               be, and whether one file may carry more than one model.
 *
 * The half-price customer batch (server/batch/capacity.js) may only use a provider whose discount is
 * at most 0.5: the customer is charged half the retail card, so the network's real cost has to fit
 * inside that half. That is OpenAI and DashScope today; Kimi (0.6) and DeepInfra (0.8) are below
 * half and are therefore not eligible for a half-price customer batch, though the network's own
 * batches may still use them.
 */
const PROVIDERS = Object.freeze({
    // OpenAI's own Batch API: a JSONL file uploaded with purpose 'batch', a batch created with
    // completion_window '24h' and endpoint '/v1/chat/completions', and the answers in a file whose
    // id the batch names. Half the list price.
    shared: {
        adapter: 'openai-compatible',
        label: 'OpenAI Batch API',
        discount: 0.5,
        window: '24h',
        enabled: true,
        limits: { maxItems: 50000, maxBytes: 200 * 1024 * 1024, oneModelPerFile: true },
        source: 'https://platform.openai.com/docs/guides/batch',
    },
    // DashScope's OpenAI-compatible batch (file input): the same file-and-batch shape as OpenAI's,
    // at half the price of real-time inference.
    qwen: {
        adapter: 'openai-compatible',
        label: 'DashScope Batch (file input)',
        discount: 0.5,
        window: '24h',
        enabled: true,
        limits: { maxItems: 10000, maxBytes: 100 * 1024 * 1024, oneModelPerFile: true },
        source: 'https://www.alibabacloud.com/help/en/model-studio/batch-inference-api',
    },
    // Moonshot's Batch API: a JSONL file of at most 100 MB, one model per file, billed at 60% of the
    // standard price (a 40% discount).
    kimi: {
        adapter: 'openai-compatible',
        label: 'Moonshot Batch API',
        discount: 0.6,
        window: '24h',
        enabled: true,
        limits: { maxItems: 10000, maxBytes: 100 * 1024 * 1024, oneModelPerFile: true },
        source: 'https://platform.moonshot.ai/docs/api/batch.md',
    },
    // DeepInfra's OpenAI-compatible Batch API: 20% cheaper than real time, answered within 24 hours.
    deepinfra: {
        adapter: 'openai-compatible',
        label: 'DeepInfra Batch API',
        discount: 0.8,
        window: '24h',
        enabled: true,
        limits: { maxItems: 10000, maxBytes: 100 * 1024 * 1024, oneModelPerFile: true },
        source: 'https://deepinfra.com/docs/batch-inference',
    },
    // Anthropic's Message Batches: the requests go in the body (no file), the answers come back as
    // a JSONL file at the results URL the batch names. Half the list price.
    anthropic: {
        adapter: 'anthropic',
        label: 'Anthropic Message Batches',
        discount: 0.5,
        window: '24h',
        enabled: false,                       // no production key yet: the adapter exists, the route does not
        limits: { maxItems: 100000, maxBytes: 256 * 1024 * 1024, oneModelPerFile: false },
        source: 'https://docs.anthropic.com/en/docs/build-with-claude/batch-processing',
    },
    // The Gemini Batch API: inline requests, answered later, at half the price. There is no
    // production key for it yet, so the route is not enabled.
    gemini: {
        adapter: 'gemini',
        label: 'Gemini Batch API',
        discount: 0.5,
        window: '24h',
        enabled: false,
        limits: { maxItems: 10000, maxBytes: 100 * 1024 * 1024, oneModelPerFile: true },
        source: 'https://ai.google.dev/gemini-api/docs/batch',
    },
});

/** The providers that are enabled for a native batch, and their configuration. */
function enabledProviders() {
    const out = {};
    for (const [key, cfg] of Object.entries(PROVIDERS)) if (cfg.enabled) out[key] = cfg;
    return out;
}

/** One provider's configuration, or null when the provider has no (verified) batch API. */
function providerConfig(key) {
    return PROVIDERS[String(key || '')] || null;
}

module.exports = { PROVIDERS, enabledProviders, providerConfig };
