'use strict';
/**
 * The providers OpenVibe buys capacity from (the Exchange remake, stage 2): Qwen (Alibaba Model Studio), Kimi
 * (Moonshot), GLM (Z.ai), MiniMax, DeepInfra, Novita, Featherless, Refuseless, Abliteration.ai and OpenRouter.
 *
 * Each one is off until the owner puts its key in the owner settings (D11: `ai.provider_keys`, a sealed key bound to
 * the provider's origin). The pool skips a provider whose key does not resolve (`no_credentials`), so a provider with
 * no key is never offered and never costs anything.
 *
 * What is here, and where it comes from:
 *
 *   base_url, kind, timeout   the provider's own API (its docs page). OpenAI-compatible mode for every one of them:
 *                              DashScope's compatible-mode path, Moonshot's /v1, Z.ai's /api/paas/v4, MiniMax's /v1,
 *                              DeepInfra's /v1/openai, Novita's /v3/openai, Featherless's /v1, Refuseless's /v1,
 *                              Abliteration.ai's /v1 and OpenRouter's /api/v1. One adapter serves them all
 *                              (server/providers/openai.js): streaming, tool calls, timeouts, error mapping.
 *   models and prices         read on the provider's OWN page (its pricing page or its own model list), never on an
 *                              aggregator's: the page is named in `source` and the day it was read in `checked`. A
 *                              price nobody publishes is null, never a guess: Refuseless publishes no price at all,
 *                              so its models carry null and the router ranks them by nothing until it does.
 *   privacy                   what the provider says it does with a prompt. `private` only when the provider's own
 *                              terms say it keeps nothing and trains on nothing (the wording and the page are both
 *                              recorded); `anonymized` for everyone else, including the providers whose privacy page
 *                              could not be read at all.
 *   quantization              what the provider states the weights are served in. Null unless the provider says so:
 *                              none of the ten states it on the pages read on 2026-11-06.
 *   refusal_rate              null. It stays null until a provider publishes its own rate, or until a measurement
 *                              job of ours owns the number; an invented rate is worse than none.
 *   data_policy               what the provider says it does with a prompt, in the facts the house reads (retention,
 *                              trains, region, trust) with the terms page and the day it was checked. A fact the
 *                              provider did not state is null, never a guess.
 *   provider_access           the commercial gate (docs/provider-matrix.md, 2026-11-03): only OWN_DEPLOYMENT and
 *                              AUTHORIZED_WHOLESALE may serve managed paid routes. UNVERIFIED and RESTRICTED offers
 *                              stay out of the managed pool while the model catalogue is on; the owner raises a
 *                              provider's access mode only after the agreement that allows it.
 *
 * The uncensored tier: the offers whose models are abliterated (Refuseless, Abliteration.ai, and the abliterated
 * models Featherless lists) are marked `uncensored: true`. Only an offer marked that way may answer a request with
 * `policy: "uncensored"`, and only a request from an 18+ account may ask for one (server/policy/tier.js; the tier
 * is written down in docs/uncensored-policy.md).
 *
 * Prices change only by review: this file is edited like code, and the price it carries is the price the router
 * ranks on and the balance is charged.
 */

/** The day the prices, the privacy labels and the model lists below were read. */
const CHECKED = '2026-11-06';

/** The keys of the ten providers, in the order the router should prefer them when the price is equal. */
const PROVIDER_KEYS = ['qwen', 'kimi', 'glm', 'minimax', 'deepinfra', 'novita', 'featherless', 'refuseless', 'abliteration', 'openrouter'];

/**
 * What a provider says it does with a prompt.
 *
 * The first fields are the facts the house reads (server/exchange/privacy.js: `retention`, `training`, `region`,
 * `trust`; server/exchange/catalog.js: `trains`, `retention_days`, `anonymized`). A fact the provider did not
 * state is null, never a guess: an offer that declares nothing is labelled anonymized and says that it is unknown
 * (server/exchange/privacy.js). The rest is the catalogue's own record of where the facts came from.
 *
 *   retention   'none' | 'limited' | 'standard' | null  (null: the provider does not say)
 *   trains      true | false | null                       (null: the provider does not say)
 *   trust       'first-party' | 'community' | null
 */
