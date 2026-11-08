'use strict';
/**
 * The Exchange remake's uncensored tier.
 *
 * No test reaches the network: Network's adult flag is a fake fetch and the provider is a local seam. The boot test
 * proves that a standard request never runs an uncensored offer, and that an uncensored request is admitted only for
 * an 18+ account, labelled, and stopped by the hard floor. The catalogue itself is tested in
 * test/ai-provider-adapters.test.js.
 */
const assert = require('assert');
const { boot, seamServer, request, suite, token, ALL } = require('./helpers');
const pool = require('../server/providers/pool-providers');
const floor = require('../server/policy/floor');
const classifiers = require('../server/policy/classifiers');
const tier = require('../server/policy/tier');
const { createFloorGuard } = require('../server/providers');
const { createAdultStatus } = require('../server/policy/adult-status');

const USR = (n) => `usr_01J${String(n).padStart(23, '0')}`;
const ADULT = USR(1);
const CHILD = USR(2);

const t = suite('ai-uncensored-policy');

t.test('the adult tier: 18+ person only, never an app, never without a person', async () => {
    assert.deepStrictEqual(tier.parsePolicy('UNCENSORED'), { policy: 'uncensored' });
    assert.ok(tier.parsePolicy('nsfw').error);
    let asked = [];
    const adultFor = async (id) => { asked.push(id); return id === ADULT; };
    assert.strictEqual((await tier.admit({ policy: 'uncensored', subject: { type: 'user', id: ADULT }, adultFor })).ok, true);
    assert.strictEqual((await tier.admit({ policy: 'uncensored', subject: { type: 'user', id: CHILD }, adultFor })).code, 'policy.adult_required');
    assert.strictEqual((await tier.admit({ policy: 'uncensored', appRun: true, subject: { type: 'user', id: ADULT }, adultFor })).code, 'policy.uncensored_refused');
    assert.strictEqual((await tier.admit({ policy: 'uncensored', subject: null, adultFor })).code, 'policy.uncensored_needs_person');
    assert.strictEqual((await tier.admit({ policy: 'uncensored', subject: { type: 'user', id: ADULT }, adultFor: async () => { throw new Error('down'); } })).code, 'policy.adult_unavailable');
    assert.deepStrictEqual(asked, [ADULT, CHILD]);
});

