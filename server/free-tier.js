'use strict';
/**
 * Who may serve a run nobody pays for (the free allowance and the Exchange's anonymous Try it).
 *
 * The design funds free use from the owner's DeepSeek key, local models and community volunteers
 * (EXCHANGE-REMAKE-2026-11-06.md, "Money and free use"). AI_FREE_PROVIDERS names those sources; every
 * other provider needs a payer. AI_FREE_MAX_OUTPUT_PRICE_USD_PER_MTOK then caps what a metered source may
 * cost, so a free run never lands on a dearer model through the owner's key.
 *
 * A source id is a provider's own key (deepseek, shared, …) or one of two families:
 *   - `local` matches every local model server (the seeded `local` and `local2`, and whisper.cpp);
 *   - `community` matches the community machines (server/community/, which has no registry provider row).
 * Matching is case-insensitive. An empty list allows nothing: the free tier then needs a payer.
 *
 * Both rules are admission, never pricing: a skipped offer is not charged, and a person's own key, own
 * token (their Balance), project or service run-token budget never goes through here.
 */

/** The sources a free run may use when AI_FREE_PROVIDERS is unset (the design's three funding sources). */
const DEFAULT_PROVIDERS = ['deepseek', 'local', 'community'];

const isLocal = (provider) => Boolean(provider) && (provider.kind === 'whisper' || Boolean(provider.metadata && provider.metadata.local));

/** The configured source ids, lowercased; `freeUse` is config.freeUse (undefined falls back to the default). */
function sourcesOf(freeUse) {
    const list = freeUse && Array.isArray(freeUse.providers) ? freeUse.providers : DEFAULT_PROVIDERS;
    return new Set(list.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
}

/** The output price ceiling in USD per 1M tokens, or null when the config names no usable number. */
function ceilingOf(freeUse) {
    const n = Number(freeUse && freeUse.maxOutputPricePerMtok);
    return Number.isFinite(n) ? n : null;
}

/**
 * May this provider record serve a free run? An exact key always matches; `local` also covers a local
 * server under another key (local2), so adding a second local model never silently leaves the free tier.
 */
function allowsProvider(providerKey, providerRecord, sources) {
    if (!sources) return false;
    const key = String(providerKey || '').trim().toLowerCase();
    if (!key) return false;
    if (sources.has(key)) return true;
    return isLocal(providerRecord) && sources.has('local');
}

/** May a community machine serve a free run? (community capacity is not a registry provider.) */
const allowsCommunity = (sources) => Boolean(sources) && sources.has('community');

/**
 * Could this offer serve the free tier? Both rules: its provider is a named source and its output price
 * is at or below the ceiling. An offer with no per-token card (local, prepaid) has no output price to cap.
 */
function allowsOffer({ providerKey, providerRecord = null, outputPrice = null }, freeUse) {
    const sources = sourcesOf(freeUse);
    if (!allowsProvider(providerKey, providerRecord, sources)) return false;
    const ceiling = ceilingOf(freeUse);
    if (ceiling == null) return true;
    return !(Number(outputPrice) > ceiling);
}

module.exports = { DEFAULT_PROVIDERS, isLocal, sourcesOf, ceilingOf, allowsProvider, allowsCommunity, allowsOffer };
