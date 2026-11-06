'use strict';
/**
 * The house text classifiers, in one place: OpenVibe.Live's `server/ai/explicit.js` and OpenVibe.Vision's
 * `server/vision/review.js`.
 *
 * Why they are here: OpenVibe.AI is its own service and cannot import another service's files, so the rules
 * travel with the name of the file they come from and the day they were read (2026-11-06). They are the house's
 * rules, not new ones: Live and Vision keep their own copies until the rules move into one shared package
 * (the follow-up). Nothing here decides what OpenVibe answers; it only says what a piece of text is.
 *
 *   Live    server/ai/explicit.js    EXPLICIT, MINOR, NUDE, minorNude(), isExplicit()
 *   Vision  server/vision/review.js  MINOR, NUDE, SEX, classifyText() → fine | sex_acts | minor_sexual
 *
 * What a caller may use:
 *
 *   minorNude(text)     a child and a bare body in the same text (Live's rule, the hard line nudity never moves)
 *   classifyText(text)  the category of a text: `fine`, `sex_acts` or `minor_sexual` (Vision's rule)
 *
 * `isExplicit` is here because it is Live's own rule (sex acts, whatever the age), but it is NOT a floor rule:
 * the uncensored tier exists for adult content, and the floor is about children, consent and weapons.
 */

/** Live: what a scene shows, not what someone talks about in passing — sex acts and pornography. */
const EXPLICIT = /\b(?:sexual(?:ly)?\s+(?:acts?|activity|intercourse)|sex\s+acts?|having\s+sex|(?:pornographic|sexually\s+explicit|explicit\s+adult)\s+(?:content|material|footage|scenes?|imagery|videos?|acts?)|adult\s+(?:films?|videos?)|porn(?:o|ography|ographic)?|masturbat\w*|intercourse|oral\s+sex|penetrat\w*)\b/i;

/** Live: a person who is not an adult. */
const MINOR = /\b(?:child(?:ren)?|kids?|minors?|teen(?:age(?:rs?)?|s)?|toddlers?|bab(?:y|ies)|infants?|boys?|girls?|underage)\b/i;

/** Live: a bare body. Nudity is art (the owner, 2026-10-31); a child and a bare body in the same text is not. */
const NUDE = /\b(?:naked|nude|nudity|undress(?:ed|ing)?|topless|bottomless|genital(?:s|ia)?|penis(?:es)?|vaginas?|vulvas?|breasts?|nipples?)\b/i;

/** Live: the hard line that nudity being art never moves. */
const minorNude = (t) => MINOR.test(String(t || '')) && NUDE.test(String(t || ''));

/** Live: true when any of the texts describes sex acts or pornography, or puts a child and nudity together. */
function isExplicit(...texts) {
    return texts.some((t) => t != null && (EXPLICIT.test(String(t)) || minorNude(String(t))));
}

/** Vision: a person who is not an adult (its list is Live's plus preteens and schoolchildren). */
const MINOR_VISION = /\b(?:child(?:ren)?|kids?|minors?|underage|preteens?|toddlers?|bab(?:y|ies)|infants?|boys?|girls?|teen(?:age(?:rs?)?|s)?|schoolboys?|schoolgirls?)\b/i;

/** Vision: a bare body. */
const NUDE_VISION = /\b(?:naked|nude|nudity|undress(?:ed|ing)?|topless|bottomless|genital(?:s|ia)?|penis(?:es)?|vaginas?|vulvas?|breasts?|nipples?)\b/i;

/**
 * Vision: what a scene shows, not what someone talks about in passing. Nudity and body words are deliberately
 * absent (a nude body is not a sex act).
 */
const SEX = /\b(?:sexual(?:ly)?\s+(?:acts?|activity|intercourse|content|explicit|material|scenes?)|sex\s+(?:acts?|scenes?|shows?|clubs?|work|toys?)|having\s+sex|(?:pornographic|explicit\s+adult|adult)\s+(?:content|material|footage|scenes?|imagery|videos?|films?|acts?)|porn(?:o|ography|ographic)?|masturbat\w*|intercourse|oral\s+sex|anal\s+sex|penetrat\w*|erotic\w*|orgasm\w*|blow\s?job|hand\s?job|nsfw)\b/i;

/** Vision: the three categories, worst last. */
const CATEGORIES = ['fine', 'sex_acts', 'minor_sexual'];

/**
 * Vision: sort a piece of text into the three categories.
 * → { category: 'fine' | 'sex_acts' | 'minor_sexual', cue, reason }
 */
function classifyText(...texts) {
    const all = texts.filter((t) => t != null).map(String).join('\n').trim();
    if (!all) return { category: 'fine', cue: 'empty', reason: 'there is no text to judge' };
    const minor = MINOR_VISION.test(all);
    const nude = NUDE_VISION.test(all);
    const sex = SEX.test(all);
    if (minor && (sex || nude)) {
        return { category: 'minor_sexual', cue: 'minor+nudity_or_sex', reason: 'the text puts a child together with nudity or sex acts' };
    }
    if (sex) return { category: 'sex_acts', cue: 'sex_acts', reason: 'the text describes sex acts or pornography' };
    if (nude) return { category: 'fine', cue: 'nudity', reason: 'the text describes nudity, which is allowed; it does not describe a sex act' };
    return { category: 'fine', cue: 'none', reason: 'the text describes neither sex acts nor a child with nudity' };
}

module.exports = {
    EXPLICIT, MINOR, NUDE, MINOR_VISION, NUDE_VISION, SEX, CATEGORIES,
    minorNude, isExplicit, classifyText,
};
