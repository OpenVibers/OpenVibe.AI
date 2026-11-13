'use strict';
/**
 * The AI meter, the part OpenVibe.AI keeps (plan L40): the tokens each adapter reads, the money of a call, and the
 * record AI publishes as one ai.call.recorded@1 event. The ledger itself is OpenVibe.Report's.
 */
const assert = require('assert');
const { suite } = require('./helpers');
const usageParsers = require('../server/providers/usage');
const record = require('../server/usage-record');
const events = require('../server/events');

const t = suite('ai-usage');

t.test('every adapter reads its own cached tokens, and never counts them twice', () => {
    // Anthropic: input_tokens EXCLUDES the cache reads and the cache writes.
    const anthropic = usageParsers.anthropicUsage({
        input_tokens: 1000, output_tokens: 200,
        cache_read_input_tokens: 8000, cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 },
    });
    assert.strictEqual(anthropic.cached, 8000, 'the Anthropic cache read');
    assert.strictEqual(anthropic.cache_write, 500, 'the Anthropic cache write');
    assert.strictEqual(anthropic.cache_write_ttl, '5m', 'the bigger 5m share says so');
    assert.strictEqual(anthropic.input, 9500, 'the whole prompt: 1000 + 8000 + 500');
    assert.strictEqual(usageParsers.uncachedInput(anthropic), 1000, 'the uncached input is the input_tokens');
    assert.strictEqual(usageParsers.anthropicUsage({ input_tokens: 10, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 200 } }).cache_write_ttl, '1h', 'a 1h cache write says so');

    // OpenAI: prompt_tokens INCLUDES the cached tokens.
    const openai = usageParsers.openAiUsage({
        prompt_tokens: 1000, completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 100 },
    });
    assert.strictEqual(openai.cached, 800, 'the OpenAI cache read');
    assert.strictEqual(openai.reasoning, 100, 'the OpenAI reasoning');
    assert.strictEqual(openai.output, 200, 'the reasoning is counted apart, never twice');
    assert.strictEqual(usageParsers.uncachedInput(openai), 200, '1000 prompt tokens, 800 of them cached: 200 left');

    // DeepSeek: its own fields, prompt_tokens = hit + miss.
    const deepseek = usageParsers.deepSeekUsage({ prompt_tokens: 9000, completion_tokens: 100, prompt_cache_hit_tokens: 8000, prompt_cache_miss_tokens: 1000 });
    assert.strictEqual(deepseek.cached, 8000, 'the DeepSeek cache hit');
    assert.strictEqual(usageParsers.uncachedInput(deepseek), 1000, 'the DeepSeek cache miss is the uncached input');

    // Gemini: promptTokenCount INCLUDES cachedContentTokenCount.
    const gemini = usageParsers.geminiUsage({ promptTokenCount: 5000, candidatesTokenCount: 400, thoughtsTokenCount: 150, cachedContentTokenCount: 4000 });
    assert.strictEqual(gemini.cached, 4000, 'the Gemini cached content');
    assert.strictEqual(gemini.reasoning, 150, 'the Gemini thinking');
    assert.strictEqual(usageParsers.uncachedInput(gemini), 1000, 'the Gemini uncached input');

    // The Responses API counts its cached tokens apart too.
    const responses = usageParsers.responsesUsage({ input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 800 } });
    assert.strictEqual(usageParsers.uncachedInput(responses), 200, 'the Responses API cache read');
});

