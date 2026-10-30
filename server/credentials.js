'use strict';
/**
 * A person's own provider key (roadmap WS-O task 2; Contracts ai.credential.manage, ai.credential-put@2 and
 * ai.credential@2 since Codes C3). The service that holds the person's consent (Live, for a streamer's AI viewers;
 * Codes, for the people it builds for) stores the key here; it never leaves OpenVibe.AI again. Runs that name the
 * credential (ai.run-request credential { subject, provider? }) call that provider with that key only
 * (server/providers/index.js executeWithCredential), never a shared key.
 *
 *   PUT    /api/v1/credentials/:subject             store or replace the DEFAULT provider's credential (the v1 route)
 *   PUT    /api/v1/credentials/:subject/:provider   store or replace that provider's credential
 *   GET    /api/v1/credentials/:subject[/:provider] read it back without the key: a four-character hint, today's spend
 *   DELETE /api/v1/credentials/:subject[/:provider]
 *
 * A person may keep one credential per provider (anthropic, openai, deepseek, minimax, openrouter, custom, node), each
 * with its own daily budget; the provider-less routes read and write the default one, which is the row a pre-C3 caller
 * stored (migrations/0014).
 *
 * At rest the key is AES-256-GCM encrypted with AI_CREDENTIALS_KEY (64 hex characters) and bound to its owner, subject
 * AND provider (the additional data), so a row copied to another owner, subject or provider does not decrypt. Rows
 * written before the provider dimension were sealed with owner|subject only (`v1:`); they are read with that AAD and
 * rewritten as `v2:` (owner|subject|provider) on first use. Without the key configured the routes answer 503 and
 * credentialed runs are refused. Spend is what the credential's requests cost today (provider_key byo:<owner>:<subject>
 * for a row stored before C3 or through the provider-less route, byo:<owner>:<subject>:<provider> for the rest),
 * checked against the optional budget_usd_per_day.
 *
 * Provider node (contracts 0.220.0) is the person's own machine instead: `machine` names it, there is no key (nothing is
 * sealed, no hint), and a run reaches it only through OpenVibe.Bot (server/machines.js), for that person only.
 */
const crypto = require('crypto');
const express = require('express');
const { validate } = require('openvibe-contracts');
const { AiError } = require('./util');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROVIDERS = ['openai', 'anthropic', 'node', 'deepseek', 'minimax', 'openrouter', 'custom'];
/** Where each provider answers when the person stored no base_url. DeepSeek and MiniMax speak the Anthropic format at
 *  their own /anthropic path; a custom provider always names its endpoint. */
const PROVIDER_BASE_URL = {
    anthropic: 'https://api.anthropic.com/v1', openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com/anthropic',
    minimax: 'https://api.minimax.io/anthropic', openrouter: 'https://openrouter.ai/api/v1',
};

function providerKeyFor(owner, subject, provider = null) { return provider ? `byo:${owner}:${subject}:${provider}` : `byo:${owner}:${subject}`; }
/** The AAD a key is sealed with: moving the row to another owner, subject or provider must not decrypt it. */
function aadFor(owner, subject, provider) { return `${owner}|${subject}|${provider}`; }
function legacyAadFor(owner, subject) { return `${owner}|${subject}`; }

