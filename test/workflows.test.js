'use strict';
// Every seeded workflow: schemas compile, a realistic input validates and runs end to end on the
// stub provider, the output matches the versioned output schema, product workflows store their
// sources as citations, and bad input is refused with the schema errors.

const assert = require('assert');
const nodeHttp = require('http');
const { boot, request, token, suite, ALL } = require('./helpers');
const schemas = require('../server/schemas');
const { KIND_TO_WORKFLOW } = require('../server/workflows/live');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SRC = (n) => Array.from({ length: n }, (_, i) => ({ source_type: 'news.article', source_id: `a${i}`, title: `Source ${i}`, url: `https://example.org/${i}`, content: `Fact number ${i} happened on day ${i}.`, published_at: '2026-09-20' }));
const PASS = { role: 'chat', kind: 'chat_global', system: [{ text: 'You summarize chat.', cache: true }], user: 'Summarize: hi all', max_tokens: 80 };

const EXAMPLES = {
    'live.translate': { text: 'こんにちは、みなさん', from: 'ja', to: 'en', context: 'chat' },
    'live.paste.describe_image': { title: 'my screenshot', image: { data_url: PNG } },
    'live.paste.summarize_text': { title: 'notes', content: 'A list of things to buy: eggs, milk.' },
    'live.stream.describe_frame': { image: { data_url: PNG } },
    'live.stream.summarize': { observations: ['Streamer opens a code editor', 'Streamer fixes a bug'], speech: [{ start_sec: 12, text: 'ok so this function is broken' }], sounds: [{ start_sec: 30, label: 'Laughter', confidence: 0.8 }] },
    'live.streamer.overview': { streamer: { username: 'ann', display_name: 'Ann', bio: 'I code', category: 'desktop', category_inferred: true }, memories: ['coding in rust'], vods: [{ title: 'Rust night', category: 'desktop' }], pastes: [{ title: 'snippet', summary: 'a rust snippet' }] },
    'live.media.overview': { frames: ['a desk', 'a keyboard'], transcript: 'hello chat' },
    'live.stream.recap': { facts: { streamer: 'Ann', title: 'Rust night', duration: '2h 1m', viewers: { peak: 4, avg: 2 } } },
    'live.media.transcribe': { media_url: '__MEDIA__/v/1', language: 'en' },
    'media.analyze': { media_url: '__MEDIA__/fixture.mp4', language: 'en' },
    'network.site_copy': { sites: [{ id: 'live', name: 'OpenVibe.Live', what: 'live streaming' }], links: [{ id: 'tools', name: 'Tools', about: 'online tools' }] },
    'ai.chat': { messages: [{ role: 'user', content: 'hello' }] },
    'ai.complete': { messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }] },
    'ai.generate': { prompt: 'Write a haiku about SQLite.' },
    'ai.summarize': { text: 'SQLite is an embedded database engine. It is small and fast.', max_words: 20 },
    'ai.classify': { text: 'I love this!', labels: ['positive', 'negative', 'neutral'] },
    'ai.extract': { text: 'Order 42 ships to Berlin.', schema: { type: 'object', additionalProperties: false, required: ['order', 'city'], properties: { order: { type: 'string' }, city: { type: 'string' } } } },
    'ai.enrich': { record: { name: 'Widget' }, instructions: 'normalise the name' },
    'ai.embed': { input: ['one', 'two'] },
    'ai.image': { prompt: 'A goose eating croutons, watercolour.', size: '1024x1024', n: 1 },
    'wiki.generate_space': { topic: 'SQLite', sources: SRC(2) },
    'wiki.generate_page': { title: 'WAL mode', sources: SRC(3) },
    'blog.draft_post': { topic: 'Why we self-host', sources: SRC(1) },
    'blog.write_digest': { desk: 'News digest', about: 'Government and space agency announcements', period: '14 October 2026', sources: SRC(3) },
    'blog.write_satire': { topic: 'Is it safe to let your air fryer vote?', angle: 'a consumer safety explainer' },
    'news.summarize_story': { topic: 'Example', sources: SRC(3) },
    'news.compare_perspectives': { topic: 'Example', sources: SRC(2) },
    'reviews.summarize_entity': { entity: { name: 'Widget', type: 'product' }, sources: SRC(2) },
    'deals.enrich_deal': { offer: { title: 'Widget 50% off', merchant: 'Shop' }, sources: SRC(1) },
    'coupons.extract_coupon': { merchant: { name: 'Shop', domain: 'shop.example' }, sources: SRC(1) },
    'trade.summarize_market_context': { instrument: { symbol: 'XYZ', name: 'XYZ Corp' }, stale_after_hours: 24, sources: SRC(2) },
    'codes.generate_docs': { project: 'demo', sources: [{ source_type: 'code.file', title: 'index.js', content: 'module.exports = 1;' }] },
    'games.generate_lore': { world: 'Hobo Quest', prompt: 'The origin of the tin-can knights', sources: SRC(1) },
    'moderation.classify': { text: 'you absolute potato, gg', context: 'arena chat' },
    'rent.screen_listing': { listing: { title: 'Bright room near the river', kind: 'room', price: 650, currency: 'EUR', period: 'month', city: 'Porto', country: 'PT', description: 'I am abroad for work; send the deposit by wire and I will mail the keys.' } },
    'food.suggest_recipes': { pantry: ['rice', 'onions', 'canned tomatoes'], people: 2, sources: [{ source_type: 'food.food', source_id: 'lentils', title: 'Lentils, dried', content: '{"id":"lentils","unit":"kg"}' }] },
    'chat.member.reply': { ai_name: 'Pantry', persona: 'A cheerful cook who keeps it cheap.', room: 'Kim and Lee\'s kitchen', memory: 'Lee is vegetarian.', context: 'Pantry: rice, onions, canned tomatoes, lentils.', context_source: 'OpenVibe.Food household', transcript: 'kim: home late tonight\nlee: same', asked_by: 'kim', message: '@Pantry what can we cook in 20 minutes?' },
    'food.read_pantry_photo': { image: { data_url: PNG }, kind: 'receipt', foods: ['Large Eggs (1 dozen)', 'Whole Milk (1 gallon)'] },
    'pics.describe_image': { image: { data_url: PNG }, title: 'The coast' },
    'chat.member.turn': { messages: [{ role: 'system', content: 'You are Pantry.' }, { role: 'user', content: 'kim: @Pantry roll a die' }], tools: [{ type: 'function', function: { name: 'roll_dice', parameters: { type: 'object', properties: { sides: { type: 'integer' } } } } }] },
    'tools.describe': { tool: 'img.convert', sources: [{ source_type: 'tools.tool', title: 'img.convert descriptor', content: '{"id":"img.convert","inputs":["file","format"]}' }] },
};
for (const k of new Set(Object.values(KIND_TO_WORKFLOW).concat('live.complete'))) EXAMPLES[k] = PASS;
// Moved from passthrough to a versioned template (WS-O task 2): structured input.
EXAMPLES['live.viewers.plan'] = { stable: 'Stream: Rust night by ann. Roster: goosebot (a goose who loves croutons), bytebot (a pedantic compiler).', volatile: 'Transcript [1:34] it compiles!\nChat: bob: LETS GO', max_lines: 2, temperature: 0.9 };
EXAMPLES['live.viewers.reply'] = { stable: 'Stream: Rust night by ann. Roster: goosebot.', situation: 'ann is celebrating a build.', bot: 'goosebot', streamer_line: 'goosebot what do you think', max_words: 18 };
EXAMPLES['live.viewers.fold'] = { channel_memory: 'croutons', personas: [{ username: 'goosebot', memory: '', lines: ['honk', 'croutons are soup confetti', 'compile faster'] }] };
EXAMPLES['live.viewers.clone'] = { name: 'bob', overview: 'Hypes every build.', memory: '', samples: ['LETS GO', 'W'] };
EXAMPLES['live.arena.persona'] = { facts: { name: 'Ann', handle: 'ann', category: 'desktop', ratings: { heat: 70 }, things_they_said_on_stream: ['this borrow checker hates me'], roster_rivals: ['bob'] } };
EXAMPLES['live.arena.quotes'] = { lines: ['this borrow checker hates me and I hate it back', 'chat you are all backseat compilers', 'I have never been this cooked'] };
EXAMPLES['live.arena.headline'] = { kind: 'open', a: 'ann', b: 'bob', line: 'bob streams to his own alt accounts', rematch: false };
EXAMPLES['live.arena.drama'] = { kind: 'rage_quit', streamer: 'bob', other: null, what: 'bob usually goes 140 minutes. Today it lasted 6.', facts: { minutes_live: 6, usual_minutes: 140, last_title: 'ranked grind' }, quote: 'this game is rigged' };
EXAMPLES['live.rundown.segment'] = { streamer: 'goosely', title: 'Tech news', category: 'Science & Technology', topics: ['Supermarket fridges hacked in France'], earlier: 'Opened with a router rant.', lines: [{ t: 1081, text: 'The person that deals with refrigeration, I am not going to say is stupid.' }, { t: 1096, text: 'Having the internet inside of a refrigerator is a bad idea.' }] };
EXAMPLES['live.rundown.episode'] = { streamer: 'goosely', title: 'Tech news', category: 'Science & Technology', minutes: 140, peak_viewers: 6, chat_messages: 210, segments: [{ t: 1081, topic: 'Supermarket fridges hacked in France', title: 'Fridges on the internet', what: 'They read about hacked supermarket fridges.', take: 'Internet fridges are a bad idea.', quotes: ['Having the internet inside of a refrigerator is a bad idea.'] }] };
EXAMPLES['live.rundown.topic'] = { topic: 'Supermarket fridges hacked in France', takes: [{ streamer: 'goosely', when: '2026-10-18', what: 'They read about hacked supermarket fridges.', take: 'Internet fridges are a bad idea.', quote: 'Having the internet inside of a refrigerator is a bad idea.' }] };
EXAMPLES['live.clips.confirm'] = { scene: ['streamer jumps up cheering'], transcript: [{ t: 94, text: 'IT COMPILES' }], sounds: [{ t: 95, label: 'Cheering', confidence: 0.8 }], chat: ['LETS GO', 'poggers'] };
EXAMPLES['live.chat.global'] = { window_label: 'past 3 hours', prior_memory: 'croutons are a running joke', recent_labels: ['the crouton war'], messages: [{ mins_ago: 12, where: 'global', author: 'goosely', kind: null, text: 'croutons are soup confetti' }, { mins_ago: 3, where: '#ann', author: 'bob', kind: 'emote', text: 'waves' }] };
EXAMPLES['live.chat.profile'] = { subject_kind: 'relay', name: 'KickFan', platform: 'kick', recent_24h: false, seen: 0, prior_memory: '', messages: [{ mins_ago: 2000, author: 'KickFan', text: 'hello from kick' }] };
// Chat runs the same two workflows under its own namespace (plan T3).
EXAMPLES['chat.global'] = EXAMPLES['live.chat.global'];
EXAMPLES['chat.profile'] = EXAMPLES['live.chat.profile'];
EXAMPLES['live.person.overview'] = { as_streamer: 'Codes rust late at night.', as_chatter: 'Jokes about croutons.' };
EXAMPLES['live.stream.titles'] = { summaries: ['Fixed a borrow checker bug live', 'Built a robot arm and it waved'] };
EXAMPLES['live.moments.rank'] = { vods: [{ title: 'Rust night', overview: 'the build finally compiles', views: 30, clips: 2, peak_viewers: 5 }, { title: 'Chill', overview: 'sitting at a desk', views: 3, clips: 0, peak_viewers: 1 }], want: 2 };
EXAMPLES['live.hero.slogans'] = { global: 'Chat argued about croutons all day.', users: [{ name: 'goosely', text: 'always defends croutons' }], streamers: [{ name: 'ann', text: 'codes rust at night' }], vods: [{ name: 'Rust night', text: 'the build finally compiles' }], usernames: ['goosely', 'ann'], count: 20 };
EXAMPLES['live.easter_egg'] = { vibe: 'croutons' };
// Space's spaces (server/workflows/space.js): the builder, changing a space, and a space's own AI.
EXAMPLES['space.app.build'] = { prompt: 'A guestbook where people sign in and leave a one-line note', name: 'Guestbook', current: [{ path: 'index.html', content: '<!doctype html><title>Guestbook</title><script src="/_openvibe/sdk.js"></script>' }] };
EXAMPLES['space.app.ask'] = { space: 'Pirate helper', instructions: 'Talk like a pirate.', transcript: 'visitor: hi\nai: Ahoy!', message: 'What is a good name for a parrot?' };
EXAMPLES['live.home.star'] = { recent_stars: ['bob'], previous_star: 'bob', candidates: [{ username: 'ann', name: 'Ann', language: 'en', last_14d: { sessions: 5, hours: 12 } }] };
EXAMPLES['live.arena.judge_beef'] = { target_names: ['ann', 'Ann the Great'], target_as_transcribed: ['ann', 'an'], target_named_in_new_speech: true, how_the_name_was_matched: 'exact', what_speaker_already_said_about_target: null, new_speech: 'ann your stream is so boring even your bots left chat' };
EXAMPLES['live.arena.judge_mic'] = { speech: 'chat you guys are the worst mods I have ever seen in my life' };
EXAMPLES['live.moments.pick'] = { title: 'Rust night', flavor: 'clip', timeline: [{ t: 12, text: 'the build fails' }, { t: 95, text: 'streamer jumps up cheering' }], transcript: [{ t: 94, text: 'IT COMPILES' }], sounds: [{ t: 96, label: 'Cheering' }], clipped: [95], spikes: [96], avoid: [300] };

