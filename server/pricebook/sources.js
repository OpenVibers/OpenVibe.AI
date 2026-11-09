'use strict';
/**
 * The price listings the price book reads: each catalogued provider's own model and price list.
 *
 * A price is only ever read from the provider that sells it. OpenRouter's public model list is in here as a
 * cross-reference: it is a second opinion about what a model costs, never the source of a price, so nothing the
 * job learns from it can change a price.
 *
 * The URLs are the ones the catalogue already names in each model's source (server/providers/pool-providers.js),
 * so the price a card shows and the price the book read point at the same page. Two of them answer in a slightly
 * different shape than the catalogue's URL suggests (MiniMax redirects to its pricing overview, Alibaba's page
 * is the HTML table behind the markdown URL), and the reader follows the redirect by hand.
 */
const parsers = require('./parsers');

/** Every provider's own listing, in the order the job reads them. */
const SOURCES = [
    {
        key: 'deepseek',
        provider: 'deepseek',
        role: 'own',
        url: 'https://api-docs.deepseek.com/quick_start/pricing.md',
        kind: 'text',
        parse: parsers.deepseek,
        // The off-peak window the same listing publishes, read for the batch capacity rules.
        offPeak: parsers.deepseekOffPeak,
        // The peak hours it publishes, as off-peak weekday blocks (BA1): one daily window cannot say
        // "peak 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday".
        offPeakBlocks: parsers.deepseekOffPeakBlocks,
    },
    {
        key: 'qwen',
        provider: 'qwen',
        role: 'own',
        url: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
        kind: 'text',
        parse: parsers.qwen,
    },
    {
        key: 'kimi',
        provider: 'kimi',
        role: 'own',
        url: 'https://platform.kimi.ai/docs/pricing/chat',
        kind: 'text',
        parse: parsers.kimi,
    },
    {
        key: 'glm',
        provider: 'glm',
        role: 'own',
        url: 'https://docs.z.ai/guides/overview/pricing.md',
        kind: 'text',
        parse: parsers.glm,
    },
    {
        key: 'minimax',
        provider: 'minimax',
        role: 'own',
        url: 'https://platform.minimax.io/docs/pricing.md',
        kind: 'text',
        parse: parsers.minimax,
    },
    {
        key: 'deepinfra',
        provider: 'deepinfra',
        role: 'own',
        url: 'https://api.deepinfra.com/v1/models',
        kind: 'json',
        parse: parsers.deepinfra,
    },
    {
        key: 'novita',
        provider: 'novita',
        role: 'own',
        url: 'https://api.novita.ai/v3/openai/models',
        kind: 'json',
        parse: parsers.novita,
    },
    {
        key: 'featherless',
        provider: 'featherless',
        role: 'own',
        url: 'https://api.featherless.ai/v1/models',
        kind: 'json',
        parse: parsers.featherless,
    },
    {
        key: 'refuseless',
        provider: 'refuseless',
        role: 'own',
        url: 'https://docs.refuseless.com/api/models.md',
        kind: 'text',
        parse: parsers.refuseless,
    },
    {
        key: 'abliteration',
        provider: 'abliteration',
        role: 'own',
        url: 'https://docs.abliteration.ai/pricing.md',
        kind: 'text',
        parse: parsers.abliteration,
    },
    {
        key: 'openrouter',
        provider: 'openrouter',
        role: 'cross-reference',
        url: 'https://openrouter.ai/api/v1/models',
        kind: 'json',
        parse: parsers.openrouter,
    },
    ...[
        ['venice', 'https://api.venice.ai/api/v1/models'],
        ['abliteratedmodels', 'https://api.abliteratedmodels.cc/v1/models'],
        ['uplinkswitch', 'https://api.uplinkswitch.ai/v1/models'],
        ['chutes', 'https://llm.chutes.ai/v1/models'],
        ['siliconflow', 'https://api.siliconflow.com/v1/models'],
        ['nebius', 'https://api.tokenfactory.nebius.com/v1/models'],
        ['together', 'https://api.together.xyz/v1/models'],
        ['fireworks', 'https://api.fireworks.ai/inference/v1/models'],
        ['groq', 'https://api.groq.com/openai/v1/models'],
        ['cerebras', 'https://api.cerebras.ai/public/v1/models'],
        ['sambanova', 'https://api.sambanova.ai/v1/models'],
        ['baseten', 'https://inference.baseten.co/v1/models'],
        ['hyperbolic', 'https://api.hyperbolic.xyz/v1/models'],
    ].map(([key, url]) => ({ key, provider: key, role: 'own', url, kind: 'json', parse: parsers.compatibleModels })),
];

/** The listings that may change a price (the cross-reference is not one of them). */
const ownSources = () => SOURCES.filter((s) => s.role === 'own');

/** The one listing that only says what the others say. */
const crossReference = () => SOURCES.find((s) => s.role === 'cross-reference') || null;

module.exports = { SOURCES, ownSources, crossReference };