const policy = (o) => ({
    trains: o.trains === true ? true : (o.trains === false ? false : null),
    training: o.trains === true ? true : (o.trains === false ? false : null),
    retention: o.retention || null,
    retention_days: o.retention_days == null ? null : o.retention_days,
    region: o.region || null,
    anonymized: o.anonymized === true ? true : (o.anonymized === false ? false : null),
    trust: o.trust || null,
    // The catalogue's own words about the same thing.
    retention_note: o.retention_note || null,
    terms_url: o.terms || null,
    resale: o.resale || null,
    checked: o.checked || CHECKED,
    source: o.source || null,
});

/**
 * The privacy label of a provider.
 *
 *   private      the provider's own terms say it keeps nothing and trains on nothing. The wording and the page it
 *                was read from are both recorded, so the label can be checked again later.
 *   anonymized   everything else: the provider may keep the prompt, may train on it, or says nothing at all (a page
 *                that could not be read counts as saying nothing). The prompt is never published under the person's
 *                name.
 */
const privacy = (o) => ({
    label: o.label,
    terms_url: o.terms_url || null,
    wording: o.wording,
    checked: o.checked || CHECKED,
});

const PROVIDERS = [
    {
        key: 'qwen',
        display_name: 'Qwen (Alibaba Model Studio)',
        base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        default_model: 'qwen3.8-max',
        timeout_ms: 60000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'UNVERIFIED',
        priority: 40,
        // DashScope's own batch price: half the price of a normal call, on the Singapore deployment
        // (https://www.alibabacloud.com/help/en/model-studio/model-pricing, read 2026-11-07). The batch
        // API itself is BA2; the multiplier is what a batch run would be priced on.
        tier_rates: { batch: 0.5 },
        privacy: privacy({
            label: 'anonymized',
            terms_url: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
            wording: 'no promise of zero retention or no training was found on Alibaba Cloud\'s own pages (the data security page returned an error page on 2026-11-06)',
        }),
        data_policy: policy({
            trains: null, retention: null, region: 'singapore',
            retention_note: 'the international deployment we call is in Singapore; nothing says what it keeps',
            terms: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
            resale: 'no resale clause verified (the 2026-11-03 matrix does not list Alibaba)',
        }),
        models: [
            {
                model_key: 'qwen3.8-max', display_name: 'Qwen3.8-Max', family: 'qwen', context_window: 1048576,
                cost: { in_per_mtok: 2.00, cached_per_mtok: null, out_per_mtok: 6.00 },
                source: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the international (Singapore) price: one price for the whole 1M context; 50% off in batch. The table states no cache-hit price for this model, so the cached price stays null',
            },
            {
                model_key: 'qwen3.8-flash', display_name: 'Qwen3.8-Flash', family: 'qwen', context_window: 1048576,
                cost: { in_per_mtok: 0.15, cached_per_mtok: null, out_per_mtok: 0.47 },
                source: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the international price; the global deployment is $0.113 / $0.382',
            },
            {
                model_key: 'qwen3.7-flash-2026-07-15', display_name: 'Qwen3.7-Flash', family: 'qwen', context_window: 1048576,
                cost: { in_per_mtok: 0.030, cached_per_mtok: null, out_per_mtok: 0.130 },
                source: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the price of the first tier (up to 32K tokens). The international ladder is $0.030 / $0.130 up to 32K, $0.100 / $0.400 to 256K and $0.200 / $0.800 to 1M; the catalogue holds the first tier and the ladder is written down here',
            },
        ],
    },
    {
        key: 'kimi',
        display_name: 'Kimi (Moonshot)',
        base_url: 'https://api.moonshot.ai/v1',
        default_model: 'kimi-k3.1-pro',
        timeout_ms: 60000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'UNVERIFIED',
        priority: 40,
        // Moonshot's own batch price: 60% of the price of a normal call, answered within 12 hours to 7 days
        // (https://platform.kimi.ai/docs/pricing/chat, read 2026-11-07). The batch API itself is BA2.
        tier_rates: { batch: 0.6 },
        privacy: privacy({
            label: 'anonymized',
            terms_url: 'https://platform.kimi.ai/docs/pricing/chat',
            wording: 'Moonshot\'s own pages carry no promise of zero retention or no training (no readable privacy page was found on 2026-11-06)',
        }),
        data_policy: policy({
            trains: null, retention: null, region: null,
            retention_note: 'not stated on the provider\'s own pages',
            terms: 'https://platform.kimi.ai/docs/pricing/chat',
            resale: 'no resale clause verified (the 2026-11-03 matrix does not list Moonshot)',
        }),
        models: [
            {
                model_key: 'kimi-k3.1-pro', display_name: 'Kimi K3.1 Pro', family: 'kimi', context_window: 1048576,
                cost: { in_per_mtok: 2.00, cached_per_mtok: 0.20, out_per_mtok: 10.00 },
                source: 'https://platform.kimi.ai/docs/pricing/chat', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the cached price is the cache read (5 minute time to live by default); a cache write is billed at $2.00 with a 5 minute time to live and $4.00 with a 1 hour one; 60% off in batch',
            },
            {
                model_key: 'kimi-k3.1-pro-highspeed', display_name: 'Kimi K3.1 Pro Highspeed', family: 'kimi', context_window: 1048576,
                cost: { in_per_mtok: 4.00, cached_per_mtok: 0.20, out_per_mtok: 20.00 },
                source: 'https://platform.kimi.ai/docs/pricing/chat', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the same model on the faster tier; a cache write is $4.00 with a 5 minute time to live and $8.00 with a 1 hour one',
            },
            {
                model_key: 'kimi-k3', display_name: 'Kimi K3', family: 'kimi', context_window: 1048576,
                cost: { in_per_mtok: 3.00, cached_per_mtok: 0.30, out_per_mtok: 15.00 },
                source: 'https://platform.kimi.ai/docs/pricing/chat', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the cache write is $3.00 with a 5 minute time to live and $6.00 with a 1 hour one',
            },
        ],
    },
    {
        key: 'glm',
        display_name: 'GLM (Z.ai)',
        base_url: 'https://api.z.ai/api/paas/v4',
        default_model: 'glm-5.3-flash',
        timeout_ms: 60000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'UNVERIFIED',
        priority: 40,
        privacy: privacy({
            label: 'anonymized',
            terms_url: 'https://docs.z.ai/guides/overview/pricing.md',
            wording: 'Z.ai publishes no privacy policy page (the address returns its home page on 2026-11-06), so nothing says zero retention or no training',
        }),
        data_policy: policy({
            trains: null, retention: null, region: null,
            retention_note: 'pay-as-you-go; not stated on the pricing page',
            terms: 'https://docs.z.ai/guides/overview/pricing.md',
            resale: 'no resale clause verified (the 2026-11-03 matrix does not list Z.ai)',
        }),
        models: [
            {
                model_key: 'glm-5.3', display_name: 'GLM-5.3', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 1.40, cached_per_mtok: 0.26, out_per_mtok: 4.40 },
                source: 'https://docs.z.ai/guides/overview/pricing.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the cached input is stored free for a limited time',
            },
            {
                model_key: 'glm-5.3-flash', display_name: 'GLM-5.3-Flash', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 0.15, cached_per_mtok: 0.03, out_per_mtok: 0.50 },
                source: 'https://docs.z.ai/guides/overview/pricing.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'glm-5.3-flashx', display_name: 'GLM-5.3-FlashX', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 0.37, cached_per_mtok: 0.075, out_per_mtok: 1.25 },
                source: 'https://docs.z.ai/guides/overview/pricing.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'glm-4.7-flashx', display_name: 'GLM-4.7-FlashX', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 0.07, cached_per_mtok: 0.01, out_per_mtok: 0.40 },
                source: 'https://docs.z.ai/guides/overview/pricing.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'glm-4.7-flash', display_name: 'GLM-4.7-Flash', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 0, cached_per_mtok: 0, out_per_mtok: 0 },
                source: 'https://docs.z.ai/guides/overview/pricing.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'free, rate limited',
            },
        ],
    },
    {
        key: 'minimax',
        display_name: 'MiniMax',
        base_url: 'https://api.minimax.io/v1',
        default_model: 'MiniMax-M3.1-Flash',
        timeout_ms: 60000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'UNVERIFIED',
        priority: 40,
        privacy: privacy({
            label: 'anonymized',
            terms_url: 'https://platform.minimax.io/docs/pricing.md',
            wording: 'MiniMax publishes no readable privacy policy page (the address returns a not-found page on 2026-11-06), so nothing says zero retention or no training',
        }),
        data_policy: policy({
            trains: null, retention: null, region: null,
            retention_note: 'pay-as-you-go; retention not stated on the pricing page',
            terms: 'https://platform.minimax.io/docs/pricing.md',
            resale: 'no resale clause verified (the 2026-11-03 matrix does not list MiniMax)',
        }),
        models: [
            {
                model_key: 'MiniMax-M3.1-Flash', display_name: 'MiniMax M3.1 Flash', family: 'minimax', context_window: 1048576,
                cost: { in_per_mtok: 0.15, cached_per_mtok: 0.015, out_per_mtok: 0.60 },
                source: 'https://platform.minimax.io/docs/pricing.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'MiniMax-M3', display_name: 'MiniMax M3', family: 'minimax', context_window: 1048576,
                cost: { in_per_mtok: 0.30, cached_per_mtok: 0.06, out_per_mtok: 1.20 },
                source: 'https://platform.minimax.io/docs/pricing.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the standard tier up to 512K input tokens; over 512K it is $0.60 / $0.12 / $2.40, and the priority tier costs 1.5x',
            },
        ],
    },
    {
        key: 'deepinfra',
        display_name: 'DeepInfra',
        base_url: 'https://api.deepinfra.com/v1/openai',
        default_model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
        timeout_ms: 90000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'RESTRICTED',
        priority: 30,
        // DeepInfra's own tier prices: a Flex tier at 0.8x and a batch at 0.8x of the standard price
        // (https://deepinfra.com/pricing, read 2026-11-07). The Flex tier is synchronous and is what a
        // background run asks for; the batch API itself is BA2.
        tier_rates: { flex: 0.8, batch: 0.8 },
        privacy: privacy({
            label: 'private',
            terms_url: 'https://deepinfra.com/privacy',
            wording: '"We will not store, sell, or train using this data unless we have your explicit consent." (privacy policy, 2026-11-06) and "Input data is not stored to disk during inference - it exists only in memory while the request is being processed" (https://docs.deepinfra.com/account/data-privacy). Google and Anthropic models are the stated exceptions',
            checked: CHECKED,
        }),
        data_policy: policy({
            trains: false, retention: 'none', trust: 'first-party', region: null,
            retention_note: 'input data is not stored to disk during inference; output is deleted from memory after the answer',
            terms: 'https://deepinfra.com/privacy',
            resale: 'RESTRICTED (2026-11-03 matrix): "resell, sublicense, rent, distribute, or otherwise make the Services available to any third party except as expressly permitted under this Agreement or the applicable Service Order" (Terms §11(a)(viii), modified 2026-10-15)',
        }),
        models: [
            {
                model_key: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', display_name: 'DeepSeek V4.1 Flash 1017', family: 'deepseek', context_window: 1048576,
                cost: { in_per_mtok: 0.20, cached_per_mtok: 0.006, out_per_mtok: 0.60 },
                source: 'https://api.deepinfra.com/v1/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: true },
                quantization: null, refusal_rate: null,
                note: "the provider's own id and price; the list marks the model as a vision model (vlm)",
            },
            {
                model_key: 'deepseek-ai/DeepSeek-V4-Flash', display_name: 'DeepSeek V4 Flash', family: 'deepseek', context_window: 1048576,
                cost: { in_per_mtok: 0.09, cached_per_mtok: 0.018, out_per_mtok: 0.18 },
                source: 'https://api.deepinfra.com/v1/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'zai-org/GLM-5.3', display_name: 'GLM-5.3', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 0.90, cached_per_mtok: 0.20, out_per_mtok: 4.00 },
                source: 'https://api.deepinfra.com/v1/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'Qwen/Qwen3.8-Max', display_name: 'Qwen3.8-Max', family: 'qwen', context_window: 256000,
                cost: { in_per_mtok: 1.65, cached_per_mtok: 0.206, out_per_mtok: 4.951 },
                source: 'https://api.deepinfra.com/v1/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'openai/gpt-oss-120b', display_name: 'GPT-OSS 120B', family: 'gpt-oss', context_window: 131072,
                cost: { in_per_mtok: 0.037, cached_per_mtok: null, out_per_mtok: 0.17 },
                source: 'https://api.deepinfra.com/v1/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the list states no cache-read price for this model, so the cached price stays null',
            },
            {
                model_key: 'Qwen/Qwen3-14B', display_name: 'Qwen3 14B', family: 'qwen', context_window: 40960,
                cost: { in_per_mtok: 0.12, cached_per_mtok: null, out_per_mtok: 0.24 },
                source: 'https://api.deepinfra.com/v1/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the list states no cache-read price for this model, so the cached price stays null',
            },
        ],
    },
    {
        key: 'novita',
        display_name: 'Novita AI',
        base_url: 'https://api.novita.ai/v3/openai',
        default_model: 'deepseek/deepseek-v4.1-flash-1017',
        timeout_ms: 90000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'UNVERIFIED',
        priority: 30,
        privacy: privacy({
            label: 'anonymized',
            terms_url: 'https://api.novita.ai/v3/openai/models',
            wording: 'Novita has no readable privacy policy page (the address returns a not-found page on 2026-11-06), so nothing says zero retention or no training',
        }),
        data_policy: policy({
            trains: null, retention: null, region: null,
            retention_note: 'not stated (the provider has no readable privacy page)',
            terms: 'https://api.novita.ai/v3/openai/models',
            resale: 'UNVERIFIED (2026-11-03 matrix): the terms page returned 404',
        }),

        models: [
            {
                model_key: 'deepseek/deepseek-v4.1-flash-1017', display_name: 'DeepSeek V4.1 Flash 1017', family: 'deepseek', context_window: 1048576,
                cost: { in_per_mtok: 0.30, cached_per_mtok: 0.006, out_per_mtok: 1.20 },
                source: 'https://api.novita.ai/v3/openai/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the list marks the model as serverless with function calling, structured outputs and reasoning',
            },
            {
                model_key: 'qwen/qwen3.8-max', display_name: 'Qwen3.8-Max', family: 'qwen', context_window: 1000000,
                cost: { in_per_mtok: 2.00, cached_per_mtok: 0.25, out_per_mtok: 6.00 },
                source: 'https://api.novita.ai/v3/openai/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'zai-org/glm-5.3', display_name: 'GLM-5.3', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 1.40, cached_per_mtok: 0.26, out_per_mtok: 4.40 },
                source: 'https://api.novita.ai/v3/openai/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'moonshotai/kimi-k3.1-pro', display_name: 'Kimi K3.1 Pro', family: 'kimi', context_window: 1048576,
                cost: { in_per_mtok: 2.00, cached_per_mtok: 0.20, out_per_mtok: 10.00 },
                source: 'https://api.novita.ai/v3/openai/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'xiaomimimo/mimo-v2.6-flash', display_name: 'MiMo V2.6 Flash', family: 'mimo', context_window: 1048576,
                cost: { in_per_mtok: 0.14, cached_per_mtok: 0.0028, out_per_mtok: 0.28 },
                source: 'https://api.novita.ai/v3/openai/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
        ],
    },
    {
        key: 'featherless',
        display_name: 'Featherless AI',
        base_url: 'https://api.featherless.ai/v1',
        default_model: 'Qwen/Qwen3-14B',
        timeout_ms: 90000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'AUTHORIZED_WHOLESALE',
        priority: 30,
        privacy: privacy({
            label: 'anonymized',
            terms_url: 'https://featherless.ai/privacy',
            wording: '"We do not collect or store prompts or completions." (privacy policy, last updated 2024-06-10, read 2026-11-06): the retention is zero, but the policy never says the prompts are not trained on, so the label stays anonymized',
            checked: CHECKED,
        }),
        data_policy: policy({
            trains: null, retention: 'none', trust: 'first-party', region: null,
            retention_note: 'prompts and completions are not collected or stored; training is not mentioned',
            terms: 'https://featherless.ai/privacy',
            resale: 'AUTHORIZED_WHOLESALE, Scale plans only (2026-11-03 matrix): "Scale plans are not subject to said limits and may be used in arbitrary applications, including inference resale." (Terms §3, last updated 2024-06-10). It needs an executed Scale agreement before the managed pool may use it.',
        }),
        models: [
            {
                model_key: 'Qwen/Qwen3-14B', display_name: 'Qwen3 14B', family: 'qwen', context_window: 32768,
                cost: { in_per_mtok: 0.12, cached_per_mtok: null, out_per_mtok: 0.24 },
                source: 'https://api.featherless.ai/v1/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the list states a price per token; the catalogue holds it per million. No cache-read price is stated',
            },
            {
                model_key: 'Qwen/Qwen3-0.6B', display_name: 'Qwen3 0.6B', family: 'qwen', context_window: 32768,
                cost: { in_per_mtok: 0.04, cached_per_mtok: null, out_per_mtok: 0.08 },
                source: 'https://api.featherless.ai/v1/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'meta-llama/Meta-Llama-3.1-8B-Instruct', display_name: 'Llama 3.1 8B Instruct', family: 'llama', context_window: 32768,
                cost: { in_per_mtok: 0.05, cached_per_mtok: null, out_per_mtok: 0.08 },
                source: 'https://api.featherless.ai/v1/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'gated on Featherless: the price is published, the model needs the account to be let in',
            },
            {
                model_key: 'mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated', display_name: 'Llama 3.1 8B Instruct (abliterated)', family: 'llama', context_window: 32768,
                cost: { in_per_mtok: 0.05, cached_per_mtok: null, out_per_mtok: 0.08 },
                source: 'https://api.featherless.ai/v1/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null, uncensored: true,
                note: 'an abliterated model is an uncensored offer by its name',
            },
            {
                model_key: 'zetasepic/Qwen2.5-72B-Instruct-abliterated', display_name: 'Qwen2.5 72B Instruct (abliterated)', family: 'qwen', context_window: 32768,
                cost: { in_per_mtok: 1.48, cached_per_mtok: null, out_per_mtok: 1.60 },
                source: 'https://api.featherless.ai/v1/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null, uncensored: true,
                note: 'an abliterated model is an uncensored offer by its name',
            },
        ],
    },
    {
        key: 'refuseless',
        display_name: 'Refuseless (the uncensored tier)',
        base_url: 'https://api.refuseless.com/v1',
        default_model: 'deepseek-v4.1-flash-abliterated',
        timeout_ms: 60000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'UNVERIFIED',
        priority: 20,
        uncensored: true,
        privacy: privacy({
            label: 'anonymized',
            terms_url: 'https://docs.refuseless.com/api/models.md',
            wording: 'Refuseless\'s privacy page could not be read (a bot check answers it on 2026-11-06), so nothing says zero retention or no training',
        }),
        data_policy: policy({
            trains: null, retention: null, region: null,
            retention_note: 'unknown: the provider\'s privacy page answers a bot check',
            terms: 'https://docs.refuseless.com/api/models.md',
            resale: 'UNVERIFIED (2026-11-03 matrix): no terms URL was located',
        }),
        models: [
            {
                model_key: 'deepseek-v4.1-flash-abliterated', display_name: 'DeepSeek V4.1 Flash (abliterated)', family: 'deepseek', context_window: 1048576,
                cost: { in_per_mtok: null, cached_per_mtok: null, out_per_mtok: null },
                source: 'https://docs.refuseless.com/api/models.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null, uncensored: true,
                note: 'Refuseless publishes no price (its pricing page answers a bot check), so the price stays null rather than guessed',
            },
            {
                model_key: 'deepseek-v4.1-flash-abliterated-free', display_name: 'DeepSeek V4.1 Flash (abliterated, free)', family: 'deepseek', context_window: 524288,
                cost: { in_per_mtok: null, cached_per_mtok: null, out_per_mtok: null },
                source: 'https://docs.refuseless.com/api/models.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null, uncensored: true,
                note: 'the free model of the lineup; the price stays null, the name says free',
            },
            {
                model_key: 'glm-5.3-flash-abliterated', display_name: 'GLM 5.3 Flash (abliterated)', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: null, cached_per_mtok: null, out_per_mtok: null },
                source: 'https://docs.refuseless.com/api/models.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null, uncensored: true,
                note: 'no published price',
            },
            {
                model_key: 'glm-5.3-abliterated', display_name: 'GLM 5.3 (abliterated)', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: null, cached_per_mtok: null, out_per_mtok: null },
                source: 'https://docs.refuseless.com/api/models.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null, uncensored: true,
                note: 'no published price',
            },
            {
                model_key: 'deepseek-v4.1-flash-fast', display_name: 'DeepSeek V4.1 Flash Fast', family: 'deepseek', context_window: 1048576,
                cost: { in_per_mtok: null, cached_per_mtok: null, out_per_mtok: null },
                source: 'https://docs.refuseless.com/api/models.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the standard weights (abliterated: false); no published price',
            },
            {
                model_key: 'minimax-m3.1-flash', display_name: 'MiniMax M3.1 Flash', family: 'minimax', context_window: 1048576,
                cost: { in_per_mtok: null, cached_per_mtok: null, out_per_mtok: null },
                source: 'https://docs.refuseless.com/api/models.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the standard weights (abliterated: false); no published price',
            },
        ],
    },
    {
        key: 'abliteration',
        display_name: 'Abliteration.ai (the uncensored tier)',
        base_url: 'https://api.abliteration.ai/v1',
        default_model: 'abliterated-model-large-flash',
        timeout_ms: 60000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'UNVERIFIED',
        priority: 20,
        uncensored: true,
        privacy: privacy({
            label: 'private',
            terms_url: 'https://docs.abliteration.ai/security-and-compliance',
            wording: '"Customer prompts, outputs, and attachments are not used to train our models. Prompts and responses are processed transiently and are not stored." (security and compliance page, read 2026-11-06; privacy policy at https://abliteration.ai/privacy-policy)',
            checked: CHECKED,
        }),
        data_policy: policy({
            trains: false, retention: 'none', trust: 'first-party', region: null,
            retention_note: 'processed transiently and not stored; operational metadata is kept for billing, security and reliability',
            terms: 'https://docs.abliteration.ai/security-and-compliance',
            resale: 'no resale clause verified (the 2026-11-03 matrix does not list Abliteration.ai)',
        }),
        models: [
            {
                model_key: 'abliterated-model-large-flash', display_name: 'Abliterated Large Flash', family: 'abliterated', context_window: 1048576, max_output: 262144,
                cost: { in_per_mtok: 1.00, cached_per_mtok: 0.10, out_per_mtok: 2.00 },
                source: 'https://docs.abliteration.ai/pricing.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: true },
                quantization: null, refusal_rate: null, uncensored: true,
                note: 'the cache-read price is 10% of the input price, as the pricing page states; the model takes image input',
            },
            {
                model_key: 'abliterated-model', display_name: 'Abliterated Model', family: 'abliterated', context_window: 262144, max_output: 262134,
                cost: { in_per_mtok: 1.00, cached_per_mtok: 0.10, out_per_mtok: 3.00 },
                source: 'https://docs.abliteration.ai/pricing.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: true },
                quantization: null, refusal_rate: null, uncensored: true,
                note: 'the cache-read price is 10% of the input price; the model takes image input',
            },
            {
                model_key: 'abliterated-model-large-v2', display_name: 'Abliterated Large v2', family: 'abliterated', context_window: 1000000, max_output: 999990,
                cost: { in_per_mtok: 3.00, cached_per_mtok: 0.30, out_per_mtok: 5.00 },
                source: 'https://docs.abliteration.ai/pricing.md', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null, uncensored: true,
                note: 'text only (an image request is answered with a 400); the cache-read price is 10% of the input price',
            },
        ],
    },
    {
        key: 'openrouter',
        display_name: 'OpenRouter (the last fallback)',
        base_url: 'https://openrouter.ai/api/v1',
        default_model: 'openrouter/auto',
        timeout_ms: 120000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'UNVERIFIED',
        priority: 90,
        role: 'fallback',
        privacy: privacy({
            label: 'anonymized',
            terms_url: 'https://openrouter.ai/terms',
            wording: '"Some Models may store or train on your Inputs for improving their own large language models" (terms of service, read 2026-11-06); OpenRouter itself opts out where it can',
        }),
        data_policy: policy({
            trains: true, retention: 'standard', trust: 'first-party', region: null,
            retention_note: 'prompts and completions are not logged by default; some models may store or train on them',
            terms: 'https://openrouter.ai/terms',
            resale: 'UNVERIFIED (2026-11-03 matrix does not list OpenRouter). The price book (2026-10-30) records that its terms contemplate selling capacity inside your own product; that is not the same as an executed agreement.',
        }),
        // OpenRouter lists hundreds of models and prices each one itself; the catalogue sync reads its own list with
        // the key. No model is seeded here: a price we did not read from OpenRouter is not one of ours to publish.
        models: [],
    },
];

