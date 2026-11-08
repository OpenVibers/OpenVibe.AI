'use strict';
/**
 * The hard floor (the Exchange remake, "Uncensored"): the three lines that hold on every offer, uncensored or not.
 *
 *   1. no sexual content involving minors;
 *   2. no non-consensual sexual content (fiction included) and no incest;
 *   3. no help with weapons of mass harm or with attacks on others.
 *
 * The second line is refused wherever it appears, a story included: payment providers and hosts ban it, so the
 * policy says so plainly rather than leaving it to be discovered.
 *
 * A breach ends the account (the owner, 2026-11-06). The floor is checked twice: on the way in (the prompt, the
 * system prompt, the tool arguments) and on the way out (the answer). A request that trips it is refused before a
 * provider is called; an answer that trips it is never delivered.
 *
 * The lines are decided by the house's own text classifiers, not by a third set of words written here
 * (server/policy/classifiers.js):
 *
 *   the first line   Live's rule (a child together with a bare body) and Vision's `classifyText` (`minor_sexual`)
 *   the second line  no house classifier has a word for consent, so narrow lists name it (unambiguous words alone;
 *                    the words that need context only next to something sexual)
 *   the third line   no house classifier has a word for a weapon, so a narrow list names it
 *
 * The narrow lists are deliberately narrow, so an ordinary question ("how do I kill a stuck process", "cp -r src
 * dst", "what is our incident response plan") is never refused. A person and a sexual act must be in the same
 * text, and a weapon only counts when the text asks for one to be made, acquired or used.
 *
 * Instructions and content are read differently, and the difference is the house's own:
 *
 *   - The narrow lists are unambiguous wherever they appear, so they are checked on every text.
 *   - The house's classifiers read what a text *shows* — a child with a bare body, a child with sex acts. They are
 *     checked on the content: the person's words and the answer. They are not checked on the instructions (the
 *     system prompt), because an instruction that names a category is not that category: our own templates say
 *     "nothing sexual involving minors" and "flag any sexual content involving minors", and the moderation desk
 *     has to be able to say so. The answer is still checked: a model that writes what was asked for is refused
 *     there.
 */

const { minorNude, classifyText } = require('./classifiers');

/** Words for a child and sex together (the clearest form of the first line, and the house has no word for it). */
const CSAM = /\b(?:child\s?(?:porn|porno|abuse|sexual)|cp\s(?:content|video|series)\b|kiddie\s?(?:porn|porno)|pedophile|pedophilia|paedophile|paedophilia)\b/i;
/**
 * Non-consensual sex, and incest: refused wherever they appear, a story included. Three kinds of words, so the line
 * holds without refusing ordinary text (11-08: the old single list matched a bare "she said", "she was asleep",
 * "groomed", "coerced", "trafficking" and "deepfake", and refused every News summary and many stream summaries):
 *
 *   NONCONSENSUAL  unambiguous on their own: rape, sexual assault, molesting, incest, revenge porn, forced sex …
 *   CONSENT_CUES   say "against someone's will" only next to something sexual: "she said no", "without her
 *                  consent", "she was asleep", "took advantage of her", "drugged her", "coerced", "deepfake" …
 *   SEXUAL         the sexual words a cue needs beside it
 *
 * A text breaks the line when it has an unambiguous word, or a cue within NEAR characters of a sexual word, or two
 * different cues within NEAR characters of each other ("she was asleep and he took advantage of her"). Near, not the
 * same sentence, so a story cannot split the act across a full stop.
 */