const t = suite('workflows');
const HAS_FFMPEG = require('child_process').spawnSync('ffprobe', ['-version']).status === 0;
let h;
let media;
const tok = token('live', ALL);

t.test('boot seeds every required workflow key', async () => {
    const fixture = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'media-analysis.mp4'));
    media = nodeHttp.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(req.url === '/fixture.mp4' ? fixture : Buffer.alloc(2048, 1)); });
    await new Promise(r => media.listen(0, '127.0.0.1', r));
    const mediaBase = `http://127.0.0.1:${media.address().port}`;
    EXAMPLES['live.media.transcribe'].media_url = `${mediaBase}/v/1`;
    EXAMPLES['media.analyze'].media_url = `${mediaBase}/fixture.mp4`;
    // AI_IMAGE_MODEL seeds default.image, so ai.image runs end to end on the stub's PNG like every other workflow.
    h = await boot({ env: { OV_MEDIA_INTERNAL_URL: mediaBase, AI_IMAGE_MODEL: 'gpt-image-1' } });
    const keys = (await h.registry.listWorkflows()).map(w => w.key);
    for (const k of ['wiki.generate_space', 'wiki.generate_page', 'blog.draft_post', 'blog.write_digest', 'blog.write_satire', 'news.summarize_story', 'news.compare_perspectives', 'reviews.summarize_entity', 'deals.enrich_deal',
        'coupons.extract_coupon', 'trade.summarize_market_context', 'codes.generate_docs', 'games.generate_lore', 'moderation.classify', 'tools.describe', 'food.suggest_recipes', 'food.read_pantry_photo', 'pics.describe_image', 'rent.screen_listing', 'chat.member.reply', 'chat.member.turn',
        'live.translate', 'live.stream.describe_frame', 'live.stream.summarize', 'live.viewers.reply', 'live.chat.insight', 'live.hero.slogans', 'live.stream.recap', 'network.site_copy']) {
        assert.ok(keys.includes(k), `missing ${k}`);
    }
    for (const k of ['default.chat', 'default.json', 'default.embedding', 'default.image', 'wiki.generate', 'blog.draft', 'news.summarize', 'reviews.summarize', 'deals.enrich', 'coupons.extract', 'trade.summarize', 'codes.generate_docs', 'games.generate_lore', 'tools.describe', 'moderation.classify', 'food.suggest', 'food.vision', 'rent.screen', 'chat.member']) {
        assert.ok(await h.registry.getRoute(k), `missing historical route ${k}`);
    }
});

