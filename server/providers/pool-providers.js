'use strict';
/**
 * The providers OpenVibe buys capacity from (the Exchange remake, stage 2): Qwen (Alibaba Model Studio), Kimi
 * (Moonshot), GLM (Z.ai), MiniMax, DeepInfra, Novita, Featherless, Refuseless and OpenRouter.
 *
 * Each one is off until the owner puts its key in the owner settings (D11: `ai.provider_keys`, a sealed key bound to
 * the provider's origin). The pool skips a provider whose key does not resolve (`no_credentials`), so a provider with
 * no key is never offered and never costs anything.
 *
 * What is here, and where it comes from:
 *
 *   base_url, kind, timeout   the provider's own API (its docs page). OpenAI-compatible mode for every one of them:
 *                              DashScope's compatible-mode path, Moonshot's /v1, Z.ai's /api/paas/v4, MiniMax's /v1,
 *                              DeepInfra's /v1/openai, Novita's /v3/openai, Featherless's /v1, Refuseless's /v1 and
 *                              OpenRouter's /api/v1.
 *   models and prices         the price book (research-2026-10-30/price-book/inference.csv, checked 2026-10-30) and
 *                              OpenVibe.Watch's recorded official lists (2026-11-04) for DeepInfra and Featherless. Every
 *                              price carries the page it was read from and the day it was read; a price we do not have
 *                              is never invented: the model is left out of the catalog instead.
 *   data_policy               what the provider says it does with a prompt (the price book's `data_policy` and
 *                              `trains_on_prompts` columns), with the terms page and the day it was checked.
 *   provider_access           the commercial gate (docs/provider-matrix.md, 2026-11-03): only OWN_DEPLOYMENT and
 *                              AUTHORIZED_WHOLESALE may serve managed paid routes. UNVERIFIED and RESTRICTED offers
 *                              stay out of the managed pool while the model catalogue is on; the owner raises a
 *                              provider's access mode only after the agreement that allows it.
 *
 * The uncensored tier: Refuseless's abliterated models (and the abliterated models Featherless lists) are marked
 * `uncensored: true`. Only an offer marked that way may answer a request with `policy: "uncensored"`, and only a
 * request from an 18+ account may ask for one (server/policy/tier.js).
 *
 * Prices change only by review: this file is edited like code, and the price it carries is the price the router
 * ranks on and the balance is charged.
 */

const PRICE_BOOK = { checked: '2026-10-30', file: 'research-2026-10-30/price-book/inference.csv' };
const WATCH_LISTS = { checked: '2026-11-04', file: 'OpenVibe.Watch test/fixtures/provider-rates' };

/** The keys of the nine providers, in the order the router should prefer them when the price is equal. */
const PROVIDER_KEYS = ['qwen', 'kimi', 'glm', 'minimax', 'deepinfra', 'novita', 'featherless', 'refuseless', 'openrouter'];

/**
 * The data policy of a provider, as the price book recorded it. `trains_on_prompts` is one of
 * no | not_stated | yes | unknown; `retention` and `region` are free text (the price book's own words).
 */
