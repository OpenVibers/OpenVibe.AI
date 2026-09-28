'use strict';
// Live prompts moved to versioned templates (roadmap WS-O task 2); each renders as Live rendered it.
//   live.moments.pick: the prepare hook formats the timeline, transcript and sounds as [m:ss] lines, names clip and
//     chat signals, adds the flavor hint, and writes the "already used" line only when there is something to avoid;
//     nothing to work from is no run; the postprocess refuses an answer without a time.
//   live.arena.judge_beef / judge_mic: the user message is the same JSON object Live sent, keys in the same order;
//     the system prompt and the JSON schema are Live's; an answer without a numeric quality is no answer.
const assert = require('assert');
const { suite } = require('./helpers');
const { PREPARE, POSTPROCESS } = require('../server/workflows/hooks');
const { render } = require('../server/templates');
const live = require('../server/workflows/live');

const t = suite('live-templates');
const tpl = (live.templates || []).find((x) => x.key === 'live.moments.pick');

t.test('the prompt renders as Live rendered it', () => {
    assert.ok(tpl, 'the template exists');
    const prep = PREPARE['live.moments.pick']({ title: 'Rust night', flavor: 'clip', timeline: [{ t: 95, text: 'streamer   jumps up' }], transcript: [{ t: 94, text: 'IT COMPILES' }], sounds: [{ t: 96, label: 'Cheering' }], clipped: [95, 3605], spikes: [96], avoid: [300, 60] });
    const out = render(tpl.user_prompt, prep.vars);
    assert.match(out, /titled "Rust night"/);
    assert.match(out, /TIMELINE:\n\[1:35\] streamer jumps up/);
    assert.match(out, /TRANSCRIPT:\n\[1:34\] IT COMPILES/);
    assert.match(out, /\[1:36\] Cheering/);
    assert.match(out, /CLIPPED these timestamps .*: 1:35, 60:05/);
    assert.match(out, /25-SECOND VIDEO CLIP/);
    assert.match(out, /ALREADY USED .*: 1:00, 5:00\. Find a DIFFERENT moment\./);
    const none = render(tpl.user_prompt, PREPARE['live.moments.pick']({ title: 'x', timeline: [{ t: 1, text: 'a' }] }).vars);
    assert.ok(!/ALREADY USED/.test(none), 'no avoid line without anything to avoid');
    assert.match(none, /SCREENSHOT paste/, 'paste is the default flavor');
    assert.match(none, /TRANSCRIPT:\n\(none\)/);
    assert.deepStrictEqual(PREPARE['live.moments.pick']({ title: 'x' }), { output: null }, 'nothing to work from: no run');
});

t.test('the answer is read like Live read it', () => {
    const post = POSTPROCESS['live.moments.pick'];
    assert.deepStrictEqual(post({ text: 'Sure! {"t": 95.7, "title": "\\"It Compiles\\"", "desc": "He  jumps."}' }), { t: 95, title: 'It Compiles', desc: 'He jumps.' });
    assert.strictEqual(post({ text: '{"title": "no time"}' }), null);
    assert.strictEqual(post({ text: 'no json at all' }), null);
});

t.test('the Arena judges send what Live sent', () => {
    const beef = live.templates.find((x) => x.key === 'live.arena.judge_beef');
    const mic = live.templates.find((x) => x.key === 'live.arena.judge_mic');
    assert.ok(beef && mic);
    assert.match(beef.system_prompt, /^You judge live streamer-vs-streamer shit talk/);
    assert.deepStrictEqual(beef.output_schema.required, ['about_target', 'aimed_at_target', 'quality', 'best_line', 'about', 'announcer', 'flagged']);
    const input = { target_names: ['ann'], target_as_transcribed: ['an'], target_named_in_new_speech: false, how_the_name_was_matched: 'sound-alike', what_speaker_already_said_about_target: 'called her washed', new_speech: 'she is still washed' };
    const user = render(beef.user_prompt, PREPARE['live.arena.judge_beef'](input).vars);
    assert.strictEqual(user, JSON.stringify(input), 'the same object, keys in the same order');
    assert.strictEqual(render(mic.user_prompt, PREPARE['live.arena.judge_mic']({ speech: 'x y' }).vars), JSON.stringify({ speech: 'x y' }));
    const post = POSTPROCESS['live.arena.judge'];
    assert.strictEqual(post({ json: { quality: 'high' } }), null);
    assert.strictEqual(post({ json: { is_trash_talk: true, quality: 14.6 } }).quality, 10);
});