t.test('every workflow has compiling, versioned input and output schemas and an example', async () => {
    for (const w of await h.registry.listWorkflows()) {
        assert.strictEqual(w.version, 1);
        schemas.assertSchema(w.input_schema, `${w.key} input`);
        schemas.assertSchema(w.output_schema, `${w.key} output`);
        assert.ok(EXAMPLES[w.key], `no example input for ${w.key}`);
        const v = schemas.validate(w.input_schema, EXAMPLES[w.key]);
        assert.ok(v.valid, `${w.key} example invalid: ${JSON.stringify(v.errors)}`);
    }
});

t.test('every workflow runs end to end on the stub and returns schema-valid output', async () => {
    for (const w of await h.registry.listWorkflows()) {
        if (w.key === 'media.analyze' && !HAS_FFMPEG) { console.log('workflow media.analyze end to end: skipped (no ffprobe)'); continue; }
        const r = await request(h.base, 'POST', '/api/v1/runs?wait=10000', { tok, body: { workflow: w.key, input: EXAMPLES[w.key] } });
        assert.strictEqual(r.status, 201, `${w.key}: ${r.status} ${r.text.slice(0, 300)}`);
        const run = r.body.run;
        assert.strictEqual(run.status, 'succeeded', `${w.key}: ${JSON.stringify(run.error)}`);
        assert.strictEqual(run.synthetic, true, `${w.key} should be marked synthetic`);
        assert.strictEqual(run.provenance.origin, 'ai');
        assert.strictEqual(run.provenance.workflow, w.key);
        assert.ok(run.provenance.model, `${w.key} has a model`);
        assert.ok(schemas.validate(w.output_schema, run.output).valid, `${w.key} output invalid`);
        // WS-O task 3: every output says what backs it: cited sources, or explicit gaps.
        assert.ok(run.grounding && Array.isArray(run.grounding.cited) && Array.isArray(run.grounding.gaps), `${w.key} has grounding`);
        assert.ok(run.grounding.cited.length || run.grounding.gaps.length, `${w.key}: citations or explicit gaps`);
        if (EXAMPLES[w.key].sources) {
            assert.strictEqual(run.citations_count, EXAMPLES[w.key].sources.length, `${w.key} citations`);
            const d = await request(h.base, 'GET', `/api/v1/runs/${run.id}`, { tok });
            assert.strictEqual(d.body.citations.length, EXAMPLES[w.key].sources.length);
            assert.ok(d.body.citations.every(c => c.source_type && c.content_hash), 'citations carry type and content hash');
        }
    }
});

