'use strict';
/**
 * Plan E5: the daily free allowance grows with trust (server/abuse/index.js decides when it is spent).
 *
 * The tiers, as the plan states them:
 *
 *   new          an account under 24 h old, unverified: a quarter of the base allowance
 *   established  an account over 7 days old, unverified: half
 *   verified     a passkey, a linked account, or 30 days with activity: the full allowance
 *   contributor  a verified volunteer whose kudos (server/community/) buy more: up to one more base
 *
 * A hosting/data-centre ASN (the network signal) is always the new tier and a lower rate, whatever the account
 * says: a data centre is not a person's home, and a farm can make accounts look old. If Network cannot answer,
 * the account is treated as new: the conservative side, never the generous one.
 *
 * The result is a token budget, never money: the allowance caps how many free tokens a day the account (or the
 * accounts sharing one device) may claim. It does not price anything (server/free-allowance.js does that).
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const TIERS = Object.freeze({
    new: Object.freeze({ factor: 0.25, label: 'New account (under 24 hours)' }),
    established: Object.freeze({ factor: 0.5, label: 'Established account (over 7 days)' }),
    verified: Object.freeze({ factor: 1, label: 'Verified account' }),
});

// The daily allowance grows with rank (2026-11-16; the owner, after their own Actor task met the free allowance: "owner
// rank should be able to use more tokens per day"). Network's trust facts carry `rank` (owner, admin, global_mod,
// streamer, user). A factor multiplies the verified allowance; 'unlimited' lifts the daily cap (the rate limits still
// apply). Staff ranks are trusted whatever network they call from; a streamer's factor applies on top of their tier.
// AI_FREE_RANK_FACTORS overrides these, e.g. {"owner":"unlimited","admin":50,"streamer":3}.
const RANK_FACTORS = Object.freeze({ owner: 'unlimited', admin: 'unlimited', global_mod: 10, streamer: 2, user: 1 });
const STAFF = new Set(['owner', 'admin', 'global_mod']);

/** The rank factors in force: the defaults with a JSON override from the config (bad entries are ignored). */
function rankFactors(override) {
    const out = { ...RANK_FACTORS };
    let o = override;
    if (typeof o === 'string' && o.trim()) { try { o = JSON.parse(o); } catch { o = null; } }
    if (o && typeof o === 'object') {
        for (const [rank, v] of Object.entries(o)) {
            if (!Object.prototype.hasOwnProperty.call(RANK_FACTORS, rank)) continue;
            if (v === 'unlimited') out[rank] = 'unlimited';
            else if (Number.isFinite(Number(v)) && Number(v) >= 0) out[rank] = Number(v);
        }
    }
    return out;
}

/** A whole, non-negative token count; anything unusable becomes 0. */
function tokensOf(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The tier an account is in, from Network's trust signals (server/identity/trust.js) and the AI-side kudos.
 *
 *   signals   { available, account_age_hours, verified, verified_by, ... } | null
 *   kudos     the volunteer's free-allowance bonus in tokens (community.kudosBonus), 0 when none
 *   hosting   the request came from a hosting/data-centre ASN
 *   base      AI_FREE_DAILY_TOKENS (the full allowance)
 *
 * → { tier, allowance, base, kudos_bonus, reasons, hosting }
 */
function tierFor({ signals = null, kudos = 0, hosting = false, base = 0, factors = null } = {}) {
    const full = tokensOf(base);
    const reasons = [];
    const rank = signals && signals.available && typeof signals.rank === 'string' ? signals.rank : 'user';
    const byRank = rankFactors(factors);
    const rankFactor = Object.prototype.hasOwnProperty.call(byRank, rank) ? byRank[rank] : 1;
    if (STAFF.has(rank)) {
        // Staff: trusted from any network. Unlimited lifts the daily cap; a number multiplies the full allowance.
        if (rankFactor === 'unlimited') return { tier: rank, allowance: null, unlimited: true, base: full, kudos_bonus: 0, reasons: [`${rank}: no daily cap`], hosting: Boolean(hosting), rank };
        return { tier: rank, allowance: Math.floor(full * rankFactor), unlimited: false, base: full, kudos_bonus: 0, reasons: [`${rank}: ${rankFactor}× the full allowance`], hosting: Boolean(hosting), rank };
    }
    let tier;
    if (hosting) {
        tier = 'new';
        reasons.push('the client address is in a hosting/data-centre ASN');
    } else if (signals && signals.available && signals.verified) {
        tier = 'verified';
        reasons.push(`verified: ${(signals.verified_by || []).join(', ') || 'trusted account'}`);
    } else if (signals && signals.available && Number(signals.account_age_hours) >= 7 * 24) {
        tier = 'established';
        reasons.push('the account is over 7 days old');
    } else {
        tier = 'new';
        reasons.push(signals && signals.available ? 'the account is under 24 hours old or unverified' : 'Network could not vouch for the account');
    }
    let allowance = Math.floor(full * TIERS[tier].factor);
    // A volunteer's kudos buy at most one more base allowance, and only on top of the full tier: never a way
    // around a hosting ASN or an unverified account.
    const kudosBonus = tier === 'verified' ? Math.min(full, tokensOf(kudos)) : 0;
    if (kudosBonus) {
        allowance += kudosBonus;
        reasons.push(`kudos add ${kudosBonus} tokens`);
    }
    if (rank === 'streamer' && rankFactor !== 1) {
        if (rankFactor === 'unlimited') return { tier, allowance: null, unlimited: true, base: full, kudos_bonus: kudosBonus, reasons: [...reasons, 'streamer: no daily cap'], hosting: Boolean(hosting), rank };
        allowance = Math.floor(allowance * rankFactor);
        reasons.push(`streamer: ${rankFactor}×`);
    }
    if (!full) reasons.push('the free allowance is switched off (AI_FREE_DAILY_TOKENS=0)');
    return { tier, allowance, unlimited: false, base: full, kudos_bonus: kudosBonus, reasons, hosting: Boolean(hosting), rank };
}

/** The lower request rate a hosting ASN gets, whatever the account says (server/abuse/index.js). */
function rateFor({ hosting = false, normal = 60, hostingRate = 20 } = {}) {
    return hosting ? Math.max(1, Math.floor(Number(hostingRate) || 0)) : Math.max(1, Math.floor(Number(normal) || 0));
}

module.exports = { TIERS, HOUR, DAY, tierFor, rateFor, tokensOf, rankFactors, RANK_FACTORS };