t.test('slogans, the daily secret and the star render as Live rendered them', () => {
    const tp = (k) => live.templates.find((x) => x.key === k);
    const sl = render(tp('live.hero.slogans').user_prompt, PREPARE['live.hero.slogans']({ users: [{ name: 'goosely', text: 'loves   croutons' }], usernames: ['goosely'], count: 20 }).vars);
    assert.match(sl, /=== GLOBAL CHAT VIBE \(overview \+ memory \+ timeline\) ===\n\(quiet\)/);
    assert.match(sl, /PER-USER CHAT ANALYSIS \(running jokes \/ personalities\) ===\n- goosely: loves croutons/);
    assert.match(sl, /STREAMERS \(what they stream\) ===\n\(none yet\)/);
    assert.match(sl, /"audiences": \[ 20 noun phrases/);
    assert.ok(!/\{\{|\$\{/.test(sl), 'nothing left unrendered');
    const egg = tp('live.easter_egg').user_prompt;
    assert.match(render(egg, PREPARE['live.easter_egg']({ vibe: 'croutons' }).vars), /site\.\nToday's community vibe \(for flavour only\): croutons\nReturn STRICT JSON/);
    assert.match(render(egg, PREPARE['live.easter_egg']({}).vars), /site\.\nReturn STRICT JSON/, 'no vibe line without a vibe');
    const star = { recent_stars: ['bob'], previous_star: null, candidates: [{ username: 'ann' }] };
    assert.strictEqual(render(tp('live.home.star').user_prompt, PREPARE['live.home.star'](star).vars), JSON.stringify(star));
    assert.deepStrictEqual(POSTPROCESS['live.easter_egg']({ json: { title: 'T', code: ['up', 'g'], clues: ['sky', "'goose'"], effect: 'lava', reward: 'yay' } }).effect, 'confetti');
    assert.strictEqual(POSTPROCESS['live.home.star']({ json: { headline: 'x' } }), null);
});

t.test('chat analysis, person overviews, session titles and VOD ranking render as Live rendered them', () => {
    const tp = (k) => live.templates.find((x) => x.key === k).user_prompt;
    const g = render(tp('live.chat.global'), PREPARE['live.chat.global']({ window_label: 'past 3 hours', prior_memory: 'notes', recent_labels: ['a', 'b'], messages: [{ mins_ago: 12, where: 'global', author: 'goosely', text: ' hi ' }, { mins_ago: 3, where: '#ann', author: 'bob', kind: 'emote', text: 'waves' }] }).vars);
    assert.match(g, /covers roughly the past 3 hours, across/);
    assert.match(g, /"""notes"""/);
    assert.match(g, /avoid duplicating these\):\n- a\n- b\n/);
    assert.match(g, /RECENT CHAT \(2 messages, oldest first\):\n\[12m ago\] \[global\] goosely: hi\n\[3m ago\] \[#ann\] bob: \(emote\) waves$/);
    const p = (x) => render(tp('live.chat.profile'), PREPARE['live.chat.profile'](x).vars);
    const user = p({ subject_kind: 'user', name: 'goosely', recent_24h: true, seen: 42, messages: [{ mins_ago: 1, where: 'global', author: 'goosely', text: 'x' }] });
    assert.match(user, /^You profile an individual chatter \("goosely"\)/);
    assert.match(user, /"overview_24h": "2-3 sentences on what this user has been chatting about/);
    assert.match(user, /all-time gist so far; ~42 messages seen previously\)/);
    assert.match(user, /MESSAGES FROM THIS USER IN THE LAST 24H \(oldest first\):\n\[1m ago\] goosely: x$/, 'no channel tag in a profile');
    const anon = p({ subject_kind: 'anon', name: 'anon_7', recent_24h: false, seen: 9, messages: [{ author: 'anon_7', text: 'y' }] });
    assert.match(anon, /an ANONYMOUS chatter \("anon_7", not logged in\)/);
    assert.match(anon, /They have not chatted in the last 24h; write 1 sentence/);
    assert.match(anon, /THIS ANON'S MOST RECENT MESSAGES \(oldest first\):\nanon_7: y$/);
    assert.ok(!/messages seen previously/.test(anon));
    assert.match(p({ subject_kind: 'relay', name: 'KickFan', platform: 'kick', messages: [{ author: 'KickFan', text: 'z' }] }), /an external chatter \("KickFan", bridged in from kick\)/);
    const long = PREPARE['live.chat.global']({ messages: Array.from({ length: 300 }, (_, i) => ({ mins_ago: 300 - i, author: 'u', text: 'x'.repeat(200) + i })) }).vars.messages;
    assert.ok(long.length === 9000 && long.endsWith('x299'), 'the freshest 9000 characters');
    assert.match(render(tp('live.person.overview'), { as_streamer: 'S', as_chatter: 'C' }), /AS A STREAMER:\nS\n\nAS A CHATTER:\nC$/);
    assert.match(render(tp('live.stream.titles'), PREPARE['live.stream.titles']({ summaries: ['one  two', 'three'] }).vars), /\n\n0\. one two\n1\. three\n\n/);
    const rank = render(tp('live.moments.rank'), PREPARE['live.moments.rank']({ vods: [{ title: 'Rust', overview: '', views: 3, clips: 1, peak_viewers: 2 }], want: 8 }).vars);
    assert.match(rank, /\n\n0\. \[3 views · 1 clips · peak 2\] "Rust" — \(no summary\)\n\n/);
    assert.match(rank, /for the top 1, best first\.$/);
    assert.deepStrictEqual(POSTPROCESS['live.moments.rank']({ text: '[{"index": 0, "score": 140, "why": "x"}, {"index": 0, "score": 3}, {"index": 9}]' }, { vods: [{}] }).ranked, [{ index: 0, score: 100, why: 'x' }]);
    assert.deepStrictEqual(POSTPROCESS['live.chat.insight']({ json: { overview_24h: 'a', timeline: [{ label: 'L', mins_ago: '5' }] } }, { subject_kind: 'user' }), { overview_24h: 'a', overview_alltime: '', memory: '', timeline: [{ label: 'L', detail: '', mins_ago: 5 }] });
    assert.strictEqual(POSTPROCESS['live.person.overview']({ text: 'Overview: A coder.' }).overview, 'A coder.');
});

t.test('Arena persona, quotes, headline and clip confirmation render as Live rendered them', () => {
    const tp = (k) => live.templates.find((x) => x.key === k);
    const facts = { name: 'Ann', numbers: { hours_live_90d: 3 } };
    assert.strictEqual(render(tp('live.arena.persona').user_prompt, PREPARE['live.arena.persona']({ facts }).vars), `Write the Arena persona for this fighter. Facts (JSON):\n${JSON.stringify(facts)}`);
    assert.match(tp('live.arena.persona').system_prompt, /^You write fighting-game "character select" bios/);
    assert.strictEqual(render(tp('live.arena.quotes').user_prompt, PREPARE['live.arena.quotes']({ lines: ['a b', 'c'] }).vars), 'Lines (index: text):\n0: a b\n1: c');
    const ctx = { kind: 'score', winner: 'ann', loser: 'bob', score_a: 3, score_b: 1 };
    assert.strictEqual(render(tp('live.arena.headline').user_prompt, PREPARE['live.arena.headline'](ctx).vars), JSON.stringify(ctx));
    const clip = render(tp('live.clips.confirm').user_prompt, PREPARE['live.clips.confirm']({ scene: ['a  jump'], transcript: [{ t: 94, text: 'IT COMPILES' }], sounds: [{ t: 95, label: 'Cheering', confidence: 0.8 }], chat: [] }).vars);
    assert.match(clip, /ON SCREEN \(recent scene notes\):\n- a jump\n\nWHAT WAS SAID \(recent transcript\):\n- \[1:34\] IT COMPILES\n\nWHAT WAS HEARD \(non-speech sounds detected\):\n- \[1:35\] Cheering \(0\.80\)\n\nCHAT \(recent messages\):\n\(none\)\n\nReturn STRICT JSON only/);
    assert.deepStrictEqual(POSTPROCESS['live.arena.quotes']({ json: { picks: [{ index: 5, why: 'x' }, { index: 1, why: 'y' }], walkout: 9, voice_verdict: 'v', mic_style: 'm' } }, { lines: ['a', 'b'] }), { picks: [{ index: 1, why: 'y' }], walkout: 1, voice_verdict: 'v', mic_style: 'm' });
    assert.strictEqual(POSTPROCESS['live.arena.persona']({ json: { title: 'no name' } }), null);
    assert.deepStrictEqual(POSTPROCESS['live.clips.confirm']({ text: '{"clip": "yes", "title": " A  B "}' }), { clip: false, title: 'A B', desc: '' });
});

t.run();
