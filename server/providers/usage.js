'use strict';
/**
 * What a provider's answer says about the tokens it used (plan L40: one meter, and the cache is part of the bill).
 *
 * Every adapter answers the same shape, so the ledger can read one record whatever the provider was:
 *
 *   input             the WHOLE prompt: the uncached input plus the cache reads plus the cache writes
 *   output            the tokens the provider produced (the reasoning tokens are counted apart)
 *   reasoning         the thinking tokens, when the provider counts them apart
 *   cached            the tokens read from the provider's cache
 *   cache_write       the tokens written to the provider's cache
 *   cache_write_ttl   '5m' or '1h', when the provider says how long the written entry lives
 *   images / audio_seconds / video_seconds   the metered media
 *
 * The providers do not agree, so each one is read on its own terms (and never counted twice):
 *
 *   Anthropic   input_tokens EXCLUDES the cache reads and the cache writes; the cache reads are
 *               cache_read_input_tokens, the writes cache_creation_input_tokens (5m and 1h apart
 *               under cache_creation).
 *   OpenAI      prompt_tokens INCLUDES the cached tokens; the cache read is
 *               prompt_tokens_details.cached_tokens, the reasoning completion_tokens_details.reasoning_tokens.
 *   DeepSeek    prompt_cache_hit_tokens and prompt_cache_miss_tokens, and prompt_tokens = hit + miss.
 *   Gemini      promptTokenCount INCLUDES cachedContentTokenCount; the reasoning is thoughtsTokenCount.
 *
 * The record's own 'input' is the UNCACHED input: this shape's input minus its cached minus its cache_write.
 */

const num = (v) => (v === null || v === undefined || v === '' ? 0 : (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0));

/** The shape every parser answers. */
const empty = () => ({ input: 0, output: 0, reasoning: 0, cached: 0, cache_write: 0, cache_write_ttl: null });

/** Anthropic: input_tokens excludes the cache reads and the cache writes. */
function anthropicUsage(u = {}) {
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheWrite = num(u.cache_creation_input_tokens);
    const uncached = num(u.input_tokens);
    const creation = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {};
    const oneHour = num(creation.ephemeral_1h_input_tokens);
    const fiveMin = num(creation.ephemeral_5m_input_tokens);
    return {
        ...empty(),
        input: uncached + cacheRead + cacheWrite,
        output: num(u.output_tokens),
        cached: cacheRead,
        cache_write: cacheWrite || fiveMin + oneHour,
        cache_write_ttl: (cacheWrite || fiveMin || oneHour) ? (oneHour > 0 && oneHour >= fiveMin ? '1h' : '5m') : null,
    };
}

/** OpenAI (and every compatible gateway): prompt_tokens includes the cached tokens. */
function openAiUsage(u = {}) {
    const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? u.prompt_tokens_details : {};
    const completion = u.completion_tokens_details && typeof u.completion_tokens_details === 'object' ? u.completion_tokens_details : {};
    const cached = num(details.cached_tokens);
    const reasoning = num(completion.reasoning_tokens);
    const output = num(u.completion_tokens);
    return {
        ...empty(),
        input: num(u.prompt_tokens),
        output: Math.max(0, output - reasoning),      // the reasoning is counted apart, never twice
        reasoning,
        cached,
        cache_write: 0,
        cache_write_ttl: null,
    };
}

/** OpenAI's Responses API: input_tokens and its cached tokens live in input_tokens_details. */
function responsesUsage(u = {}) {
    const details = u.input_tokens_details && typeof u.input_tokens_details === 'object' ? u.input_tokens_details : {};
    const completion = u.output_tokens_details && typeof u.output_tokens_details === 'object' ? u.output_tokens_details : {};
    const cached = num(details.cached_tokens);
    const reasoning = num(completion.reasoning_tokens);
    const output = num(u.output_tokens);
    return {
        ...empty(),
        input: num(u.input_tokens),
        output: Math.max(0, output - reasoning),
        reasoning,
        cached,
        cache_write: 0,
        cache_write_ttl: null,
    };
}

/** DeepSeek (OpenAI-shaped): prompt_cache_hit_tokens and prompt_cache_miss_tokens, prompt_tokens = hit + miss. */
function deepSeekUsage(u = {}) {
    const hit = num(u.prompt_cache_hit_tokens);
    const miss = num(u.prompt_cache_miss_tokens);
    const prompt = num(u.prompt_tokens);
    // DeepSeek counts prompt_tokens as hit + miss. When only one of the two is reported, the prompt total still counts.
    const input = hit || miss ? hit + miss : prompt;
    const reasoning = num(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens);
    const output = num(u.completion_tokens);
    return {
        ...empty(),
        input,
        output: Math.max(0, output - reasoning),
        reasoning,
        cached: hit,
        cache_write: 0,
        cache_write_ttl: null,
    };
}

/** Gemini (native): promptTokenCount includes cachedContentTokenCount; thoughtsTokenCount is the thinking. */
function geminiUsage(u = {}) {
    const details = Array.isArray(u.promptTokensDetails) ? u.promptTokensDetails[0] : null;
    const cached = num(u.cachedContentTokenCount) || num(details && details.cachedContentTokenCount);
    const reasoning = num(u.thoughtsTokenCount);
    const output = num(u.candidatesTokenCount);
    return {
        ...empty(),
        input: num(u.promptTokenCount),
        output: Math.max(0, output - reasoning),
        reasoning,
        cached,
        cache_write: 0,
        cache_write_ttl: null,
    };
}

/**
 * The usage of an OpenAI-shaped answer, whichever gateway sent it: DeepSeek's own fields win when they
 * are there, OpenAI's details otherwise.
 */
function openAiCompatibleUsage(u = {}) {
    if (u && (u.prompt_cache_hit_tokens !== undefined || u.prompt_cache_miss_tokens !== undefined)) return deepSeekUsage(u);
    return openAiUsage(u);
}

/** The uncached input of a usage shape: the whole prompt less the cache reads and the cache writes. */
const uncachedInput = (usage = {}) => Math.max(0, num(usage.input) - num(usage.cached) - num(usage.cache_write));

/** The cache tokens of a usage shape, read and written. */
const cacheTokens = (usage = {}) => ({ read: num(usage.cached), write: num(usage.cache_write) });

module.exports = { num, empty, anthropicUsage, openAiUsage, responsesUsage, deepSeekUsage, geminiUsage, openAiCompatibleUsage, uncachedInput, cacheTokens };