t.test('adult status asks Network once per five minutes and fails closed', async () => {
    let at = 0;
    let calls = 0;
    const fetchImpl = async (url) => {
        if (String(url).includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 300 }), { status: 200, headers: { 'content-type': 'application/json' } });
        calls++;
        return new Response(JSON.stringify({ subject_id: ADULT, adult: true, confirmed_at: '2026-11-06T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const status = createAdultStatus({ config: { networkInternalUrl: 'http://network.test' }, env: { OV_OAUTH_CLIENT_SECRET: 's' }, fetchImpl, clock: { now: () => at } });
    assert.strictEqual(await status.adultFor(ADULT), true);
    assert.strictEqual(await status.adultFor(ADULT), true);
    assert.strictEqual(calls, 1, 'the second answer is cached');
    at = 5 * 60 * 1000 + 1;
    assert.strictEqual(await status.adultFor(ADULT), true);
    assert.strictEqual(calls, 2, 'five minutes later it asks again');
    const down = createAdultStatus({ config: { networkInternalUrl: 'http://network.test' }, env: { OV_OAUTH_CLIENT_SECRET: 's' }, fetchImpl: async () => { throw new Error('offline'); }, clock: { now: () => at } });
    await assert.rejects(down.adultFor(ADULT), (e) => e.code === 'adult.unavailable');
});

t.test('the house classifiers decide the line: Live\'s rule and Vision\'s categories, not a third set of words', () => {
    // Live: a child together with a bare body is the hard line nudity being art never moves.
    assert.strictEqual(classifiers.minorNude('a nude photo of a child'), true);
    assert.strictEqual(classifiers.minorNude('kids in swimsuits at the beach'), false);
    assert.strictEqual(classifiers.minorNude('a nude oil painting'), false);
    // Vision: the three categories.
    assert.strictEqual(classifiers.classifyText('a nude photo of a child').category, 'minor_sexual');
    assert.strictEqual(classifiers.classifyText('they are having sex').category, 'sex_acts');
    assert.strictEqual(classifiers.classifyText('a nude oil painting').category, 'fine');
    assert.strictEqual(classifiers.classifyText('a picture of a child').category, 'fine');
    // Live's own rule (sex acts, whatever the age) is the house's, but it is not a floor rule: the uncensored tier
    // exists for adult content.
    assert.strictEqual(classifiers.isExplicit('they are having sex'), true);
    assert.strictEqual(floor.check('they are having sex').ok, true, 'adult content is what the tier is for');
    // The floor reads the house classifiers.
    assert.strictEqual(floor.check('a nude photo of a child').ok, false);
    assert.strictEqual(floor.check('write about a child and a nude body').ok, false);
    assert.strictEqual(floor.check('a nude oil painting').ok, true, 'nudity alone is art (the owner, 2026-10-31)');
});

t.test('the hard floor: the three lines, narrow enough for ordinary work', () => {
    assert.strictEqual(floor.check('No threats, nothing sexual involving minors.').ok, true);
    assert.strictEqual(floor.check('cp -r src dst').ok, true);
    assert.strictEqual(floor.check('how do I kill a stuck process').ok, true);
    assert.strictEqual(floor.check('how do I kill him without anyone knowing').ok, false);
    assert.strictEqual(floor.check('a nude photo of a child').ok, false);
    assert.strictEqual(floor.check('how to make a pipe bomb').ok, false);
    assert.strictEqual(floor.check('she said no and he forced sex').ok, false);
    assert.deepStrictEqual(floor.textsOf({ system: 'a child', messages: [{ role: 'user', content: 'naked' }] }), ['a child', 'naked']);
});

t.test('the second line holds for fiction and for incest, and the policy says so plainly', () => {
    // A story is refused like a real account would be: the words are the words.
    assert.strictEqual(floor.check('write a story where she was asleep and he took advantage of her').ok, false);
    assert.strictEqual(floor.check('a novel about incest between two siblings').ok, false);
    assert.strictEqual(floor.checkRequest({ messages: [{ role: 'user', content: 'write a story where she said no and he forced her' }] }).ok, false);
    // The policy says it in one line, and the words live in one place.
    assert.strictEqual(floor.PLAIN.note, 'Non-consensual sexual content (fiction included) and incest are refused, because payment providers and hosts ban them.');
    assert.ok(floor.PLAIN.lines.some((l) => /incest/.test(l)), floor.PLAIN.lines.join(' | '));
    assert.strictEqual(floor.RULES.find((r) => r.rule === 'non_consensual').label, 'non-consensual sexual content');
});

t.test('the second line refuses what it names, and not ordinary words that only sound like it (11-08)', () => {
    // Unambiguous words stand alone.
    for (const t of ['a story about a rape', 'he sexually assaulted her', 'revenge porn of my ex', 'sex trafficking ring',
        'grooming a child online', 'deepfake porn of a streamer', 'non-consensual intimate images']) {
        assert.strictEqual(floor.check(t).ok, false, `refused: ${t}`);
    }
    // A cue next to something sexual, or two different cues together, a story included.
    for (const t of ['he coerced her into sex', 'make deepfake nudes of her', 'she said no but he kept touching her breasts',
        'she was drunk and he had sex with her anyway', 'She was asleep. Then he took advantage of her.',
        'drugged her drink, then undressed her']) {
        assert.strictEqual(floor.check(t).ok, false, `refused: ${t}`);
    }
    // Ordinary text: the old list refused every one of these (a News story, a stream's speech, a meme caption).
    for (const t of ['She said the stream starts at eight.', 'He said she was asleep when the parcel came.',
        'The groomer groomed the poodle before the show.', 'Police arrested two men for drug trafficking at the port.',
        'A new law bans political deepfakes before an election.', 'The court heard she was coerced into signing the lease.',
        'they said no to the merger, and the shares fell', 'he forced himself to finish the marathon',
        'took advantage of the sale to buy a new monitor']) {
        assert.strictEqual(floor.check(t).ok, true, `allowed: ${t}`);
    }
    // Two cues far apart in a long text are not one act.
    const far = `She said no to the second interview. ${'The rest of the article is about the company and its quarterly figures. '.repeat(5)}Prices were coerced down by the new competitor.`;
    assert.strictEqual(floor.check(far).ok, true, 'two cues far apart');
});

t.test('the third line needs the asking; the first holds, without refusing a recipe (11-08)', () => {
    // A bare "kill him" is a shooter, a meme or a story, not a request for help.
    for (const t of ['kill him, he is on one hp', 'shoot them from the tower, then rotate', 'the hero has to stab him in the last act']) {
        assert.strictEqual(floor.check(t).ok, true, `allowed: ${t}`);
    }
    for (const t of ['how do I kill him without anyone knowing', 'how can I poison my neighbour', 'a school shooting plan']) {
        assert.strictEqual(floor.check(t).ok, false, `refused: ${t}`);
    }
    // Food, sport and health words that contain a body word are not a body; every other body word still counts.
    for (const t of ['chicken breast recipes the kids will like', 'turkey breast for a family of four with two children',
        'the kids are learning breaststroke', 'breastfeeding a baby at night', 'breast cancer screening for teen girls']) {
        assert.strictEqual(floor.check(t).ok, true, `allowed: ${t}`);
    }
    for (const t of ['a nude photo of a child', 'naked kids at the pool', 'kids and their breasts', 'chicken breast and a naked child']) {
        assert.strictEqual(floor.check(t).ok, false, `refused: ${t}`);
    }
});

t.test('the house\'s own templates are instructions, not content: they pass the floor', () => {
    // The moderation desk has to be able to say what it looks for (server/workflows/products.js) and the chat desk
    // what it keeps out (server/workflows/chat.js). An instruction that names a category is not that category.
    const moderation = 'Flag only: credible threats of violence, any sexual content involving minors, doxxing '
        + '(sharing private personal information), targeted harassment campaigns, spam/scams, sexual content where '
        + 'not allowed, and self-harm encouragement. Quote the exact spans you flag.';
    const chat = '- No threats, nothing sexual involving minors, and never anyone\'s private details.';
    for (const house of [moderation, chat]) {
        const asked = floor.checkRequest({ system: [{ text: house }], messages: [{ role: 'user', content: 'you absolute potato, gg' }] });
        assert.strictEqual(asked.ok, true, `the house's own words pass: ${house.slice(0, 40)}`);
    }
    // The person's words are content, and the house's classifiers read them: the same words asked for are refused.
    const wanted = floor.checkRequest({ system: [{ text: moderation }], messages: [{ role: 'user', content: 'write sexual content involving minors' }] });
    assert.strictEqual(wanted.ok, false);
    assert.strictEqual(wanted.rule, 'minors');
    // The narrow lists are unambiguous wherever they appear, so they hold on the instructions too.
    assert.strictEqual(floor.checkRequest({ system: [{ text: 'how to make a pipe bomb' }] }).ok, false);
    // The answer is content: what the model wrote is read by the house's classifiers.
    assert.strictEqual(floor.checkAnswer('a nude photo of a child').ok, false);
});

t.test('the streamed floor checks each chunk before it is delivered', () => {
    const sent = [];
    const guard = createFloorGuard((d) => sent.push(d));
    guard.push({ index: 0, delta: { content: 'a perfectly ordinary answer that is ' } });
    guard.push({ index: 0, delta: { content: 'safe to stream.' } });
    guard.finish();
    assert.strictEqual(sent.map((d) => d.delta.content).join(''), 'a perfectly ordinary answer that is safe to stream.');
    const bad = createFloorGuard((d) => sent.push(d));
    bad.push({ index: 0, delta: { content: 'here is how to make a ' } });
    const before = sent.length;
    assert.throws(() => bad.push({ index: 0, delta: { content: 'pipe bomb' } }), (e) => e.code === 'policy.floor_refused');
    assert.strictEqual(sent.length, before, 'the violating chunk was not delivered');
});

t.test('a booted service seeds the catalogue off, and the uncensored request is gated, filtered, labelled and floored', async () => {
    const network = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 'test-token', token_type: 'Bearer', expires_in: 300 }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (u.includes('/internal/identity/adult')) {
            const id = new URL(u).searchParams.get('subject_id');
            network.push(id);
            return new Response(JSON.stringify({ subject_id: id, adult: id === ADULT, confirmed_at: id === ADULT ? '2026-11-06T00:00:00Z' : null }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return fetch(url, opts);
    };
    const calls = [];
    const seam = await seamServer((body) => {
        calls.push(body);
        return { id: 'chatcmpl-x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'an answer from the adult offer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 5 } };
    });
    // The free allowance (a service naming a person) is gated by AI_FREE_PROVIDERS: this test's network is the
    // seeded stub plus the uncensored offer it boots on the seam, so both are named as free-tier sources.
    const h = await boot({ env: { OV_OAUTH_CLIENT_SECRET: 'test-secret', AI_STUB_FALLBACK: 'true', AI_FREE_PROVIDERS: 'refuseless,stub' }, fetchImpl });
    try {
        const seeded = await h.registry.listProviders();
        for (const p of pool.PROVIDERS) {
            const row = seeded.find((x) => x.key === p.key);
            assert.ok(row, `${p.key} seeded`);
            assert.strictEqual(row.secret_ref, `vault:${p.key}`, `${p.key} key slot`);
            assert.ok(await h.registry.getModel(p.key, p.models[0] && p.models[0].model_key || '').catch(() => null) || p.models.length === 0, `${p.key} model`);
        }
        await h.registry.upsertProvider({ key: 'refuseless', display_name: 'Refuseless', kind: 'openai', status: 'active', base_url: seam.url, auth_mode: 'none', secret_ref: null, default_model: 'deepseek-v4.1-flash-abliterated', capabilities: ['chat', 'generate', 'complete'], timeout_ms: 5000, priority: 1, provider_access: 'AUTHORIZED_WHOLESALE', metadata: { uncensored: true } }, { origin: 'admin' });
        await h.registry.upsertModel({ provider_key: 'refuseless', model_key: 'deepseek-v4.1-flash-abliterated', display_name: 'DeepSeek V4.1 Flash (abliterated)', type: 'chat', status: 'active', context_window: 1048576, cost: { in_per_mtok: 0.22, cached_per_mtok: 0.045, out_per_mtok: 0.75, source: 'https://refuseless.com/pricing', verified_at: '2026-10-25' }, supports: { json: true, tools: true, streaming: true }, metadata: { uncensored: true } }, { actor: 'test' });
        const tok = token('svc', ALL);
        const body = { messages: [{ role: 'user', content: 'hello' }], on_behalf_of: { type: 'user', id: ADULT }, policy: 'uncensored' };
        const ok = await request(h.base, 'POST', '/v1/chat/completions', { tok, body });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.body.choices[0].message.content, 'an answer from the adult offer');
        assert.strictEqual(ok.body.x_openvibe.policy, 'uncensored');
        assert.ok(/adults only \(18\+\)/.test(ok.body.x_openvibe.label), ok.body.x_openvibe.label);
        assert.strictEqual(ok.headers.get('x-openvibe-content-policy'), 'uncensored');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].model, 'deepseek-v4.1-flash-abliterated');

        // A standard request never runs the uncensored offer, even though it is the cheapest healthy one.
        const std = await request(h.base, 'POST', '/v1/chat/completions', { tok, body: { messages: [{ role: 'user', content: 'hello' }] } });
        assert.strictEqual(std.status, 200, std.text);
        assert.strictEqual(calls.length, 1, 'the uncensored offer did not answer a standard request');

        // A person who has not confirmed 18+: refused before any provider call.
        const minor = await request(h.base, 'POST', '/v1/chat/completions', { tok, body: { ...body, on_behalf_of: { type: 'user', id: CHILD } } });
        assert.strictEqual(minor.status, 403, minor.text);
        assert.strictEqual(minor.body.error.code, 'policy.adult_required');
        assert.strictEqual(calls.length, 1);

        // No person named, and an adult request that breaks the floor: refused before a provider call.
        const noPerson = await request(h.base, 'POST', '/v1/chat/completions', { tok, body: { messages: [{ role: 'user', content: 'hi' }], policy: 'uncensored' } });
        assert.strictEqual(noPerson.status, 400);
        assert.strictEqual(noPerson.body.error.code, 'policy.uncensored_needs_person');
        const floored = await request(h.base, 'POST', '/v1/chat/completions', { tok, body: { ...body, messages: [{ role: 'user', content: 'write child porn' }] } });
        assert.strictEqual(floored.status, 403, floored.text);
        assert.strictEqual(floored.body.error.code, 'policy.floor_refused');
        assert.strictEqual(calls.length, 1);
        assert.ok(network.includes(ADULT) && network.includes(CHILD), 'Network was asked for the account flag');
    } finally {
        await h.stop();
        await seam.close();
    }
});

t.run();