t.test('grounding: cited sources, the output\'s own gaps, or a gap written for it (WS-O task 3)', async () => {
    const { groundingOf } = require('../server/workflows/engine');
    assert.deepStrictEqual(groundingOf({ summary: 'x', citations: [1, 0, 1, 7] }, 2, true), { cited: [0, 1], gaps: [] }, 'cited ordinals in range, sorted, once');
    assert.deepStrictEqual(groundingOf({ items: [{ gaps: ['no price given'] }], gaps: ['no price given', 'date unclear'] }, 1, true).gaps, ['no price given', 'date unclear'], 'the output\'s gaps, once each');
    assert.match(groundingOf({ text: 'hola' }, 0, false).gaps[0], /No sources were given/);
    assert.match(groundingOf({ summary: 'x', citations: [] }, 3, true).gaps[0], /None of the given sources is cited/);
    assert.match(groundingOf({ summary: 'x' }, 2, false).gaps[0], /does not cite them/);
    // (A cached run carrying its source run's grounding: test/cache.test.js; stub output is never cached.)
});

t.test('citations index only the provided sources', async () => {
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'news.summarize_story', input: { sources: SRC(2) } } });
    const seen = JSON.stringify(r.body.run.output).match(/"citations":\[([0-9,]*)\]/g) || [];
    for (const m of seen) for (const n of m.replace(/\D+/g, ' ').trim().split(' ').filter(Boolean)) assert.ok(Number(n) < 2, `citation ${n} out of range`);
});