const policy = (o) => ({
    trains_on_prompts: o.trains || 'not_stated',
    retention: o.retention || 'not stated',
    region: o.region || 'not stated',
    terms_url: o.terms || null,
    resale: o.resale || null,
    checked: o.checked || PRICE_BOOK.checked,
    source: o.source || null,
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
        data_policy: policy({
            trains: 'not_stated', retention: 'not stated', region: 'international (Singapore)',
            terms: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
            resale: 'no resale clause verified (the 2026-11-03 matrix does not list Alibaba)',
        }),
        models: [
            {
                model_key: 'qwen3.8-max', display_name: 'Qwen3.8-Max', family: 'qwen', context_window: 1048576,
                cost: { in_per_mtok: 2.00, cached_per_mtok: 0.25, out_per_mtok: 6.00 },
                source: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
                note: 'flat across the context length; 50% off in batch',
            },
            {
                model_key: 'qwen3.7-flash', display_name: 'Qwen3.7-Flash', family: 'qwen', context_window: 1048576,
                cost: { in_per_mtok: 0.03, cached_per_mtok: 0.006, out_per_mtok: 0.13 },
                source: 'https://openrouter.ai/api/v1/models', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
                note: 'the cheapest way to answer in this family',
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
        data_policy: policy({
            trains: 'not_stated', retention: 'not stated', region: 'not stated',
            terms: 'https://platform.kimi.ai/docs/pricing/chat',
            resale: 'no resale clause verified (the 2026-11-03 matrix does not list Moonshot)',
        }),
        models: [
            {
                model_key: 'kimi-k3.1-pro', display_name: 'Kimi K3.1 Pro', family: 'kimi', context_window: 1048576,
                cost: { in_per_mtok: 2.00, cached_per_mtok: 0.20, out_per_mtok: 10.00 },
                source: 'https://platform.kimi.ai/docs/pricing/chat', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
                note: 'a million tokens of context; cache writes are billed by their time to live',
            },
            {
                model_key: 'kimi-k3', display_name: 'Kimi K3', family: 'kimi', context_window: 1048576,
                cost: { in_per_mtok: 3.00, cached_per_mtok: 0.30, out_per_mtok: 15.00 },
                source: 'https://www.together.ai/pricing', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
                note: 'the price the price book read from the host lists',
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
        data_policy: policy({
            trains: 'not_stated', retention: 'pay-as-you-go; not stated on the pricing page', region: 'not stated',
            terms: 'https://docs.z.ai/guides/overview/pricing',
            resale: 'no resale clause verified (the 2026-11-03 matrix does not list Z.ai)',
        }),
        models: [
            {
                model_key: 'glm-5.3', display_name: 'GLM-5.3', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 1.40, cached_per_mtok: 0.26, out_per_mtok: 4.40 },
                source: 'https://docs.z.ai/guides/overview/pricing', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
                note: 'cached input is stored free for a limited time',
            },
            {
                model_key: 'glm-5.3-flash', display_name: 'GLM-5.3-Flash', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 0.15, cached_per_mtok: 0.03, out_per_mtok: 0.50 },
                source: 'https://docs.z.ai/guides/overview/pricing', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
            },
            {
                model_key: 'glm-5.3-flashx', display_name: 'GLM-5.3-FlashX', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 0.37, cached_per_mtok: 0.075, out_per_mtok: 1.25 },
                source: 'https://docs.z.ai/guides/overview/pricing', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
            },
            {
                model_key: 'glm-4.7', display_name: 'GLM-4.7', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 0.60, cached_per_mtok: 0.11, out_per_mtok: 2.20 },
                source: 'https://docs.z.ai/guides/overview/pricing', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
            },
            {
                model_key: 'glm-4.7-flash', display_name: 'GLM-4.7-Flash', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 0, cached_per_mtok: 0, out_per_mtok: 0 },
                source: 'https://docs.z.ai/guides/overview/pricing', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
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
        data_policy: policy({
            trains: 'not_stated', retention: 'pay-as-you-go; retention not stated on the pricing page', region: 'not stated',
            terms: 'https://platform.minimax.io/docs/pricing',
            resale: 'no resale clause verified (the 2026-11-03 matrix does not list MiniMax)',
        }),
        models: [
            {
                model_key: 'MiniMax-M3.1-Flash', display_name: 'MiniMax M3.1 Flash', family: 'minimax', context_window: 1048576,
                cost: { in_per_mtok: 0.15, cached_per_mtok: 0.015, out_per_mtok: 0.60 },
                source: 'https://platform.minimax.io/docs/pricing', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
            },
            {
                model_key: 'MiniMax-M3', display_name: 'MiniMax M3', family: 'minimax', context_window: 1048576,
                cost: { in_per_mtok: 0.30, cached_per_mtok: 0.06, out_per_mtok: 1.20 },
                source: 'https://platform.minimax.io/docs/pricing', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
                note: 'the price of the 512k input tier; the priority tier costs 1.5x (0.45 / 0.09 / 1.80)',
            },
        ],
    },
    {
        key: 'deepinfra',
        display_name: 'DeepInfra',
        base_url: 'https://api.deepinfra.com/v1/openai',
        default_model: 'deepseek-v4.1-flash-1017',
        timeout_ms: 90000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'RESTRICTED',
        priority: 30,
        data_policy: policy({
            trains: 'no', retention: 'serves open-weight models; no training on prompts', region: 'not stated',
            terms: 'https://deepinfra.com/terms',
            resale: 'RESTRICTED (2026-11-03 matrix): "resell, sublicense, rent, distribute, or otherwise make the Services available to any third party except as expressly permitted under this Agreement or the applicable Service Order" (Terms §11(a)(viii), modified 2026-10-15)',
        }),
        models: [
            {
                model_key: 'deepseek-v4.1-flash-1017', display_name: 'DeepSeek V4.1 Flash 1017', family: 'deepseek', context_window: 1048576,
                cost: { in_per_mtok: 0.098, cached_per_mtok: 0.00294, out_per_mtok: 0.294 },
                source: 'https://router.requesty.ai/v1/models', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
                note: 'the cheapest route the price book found; the priority variant costs 15x',
            },
            {
                model_key: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash', family: 'deepseek', context_window: 1048576,
                cost: { in_per_mtok: 0.09, cached_per_mtok: 0.009, out_per_mtok: 0.18 },
                source: 'https://api.deepinfra.com/v1/models', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
            },
            {
                model_key: 'gpt-oss-120b', display_name: 'GPT-OSS 120B', family: 'gpt-oss', context_window: 131072,
                cost: { in_per_mtok: 0.037, cached_per_mtok: 0.0037, out_per_mtok: 0.17 },
                source: 'https://api.deepinfra.com/v1/models', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
            },
        ],
    },
    {
        key: 'novita',
        display_name: 'Novita AI',
        base_url: 'https://api.novita.ai/v3/openai',
        default_model: 'deepseek-v4.1-flash-1017',
        timeout_ms: 90000,
        capabilities: ['chat', 'generate', 'summarize', 'classify', 'extract', 'enrich', 'json', 'tools'],
        provider_access: 'UNVERIFIED',
        priority: 30,
        data_policy: policy({
            trains: 'no', retention: 'no training on prompts stated', region: 'not stated',
            terms: 'https://api.novita.ai/v3/openai/models',
            resale: 'UNVERIFIED (2026-11-03 matrix): the terms page returned 404',
        }),
        models: [
            {
                model_key: 'deepseek-v4.1-flash-1017', display_name: 'DeepSeek V4.1 Flash 1017', family: 'deepseek', context_window: 1048576,
                cost: { in_per_mtok: 0.30, cached_per_mtok: 0.006, out_per_mtok: 1.20 },
                source: 'https://api.novita.ai/v3/openai/models', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
            },
            {
                model_key: 'kimi-k3.1-pro', display_name: 'Kimi K3.1 Pro', family: 'kimi', context_window: 1048576,
                cost: { in_per_mtok: 2.00, cached_per_mtok: 0.20, out_per_mtok: 10.00 },
                source: 'https://api.novita.ai/v3/openai/models', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
            },
            {
                model_key: 'glm-5.3', display_name: 'GLM-5.3', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 1.40, cached_per_mtok: 0.26, out_per_mtok: 4.40 },
                source: 'https://api.novita.ai/v3/openai/models', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
            },
            {
                model_key: 'qwen3.8-max', display_name: 'Qwen3.8-Max', family: 'qwen', context_window: 1048576,
                cost: { in_per_mtok: 2.00, cached_per_mtok: 0.25, out_per_mtok: 6.00 },
                source: 'https://api.novita.ai/v3/openai/models', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
            },
            {
                model_key: 'mimo-v2.6-flash', display_name: 'MiMo V2.6 Flash', family: 'mimo', context_window: 1048576,
                cost: { in_per_mtok: 0.14, cached_per_mtok: 0.0028, out_per_mtok: 0.28 },
                source: 'https://api.novita.ai/v3/openai/models', checked: PRICE_BOOK.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
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
        data_policy: policy({
            trains: 'not_stated', retention: 'not stated', region: 'not stated',
            terms: 'https://featherless.ai/terms',
            resale: 'AUTHORIZED_WHOLESALE, Scale plans only (2026-11-03 matrix): "Scale plans are not subject to said limits and may be used in arbitrary applications, including inference resale." (Terms §3, last updated 2024-06-10). It needs an executed Scale agreement before the managed pool may use it.',
            checked: WATCH_LISTS.checked,
        }),
        models: [
            {
                model_key: 'Qwen/Qwen3-14B', display_name: 'Qwen3 14B', family: 'qwen', context_window: 32768,
                cost: { in_per_mtok: 0.12, cached_per_mtok: 0.012, out_per_mtok: 0.24 },
                source: 'https://api.featherless.ai/v1/models', checked: WATCH_LISTS.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
                note: 'Featherless states its price per token; the catalog holds it per million',
            },
            {
                model_key: 'Qwen/Qwen3-0.6B', display_name: 'Qwen3 0.6B', family: 'qwen', context_window: 32768,
                cost: { in_per_mtok: 0.04, cached_per_mtok: 0.004, out_per_mtok: 0.08 },
                source: 'https://api.featherless.ai/v1/models', checked: WATCH_LISTS.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
            },
            {
                model_key: 'meta-llama/Meta-Llama-3.1-8B-Instruct', display_name: 'Llama 3.1 8B Instruct', family: 'llama', context_window: 32768,
                cost: { in_per_mtok: 0.05, cached_per_mtok: 0.005, out_per_mtok: 0.08 },
                source: 'https://api.featherless.ai/v1/models', checked: WATCH_LISTS.checked,
                supports: { json: true, tools: true, streaming: true, vision: false },
                note: 'gated on Featherless: the price is published, the model needs the account to be let in',
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
        data_policy: policy({
            trains: 'unknown', retention: 'unknown', region: 'unknown',
            terms: 'https://refuseless.com/pricing',
            resale: 'UNVERIFIED (2026-11-03 matrix): no terms URL was located',
            checked: '2026-10-25',
        }),
        models: [
            {
                model_key: 'deepseek-v4.1-flash-abliterated', display_name: 'DeepSeek V4.1 Flash (abliterated)', family: 'deepseek', context_window: 1048576,
                cost: { in_per_mtok: 0.22, cached_per_mtok: 0.045, out_per_mtok: 0.75 },
                source: 'https://refuseless.com/pricing', checked: '2026-10-25',
                supports: { json: true, tools: true, streaming: true, vision: false },
                uncensored: true,
                note: 'the price LiteLLM read on 2026-10-25; the price book could not read the catalogue (401)',
            },
            {
                model_key: 'glm-5.3-flash-abliterated', display_name: 'GLM 5.3 Flash (abliterated)', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 0.25, cached_per_mtok: 0.15, out_per_mtok: 0.80 },
                source: 'https://refuseless.com/pricing', checked: '2026-10-25',
                supports: { json: true, tools: true, streaming: true, vision: false },
                uncensored: true,
            },
            {
                model_key: 'glm-5.3-abliterated', display_name: 'GLM 5.3 (abliterated)', family: 'glm', context_window: 1048576,
                cost: { in_per_mtok: 1.25, cached_per_mtok: 0.25, out_per_mtok: 2.25 },
                source: 'https://refuseless.com/pricing', checked: '2026-10-25',
                supports: { json: true, tools: true, streaming: true, vision: false },
                uncensored: true,
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
        data_policy: policy({
            trains: 'provider_dependent', retention: 'prompts and completions are not logged by default; the providers that log are not routed unless the training toggle is on',
            region: 'not stated', terms: 'https://openrouter.ai/terms',
            resale: 'UNVERIFIED (2026-11-03 matrix does not list OpenRouter). The price book (2026-10-30) records that its terms contemplate selling capacity inside your own product; that is not the same as an executed agreement.',
        }),
        // OpenRouter lists hundreds of models and prices each one itself; the catalogue sync reads its own list with
        // the key. No model is seeded here: a price we did not read from OpenRouter is not one of ours to publish.
        models: [],
    },
];

const byKey = new Map(PROVIDERS.map((p) => [p.key, p]));

/** The name a provider's model is known by in the price book, without its namespace: `deepseek/deepseek-chat` -> `deepseek-chat`. */
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

module.exports = { PROVIDERS, PROVIDER_KEYS, PRICE_BOOK, WATCH_LISTS, byKey, priceOf, isUncensored, leaf };