const byKey = new Map(PROVIDERS.map((p) => [p.key, p]));

/** The name a provider's model is known by, without its namespace: `deepseek/deepseek-chat` -> `deepseek-chat`. */
const leaf = (id) => String(id || '').split('/').pop().toLowerCase();

/**
 * The catalog price of one model of one provider, matched by name (the provider's own id and the price book's name
 * often differ in their namespace: `meta-llama/Llama-3.3-70B-Instruct-Turbo` and `Llama-3.3-70B-Instruct-Turbo` are
 * one model). → the model's record or null.
 */
function priceOf(providerKey, modelId) {
    const p = byKey.get(providerKey);
    if (!p) return null;
    const name = leaf(modelId);
    return p.models.find((m) => leaf(m.model_key) === name) || null;
}

/**
 * Is this offer an uncensored one? A provider or a model marked `uncensored` is, and so is a model whose name says
 * it is: an abliterated model is an uncensored model wherever it is served (Featherless lists several).
 */
function isUncensored(provider, model) {
    if (provider && provider.metadata && provider.metadata.uncensored) return true;
    if (model && model.metadata && model.metadata.uncensored) return true;
    if (model && model.metadata && model.metadata.family === 'abliterated') return true;
    const id = String((model && (model.model_key || model.metadata && model.metadata.model)) || '');
    return /abliterated|uncensored/i.test(id);
}

module.exports = { PROVIDERS, PROVIDER_KEYS, CHECKED, byKey, priceOf, isUncensored, leaf };