t.test('invalid input is refused with the schema errors; unknown workflows are 404', async () => {
    let r = await request(h.base, 'POST', '/api/v1/runs', { tok, body: { workflow: 'news.summarize_story', input: { sources: [] } } });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.code, 'input.invalid');
    assert.ok(Array.isArray(r.body.errors) && r.body.errors.length);
    r = await request(h.base, 'POST', '/api/v1/runs', { tok, body: { workflow: 'nope.nothing', input: {} } });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.code, 'workflow.not_found');
});

t.test('a workflow with nothing to work from fails explicitly (no fabricated output)', async () => {
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'live.media.overview', input: { frames: [] } } });
    assert.strictEqual(r.body.run.status, 'failed');
    assert.strictEqual(r.body.run.error.code, 'input.insufficient');
    assert.strictEqual(r.body.run.output, null);
});

t.test('translation of non-text short-circuits without a provider call', async () => {
    const before = h.pool.stats.stub ? h.pool.stats.stub.calls : 0;
    const r = await request(h.base, 'POST', '/api/v1/runs?wait=5000', { tok, body: { workflow: 'live.translate', input: { text: ':kek: !sr', to: 'ja' } } });
    assert.strictEqual(r.body.run.status, 'succeeded');
    assert.strictEqual(r.body.run.output.reason, 'not_translatable');
    assert.strictEqual(r.body.run.provenance.provider, null);
    assert.strictEqual(h.pool.stats.stub.calls, before);
});

t.test('direct operations are runs of ai.<op>', async () => {
    const r = await request(h.base, 'POST', '/api/v1/classify', { tok, body: { text: 'great', labels: ['good', 'bad'] } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.run.workflow.key, 'ai.classify');
    assert.ok(['good', 'bad'].includes(r.body.run.output.label));
    const e = await request(h.base, 'POST', '/api/v1/embed', { tok, body: { input: 'x' } });
    assert.strictEqual(e.body.run.output.vectors.length, 1);
    assert.strictEqual(e.body.run.output.dimensions, 64);
    const again = await request(h.base, 'POST', '/api/v1/embed', { tok, body: { input: 'x' } });
    assert.deepStrictEqual(again.body.run.output, e.body.run.output, 'stub is deterministic');
});

t.test('shutdown', async () => { await h.stop(); media.close(); });

t.run();
