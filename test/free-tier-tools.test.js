'use strict';
/**
 * Free runs that call tools (11-17): the owner's Actor tasks failed with "free AI allowance … spent" though his rank
 * has no cap. Actor's loop needs tools; the free tier's sources were deepseek, local and community, and the seeded
 * DeepSeek provider did not list tools (its models do, and the pool preset does), so placement found no capable free
 * source and the run ended as an allowance 402. The seed lists tools now; and when the free sources are skipped for
 * what they cannot do, the answer says that (ai.free_unavailable, still a 402 on every route) instead of "spent".
 *   node test/free-tier-tools.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { providerRecords } = require('../server/workflows/seed');
const { load } = require('../server/config');

const env = { NODE_ENV: 'test', DEEPSEEK_API_KEY: 'fixture-deepseek-key', AI_DEEPSEEK_API_KEY: 'fixture-deepseek-key' };
const config = load(env);
const records = providerRecords(config, env);
const deepseek = records.find((p) => p.key === 'deepseek');
assert.ok(deepseek, 'the DeepSeek provider is seeded');
assert.ok(deepseek.capabilities.includes('tools'), 'DeepSeek can call tools');
assert.ok(deepseek.capabilities.includes('chat'));

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8');
const runs = read('runs.js');
assert.match(runs, /code = 'ai\.free_unavailable';[\s\S]{0,400}No free model can take this run/, 'the true reason when the free sources cannot do it');
assert.match(runs, /freeIncapable && !payerSkipped/, 'a spent allowance still says spent');
for (const f of ['api/openai.js', 'api/messages.js', 'api/speech.js', 'api/compat-extra.js']) {
    const src = read(f);
    const n = (src.match(/code === 'ai\.allowance_spent' \|\| code === 'ai\.free_unavailable'/g) || []).length;
    assert.ok(n >= 1, `${f}: ai.free_unavailable answers 402 like a spent allowance`);
}
console.log('free-tier-tools: DeepSeek is seeded with tools; a free run nothing free can do says so, as a 402');
