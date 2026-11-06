'use strict';
/**
 * The hard floor (the Exchange remake, "Uncensored"): the three lines that hold on every offer, uncensored or not.
 *
 *   1. no sexual content involving minors;
 *   2. no non-consensual sexual content of real people;
 *   3. no help with weapons of mass harm or with attacks on others.
 *
 * A breach ends the account (the owner, 2026-11-06). The floor is checked twice: on the way in (the prompt, the
 * system prompt, the tool arguments) and on the way out (the answer). A request that trips it is refused before a
 * provider is called; an answer that trips it is never delivered.
 *
 * The lines are decided by the house's own text classifiers, not by a third set of words written here
 * (server/policy/classifiers.js):
 *
 *   the first line   Live's rule (a child together with a bare body) and Vision's `classifyText` (`minor_sexual`)
 *   the second line  no house classifier has a word for consent, so a narrow list names it
 *   the third line   no house classifier has a word for a weapon, so a narrow list names it
 *
 * The narrow lists are deliberately narrow, so an ordinary question ("how do I kill a stuck process", "cp -r src
 * dst", "what is our incident response plan") is never refused. A person and a sexual act must be in the same
 * text, and a weapon only counts when the text asks for one to be made, acquired or used.
 */

const { minorNude, classifyText } = require('./classifiers');