t.test('the money of a record: a typed cache price, and none typed', () => {
    const cards = {
        in: { unit_price_usd: 10, source: 'urn:openvibe:ai:unverified:models', verified_at: '2026-10-31' },
        out: { unit_price_usd: 30, source: 'urn:openvibe:ai:unverified:models' },
        cached: { unit_price_usd: 1, source: 'urn:openvibe:ai:unverified:models' },
        cache_write: { unit_price_usd: 12, source: 'urn:openvibe:ai:unverified:models' },
    };
    const tokens = { input: 1000, output: 200, cache_read: 10000, cache_write: 500 };
    const priced = record.pricesOf(cards);
    assert.strictEqual(priced.source, 'models', 'the prices are the ones a person typed');
    assert.strictEqual(priced.date, '2026-10-31');
    const money = record.moneyOf({ prices: priced, tokens, paidBy: 'openvibe_key', feeRate: 0.1 });
    assert.strictEqual(money.list_cost_usd, 0.032, '1000 in, 200 out, 10000 cache read, 500 cache write');
    assert.strictEqual(money.cache_saved_usd, 0.089, 'what the cache saved against the input price');
    assert.strictEqual(money.charged_usd, 0.032, 'the OpenVibe key pays the list cost');
    assert.strictEqual(money.fee_usd, 0.0032, 'and the network fee on top');
    const own = record.moneyOf({ prices: priced, tokens, paidBy: 'own_key' });
    assert.strictEqual(own.charged_usd, 0, 'the key of the person is never charged here');
    assert.strictEqual(own.fee_usd, 0);

    // No cache price typed: the cache tokens are priced at the plain input price and the record says so.
    const unpriced = record.pricesOf({ ...cards, cached: { unit_price_usd: 1, source: 'urn:openvibe:ai:unverified:derived' }, cache_write: { unit_price_usd: 0, source: 'urn:openvibe:ai:unverified:unpriced' } });
    assert.strictEqual(unpriced.source, 'no cache price', 'the record says the cache price is missing');
    assert.strictEqual(unpriced.cache_read, 10, 'the cache read is priced at the input price');
    const m2 = record.moneyOf({ prices: unpriced, tokens, paidBy: 'openvibe_key' });
    assert.strictEqual(m2.cache_saved_usd, 0, 'nothing is saved without a cache price');
    assert.strictEqual(m2.list_cost_usd, 0.121);
});