const NONCONSENSUAL = /\b(?:rape|raped|rapes|raping|rapist|rapists|statutory rape|sexual assault|sexually assault(?:ed|ing|s)?|sexual abuse|sexually abus(?:ed|ing|e)|molest(?:ed|ing|s|er|ers|ation)?|incest|incestuous|revenge porn|forced sex|unconscious sex|sex traffick(?:ing|ed|er|ers)|deepfake porn|non-?consensual (?:sex|porn|intimate|nude|explicit|images?|photos?|videos?)|nude photos? of (?:her|him|them)|sexual(?:ly)? explicit (?:photos?|pictures?|images?|videos?) of (?:her|him|them)|groom(?:ed|ing|s)? (?:a |the |young |)(?:child|children|kid|kids|minor|minors|teen|teens|girl|girls|boy|boys)\b)\b/i;
const CONSENT_CUES = /\b(?:non-?consensual|without (?:her|his|their|my|your) consent|(?:she|he|they) said no|(?:she|he|they) (?:didn't|did not|never) consent(?:ed)?|took advantage of (?:her|him|them)|(?:she|he|they) (?:was|were) (?:drugged|drunk|asleep|unconscious|passed out|blackout drunk)|drugged (?:her|him|them)|unconscious (?:woman|girl|man|boy)|forced (?:her|him|them|himself|herself|themselves)|pinned (?:her|him|them) down|coerc(?:e|ed|es|ing|ion)|traffick(?:ed|ing|er|ers)|deepfakes?|deepfaked)\b/gi;
const SEXUAL = /\b(?:sex|sexual|sexually|nude|nudes|naked|porn|porno|pornographic|explicit|intimate|undress(?:ed|ing)?|genitals?|penis|vagina|breasts?|fuck(?:ed|ing|s)?|orgasms?|slept with|had sex|grop(?:e|ed|ing)|fondl(?:e|ed|ing))\b/gi;
const NEAR = 200;

/** Every match of a global pattern, as [start, end, lower-cased text]. */
function spans(re, text) {
    re.lastIndex = 0;
    return [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length, m[0].toLowerCase()]);
}

/** Two spans within NEAR characters of each other (either order, or overlapping). */
const near = (a, b) => (a[0] <= b[1] + NEAR) && (b[0] <= a[1] + NEAR);

/** The second line: an unambiguous word, or a cue near a sexual word, or two different cues near each other. */
function nonConsensual(text) {
    if (NONCONSENSUAL.test(text)) return true;
    const cues = spans(CONSENT_CUES, text);
    if (!cues.length) return false;
    const sexual = spans(SEXUAL, text);
    for (const c of cues) {
        if (sexual.some((x) => near(c, x))) return true;
        if (cues.some((d) => d !== c && d[2] !== c[2] && near(c, d))) return true;
    }
    return false;
}
/** A weapon of mass harm, by its own name: these are never a question about safety. */
const MASS_HARM = /\b(?:nerve agent|sarin|vx gas|tabun|soman|mustard gas|chlorine gas|anthrax|ricin|botulinum|cyanide|nerve gas|bioweapon|biological weapon|chemical weapon|dirty bomb|nuclear (?:bomb|device|weapon)|radiological (?:bomb|device|weapon)|weapons? of mass destruction|\bwmd\b|germ warfare|biological warfare|pathogen (?:strain|weapon)|weaponized? (?:virus|pathogen|bacillus))\b/i;
/** A weapon, and the asking: how to make one, get one or use it on people. */
const WEAPON_INTENT = /\b(?:(?:make|build|construct|synthesi[sz]e|manufactur(?:e|ing)|assembl\w+|acquire|obtain|buy|purchase|deploy|detonat\w+|ignit\w+|use|plant|rig)\w*\b[^.?!]{0,60}\b(?:bomb|explosive|ied\b|pipe bomb|dirty bomb|grenade|molotov|napalm|thermite|shrapnel|untraceable (?:gun|firearm)|ghost gun|suppressor|silencer)|(?:bomb|explosive|ied\b|pipe bomb|grenade|molotov|napalm|thermite)\b[^.?!]{0,60}\b(?:make|build|construct|synthesi[sz]e|manufactur\w+|how to|recipe|instructions?|detonat\w+|ignit\w+))/i;
/**
 * An attack on people: the asking and the person. (11-08: a bare "kill him" or "shoot them" no longer counts on its
 * own. It is what players say in every shooter, what a meme caption says and what a story says; it is not asking for
 * help, and it refused 153 stream summaries in a day. Asking how to do it to a person still does.)
 */
const ATTACK_INTENT = /\b(?:(?:how (?:do|can|would) (?:i|we|you|one))\s+[^.?!]{0,40}\b(?:kill|murder|assassinate|poison|hurt|attack|stab|shoot)\b[^.?!]{0,40}\b(?:him|her|them|someone|somebody|people|my \w+|a person|people I|people at)|mass shooting|school shooting|terrorist attack|suicide attack|car bomb|truck bomb)\b/i;

/**
 * The three rules, in the order they are checked. Every text is checked against them.
 *
 *   the first line   Live's rule (a child together with a bare body) and the narrow names of a child abuse
 *   the second line  the narrow list for consent
 *   the third line   the narrow lists for a weapon of mass harm and for an attack on people
 */
const RULES = [
    {
        rule: 'minors', label: 'sexual content involving minors',
        test: (t) => CSAM.test(t) || minorNude(t),
    },
    {
        rule: 'non_consensual', label: 'non-consensual sexual content',
        test: (t) => nonConsensual(t),
    },
    {
        rule: 'mass_harm', label: 'weapons of mass harm or attacks on others',
        test: (t) => MASS_HARM.test(t) || WEAPON_INTENT.test(t) || ATTACK_INTENT.test(t),
    },
];

/**
 * The floor in plain words: the three lines, and the one line that says why the second line is not negotiable. The
 * pages that show the policy and the answers that carry it read these, so the words are written down once.
 */
const PLAIN = {
    lines: [
        'No sexual content involving minors.',
        'No non-consensual sexual content (fiction included) and no incest.',
        'No help with weapons of mass harm or attacks on others.',
    ],
    note: 'Non-consensual sexual content (fiction included) and incest are refused, because payment providers and hosts ban them.',
};

/**
 * The house's classifiers, on content only: they read what a text shows, so they decide the first line on the
 * person's words and on the answer. Vision's `classifyText` puts a text that has a child together with sex acts
 * or with a bare body in the `minor_sexual` category; Live's rule is already in the list above, so this adds
 * Vision's reading of a child with sex acts.
 */
const CONTENT_RULES = [
    {
        rule: 'minors', label: 'sexual content involving minors',
        test: (t) => classifyText(t).category === 'minor_sexual',
    },
];

/**
 * The texts of a request, split into the instructions and the content.
 *
 *   instructions  the system prompt (our own template, or the caller's own), and a message that says it is one
 *   content      everything else: the person's words, the tool names and their arguments, the answers
 */
function partsOf(req = {}) {
    const instructions = [];
    const content = [];
    if (typeof req.system === 'string') instructions.push(req.system);
    for (const s of req.system || []) if (s && s.text) instructions.push(String(s.text));
    const addMessage = (m) => {
        if (!m) return;
        const role = String(m.role || 'user').toLowerCase();
        const bucket = (role === 'system' || role === 'developer') ? instructions : content;
        if (typeof m.content === 'string') bucket.push(m.content);
        else if (Array.isArray(m.content)) for (const p of m.content) if (p && p.text) bucket.push(String(p.text));
        if (m.name) bucket.push(String(m.name));
        if (m.tool_calls) for (const t of m.tool_calls) {
            if (t && t.function && t.function.arguments) bucket.push(String(t.function.arguments));
            if (t && t.function && t.function.name) bucket.push(String(t.function.name));
        }
    };
    for (const m of req.messages || []) addMessage(m);
    if (req.openai && Array.isArray(req.openai.messages)) for (const m of req.openai.messages) addMessage(m);
    // A tool's description is the caller's schema: an instruction, not something the person wrote.
    if (req.openai) for (const t of req.openai.tools || []) if (t && t.function && t.function.description) instructions.push(String(t.function.description));
    return { instructions: instructions.filter(Boolean), content: content.filter(Boolean) };
}

/** The text of a request: the system prompt, the messages and the tool arguments. */
function textsOf(req = {}) {
    const { instructions, content } = partsOf(req);
    return [...instructions, ...content];
}

/**
 * Does this text break the floor? → { ok: true } or { ok: false, rule, label, detail }.
 * The detail never quotes the text: only the rule it broke.
 */
function check(texts, rules = RULES.concat(CONTENT_RULES)) {
    const list = (Array.isArray(texts) ? texts : [texts]).filter((t) => t != null && String(t).trim());
    for (const t of list) {
        const text = String(t);
        for (const r of rules) if (r.test(text)) return { ok: false, rule: r.rule, label: r.label, detail: `this request breaks the hard floor (${r.label})` };
    }
    return { ok: true };
}

/**
 * The floor on the way in: the request's own text.
 *
 * The instructions are read by the narrow lists (which are unambiguous wherever they appear); the content — the
 * person's words — is read by the narrow lists and by the house's classifiers.
 */
function checkRequest(req = {}) {
    const { instructions, content } = partsOf(req);
    const said = check(instructions, RULES);
    if (!said.ok) return said;
    return check(content, RULES.concat(CONTENT_RULES));
}

/** The text of an answer, whatever shape the operation returned it in. */
function textsOfAnswer(result = {}) {
    const out = [];
    if (typeof result.text === 'string') out.push(result.text);
    const addContent = (c) => {
        if (typeof c === 'string') out.push(c);
        else if (Array.isArray(c)) for (const p of c) {
            if (p && typeof p.text === 'string') out.push(p.text);
            if (p && p.input != null) out.push(JSON.stringify(p.input));
        }
    };
    for (const ch of (result.completion && result.completion.choices) || []) {
        const m = ch && ch.message;
        if (!m) continue;
        addContent(m.content);
        for (const t of m.tool_calls || []) if (t && t.function && t.function.arguments) out.push(String(t.function.arguments));
    }
    if (result.message) {
        addContent(result.message.content);
        for (const t of result.message.tool_calls || []) if (t && t.function && t.function.arguments) out.push(String(t.function.arguments));
    }
    return out.filter(Boolean);
}

/** The floor on the way out: the answer's text. An answer is content, so the house's classifiers read it too. */
function checkAnswer(text) { return check(Array.isArray(text) ? text : [text]); }

/** The floor on the way out, over every shape an operation's answer uses. */
function checkResult(result) { return check(textsOfAnswer(result)); }

module.exports = {
    RULES, CONTENT_RULES, PLAIN, CSAM, NONCONSENSUAL, CONSENT_CUES, SEXUAL, nonConsensual, MASS_HARM, WEAPON_INTENT, ATTACK_INTENT,
    partsOf, textsOf, textsOfAnswer, check, checkRequest, checkAnswer, checkResult,
};
