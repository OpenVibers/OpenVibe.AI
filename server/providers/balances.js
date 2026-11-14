'use strict';
/**
 * What is left on each provider account, read live (plan §AB.21; the owner, 11-14: "the gift credits on all the providers
 * need to be detectable"). Only providers that publish a balance read are asked, with the owner's own key for them:
 *
 *   deepseek    GET https://api.deepseek.com/user/balance           total, of it granted (gift) and topped up
 *   openrouter  GET https://openrouter.ai/api/v1/credits            credits bought minus credits used
 *   kimi        GET https://api.moonshot.ai/v1/users/me/balance     available, of it vouchers (gift) and cash
 *
 * A provider without a key, or whose read fails, says so in words and never shows a zero it did not read. Answers are
 * kept ten minutes per provider; the key never leaves this module (it is sent only to the provider's own address).
 *
 *   GET /api/v1/admin/console/provider-balances   ai.config.manage   { providers: [{ provider, name, currency, balance,
 *                                                                      gift, paid, state, note, checked_at }] }
 */
const { providerSecret } = require('../util');

const KEEP_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };

const READERS = {
    deepseek: {
        name: 'DeepSeek', url: 'https://api.deepseek.com/user/balance',
        read(j) {
            const infos = Array.isArray(j && j.balance_infos) ? j.balance_infos : [];
            const b = infos.find((x) => x && x.currency === 'USD') || infos[0];
            if (!b) return null;
            return { currency: String(b.currency || 'USD').toUpperCase(), balance: num(b.total_balance), gift: num(b.granted_balance), paid: num(b.topped_up_balance),
                note: j.is_available === false ? 'Not enough balance to make calls' : null };
        },
    },
    openrouter: {
        name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/credits',
        read(j) {
            const d = j && j.data;
            if (!d || !Number.isFinite(Number(d.total_credits))) return null;
            return { currency: 'USD', balance: num(Number(d.total_credits) - Number(d.total_usage || 0)), gift: null, paid: num(d.total_credits), note: null };
        },
    },
    kimi: {
        name: 'Moonshot (Kimi)', url: 'https://api.moonshot.ai/v1/users/me/balance',
        read(j) {
            const d = j && j.data;
            if (!d || !Number.isFinite(Number(d.available_balance))) return null;
            return { currency: 'USD', balance: num(d.available_balance), gift: num(d.voucher_balance), paid: num(d.cash_balance), note: null };
        },
    },
};

function createProviderBalances({ registry, fetchImpl = globalThis.fetch, clock = { now: Date.now }, env = process.env, log = console } = {}) {
    const kept = new Map();   // provider → { at, row }
    async function readOne(key) {
        const reader = READERS[key];
        const hit = kept.get(key);
        if (hit && clock.now() - hit.at < KEEP_MS) return hit.row;
        const at = new Date(clock.now()).toISOString();
        const base = { provider: key, name: reader.name, currency: 'USD', balance: null, gift: null, paid: null, checked_at: at };
        let row;
        const p = await registry.getProvider(key).catch(() => null);
        const secret = p ? providerSecret(p, env) : '';
        if (!p) row = { ...base, state: 'not_set_up', note: 'Not set up here' };
        else if (!secret) row = { ...base, state: 'no_key', note: 'No key yet: add it in Setup' };
        else {
            try {
                const r = await fetchImpl(reader.url, { headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
                if (r.status === 401 || r.status === 403) row = { ...base, state: 'key_refused', note: 'The provider refused the key' };
                else if (!r.ok) row = { ...base, state: 'unavailable', note: `The provider answered ${r.status}` };
                else {
                    const got = reader.read(await r.json());
                    row = got ? { ...base, ...got, state: 'read', note: got.note } : { ...base, state: 'unavailable', note: 'The provider sent no balance' };
                }
            } catch (err) {
                log.warn && log.warn(`[balances] ${key}: ${String(err && err.message || err).slice(0, 80)}`);
                row = { ...base, state: 'unavailable', note: 'The provider did not answer' };
            }
        }
        kept.set(key, { at: clock.now(), row });
        return row;
    }
    async function list() {
        return await Promise.all(Object.keys(READERS).map(readOne));
    }
    return { list, readers: Object.keys(READERS) };
}

module.exports = { createProviderBalances, READERS, KEEP_MS };
