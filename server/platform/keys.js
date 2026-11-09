'use strict';
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { AiError } = require('../util');
const hash = (s) => createHash('sha256').update(s).digest('hex');
// A call with no max_cost_usd holds this much of its key's cap until it settles.
const DEFAULT_HOLD_USD = 1;
function createKeys({ db, clock = { now: () => Date.now() } }) {
    const iso = () => new Date(clock.now()).toISOString();
    const publicKey = (r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        monthly_cap_usd: Number(r.monthly_cap_usd),
        allowed_models: JSON.parse(r.allowed_models),
        created_at: r.created_at,
        revoked_at: r.revoked_at,
        expires_at: r.expires_at || null,
    });
    async function list(owner) {
        return (
            await db
                .prepare(
                    'SELECT * FROM exchange_api_keys WHERE owner = ? ORDER BY created_at DESC',
                )
                .all(owner)
        ).map(publicKey);
    }
    async function create(owner, b) {
        if (
            typeof b.name !== 'string' ||
            !b.name.trim() ||
            b.name.length > 80 ||
            !Number.isFinite(b.monthly_cap_usd) ||
            b.monthly_cap_usd < 0 ||
            !Array.isArray(b.allowed_models) ||
            b.allowed_models.length > 100 ||
            b.allowed_models.some(
                (m) => typeof m !== 'string' || !m || m.length > 200,
            )
        )
            throw new AiError(
                422,
                'ai.invalid',
                'A name, nonnegative monthly cap and allowed model list are required',
            );
        const expires = b.expires_at == null ? null : Date.parse(b.expires_at);
        if (expires !== null && (!Number.isFinite(expires) || expires <= clock.now())) throw new AiError(422, 'ai.invalid', 'expires_at must be a future timestamp');
        const secret = 'ovx_' + randomBytes(32).toString('base64url');
        const id = 'xkey_' + randomUUID();
        await db
            .prepare(
                'INSERT INTO exchange_api_keys(id,owner,name,digest,prefix,monthly_cap_usd,allowed_models,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
            )
            .run(
                id,
                owner,
                b.name.trim(),
                hash(secret),
                secret.slice(0, 10),
                b.monthly_cap_usd,
                JSON.stringify(b.allowed_models),
                iso(),
                expires === null ? null : new Date(expires).toISOString(),
            );
        return { key: (await list(owner)).find((k) => k.id === id), secret };
    }
    async function revoke(owner, id) {
        const r = await db
            .prepare(
                'UPDATE exchange_api_keys SET revoked_at = ? WHERE owner = ? AND id = ? RETURNING id',
            )
            .get(iso(), owner, id);
        if (!r) throw new AiError(404, 'ai.not_found', 'No such key');
        return { id, revoked: true };
    }
    async function resolve(secret) {
        if (!/^ovx_[A-Za-z0-9_-]{43}$/.test(secret)) return null;
        return db
            .prepare(
                'SELECT * FROM exchange_api_keys WHERE digest = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
            )
            .get(hash(secret), iso());
    }
    /**
     * A hold for one call against the key's monthly cap: the call's own ceiling (`limit`, its max_cost_usd) or
     * DEFAULT_HOLD_USD, never more than what is left this month. Holds add up, so calls run side by side while their
     * holds fit under the cap; settle() charges what the call cost (the hold when the cost is unknown, e.g. the client
     * hung up) and gives the rest of the hold back. Free search calls take no hold; paid search holds its ceiling. Search skips the model list.
     */
    async function reserve(key, model, free = false, limit = null, search = false) {
        // Re-read the credential: a previously resolved key may have expired or been revoked.
        const active = await db.prepare(
            'SELECT id FROM exchange_api_keys WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
        ).get(key.id, iso());
        if (!active) throw new AiError(401, 'token.invalid', 'Invalid, expired or revoked Exchange key');
        const allowed = JSON.parse(key.allowed_models);
        if (!free && !search && allowed.length && !allowed.includes(model))
            throw new AiError(403, 'exchange.model_denied', 'This model is not allowed by this key');
        const month = iso().slice(0, 7),
            day = iso().slice(0, 10),
            id = randomUUID();
        await db
            .prepare('INSERT INTO exchange_key_months(key_id,month) VALUES(?,?) ON CONFLICT DO NOTHING')
            .run(key.id, month);
        let amount = 0;
        if (!free) {
            const want = Number.isFinite(limit) && limit > 0 ? Math.min(limit, DEFAULT_HOLD_USD * 100) : DEFAULT_HOLD_USD;
            // One statement, so two calls never both take the last of the cap: the row is locked, and the second
            // reads what the first left.
            const row = await db
                .prepare(
                    `WITH m AS (
                        SELECT key_id, month, LEAST(?::double precision, monthly.cap - spent - reserved) AS take
                        FROM exchange_key_months, (SELECT ?::double precision AS cap) monthly
                        WHERE key_id = ? AND month = ? AND spent + reserved < monthly.cap
                        FOR UPDATE OF exchange_key_months
                    )
                    UPDATE exchange_key_months x SET reserved = x.reserved + m.take FROM m
                    WHERE x.key_id = m.key_id AND x.month = m.month
                      AND EXISTS (SELECT 1 FROM exchange_api_keys k WHERE k.id = x.key_id AND k.revoked_at IS NULL
                        AND (k.expires_at IS NULL OR k.expires_at::timestamptz > GREATEST(?::timestamptz, clock_timestamp())))
                    RETURNING m.take AS take`,
                )
                .get(want, key.monthly_cap_usd, key.id, month, iso());
            if (!row)
                throw new AiError(429, 'exchange.key_cap', "This key's monthly cap is spent");
            amount = Number(row.take);
        }
        await db
            .prepare('INSERT INTO exchange_key_usage(id,key_id,day,model,cost_usd,status) VALUES(?,?,?,?,?,?)')
            .run(id, key.id, day, model, amount, 'reserved');
        let settled = false;
        return {
            amount,
            async settle({ cost_usd, tokens_in = 0, tokens_out = 0 } = {}) {
                if (settled) return;
                settled = true;
                const known = Number.isFinite(cost_usd) && cost_usd >= 0;
                const cost = known ? cost_usd : amount;
                await db
                    .prepare('UPDATE exchange_key_usage SET cost_usd = ?, tokens_in = ?, tokens_out = ?, status = ? WHERE id = ?')
                    .run(cost, tokens_in, tokens_out, known ? 'settled' : 'unresolved', id);
                if (!free)
                    await db
                        .prepare('UPDATE exchange_key_months SET spent = spent + ?, reserved = GREATEST(0, reserved - ?) WHERE key_id = ? AND month = ?')
                        .run(cost, amount, key.id, month);
            },
        };
    }
    async function usage(owner) {
        return {
            rows: await db
                .prepare(
                    'SELECT u.day,u.key_id,u.model,u.status,COUNT(*)::int AS requests,SUM(u.tokens_in)::bigint AS tokens_in,SUM(u.tokens_out)::bigint AS tokens_out,SUM(u.cost_usd)::double precision AS cost_usd FROM exchange_key_usage u JOIN exchange_api_keys k ON k.id=u.key_id WHERE k.owner=? GROUP BY u.day,u.key_id,u.model,u.status ORDER BY u.day DESC LIMIT 1000',
                )
                .all(owner),
        };
    }
    return { list, create, revoke, resolve, reserve, usage };
}
module.exports = { createKeys };
