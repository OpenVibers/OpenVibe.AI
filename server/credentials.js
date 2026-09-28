'use strict';
/**
 * A person's own provider key (roadmap WS-O task 2; Contracts 0.73.0 ai.credential.manage, ai.credential-put@1,
 * ai.credential@1). The service that holds the person's consent (Live, for a streamer's AI viewers) stores the
 * key here; it never leaves OpenVibe.AI again. Runs that name the credential (ai.run-request credential { subject })
 * call that provider with that key only (server/providers/index.js executeWithCredential), never a shared key.
 *
 *   PUT    /api/v1/credentials/:subject    store or replace (the storing service is the owner)
 *   GET    /api/v1/credentials/:subject    read it back without the key: a four-character hint, today's spend
 *   DELETE /api/v1/credentials/:subject
 *
 * At rest the key is AES-256-GCM encrypted with AI_CREDENTIALS_KEY (64 hex characters), bound to its owner and
 * subject (the additional data), so a row copied to another owner or subject does not decrypt. Without the key
 * configured the routes answer 503 and credentialed runs are refused. Spend is what the credential's requests
 * cost today (provider_key byo:<owner>:<subject>), checked against the optional budget_usd_per_day.
 */
const crypto = require('crypto');
const express = require('express');
const { validate } = require('openvibe-contracts');
const { AiError } = require('./util');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function providerKeyFor(owner, subject) { return `byo:${owner}:${subject}`; }

function createCredentials({ db, config, clock = { now: () => Date.now() } }) {
    db.exec(`CREATE TABLE IF NOT EXISTS subject_credentials (
        owner          TEXT NOT NULL,
        subject        TEXT NOT NULL,
        provider       TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
        base_url       TEXT,
        key_enc        TEXT NOT NULL,
        key_hint       TEXT NOT NULL,
        models         TEXT NOT NULL DEFAULT '{}',
        budget_usd_day REAL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        last_used_at   TEXT,
        PRIMARY KEY (owner, subject)
    )`);
    const iso = (ms) => new Date(ms).toISOString();

    function secretKey() {
        const hex = String(config.credentialsKey || '');
        if (!/^[0-9a-f]{64}$/i.test(hex)) throw new AiError(503, 'credentials.unavailable', 'person credentials are not configured on this service (AI_CREDENTIALS_KEY)');
        return Buffer.from(hex, 'hex');
    }
    function seal(plain, aad) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
        c.setAAD(Buffer.from(aad));
        const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
        return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
    }
    function open(sealed, aad) {
        const [v, iv, tag, body] = String(sealed).split(':');
        if (v !== 'v1') throw new Error('unknown credential format');
        const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
        d.setAAD(Buffer.from(aad));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
    }

    function spentToday(owner, subject) {
        const day = iso(clock.now()).slice(0, 10);
        const r = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM requests WHERE provider_key = ? AND status = 'ok' AND created_at >= ?").get(providerKeyFor(owner, subject), `${day}T00:00:00.000Z`);
        return r ? Number(r.c) || 0 : 0;
    }

    function view(row) {
        return {
            subject: row.subject, owner: row.owner, provider: row.provider, base_url: row.base_url || null, key_hint: row.key_hint,
            models: JSON.parse(row.models || '{}'), budget_usd_per_day: row.budget_usd_day == null ? null : row.budget_usd_day,
            spent_usd_today: Math.round(spentToday(row.owner, row.subject) * 1e6) / 1e6,
            created_at: row.created_at, updated_at: row.updated_at, last_used_at: row.last_used_at || null,
        };
    }
    const row = (owner, subject) => db.prepare('SELECT * FROM subject_credentials WHERE owner = ? AND subject = ?').get(owner, subject);

    function put(owner, subject, body) {
        if (!SUBJECT_RE.test(String(subject))) throw new AiError(400, 'input.invalid', 'subject must be a usr_ subject');
        const v = validate('ai.credential-put@1', body);
        if (!v.valid) throw new AiError(422, 'input.invalid', 'body does not match ai.credential-put@1', { errors: v.errors });
        const at = iso(clock.now());
        const key = String(body.api_key);
        const prev = row(owner, subject);
        db.prepare(`INSERT INTO subject_credentials (owner, subject, provider, base_url, key_enc, key_hint, models, budget_usd_day, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(owner, subject) DO UPDATE SET provider = excluded.provider, base_url = excluded.base_url, key_enc = excluded.key_enc,
                      key_hint = excluded.key_hint, models = excluded.models, budget_usd_day = excluded.budget_usd_day, updated_at = excluded.updated_at`)
            .run(owner, subject, body.provider, body.base_url || null, seal(key, `${owner}|${subject}`), `…${key.slice(-4)}`, JSON.stringify(body.models || {}),
                body.budget_usd_per_day ? Number(body.budget_usd_per_day) : null, prev ? prev.created_at : at, at);
        return view(row(owner, subject));
    }

    function get(owner, subject) {
        const r = row(owner, subject);
        if (!r) throw new AiError(404, 'credential.not_found', 'no credential stored for that subject');
        return view(r);
    }

    function remove(owner, subject) {
        return db.prepare('DELETE FROM subject_credentials WHERE owner = ? AND subject = ?').run(owner, subject).changes > 0;
    }

    /** Checks a run may use the credential (exists, within budget); throws AiError otherwise. */
    function admit(owner, subject) {
        const r = row(owner, subject);
        if (!r) throw new AiError(404, 'credential.not_found', 'no credential stored for that subject');
        secretKey();
        if (r.budget_usd_day != null && r.budget_usd_day > 0 && spentToday(owner, subject) >= r.budget_usd_day) {
            const tomorrow = new Date(iso(clock.now()).slice(0, 10) + 'T00:00:00.000Z').getTime() + 86400000;
            throw new AiError(429, 'quota.exceeded', "this person's own daily budget for their key is spent", { retry_after_seconds: Math.max(60, Math.ceil((tomorrow - clock.now()) / 1000)), quota: { scope: 'credential' } });
        }
    }

    /** The decrypted credential for one execution: { providerKey, provider, base_url, apiKey, models }. */
    function forRun(owner, subject) {
        const r = row(owner, subject);
        if (!r) throw new AiError(404, 'credential.not_found', 'the credential was deleted');
        db.prepare('UPDATE subject_credentials SET last_used_at = ? WHERE owner = ? AND subject = ?').run(iso(clock.now()), owner, subject);
        return { providerKey: providerKeyFor(owner, subject), provider: r.provider, base_url: r.base_url || null, apiKey: open(r.key_enc, `${owner}|${subject}`), models: JSON.parse(r.models || '{}') };
    }

    return { put, get, remove, admit, forRun, spentToday, providerKeyFor };
}

