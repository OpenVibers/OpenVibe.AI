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
const NEW_CHECKED = '2026-11-09';

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
        docs_url: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
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
        docs_url: 'https://platform.moonshot.ai/docs/guide/start-using-kimi-api',
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
        docs_url: 'https://docs.z.ai/guides/overview/quick-start',
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
        docs_url: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
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
        docs_url: 'https://deepinfra.com/docs/openai_api',
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
        docs_url: 'https://novita.ai/docs/api-reference/model-apis-llm-list-models',
        display_name: 'Novita AI',
        base_url: 'https://api.novita.ai/openai',
        default_model: 'deepseek/deepseek-v4.1-flash-1017',
        timeout_ms: 90000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'UNVERIFIED',
        priority: 30,
        privacy: privacy({
            label: 'anonymized',
            terms_url: 'https://api.novita.ai/openai/models',
            wording: 'Novita has no readable privacy policy page (the address returns a not-found page on 2026-11-06), so nothing says zero retention or no training',
        }),
        data_policy: policy({
            trains: null, retention: null, region: null,
            retention_note: 'not stated (the provider has no readable privacy page)',
            terms: 'https://api.novita.ai/openai/models',
            resale: 'UNVERIFIED (2026-11-03 matrix): the terms page returned 404',
        }),

        models: [
            {
                model_key: 'deepseek/deepseek-v4.1-flash-1017', display_name: 'DeepSeek V4.1 Flash 1017', family: 'deepseek', context_window: 1048576,
                cost: { in_per_mtok: 0.30, cached_per_mtok: 0.006, out_per_mtok: 1.20 },
                source: 'https://api.novita.ai/openai/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
                note: 'the list marks the model as serverless with function calling, structured outputs and reasoning',
            },
            {
                model_key: 'qwen/qwen3.8-max', display_name: 'Qwen3.8-Max', family: 'qwen', context_window: 1000000,
                cost: { in_per_mtok: 2.00, cached_per_mtok: 0.25, out_per_mtok: 6.00 },
                source: 'https://api.novita.ai/openai/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'zai-org/glm-5.3', display_name: 'GLM-5.3', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 1.40, cached_per_mtok: 0.26, out_per_mtok: 4.40 },
                source: 'https://api.novita.ai/openai/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'moonshotai/kimi-k3.1-pro', display_name: 'Kimi K3.1 Pro', family: 'kimi', context_window: 1048576,
                cost: { in_per_mtok: 2.00, cached_per_mtok: 0.20, out_per_mtok: 10.00 },
                source: 'https://api.novita.ai/openai/models', checked: CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null,
            },
            {
                model_key: 'xiaomimimo/mimo-v2.6-flash', display_name: 'MiMo V2.6 Flash', family: 'mimo', context_window: 1048576,
                cost: { in_per_mtok: 0.14, cached_per_mtok: 0.0028, out_per_mtok: 0.28 },
                source: 'https://api.novita.ai/openai/models', checked: CHECKED,
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
        key: 'openrouter', keys_url: 'https://openrouter.ai/settings/keys',
        models_public: true,
        check_endpoint: 'https://openrouter.ai/api/v1/key',
        docs_url: 'https://openrouter.ai/docs/api-reference/overview',
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
    ...[
        ['venice', 'Venice AI', 'https://api.venice.ai/api/v1', 'venice-uncensored-1-2', 'https://docs.venice.ai/overview/pricing', 'PRIVATE', 'UNVERIFIED', { in: 0.20, cached: null, out: 0.90 }, 131072, true],
        ['abliteratedmodels', 'abliteratedmodels.cc', 'https://api.abliteratedmodels.cc/v1', 'uncensored', 'https://abliteratedmodels.cc/es/', 'UNKNOWN', 'UNVERIFIED', { in: 0.15, cached: null, out: 0.50 }, 100000, true],
        ['uplinkswitch', 'UplinkSwitch', 'https://api.uplinkswitch.ai/v1', 'abliterated', 'https://uplinkswitch.ai/acceptable-use', 'UNKNOWN', 'UNVERIFIED', { in: null, cached: null, out: null }, null, true],
        ['chutes', 'Chutes', 'https://llm.chutes.ai/v1', 'Qwen/Qwen3-32B-TEE', 'https://www.chutes.ai/pricing', 'UNKNOWN', 'UNVERIFIED', { in: 0.104, cached: null, out: 0.416 }, 40960, false],
        ['siliconflow', 'SiliconFlow', 'https://api.siliconflow.com/v1', 'Qwen/Qwen3-32B', 'https://docs.siliconflow.com/', 'UNKNOWN', 'UNVERIFIED', { in: null, cached: null, out: null }, null, false],
        ['nebius', 'Nebius Token Factory', 'https://api.tokenfactory.nebius.com/v1', 'Qwen/Qwen3-30B-A3B-Instruct-2507', 'https://nebius.com/services/token-factory/models/qwen-models-inference', 'UNKNOWN', 'UNVERIFIED', { in: 0.10, cached: null, out: 0.30 }, 262144, false, 'https://docs.tokenfactory.nebius.com/quickstart'],
        ['together', 'Together AI', 'https://api.together.ai/v1', 'openai/gpt-oss-120b', 'https://www.together.ai/pricing', 'UNKNOWN', 'RESTRICTED', { in: 0.15, cached: null, out: 0.60 }, 131072, false, 'https://docs.together.ai/docs/openai-api-compatibility', 'https://api.together.ai/settings/api-keys', '', 'togetherai'],
        ['fireworks', 'Fireworks AI', 'https://api.fireworks.ai/inference/v1', 'accounts/fireworks/models/gpt-oss-120b', 'https://fireworks.ai/models', 'UNKNOWN', 'UNVERIFIED', { in: 0.15, cached: null, out: 0.60 }, 131072, false, 'https://docs.fireworks.ai/tools-sdks/openai-compatibility', 'https://fireworks.ai/account/api-keys', ''],
        ['groq', 'Groq', 'https://api.groq.com/openai/v1', 'openai/gpt-oss-120b', 'https://console.groq.com/docs/model/openai/gpt-oss-120b', 'UNKNOWN', 'UNVERIFIED', { in: 0.15, cached: 0.075, out: 0.60 }, 131072, false, 'https://console.groq.com/docs/openai', 'https://console.groq.com/keys', 'openai/gpt-oss-20b'],
        ['cerebras', 'Cerebras', 'https://api.cerebras.ai/v1', 'gpt-oss-120b', 'https://api.cerebras.ai/public/v1/models', 'UNKNOWN', 'UNVERIFIED', { in: null, cached: null, out: null }, 131072, false, 'https://inference-docs.cerebras.ai/api-reference/models', 'https://cloud.cerebras.ai/', ''],
        ['sambanova', 'SambaNova', 'https://api.sambanova.ai/v1', 'gpt-oss-120b', 'https://cloud.sambanova.ai/plans/pricing', 'UNKNOWN', 'UNVERIFIED', { in: 0.22, cached: null, out: 0.59 }, 131072, false, 'https://docs-prod.sambanova.ai/docs/api-reference/endpoints/model-list'],
        ['baseten', 'Baseten', 'https://inference.baseten.co/v1', 'openai/gpt-oss-120b', 'https://www.baseten.co/pricing/', 'UNKNOWN', 'UNVERIFIED', { in: null, cached: null, out: null }, 131072, false],
        ['hyperbolic', 'Hyperbolic', 'https://api.hyperbolic.ai/inference/v1', 'openai/gpt-oss-120b', 'https://docs.hyperbolic.xyz/docs/hyperbolic-ai-inference-pricing', 'UNKNOWN', 'UNVERIFIED', { in: null, cached: null, out: null }, 131072, false, 'https://docs.hyperbolic.ai/inference/quickstart'],
    ].map(([key, display_name, base_url, model_key, source, privacyLabel, provider_access, prices, context_window, uncensored, docs_url, keys_url, credential_default_model, models_dev_id]) => {
        const privateTier = privacyLabel === 'PRIVATE';
        return {
            key, display_name, base_url, docs_url, keys_url, credential_default_model, models_dev_id, default_model: model_key, timeout_ms: 60000,
            capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
            provider_access, priority: 40, ...(uncensored ? { uncensored: true } : {}),
            privacy: privacy({ label: privateTier ? 'private' : 'anonymized', terms_url: privateTier ? source : null,
                wording: privateTier ? 'Venice states prompts and generations are never stored or logged, and are not used to train future models for this model.' : 'Retention and training commitments were not confirmed on the provider page; unknown.' }),
            data_policy: policy({ trains: privateTier ? false : null, retention: privateTier ? 'none' : null,
                retention_note: privateTier ? 'zero data retention stated for this model' : null, terms: privateTier ? source : null,
                resale: 'UNVERIFIED; owner must verify resale rights before enabling managed access' }),
            models: [{ model_key, display_name: model_key, family: uncensored ? 'abliterated' : key,
                context_window, cost: { in_per_mtok: prices.in, cached_per_mtok: prices.cached, out_per_mtok: prices.out },
                source, checked: NEW_CHECKED, supports: { json: true, tools: true, streaming: true, vision: false },
                quantization: null, refusal_rate: null, ...(uncensored ? { uncensored: true } : {}),
                note: prices.in == null || prices.out == null ? 'Provider price not confirmed from its own price listing; kept null pending pricebook review.' : null },
            ...(key === 'chutes' ? [{ model_key: 'unsloth/Mistral-Nemo-Instruct-2407-TEE', display_name: 'Mistral Nemo Instruct 2407 TEE', family: 'mistral', context_window: 131072,
                cost: { in_per_mtok: 0.0245, cached_per_mtok: null, out_per_mtok: 0.0978 }, source, checked: NEW_CHECKED,
                supports: { json: true, tools: true, streaming: true, vision: false }, quantization: null, refusal_rate: null }] : []),
            ],
        };
    }),
    // Providers without a hand-kept model list: the owner syncs and enables their models.
    { key: 'meta', display_name: 'Meta Model API', base_url: 'https://api.meta.ai/v1',
        docs_url: 'https://dev.meta.ai/docs/api-reference', capabilities: ['chat', 'vision', 'tools', 'web-search'],
        search_adapters: ['meta'] },
    { key: 'deepseek', keys_url: 'https://platform.deepseek.com/api_keys', display_name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', default_model: 'deepseek-flash',
        docs_url: 'https://api-docs.deepseek.com/', capabilities: ['chat', 'vision', 'tools', 'web-search'], search_adapters: ['deepseek'] },
    { key: 'anthropic', keys_url: 'https://console.anthropic.com/settings/keys', display_name: 'Anthropic', kind: 'anthropic', base_url: 'https://api.anthropic.com/v1', auth_mode: 'x-api-key',
        docs_url: 'https://platform.claude.com/docs/en/api/overview', capabilities: ['chat', 'messages', 'vision', 'tools'] },
    { key: 'openai', keys_url: 'https://platform.openai.com/api-keys', display_name: 'OpenAI', base_url: 'https://api.openai.com/v1', default_model: 'gpt-5-mini',
        docs_url: 'https://platform.openai.com/docs/api-reference/models/list', capabilities: ['chat', 'vision', 'tools', 'image', 'video', 'speech', 'transcribe', 'embed'] },
    { key: 'gemini', models_dev_id: 'google', keys_url: 'https://aistudio.google.com/apikey', display_name: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
        api_family: 'google', docs_url: 'https://ai.google.dev/gemini-api/docs/openai', capabilities: ['chat', 'vision', 'tools', 'embed'] },
    { key: 'xai', keys_url: 'https://console.x.ai/', display_name: 'xAI', base_url: 'https://api.x.ai/v1',
        docs_url: 'https://docs.x.ai/docs/api-reference', capabilities: ['chat', 'vision', 'tools', 'image', 'video'] },
    { key: 'mistral', keys_url: 'https://console.mistral.ai/api-keys', display_name: 'Mistral', base_url: 'https://api.mistral.ai/v1',
        docs_url: 'https://docs.mistral.ai/api', capabilities: ['chat', 'vision', 'tools', 'embed', 'transcribe'] },
    { key: 'cohere', display_name: 'Cohere', base_url: 'https://api.cohere.com/compatibility/v1', models_endpoint: 'https://api.cohere.com/v1/models',
        docs_url: 'https://docs.cohere.com/docs/compatibility-api', capabilities: ['chat', 'tools', 'embed', 'rerank'] },
    { key: 'perplexity', display_name: 'Perplexity', kind: 'responses', base_url: 'https://api.perplexity.ai/v1',
        docs_url: 'https://docs.perplexity.ai/docs/agent-api/openai-compatibility', capabilities: ['chat', 'web-search'], search_adapters: ['perplexity'] },
    { key: 'brave', display_name: 'Brave Search', kind: 'http', base_url: 'https://api.search.brave.com/res/v1',
        auth_header: 'x-subscription-token', models_endpoint: null, capabilities: ['web-search', 'image-search'],
        search_adapters: ['brave', 'brave-images'], docs_url: 'https://api-dashboard.search.brave.com/documentation/services/web-search' },
    { key: 'tavily', display_name: 'Tavily', kind: 'http', base_url: 'https://api.tavily.com', models_endpoint: null,
        check_endpoint: 'https://api.tavily.com/usage',
        capabilities: ['web-search'], search_adapters: ['tavily'], docs_url: 'https://docs.tavily.com/documentation/api-reference/endpoint/search' },
    { key: 'exa', display_name: 'Exa', kind: 'http', base_url: 'https://api.exa.ai', auth_mode: 'x-api-key', models_endpoint: null,
        capabilities: ['web-search'], search_adapters: ['exa'], docs_url: 'https://docs.exa.ai/reference/search' },
    { key: 'serper', display_name: 'Serper', kind: 'http', base_url: 'https://google.serper.dev', auth_mode: 'x-api-key', models_endpoint: null,
        capabilities: ['web-search', 'image-search'], search_adapters: ['serper', 'serper-images'], docs_url: 'https://serper.dev/' },
    { key: 'jina', display_name: 'Jina', kind: 'http', base_url: 'https://s.jina.ai', models_endpoint: null,
        capabilities: ['web-search'], search_adapters: ['jina'], docs_url: 'https://jina.ai/reader/' },
    { key: 'searxng', display_name: 'SearXNG', kind: 'http', base_url: null, auth_mode: 'none', models_endpoint: null,
        capabilities: ['web-search'], search_adapters: ['searxng'], docs_url: 'https://docs.searxng.org/dev/search_api.html' },
    { key: 'openverse', display_name: 'Openverse', kind: 'http', base_url: 'https://api.openverse.org/v1', auth_mode: 'none', models_endpoint: null,
        capabilities: ['image-search'], search_adapters: ['openverse'], docs_url: 'https://api.openverse.org/' },
    { key: 'commons', display_name: 'Wikimedia Commons', kind: 'http', base_url: 'https://commons.wikimedia.org/w/api.php', auth_mode: 'none', models_endpoint: null,
        capabilities: ['image-search'], search_adapters: ['commons'], docs_url: 'https://www.mediawiki.org/wiki/API:Search' },

    // Cheap hosted inference (owner, 2026-11-10): every endpoint below was read and probed keyless today.
    // Each starts disabled with no key; the owner puts its key in the owner settings and syncs its model list.
    { key: 'parasail', display_name: 'Parasail', base_url: 'https://api.parasail.io/v1',
        docs_url: 'https://docs.parasail.io/parasail-docs/products/overview/models', capabilities: ['chat', 'embed'] },
    { key: 'particle-ai', display_name: 'Particle AI', base_url: 'https://api.particle.ai/v1',
        docs_url: 'https://docs.particle.ai/', capabilities: ['chat'] },
    { key: 'inference-net', display_name: 'Inference.net', base_url: 'https://api.inference.net/v1', models_public: true,
        docs_url: 'https://docs.inference.net/', capabilities: ['chat'] },
    { key: 'atlas-cloud', display_name: 'AtlasCloud', base_url: 'https://api.atlascloud.ai/v1', models_public: true,
        docs_url: 'https://www.atlascloud.ai/docs', capabilities: ['chat'] },
    { key: 'avian', display_name: 'Avian', base_url: 'https://api.avian.io/v1', models_public: true,
        docs_url: 'https://avian.io/docs/', capabilities: ['chat'] },
    { key: 'nanogpt', display_name: 'NanoGPT', base_url: 'https://api.nano-gpt.com/v1', models_public: true,
        docs_url: 'https://nano-gpt.com/pricing', capabilities: ['chat'] },
    { key: 'infermatic', display_name: 'Infermatic', base_url: 'https://api.totalgpt.ai/v1',
        docs_url: 'https://ui.infermatic.ai/docs', capabilities: ['chat'] },
    { key: 'arliai', display_name: 'ArliAI', base_url: 'https://api.arliai.com/v1',
        models_endpoint: 'https://api.arliai.com/model/all', models_public: true,
        docs_url: 'https://www.arliai.com/', capabilities: ['chat', 'embed', 'image'] },
    { key: 'friendli', display_name: 'Friendli', base_url: 'https://api.friendli.ai/serverless/v1', models_public: true,
        docs_url: 'https://friendli.ai/docs/guides/model-apis/introduction', capabilities: ['chat'] },
    { key: 'scaleway', display_name: 'Scaleway', base_url: 'https://api.scaleway.ai/v1',
        docs_url: 'https://www.scaleway.com/en/developers/api/generative-apis', capabilities: ['chat', 'embed'] },

];

// The seed, console and personal-key forms consume these same records.
for (const p of PROVIDERS) {
    if (p.capabilities.includes('chat')) p.capabilities = [...new Set([...p.capabilities, 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json'])];
    p.kind ||= 'openai';
    p.auth_mode ||= 'bearer';
    p.api_family ||= p.kind === 'http' ? 'adapter' : p.kind;
    if (p.models_endpoint === undefined) p.models_endpoint = p.base_url ? `${p.base_url}/models` : null;
    p.models ||= [];
    p.provider_access ||= 'UNVERIFIED';
    p.priority ??= 100;
    p.timeout_ms ||= 30000;
    p.docs_url ||= p.models[0]?.source || null;
    p.data_policy ||= policy({ checked: '2026-11-10' });
    p.privacy ||= privacy({ label: 'anonymized', wording: 'Data retention and training terms have not been verified.', checked: '2026-11-10' });
}
const PROVIDER_KEYS = PROVIDERS.map(p => p.key);

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