function createCredentials({ db, config, clock = { now: () => Date.now() } }) {
    // subject_credentials is in migrations/0001_initial.sql (ADR-035); 0011 added the node machine, 0014 the provider
    // dimension (is_default, spend_key, one row per provider).
    const iso = (ms) => new Date(ms).toISOString();

    function secretKey() {
        const hex = String(config.credentialsKey || '');
        if (!/^[0-9a-f]{64}$/i.test(hex)) throw new AiError(503, 'credentials.unavailable', 'person credentials are not configured on this service (AI_CREDENTIALS_KEY)');
        return Buffer.from(hex, 'hex');
    }
    /** v2: bound to owner, subject and provider (Codes C3). */
    function seal(plain, aad) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
        c.setAAD(Buffer.from(aad));
        const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
        return `v2:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
    }
    /**
     * A sealed key. `v2:` opens with the provider-bound AAD; `v1:` is a row written before the provider dimension
     * and opens with owner|subject only (the caller then rewrites it). Any other prefix is refused.
     */
    function open(sealed, aad, legacyAad) {
        const [v, iv, tag, body] = String(sealed).split(':');
        if (v !== 'v1' && v !== 'v2') throw new Error('unknown credential format');
        const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
        d.setAAD(Buffer.from(v === 'v1' ? legacyAad : aad));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
    }
    /** The row's key; a pre-C3 row is upgraded to the provider-bound AAD as it is read. */
    async function openRow(r) {
        const key = open(r.key_enc, aadFor(r.owner, r.subject, r.provider), legacyAadFor(r.owner, r.subject));
        if (String(r.key_enc).startsWith('v1:')) {
            await db.prepare("UPDATE subject_credentials SET key_enc = ? WHERE owner = ? AND subject = ? AND provider = ? AND key_enc LIKE 'v1:%'")
                .run(seal(key, aadFor(r.owner, r.subject, r.provider)), r.owner, r.subject, r.provider);
        }
        return key;
    }

    async function spentToday(row) {
        const day = iso(clock.now()).slice(0, 10);
        const r = await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM requests WHERE provider_key = ? AND status = 'ok' AND created_at >= ?").get(row.spend_key || providerKeyFor(row.owner, row.subject), `${day}T00:00:00.000Z`);
        return r ? Number(r.c) || 0 : 0;
    }

    async function view(row) {
        return {
            subject: row.subject, owner: row.owner, provider: row.provider, base_url: row.base_url || null,
            ...(row.provider === 'node' ? { machine: row.machine } : { key_hint: row.key_hint }),
            models: JSON.parse(row.models || '{}'), budget_usd_per_day: row.budget_usd_day == null ? null : row.budget_usd_day,
            spent_usd_today: Math.round(await spentToday(row) * 1e6) / 1e6,
            created_at: row.created_at, updated_at: row.updated_at, last_used_at: row.last_used_at || null,
        };
    }
    const getRow = async (owner, subject, provider) => provider
        ? await db.prepare('SELECT * FROM subject_credentials WHERE owner = ? AND subject = ? AND provider = ?').get(owner, subject, provider)
        : await db.prepare('SELECT * FROM subject_credentials WHERE owner = ? AND subject = ? AND is_default').get(owner, subject);

    /**
     * put(owner, subject, body, provider?) — the provider is the route's when it names one (the body may then leave it
     * out). The provider-less route stores the DEFAULT credential.
     */
    async function put(owner, subject, body, provider = null) {
        if (!SUBJECT_RE.test(String(subject))) throw new AiError(400, 'input.invalid', 'subject must be a usr_ subject');
        const v = validate('ai.credential-put@2', body);
        if (!v.valid) throw new AiError(422, 'input.invalid', 'body does not match ai.credential-put@2', { errors: v.errors });
        if (provider !== null && body.provider !== provider) throw new AiError(422, 'input.invalid', `body.provider is ${body.provider}, the route names ${provider}`);
        const at = iso(clock.now());
        const makeDefault = provider === null;
        const prev = await getRow(owner, subject, body.provider);
        if (body.provider === 'node') {
            // The person's own machine: nothing to seal. Bot checks it is theirs and that they turned it on, at each run.
            await db.tx(async () => {
            if (makeDefault) await db.prepare('UPDATE subject_credentials SET is_default = false WHERE owner = ? AND subject = ? AND provider <> ?').run(owner, subject, 'node');
            await db.prepare(`INSERT INTO subject_credentials (owner, subject, provider, base_url, machine, key_enc, key_hint, models, budget_usd_day, is_default, spend_key, created_at, updated_at)
                        VALUES (?, ?, 'node', NULL, ?, '', '', ?, NULL, ?, ?, ?, ?)
                        ON CONFLICT(owner, subject, provider) DO UPDATE SET base_url = NULL, machine = excluded.machine, key_enc = '',
                          key_hint = '', models = excluded.models, budget_usd_day = NULL, is_default = subject_credentials.is_default OR excluded.is_default, updated_at = excluded.updated_at`)
                .run(owner, subject, body.machine, JSON.stringify(body.models || {}), makeDefault,
                    (prev && prev.spend_key) || (makeDefault ? providerKeyFor(owner, subject) : providerKeyFor(owner, subject, 'node')), prev ? prev.created_at : at, at);
            });
            return await view(await getRow(owner, subject, 'node'));
        }
        // The stored key stays for a change of models or budget; a new provider or endpoint needs the key again.
        const newKey = body.key != null ? String(body.key) : (body.api_key != null ? String(body.api_key) : null);
        const sameEndpoint = prev && prev.provider !== 'node' && (prev.base_url || null) === (body.base_url || null);
        if (newKey == null && !sameEndpoint) {
            throw new AiError(400, 'credential.key_required', prev ? 'enter the key again to change the provider or its address' : 'key is required the first time');
        }
        const key = newKey != null ? newKey : await openRow(prev);
        await db.tx(async () => {
        if (makeDefault) await db.prepare('UPDATE subject_credentials SET is_default = false WHERE owner = ? AND subject = ? AND provider <> ?').run(owner, subject, body.provider);
        await db.prepare(`INSERT INTO subject_credentials (owner, subject, provider, base_url, key_enc, key_hint, models, budget_usd_day, is_default, spend_key, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(owner, subject, provider) DO UPDATE SET base_url = excluded.base_url, key_enc = excluded.key_enc,
                      key_hint = excluded.key_hint, models = excluded.models, budget_usd_day = excluded.budget_usd_day, is_default = subject_credentials.is_default OR excluded.is_default, updated_at = excluded.updated_at`)
            .run(owner, subject, body.provider, body.base_url || null, seal(key, aadFor(owner, subject, body.provider)), `…${key.slice(-4)}`, JSON.stringify(body.models || {}),
                body.budget_usd_per_day ? Number(body.budget_usd_per_day) : null, makeDefault,
                (prev && prev.spend_key) || (makeDefault ? providerKeyFor(owner, subject) : providerKeyFor(owner, subject, body.provider)), prev ? prev.created_at : at, at);
        });
        return await view(await getRow(owner, subject, body.provider));
    }

    async function get(owner, subject, provider = null) {
        if (provider !== null && !PROVIDERS.includes(provider)) throw new AiError(404, 'credential.not_found', 'no credential stored for that provider');
        const r = await getRow(owner, subject, provider);
        if (!r) throw new AiError(404, 'credential.not_found', provider ? `no ${provider} credential stored for that subject` : 'no credential stored for that subject');
        return await view(r);
    }

    /** The newest of what is left becomes the default, so the provider-less routes keep answering. */
    async function ensureDefault(owner, subject) {
        await db.prepare(`UPDATE subject_credentials SET is_default = true WHERE owner = ? AND subject = ?
            AND NOT EXISTS (SELECT 1 FROM subject_credentials d WHERE d.owner = ? AND d.subject = ? AND d.is_default)
            AND provider = (SELECT provider FROM subject_credentials WHERE owner = ? AND subject = ? ORDER BY updated_at DESC, provider LIMIT 1)`)
            .run(owner, subject, owner, subject, owner, subject);
    }

    async function remove(owner, subject, provider = null) {
        if (provider !== null) {
            let gone = false;
            await db.tx(async () => {
                gone = (await db.prepare('DELETE FROM subject_credentials WHERE owner = ? AND subject = ? AND provider = ?').run(owner, subject, provider)).changes > 0;
                if (gone) await ensureDefault(owner, subject);
            });
            return gone;
        }
        let gone = false;
        await db.tx(async () => {
            gone = (await db.prepare('DELETE FROM subject_credentials WHERE owner = ? AND subject = ? AND is_default').run(owner, subject)).changes > 0;
            if (gone) await ensureDefault(owner, subject);
        });
        return gone;
    }

    /** Checks a run may use the credential (exists, within budget); throws AiError otherwise. */
    async function admit(owner, subject, provider = null) {
        if (provider !== null && !PROVIDERS.includes(provider)) throw new AiError(404, 'credential.not_found', 'no credential stored for that provider');
        const r = await getRow(owner, subject, provider);
        if (!r) throw new AiError(404, 'credential.not_found', provider ? `no ${provider} credential stored for that subject` : 'no credential stored for that subject');
        if (r.provider === 'node') return;   // the person's own machine: no key, no spend
        secretKey();
        if (r.budget_usd_day != null && r.budget_usd_day > 0 && await spentToday(r) >= r.budget_usd_day) {
            const tomorrow = new Date(iso(clock.now()).slice(0, 10) + 'T00:00:00.000Z').getTime() + 86400000;
            throw new AiError(429, 'quota.exceeded', "this person's own daily budget for their key is spent", { retry_after_seconds: Math.max(60, Math.ceil((tomorrow - clock.now()) / 1000)), quota: { scope: 'credential' } });
        }
    }

    /** The decrypted credential for one execution: { providerKey, provider, base_url, apiKey|machine, models }. */
    async function forRun(owner, subject, provider = null) {
        if (provider !== null && !PROVIDERS.includes(provider)) throw new AiError(404, 'credential.not_found', 'no credential stored for that provider');
        const r = await getRow(owner, subject, provider);
        if (!r) throw new AiError(404, 'credential.not_found', provider ? `the ${provider} credential was deleted` : 'the credential was deleted');
        await db.prepare('UPDATE subject_credentials SET last_used_at = ? WHERE owner = ? AND subject = ? AND provider = ?').run(iso(clock.now()), owner, subject, r.provider);
        const providerKey = r.spend_key || providerKeyFor(owner, subject);
        if (r.provider === 'node') return { providerKey, provider: 'node', subject, machine: r.machine, models: JSON.parse(r.models || '{}') };
        return { providerKey, provider: r.provider, subject, base_url: r.base_url || PROVIDER_BASE_URL[r.provider] || null, apiKey: await openRow(r), models: JSON.parse(r.models || '{}') };
    }

    return { put, get, remove, admit, forRun, spentToday, providerKeyFor };
}

/** PUT/GET/DELETE /api/v1/credentials/:subject[/:provider] (ai.credential.manage; a service token speaks for itself). */
function credentialsRouter({ credentials, auth, registry, sendError }) {
    const r = express.Router();
    const guard = auth.requireCap('ai.credential.manage');
    const owner = (req) => {
        const s = req.principal && req.principal.subject;
        if (!s || s.type !== 'service') throw new AiError(403, 'capability.denied', 'only a service stores credentials for the people it serves');
        return s.id;
    };
    const audit = async (req, action, out) => registry.audit(req.principal.sub, action, 'credential', `${out.owner}:${out.subject}:${out.provider}`, { trace: req.ov && req.ov.traceId, metadata: { provider: out.provider, base_url: out.base_url } });
    r.put('/api/v1/credentials/:subject', guard, async (req, res) => {
        try {
            const out = await credentials.put(owner(req), req.params.subject, req.body || {});
            await audit(req, 'credential.put', out);
            res.set('Cache-Control', 'no-store').json(out);
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.put('/api/v1/credentials/:subject/:provider', guard, async (req, res) => {
        try {
            const body = { ...(req.body || {}), ...(req.body && req.body.provider == null ? { provider: req.params.provider } : {}) };
            const out = await credentials.put(owner(req), req.params.subject, body, req.params.provider);
            await audit(req, 'credential.put', out);
            res.set('Cache-Control', 'no-store').json(out);
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.get('/api/v1/credentials/:subject', guard, async (req, res) => {
        try { res.set('Cache-Control', 'no-store').json(await credentials.get(owner(req), req.params.subject)); } catch (err) { sendError(res, err, req.ov); }
    });
    r.get('/api/v1/credentials/:subject/:provider', guard, async (req, res) => {
        try { res.set('Cache-Control', 'no-store').json(await credentials.get(owner(req), req.params.subject, req.params.provider)); } catch (err) { sendError(res, err, req.ov); }
    });
    r.delete('/api/v1/credentials/:subject', guard, async (req, res) => {
        try {
            const o = owner(req);
            const gone = await credentials.remove(o, req.params.subject);
            if (gone) await registry.audit(req.principal.sub, 'credential.delete', 'credential', `${o}:${req.params.subject}`, { trace: req.ov && req.ov.traceId });
            res.status(gone ? 204 : 404).end();
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.delete('/api/v1/credentials/:subject/:provider', guard, async (req, res) => {
        try {
            const o = owner(req);
            const gone = await credentials.remove(o, req.params.subject, req.params.provider);
            if (gone) await registry.audit(req.principal.sub, 'credential.delete', 'credential', `${o}:${req.params.subject}:${req.params.provider}`, { trace: req.ov && req.ov.traceId });
            res.status(gone ? 204 : 404).end();
        } catch (err) { sendError(res, err, req.ov); }
    });
    return r;
}

module.exports = { createCredentials, credentialsRouter, providerKeyFor, aadFor, PROVIDERS, PROVIDER_BASE_URL };