/** PUT/GET/DELETE /api/v1/credentials/:subject (ai.credential.manage; a service token speaks for itself). */
function credentialsRouter({ credentials, auth, registry, sendError }) {
    const r = express.Router();
    const guard = auth.requireCap('ai.credential.manage');
    const owner = (req) => {
        const s = req.principal && req.principal.subject;
        if (!s || s.type !== 'service') throw new AiError(403, 'capability.denied', 'only a service stores credentials for the people it serves');
        return s.id;
    };
    r.put('/api/v1/credentials/:subject', guard, (req, res) => {
        try {
            const out = credentials.put(owner(req), req.params.subject, req.body || {});
            registry.audit(req.principal.sub, 'credential.put', 'credential', `${out.owner}:${out.subject}`, { trace: req.ov && req.ov.traceId, metadata: { provider: out.provider, base_url: out.base_url } });
            res.set('Cache-Control', 'no-store').json(out);
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.get('/api/v1/credentials/:subject', guard, (req, res) => {
        try { res.set('Cache-Control', 'no-store').json(credentials.get(owner(req), req.params.subject)); } catch (err) { sendError(res, err, req.ov); }
    });
    r.delete('/api/v1/credentials/:subject', guard, (req, res) => {
        try {
            const o = owner(req);
            const gone = credentials.remove(o, req.params.subject);
            if (gone) registry.audit(req.principal.sub, 'credential.delete', 'credential', `${o}:${req.params.subject}`, { trace: req.ov && req.ov.traceId });
            res.status(gone ? 204 : 404).end();
        } catch (err) { sendError(res, err, req.ov); }
    });
    return r;
}

module.exports = { createCredentials, credentialsRouter, providerKeyFor };