/** Words for a child and sex together (the clearest form of the first line, and the house has no word for it). */
const CSAM = /\b(?:child\s?(?:porn|porno|abuse|sexual)|cp\s(?:content|video|series)\b|kiddie\s?(?:porn|porno)|pedophile|pedophilia|paedophile|paedophilia)\b/i;
/** Non-consensual sex, and the real people it is done to. */
const NONCONSENSUAL = /\b(?:rape|raped|rapes|raping|rapist|sexual assault|sexual abuse|molest(?:ed|ing|s)?|incest|statutory rape|non-?consensual|without (?:her|his|their|my) consent|she (?:said|said no|didn't consent|did not consent)|he (?:said no|didn't consent|did not consent)|they (?:said no|didn't consent|did not consent)|took advantage of (?:her|him|them)|she was (?:drugged|drunk|asleep|unconscious)|drugged (?:her|him|them)|unconscious (?:sex|woman|girl|man)|forced (?:sex|himself|herself|them)|coerc(?:e|ed|ing|ion)|groom(?:ed|ing)?|traffick(?:ed|ing)?|deepfake(?:s|d)?|revenge porn|nude photos? of (?:her|him|them)|sexual(?:ly)? explicit (?:photos?|pictures?|images?|videos?) of (?:her|him|them))\b/i;
/** A weapon of mass harm, by its own name: these are never a question about safety. */
const MASS_HARM = /\b(?:nerve agent|sarin|vx gas|tabun|soman|mustard gas|chlorine gas|anthrax|ricin|botulinum|cyanide|nerve gas|bioweapon|biological weapon|chemical weapon|dirty bomb|nuclear (?:bomb|device|weapon)|radiological (?:bomb|device|weapon)|weapons? of mass destruction|\bwmd\b|germ warfare|biological warfare|pathogen (?:strain|weapon)|weaponized? (?:virus|pathogen|bacillus))\b/i;
/** A weapon, and the asking: how to make one, get one or use it on people. */
const WEAPON_INTENT = /\b(?:(?:make|build|construct|synthesi[sz]e|manufactur(?:e|ing)|assembl\w+|acquire|obtain|buy|purchase|deploy|detonat\w+|ignit\w+|use|plant|rig)\w*\b[^.?!]{0,60}\b(?:bomb|explosive|ied\b|pipe bomb|dirty bomb|grenade|molotov|napalm|thermite|shrapnel|untraceable (?:gun|firearm)|ghost gun|suppressor|silencer)|(?:bomb|explosive|ied\b|pipe bomb|grenade|molotov|napalm|thermite)\b[^.?!]{0,60}\b(?:make|build|construct|synthesi[sz]e|manufactur\w+|how to|recipe|instructions?|detonat\w+|ignit\w+))/i;
/** An attack on people: the asking and the person. */
const ATTACK_INTENT = /\b(?:(?:how (?:do|can|would) (?:i|we|you|one))\s+[^.?!]{0,40}\b(?:kill|murder|assassinate|poison|hurt|attack|stab|shoot)\b[^.?!]{0,40}\b(?:him|her|them|someone|somebody|people|my \w+|a person|people I|people at)|(?:kill|murder|assassinate|poison|stab|shoot)\s+(?:him|her|them|someone|somebody|people|my \w+|a person)|mass shooting|school shooting|terrorist attack|suicide attack|car bomb|truck bomb)\b/i;

/**
 * The three rules, in the order they are checked. Each one reads the house's classifiers first and its own narrow
 * list after, so the house's wording always wins and the narrow list only adds what the house has no word for.
 */
const RULES = [
    {
        rule: 'minors', label: 'sexual content involving minors',
        test: (t) => minorNude(t) || classifyText(t).category === 'minor_sexual' || CSAM.test(t),
    },
    {
        rule: 'non_consensual', label: 'non-consensual sexual content of real people',
        test: (t) => NONCONSENSUAL.test(t),
    },
    {
        rule: 'mass_harm', label: 'weapons of mass harm or attacks on others',
        test: (t) => MASS_HARM.test(t) || WEAPON_INTENT.test(t) || ATTACK_INTENT.test(t),
    },
];

/** The text of a request: the system prompt, the messages and the tool arguments. */
function textsOf(req = {}) {
    const out = [];
    if (typeof req.system === 'string') out.push(req.system);
    for (const s of req.system || []) if (s && s.text) out.push(String(s.text));
    for (const m of req.messages || []) {
        if (!m) continue;
        if (typeof m.content === 'string') out.push(m.content);
        else if (Array.isArray(m.content)) for (const p of m.content) if (p && p.text) out.push(String(p.text));
        if (m.name) out.push(String(m.name));
        if (m.tool_calls) for (const t of m.tool_calls) {
            if (t && t.function && t.function.arguments) out.push(String(t.function.arguments));
            if (t && t.function && t.function.name) out.push(String(t.function.name));
        }
    }
    if (req.openai && Array.isArray(req.openai.messages)) {
        for (const m of req.openai.messages) {
            if (!m) continue;
            if (typeof m.content === 'string') out.push(m.content);
            else if (Array.isArray(m.content)) for (const p of m.content) if (p && p.text) out.push(String(p.text));
            if (m.tool_calls) for (const t of m.tool_calls) if (t && t.function && t.function.arguments) out.push(String(t.function.arguments));
        }
        for (const t of req.openai.tools || []) if (t && t.function && t.function.description) out.push(String(t.function.description));
    }
    return out.filter(Boolean);
}

/**
 * Does this text break the floor? → { ok: true } or { ok: false, rule, label, detail }.
 * The detail never quotes the text: only the rule it broke.
 */
function check(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).filter((t) => t != null && String(t).trim());
    for (const t of list) {
        const text = String(t);
        for (const r of RULES) if (r.test(text)) return { ok: false, rule: r.rule, label: r.label, detail: `this request breaks the hard floor (${r.label})` };
    }
    return { ok: true };
}

/** The floor on the way in: the request's own text. */
function checkRequest(req) { return check(textsOf(req)); }

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

/** The floor on the way out: the answer's text. */
function checkAnswer(text) { return check(Array.isArray(text) ? text : [text]); }

/** The floor on the way out, over every shape an operation's answer uses. */
function checkResult(result) { return check(textsOfAnswer(result)); }

module.exports = {
    RULES, CSAM, NONCONSENSUAL, MASS_HARM, WEAPON_INTENT, ATTACK_INTENT,
    textsOf, textsOfAnswer, check, checkRequest, checkAnswer, checkResult,
};
