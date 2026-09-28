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

t.run();
