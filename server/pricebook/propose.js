'use strict';
/**
 * Propose price changes the owner decides on, never applies.
 *
 * The weekly job proposes a change only when it reads a listing itself. A reviewed reading of a model the
 * book does not own yet (a new cheap host, a model the catalogue has not synced) needs another door: this
 * module reads a list of verified readings and writes them into price_changes as pending, with the provider's
 * own listing and the day it was read. It never writes a price into a model row; approving the change on the
 * operator console is what moves the live price (server/pricebook/job.js decide()).
 *
 * A model the registry does not know yet is created switched off, with no price, so the owner has a row to
 * approve against. It is not marked price_book-owned until a price is approved, so the weekly job leaves it
 * alone until then. Context length and quantisation are recorded in the fields the model row already has.
 */
const { FIELDS } = require('./store');
const { AiError } = require('../util');

const EPSILON = 1e-6;
const MAX_PROPOSALS = 500;
const TYPES = ['chat', 'vision', 'embedding', 'stt', 'image', 'video', 'speech', 'rerank'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const numeric = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** One reading, checked before anything is written: a malformed batch is refused whole, not half-written. */
function check(input, index) {
    const at = `proposals[${index}]`;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiError(422, 'ai.invalid', `${at} must be an object`);
    const provider_key = String(input.provider_key || '').trim();
    const model_key = String(input.model_key || '').trim();
    if (!provider_key || provider_key.length > 80) throw new AiError(422, 'ai.invalid', `${at}.provider_key is required`);
    if (!model_key || model_key.length > 200) throw new AiError(422, 'ai.invalid', `${at}.model_key is required`);
    const source = String(input.source || '').trim();
    let url = null;
    try { url = new URL(source); } catch { /* refused below */ }
    if (!url || url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new AiError(422, 'ai.invalid', `${at}.source must be an https URL`);
    const checked_at = String(input.checked_at || '').trim();
    if (!DATE.test(checked_at)) throw new AiError(422, 'ai.invalid', `${at}.checked_at must be YYYY-MM-DD`);
    const type = input.type === undefined ? 'chat' : String(input.type);
    if (!TYPES.includes(type)) throw new AiError(422, 'ai.invalid', `${at}.type must be one of ${TYPES.join(', ')}`);
    const prices = {};
    for (const field of FIELDS) {
        if (input[field] === null || input[field] === undefined) continue;
        const n = numeric(input[field]);
        if (n === null || n < 0) throw new AiError(422, 'ai.invalid', `${at}.${field} must be a price of 0 or more`);
        prices[field] = n;
    }
    if (!Object.keys(prices).length) throw new AiError(422, 'ai.invalid', `${at} carries no price`);
    const context_window = input.context_window === null || input.context_window === undefined ? null : Number(input.context_window);
    if (context_window !== null && (!Number.isInteger(context_window) || context_window <= 0)) throw new AiError(422, 'ai.invalid', `${at}.context_window must be a positive integer`);
    const quantization = input.quantization === null || input.quantization === undefined ? null : String(input.quantization).trim().slice(0, 40) || null;
    return {
        provider_key, model_key, type, source: url.href, checked_at, prices, context_window, quantization,
        display_name: input.display_name ? String(input.display_name).slice(0, 200) : null,
    };
}

/**
 * Write the readings as pending changes. `dryRun` says what would happen without touching the database.
 * Returns what was proposed, what already matched the live price, and the models that had to be created.
 */
async function proposePriceChanges({ registry, store, proposals, clock = { now: () => Date.now() }, actor = 'owner', dryRun = false }) {
    if (!Array.isArray(proposals) || !proposals.length) throw new AiError(422, 'ai.invalid', 'proposals must be a non-empty list');
    if (proposals.length > MAX_PROPOSALS) throw new AiError(422, 'ai.invalid', `at most ${MAX_PROPOSALS} proposals at a time`);
    const checked = proposals.map(check);
    const days = [...new Set(checked.map((p) => p.checked_at))];
    const out = { proposed: [], unchanged: [], models_created: [], checked_at: days.length === 1 ? days[0] : null, dry_run: Boolean(dryRun) };

    for (const p of checked) {
        const provider = await registry.getProvider(p.provider_key);
        if (!provider) throw new AiError(422, 'ai.invalid', `no provider ${p.provider_key}`);
        let row = await registry.getModel(p.provider_key, p.model_key);
        if (!row) {
            if (dryRun) {
                row = { provider_key: p.provider_key, model_key: p.model_key, cost: {}, metadata: {}, context_window: null, type: p.type, status: 'disabled' };
                out.models_created.push({ provider_key: p.provider_key, model_key: p.model_key, type: p.type });
            } else {
                row = await registry.upsertModel({
                    provider_key: p.provider_key,
                    model_key: p.model_key,
                    display_name: p.display_name || p.model_key,
                    type: p.type,
                    status: 'disabled',
                    context_window: p.context_window,
                    cost: {},
                    supports: {},
                    metadata: { catalog: 'pricebook-proposal', ...(p.quantization ? { quantization: p.quantization } : {}) },
                }, { actor });
                out.models_created.push({ provider_key: p.provider_key, model_key: p.model_key, type: p.type });
            }
        } else {
            // The row exists: record what the listing says if its fields are still empty. A price is never written here.
            const metadata = { ...(row.metadata || {}) };
            const missing = [];
            if (p.context_window && !row.context_window) missing.push('context_window');
            if (p.quantization && !metadata.quantization) { missing.push('quantization'); metadata.quantization = p.quantization; }
            if (missing.length && !dryRun) {
                await registry.upsertModel({
                    provider_key: row.provider_key,
                    model_key: row.model_key,
                    display_name: row.display_name,
                    type: row.type,
                    status: row.status,
                    context_window: row.context_window || p.context_window,
                    max_output: row.max_output,
                    cost: row.cost,
                    supports: row.supports,
                    metadata,
                }, { actor });
            }
        }

        const changes = [];
        for (const field of FIELDS) {
            const next = p.prices[field];
            if (next === undefined) continue;
            const old = numeric(row.cost ? row.cost[field] : null);
            if (old !== null && Math.abs(old - next) <= EPSILON) continue;
            changes.push({ field, old, next, pct: old === null || old === 0 ? null : (next - old) / old });
        }
        if (!changes.length) {
            out.unchanged.push({ provider_key: p.provider_key, model_key: p.model_key, fields: Object.keys(p.prices) });
            continue;
        }
        if (!dryRun) {
            for (const change of changes) {
                await store.supersede({ provider_key: p.provider_key, model_key: p.model_key, field: change.field });
                await store.record({
                    provider_key: p.provider_key,
                    model_key: p.model_key,
                    field: change.field,
                    old_price: change.old,
                    new_price: change.next,
                    change_pct: change.pct,
                    source: p.source,
                    checked_at: p.checked_at,
                    status: 'pending',
                    note: 'proposed from the provider\'s own listing, waiting for the owner',
                    actor,
                });
            }
        }
        out.proposed.push({
            provider_key: p.provider_key, model_key: p.model_key, source: p.source, checked_at: p.checked_at,
            fields: changes.map((c) => ({ field: c.field, old: c.old, next: c.next, pct: c.pct })),
        });
    }
    return out;
}

module.exports = { proposePriceChanges, check, EPSILON, MAX_PROPOSALS };
