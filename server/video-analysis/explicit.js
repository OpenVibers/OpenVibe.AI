'use strict';
/**
 * The house rule on explicit content, the same one OpenVibe.Live keeps for clips and moments
 * (OpenVibe.Live/server/ai/explicit.js, VIS-6 of 2026-11-06). Three categories, never more:
 *
 *   fine          allowed, including nudity: a body is not a sex act.
 *   sex_acts      the video shows sex acts or pornography: never public, kept for its owner.
 *   minor_sexual  a child together with nudity or genitals: always blocked, and the operator record
 *                 is made through OpenVibe.Vision. Nothing is reported to an external authority here.
 *
 * What is judged is what a tool found: the caption of a keyframe, the text read off the screen and
 * what was said. Describing people is fine; a word spoken in passing is not a scene. The rules are
 * the house's own, kept in step on purpose, so a video judged here is judged the same way there.
 */

// What a scene shows, not what someone talks about in passing: sex acts and pornography. Nudity and
// body words are not in it (a nude body is not a sex act).
const EXPLICIT = /\b(?:sexual(?:ly)?\s+(?:acts?|activity|intercourse)|sex\s+acts?|having\s+sex|(?:pornographic|sexually\s+explicit|explicit\s+adult)\s+(?:content|material|footage|scenes?|imagery|videos?|acts?)|adult\s+(?:films?|videos?)|porn(?:o|ography|ographic)?|masturbat\w*|intercourse|oral\s+sex|penetrat\w*)\b/i;

// The hard line that nudity being art never moves: a child and a bare body in the same text. Not a
// judgement of the words alone ("kids in swimsuits at the beach" is not this); a child together with
// nudity or genitals is sexual content involving a minor.
const MINOR = /\b(?:child(?:ren)?|kids?|minors?|teen(?:age(?:rs?)?|s)?|toddlers?|bab(?:y|ies)|infants?|boys?|girls?|underage)\b/i;
const NUDE = /\b(?:naked|nude|nudity|undress(?:ed|ing)?|topless|bottomless|genital(?:s|ia)?|penis(?:es)?|vaginas?|vulvas?|breasts?|nipples?)\b/i;

const CATEGORIES = Object.freeze(['fine', 'sex_acts', 'minor_sexual']);
const PLAIN = Object.freeze({
    fine: 'Fine - OK to show, including nudity',
    sex_acts: 'Sex acts or porn - never public; kept for its owner',
    minor_sexual: 'Sexual content involving a minor - always blocked and reported to the operator',
});

/** Sort one or more texts into exactly one category. */
function classifyText(...texts) {
    const all = texts.filter((t) => t != null).map(String).join('\n').trim();
    if (!all) return { category: 'fine', reason: 'there is no text to judge' };
    if (MINOR.test(all) && NUDE.test(all)) return { category: 'minor_sexual', reason: 'the text puts a child together with nudity' };
    if (EXPLICIT.test(all)) return { category: 'sex_acts', reason: 'the text describes sex acts or pornography' };
    if (MINOR.test(all)) return { category: 'fine', reason: 'a child is mentioned without nudity or a sex act' };
    if (NUDE.test(all)) return { category: 'fine', reason: 'the text describes nudity, which is allowed' };
    return { category: 'fine', reason: 'the text describes neither sex acts nor a child with nudity' };
}

/** True when any of the texts is sex_acts or minor_sexual. */
function isExplicit(...texts) {
    return classifyText(...texts).category !== 'fine';
}

module.exports = { isExplicit, classifyText, EXPLICIT, MINOR, NUDE, CATEGORIES, PLAIN };