t.test('the record of a run carries the tokens and the money, and no text at all', () => {
    const rec = record.recordOf({
        system: 'ai', run_id: 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ', subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ',
        attribution: 'site:design', surface: 'ai.generate', provider: 'anthropic', model: 'claude-sonnet-4-5',
        paid_by: 'own_key', paid_by_detail: 'anthropic ...a1b2',
        input: 200, output: 80, reasoning: 0, cache_read: 800, cache_write: 0,
        list_cost_usd: 0.0021, charged_usd: 0, fee_usd: 0, cache_saved_usd: 0.0012,
        price_source: 'models', price_date: '2026-10-31', latency_ms: 1200, ttft_ms: 300, attempts: 1, outcome: 'succeeded',
        at: '2026-10-31T18:00:00.000Z',
    });
    const payload = events.callPayload(rec);
    assert.strictEqual(payload.input, 200, 'the uncached input');
    assert.strictEqual(payload.cache_read, 800, 'the cache read');
    assert.strictEqual(payload.paid_by, 'own_key', 'who paid');
    assert.strictEqual(payload.cache_saved_usd, 0.0012, 'what the cache saved');
    assert.strictEqual(payload.run_id, 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ');
    const text = JSON.stringify(payload);
    for (const forbidden of ['prompt', 'output_text', 'answer', 'input_text', 'content']) {
        assert.ok(!text.includes(forbidden), 'the record carries no ' + forbidden);
    }
    assert.throws(() => record.recordOf({ paid_by: 'someone_else' }), /paid_by/, 'only the known payers');
});

t.test('the 1.1.0 fields: operation, speed, task, place and the failure class', () => {
    const rec = record.recordOf({
        system: 'ai', run_id: 'run_01JAB2C3D4E5F6G7H8J9K0MNPQ', subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ',
        attribution: 'site:design', surface: 'ai.generate', provider: 'anthropic', model: 'claude-sonnet-4-5',
        paid_by: 'openvibe_key', input: 200, output: 80, list_cost_usd: 0.0021, charged_usd: 0.0021,
        latency_ms: 1200, ttft_ms: 300, attempts: 3, outcome: 'succeeded', at: '2026-10-31T18:00:00.000Z',
        operation: 'chat', streamed: true, tps: 21.5, queue_ms: 12, task: 'chat.reply', task_id: 'run_PARENT',
        harness: 'openvibe', place: 'provider', error_class: null, fallbacks: 2, cache_hit: false,
    });
    const payload = events.callPayload(rec);
    assert.strictEqual(payload.operation, 'chat', 'what kind of call it was');
    assert.strictEqual(payload.streamed, true, 'whether it streamed');
    assert.strictEqual(payload.tps, 21.5, 'decode tokens per second');
    assert.strictEqual(payload.queue_ms, 12, 'time waited before the call');
    assert.strictEqual(payload.task, 'chat.reply');
    assert.strictEqual(payload.task_id, 'run_PARENT', 'the task the call is one step of');
    assert.strictEqual(payload.place, 'provider', 'where the model ran');
    assert.strictEqual(payload.fallbacks, 2, 'the offers that failed before the answer');
    assert.strictEqual(payload.cache_hit, false, 'not an exact-cache answer');
    assert.strictEqual(payload.harness, 'openvibe');

    // The operation comes from the run's own operation or workflow, never invented.
    assert.strictEqual(record.operationOf({ workflowKey: 'ai.generate', operation: 'generate' }), 'chat');
    assert.strictEqual(record.operationOf({ workflowKey: 'decide.fallback', operation: 'classify' }), 'decision');
    assert.strictEqual(record.operationOf({ workflowKey: 'ai.embed', operation: 'embed' }), 'embedding');
    assert.strictEqual(record.operationOf({ workflowKey: 'ai.speak', operation: 'speak' }), 'speech');
    assert.strictEqual(record.operationOf({ workflowKey: 'live.media.transcribe', operation: 'transcribe' }), 'transcription');
    assert.strictEqual(record.operationOf({ workflowKey: 'live.translate', operation: 'generate' }), 'translation');
    assert.strictEqual(record.operationOf({ workflowKey: 'moderation.classify', operation: 'classify' }), 'moderation');
    assert.strictEqual(record.operationOf({ workflowKey: 'ai.image', operation: 'image' }), 'image');

    // The provider's five failure classes become the meter's names.
    assert.strictEqual(record.errorClassOf({ failureClass: 'rate_limit' }), 'rate_limited');
    assert.strictEqual(record.errorClassOf({ failureClass: 'auth' }), 'auth');
    assert.strictEqual(record.errorClassOf({ failureClass: 'transient', code: 'provider.timeout' }), 'timeout');
    assert.strictEqual(record.errorClassOf({ failureClass: 'transient', message: 'fetch failed: ECONNRESET' }), 'network');
    assert.strictEqual(record.errorClassOf({ failureClass: 'transient', status: 503 }), 'server');
    assert.strictEqual(record.errorClassOf({ failureClass: 'request', message: 'maximum context length exceeded' }), 'context_length');
    assert.strictEqual(record.errorClassOf({ failureClass: 'request', message: 'the policy floor refused it' }), 'refused');
    assert.strictEqual(record.errorClassOf({ failureClass: 'request', message: 'invalid schema' }), 'invalid');

    // TPS is null when there is too little to measure: under 8 output tokens or under 200 ms.
    assert.strictEqual(record.tpsOf({ output: 20, streamed: true, firstDeltaAt: 1000, finishedAt: 2000 }), 20);
    assert.strictEqual(record.tpsOf({ output: 7, streamed: true, firstDeltaAt: 1000, finishedAt: 2000 }), null);
    assert.strictEqual(record.tpsOf({ output: 20, streamed: true, firstDeltaAt: 1000, finishedAt: 1199 }), null);
    assert.strictEqual(record.tpsOf({ output: 20, streamed: false, firstDeltaAt: 1000, finishedAt: 2000 }), null);
});

(async () => { await t.run(); })();
