'use strict';
/**
 * A person's own provider key (roadmap WS-O task 2; L36 Y1/Y8; Contracts ai.credential.manage,
 * ai.credential-put@2 and ai.credential@2 since Codes C3, and ai.me.* since L36).
 *
 * A service that holds the person's consent (Live for a streamer's AI viewers, Codes for the people it builds for)
 * stores the key here and never sees it again. A run that names the credential (ai.run-request credential
 * { subject, provider? }) calls that provider with that key only (server/providers/index.js
 * executeWithCredential), never a shared key.
 *
 *   PUT    /api/v1/credentials/:subject             store the DEFAULT provider's credential (the v1 route)
 *   PUT    /api/v1/credentials/:subject/:provider   store that provider's credential
 *   GET    /api/v1/credentials/:subject[/:provider] read it back without the key
 *   DELETE /api/v1/credentials/:subject[/:provider]
 *
 * The person's own routes (L36 Y1) store keys the person holds themselves under the reserved owner `self`:
 *
 *   GET    /api/v1/me/credentials
 *   PUT    /api/v1/me/credentials/:provider
 *   DELETE /api/v1/me/credentials/:provider
 *   POST   /api/v1/me/credentials/:provider/test
 *
 * A person may keep one credential per provider (the console presets: anthropic, openai, gemini, deepseek, mistral,
 * xai, groq, cerebras, together, fireworks, openrouter, minimax and a custom endpoint; plus node for the old routes),
 * each with its own daily budget. The provider-less routes read and write the default one, which is the row a pre-C3
 * caller stored (migrations/0014).
 *
 * At rest the key is AES-256-GCM encrypted with AI_CREDENTIALS_KEY (64 hex characters) and bound to its owner, subject
 * AND provider (the additional data), so a row copied to another owner, subject or provider does not decrypt. The
 * person's own rows use the reserved owner `self` and the same scheme (`self|subject|provider`). Rows written before
 * the provider dimension were sealed with owner|subject only (`v1:`); they are read with that AAD and rewritten as
 * `v2:` (owner|subject|provider) on first use. Without the key configured the routes answer 503 and credentialed runs
 * are refused. Spend is what the credential's requests cost today (provider_key byo:<owner>:<subject> for a row
 * stored before C3 or through the provider-less route, byo:<owner>:<subject>:<provider> for the rest), checked against
 * the optional budget_usd_per_day. A person's own key is never billed: its runs carry no network budget.
 *
 * Test on save (L36 Y1): list the provider's models and count them; if it lists none, one token to its cheapest model;
 * store status, checked_at, models_count and a redacted last_error. The key is never returned, never logged and never
 * put in an error, even when the provider echoes it.
 *
 * Provider node (contracts 0.220.0) is the person's own machine instead: `machine` names it, there is no key (nothing
 * is sealed, no hint), and a run reaches it only through OpenVibe.Bot (server/machines.js), for that person only.
 */
const crypto = require('crypto');
const express = require('express');
const contracts = require('openvibe-contracts');
const { validate } = contracts;

/**
 * ai.me-* are added by openvibe-contracts 0.257.0. A service pinning an older release (until the owner tags it) has no
 * schema for them, so the route validates the essential shape itself; with 0.257.0 or later the contract is the rule.
 */
function validateMe(id, body) {
    try { return contracts.schema(id) ? contracts.validate(id, body) : null; } catch { return null; }
}
function manualMePut(provider, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
    if (body.provider !== provider) return `body.provider is ${body.provider}, the route names ${provider}`;
    if (body.key != null && (typeof body.key !== 'string' || body.key.length < 8 || body.key.length > 400)) return 'key must be 8-400 characters';
    if (body.base_url != null && !/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(String(body.base_url))) return 'base_url must be an https URL without credentials, query or fragment';
    if (provider === 'custom' && !body.base_url) return 'a custom provider needs base_url';
    if (body.models != null && (typeof body.models !== 'object' || Array.isArray(body.models))) return 'models must be an object';
    if (body.budget_usd_per_day != null && !(Number(body.budget_usd_per_day) >= 0 && Number(body.budget_usd_per_day) <= 1000)) return 'budget_usd_per_day must be 0-1000';
    return null;
}
const { AiError } = require('./util');
const { CREDENTIAL_PROVIDERS, credentialProvider } = require('./console/presets');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
/** The reserved owner of a key the person holds themselves (L36 Y1). */
const SELF_OWNER = 'self';
const LEGACY_PROVIDERS = ['openai', 'anthropic', 'node', 'deepseek', 'minimax', 'openrouter', 'custom'];
const PROVIDERS = [...new Set([...LEGACY_PROVIDERS, ...CREDENTIAL_PROVIDERS])];
/** Where each provider answers when the person stored no base_url: the ONE table in server/console/presets.js. */
const PROVIDER_BASE_URL = Object.fromEntries(CREDENTIAL_PROVIDERS
    .map((id) => [id, (credentialProvider(id) || {}).base_url || null])
    .filter(([, url]) => url));
const PROVIDER_KIND = Object.fromEntries(CREDENTIAL_PROVIDERS.map((id) => [id, (credentialProvider(id) || {}).kind || 'openai']));
/** The model a provider's test uses when it lists no models (and a saved key names none). */
const DEFAULT_MODEL = {
    anthropic: 'claude-haiku-5-5', openai: 'gpt-4o-mini', gemini: 'gemini-2.5-flash', deepseek: 'deepseek-chat',
    mistral: 'mistral-small-latest', xai: 'grok-4-fast', groq: 'openai/gpt-oss-20b', cerebras: 'llama-3.3-70b',
    together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    openrouter: 'openrouter/auto', minimax: 'MiniMax-M2', custom: null,
};
/** Providers that report a balance somewhere public (L36 Y1 "its balance where the provider reports one"). */
const BALANCE_PROVIDERS = new Set(['openrouter', 'deepseek']);

function providerKeyFor(owner, subject, provider = null) { return provider ? `byo:${owner}:${subject}:${provider}` : `byo:${owner}:${subject}`; }
/** The AAD a key is sealed with: moving the row to another owner, subject or provider must not decrypt it. */
function aadFor(owner, subject, provider) { return `${owner}|${subject}|${provider}`; }
function legacyAadFor(owner, subject) { return `${owner}|${subject}`; }
const hintOf = (key) => `…${String(key).slice(-4)}`;

/** Replace the key (and anything that looks like one) before an upstream error is stored, logged or answered. */
function scrub(text, key) {
    let t = String(text == null ? '' : text);
    if (key) t = t.split(String(key)).join('[redacted]');
    return t.replace(/\b(sk|key|token)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]').slice(0, 500);
}

/** A provider's auth headers, the same way its adapter sends them (server/providers/anthropic.js). */
function authHeaders(provider, base, key) {
    if (PROVIDER_KIND[provider] === 'anthropic') {
        const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
        if (!/anthropic\.com/i.test(String(base || ''))) headers.Authorization = `Bearer ${key}`;
        return headers;
    }
    return { Authorization: `Bearer ${key}` };
}

function withDeadline(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(message || `no response within ${Math.round(ms / 1000)}s`), { code: 'provider.timeout' })), ms);
        if (timer.unref) timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function bodyText(res) {
    try { return await res.text(); } catch { return ''; }
}

function modelIds(json) {
    const list = Array.isArray(json) ? json
        : json && Array.isArray(json.data) ? json.data
            : json && Array.isArray(json.models) ? json.models : [];
    const out = [];
    for (const m of list) {
        const id = typeof m === 'string' ? m : m && (m.id || m.name);
        if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
    }
    return out;
}

/** { amount, currency } when the provider reports one, else null. A balance failure never fails the key test. */
async function balanceOf(provider, base, key, fetchImpl, timeoutMs) {
    if (!BALANCE_PROVIDERS.has(provider)) return null;
    try {
        const url = provider === 'openrouter'
            ? `${String(base).replace(/\/+$/, '')}/credits`
            : `${new URL(base).origin}/user/balance`;
        const res = await withDeadline(fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', ...authHeaders(provider, base, key) }, signal: AbortSignal.timeout(timeoutMs) }), timeoutMs);
        if (!res.ok) return null;
        const j = await res.json().catch(() => null);
        if (!j) return null;
        if (provider === 'openrouter') {
            const d = j.data || j;
            const amount = Number(d.total_credits) - Number(d.total_usage);
            return Number.isFinite(amount) ? { amount: Math.round(amount * 1e6) / 1e6, currency: 'USD' } : null;
        }
        const info = Array.isArray(j.balance_infos) ? j.balance_infos[0] : null;
        const amount = Number(info && info.total_balance);
        return Number.isFinite(amount) ? { amount, currency: String((info && info.currency) || 'USD').toUpperCase().slice(0, 3) } : null;
    } catch { return null; }
}

function createCredentials({ db, config, clock = { now: () => Date.now() }, fetchImpl = null, grants = null }) {
    // subject_credentials is in migrations/0001_initial.sql (ADR-035); 0011 added the node machine, 0014 the provider
    // dimension (is_default, spend_key, one row per provider), 0019 the health of a key.
    const iso = (ms) => new Date(ms).toISOString();
    const doFetch = fetchImpl || require('./providers/guarded-fetch').guardedFetch;
    const testTimeout = () => Number(config.credentialTestTimeoutMs) || 10000;

    function secretKey() {
        const hex = String(config.credentialsKey || '');
        if (!/^[0-9a-f]{64}$/i.test(hex)) throw new AiError(503, 'credentials.unavailable', 'person credentials are not configured on this service (AI_CREDENTIALS_KEY)');
        return Buffer.from(hex, 'hex');
    }
    /** v2: bound to owner, subject and provider (Codes C3; `self` for the person's own rows, L36). */
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
    /** The person's own view (ai.me-credential@1): no owner/subject/spend, no key, a four-character hint. */
    function selfView(row) {
        return {
            provider: row.provider, hint: String(row.key_hint || '').slice(-4) || '????',
            base_url: row.base_url || null,
            budget_usd_per_day: row.budget_usd_day == null ? null : row.budget_usd_day,
            status: row.status || 'untested', checked_at: row.checked_at || null, last_error: row.last_error || null,
            models_count: Number(row.models_count) || 0,
            created_at: row.created_at, updated_at: row.updated_at,
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
            .run(owner, subject, body.provider, body.base_url || null, seal(key, aadFor(owner, subject, body.provider)), hintOf(key), JSON.stringify(body.models || {}),
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

    /**
     * Where the person allows this service to use their own key (plan L55 C3). The detail is meant to be shown to
     * the person: it names the page and carries the two values the page needs.
     */
    function allowHint(service, provider) {
        const base = String(config.baseUrl || 'https://ai.openvibe.services').replace(/\/+$/, '');
        const q = new URLSearchParams({ allow: String(service || ''), provider: String(provider || '') });
        return `allow ${service} to use your ${provider} key at ${base}/you?${q.toString()}`;
    }

    /**
     * The row a run may use for a person (plan L55 C3): the service's own row, or — when the person allowed this
     * service for that provider — the person's own key. The consent is the person's, and it is checked here, once,
     * where the key is chosen.
     */
    async function resolveForRun(owner, subject, provider = null) {
        const own = await getRow(owner, subject, provider);
        if (own) return { row: own, own: true };
        if (!grants || provider === null) return { row: null, own: false };
        const self = await getRow(SELF_OWNER, subject, provider);
        if (!self) return { row: null, own: false };
        if (!await grants.allows(subject, owner, provider)) return { row: null, own: false, refused: true };
        return { row: self, own: false };
    }

    /** Checks a run may use the credential (exists, within budget); throws AiError otherwise. */
    async function admit(owner, subject, provider = null) {
        if (provider !== null && !PROVIDERS.includes(provider)) throw new AiError(404, 'credential.not_found', 'no credential stored for that provider');
        const found = await resolveForRun(owner, subject, provider);
        const r = found.row;
        if (!r) {
            // The person holds the key, but this service is not allowed to use it (L55 C3): say where to allow it.
            if (found.refused) throw new AiError(403, 'ai.credential_not_allowed', allowHint(owner, provider));
            throw new AiError(404, 'credential.not_found', provider ? `no ${provider} credential stored for that subject` : 'no credential stored for that subject');
        }
        if (r.provider === 'node') return;   // the person's own machine: no key, no spend
        secretKey();
        if (r.budget_usd_day != null && r.budget_usd_day > 0 && await spentToday(r) >= r.budget_usd_day) {
            const tomorrow = new Date(iso(clock.now()).slice(0, 10) + 'T00:00:00.000Z').getTime() + 86400000;
            throw new AiError(429, 'quota.exceeded', "this person's own daily budget for their key is spent", { retry_after_seconds: Math.max(60, Math.ceil((tomorrow - clock.now()) / 1000)), quota: { scope: 'credential' } });
        }
    }

    /** The decrypted credential for one execution: { providerKey, owner, provider, base_url, apiKey|machine, models, hint }. */
    async function forRun(owner, subject, provider = null) {
        if (provider !== null && !PROVIDERS.includes(provider)) throw new AiError(404, 'credential.not_found', 'no credential stored for that provider');
        let r = await getRow(owner, subject, provider);
        if (!r && provider !== null) {
            // The service holds no credential of its own: the person's own key, if they allowed this service (L55 C3).
            const found = await resolveForRun(owner, subject, provider);
            if (found.row) {
                const self = await selfForRun(subject, provider);
                if (self) return self;
            } else if (found.refused) {
                throw new AiError(403, 'ai.credential_not_allowed', allowHint(owner, provider));
            }
        }
        if (!r) throw new AiError(404, 'credential.not_found', provider ? `the ${provider} credential was deleted` : 'the credential was deleted');
        await db.prepare('UPDATE subject_credentials SET last_used_at = ? WHERE owner = ? AND subject = ? AND provider = ?').run(iso(clock.now()), owner, subject, r.provider);
        const providerKey = r.spend_key || providerKeyFor(owner, subject);
        const hint = String(r.key_hint || '').slice(-4);
        if (r.provider === 'node') return { providerKey, owner: r.owner, subject, provider: 'node', machine: r.machine, models: JSON.parse(r.models || '{}'), hint };
        return { providerKey, owner: r.owner, subject, provider: r.provider, base_url: r.base_url || PROVIDER_BASE_URL[r.provider] || null, apiKey: await openRow(r), models: JSON.parse(r.models || '{}'), hint };
    }

    // ── The person's own keys (owner `self`, L36 Y1) ───────────────────────

    /** Every self row for one person, newest first. */
    async function selfRows(subject) {
        if (!SUBJECT_RE.test(String(subject))) return [];
        return await db.prepare("SELECT * FROM subject_credentials WHERE owner = ? AND subject = ? AND provider <> 'node' ORDER BY provider").all(SELF_OWNER, subject);
    }
    async function listSelf(subject) {
        return (await selfRows(subject)).map(selfView);
    }
    async function hasSelf(subject) {
        return (await selfRows(subject)).length > 0;
    }

    /** A person's own credential for one provider (no key returned to the caller; server-side use only). */
    async function selfForRun(subject, provider) {
        if (!CREDENTIAL_PROVIDERS.includes(provider)) return null;
        const r = await getRow(SELF_OWNER, subject, provider);
        if (!r) return null;
        await db.prepare('UPDATE subject_credentials SET last_used_at = ? WHERE owner = ? AND subject = ? AND provider = ?').run(iso(clock.now()), SELF_OWNER, subject, provider);
        return {
            providerKey: r.spend_key || providerKeyFor(SELF_OWNER, subject, provider), owner: SELF_OWNER, subject,
            provider: r.provider, base_url: r.base_url || PROVIDER_BASE_URL[r.provider] || null,
            apiKey: await openRow(r), models: JSON.parse(r.models || '{}'), hint: String(r.key_hint || '').slice(-4), status: r.status,
        };
    }
    /** Every self credential a run may try first (L36 Y6). A row whose key cannot be opened is skipped, never fatal. */
    async function selfForAllRuns(subject) {
        const out = [];
        for (const r of await selfRows(subject)) {
            try {
                const cred = await selfForRun(subject, r.provider);
                if (cred) out.push(cred);
            } catch { /* a broken row must not take the person's other keys with it */ }
        }
        return out;
    }

    /** The person's own PUT: store or replace one provider's key, then test it on save. */
    async function putSelf(subject, provider, body) {
        if (!SUBJECT_RE.test(String(subject))) throw new AiError(400, 'input.invalid', 'subject must be a usr_ subject');
        if (!CREDENTIAL_PROVIDERS.includes(provider)) throw new AiError(404, 'credential.not_found', `no credential is stored for ${provider}`);
        const v = validateMe('ai.me-credential-put@1', body);
        const manual = v ? null : manualMePut(provider, body);
        if ((v && !v.valid) || manual) throw new AiError(422, 'input.invalid', 'body does not match ai.me-credential-put@1', { errors: v ? v.errors : [{ path: '', message: manual }] });
        if (body.provider !== provider) throw new AiError(422, 'input.invalid', `body.provider is ${body.provider}, the route names ${provider}`);
        const prev = await getRow(SELF_OWNER, subject, provider);
        const at = iso(clock.now());
        const sameEndpoint = prev && (prev.base_url || null) === (body.base_url || null);
        if (body.key == null && !sameEndpoint) throw new AiError(400, 'credential.key_required', prev ? 'enter the key again to change the endpoint' : 'key is required the first time');
        const key = body.key != null ? String(body.key) : await openRow(prev);
        await db.prepare(`INSERT INTO subject_credentials (owner, subject, provider, base_url, key_enc, key_hint, models, budget_usd_day, is_default, spend_key, status, checked_at, last_error, models_count, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, false, ?, 'untested', NULL, NULL, 0, ?, ?)
                    ON CONFLICT(owner, subject, provider) DO UPDATE SET base_url = excluded.base_url, key_enc = excluded.key_enc,
                      key_hint = excluded.key_hint, models = excluded.models, budget_usd_day = excluded.budget_usd_day,
                      status = 'untested', checked_at = NULL, last_error = NULL, models_count = 0, updated_at = excluded.updated_at`)
            .run(SELF_OWNER, subject, provider, body.base_url || null, seal(key, aadFor(SELF_OWNER, subject, provider)), hintOf(key),
                JSON.stringify(body.models || {}), body.budget_usd_per_day ? Number(body.budget_usd_per_day) : null,
                providerKeyFor(SELF_OWNER, subject, provider), prev ? prev.created_at : at, at);
        await testSelf(subject, provider);
        return selfView(await getRow(SELF_OWNER, subject, provider));
    }

    async function removeSelf(subject, provider) {
        if (!CREDENTIAL_PROVIDERS.includes(provider)) return false;
        return (await db.prepare('DELETE FROM subject_credentials WHERE owner = ? AND subject = ? AND provider = ?').run(SELF_OWNER, subject, provider)).changes > 0;
    }

    /** Mark a key failing (a provider 401/403 in a run, L36 Y8). Never stores the key. */
    async function markFailed(owner, subject, provider, message) {
        if (!owner || !SUBJECT_RE.test(String(subject)) || !PROVIDERS.includes(provider)) return false;
        const at = iso(clock.now());
        return (await db.prepare('UPDATE subject_credentials SET status = ?, checked_at = ?, last_error = ? WHERE owner = ? AND subject = ? AND provider = ?')
            .run('failing', at, String(message || 'the provider refused the key').slice(0, 500), owner, subject, provider)).changes > 0;
    }

    /**
     * Test one stored key (L36 Y1): the model list, else one token to its cheapest model, within testTimeout().
     * Stores status, checked_at, models_count and a redacted last_error, and returns the ai.me-credential-test@1 body.
     * For a custom (or overridden) endpoint the production fetch is the guarded fetcher, so the egress rules hold.
     */
    async function testSelf(subject, provider) {
        if (!CREDENTIAL_PROVIDERS.includes(provider)) throw new AiError(404, 'credential.not_found', `no credential is stored for ${provider}`);
        const row = await getRow(SELF_OWNER, subject, provider);
        if (!row) throw new AiError(404, 'credential.not_found', `no ${provider} credential stored`);
        const key = await openRow(row);
        const spec = credentialProvider(provider) || {};
        const base = String(row.base_url || PROVIDER_BASE_URL[provider] || '').replace(/\/+$/, '');
        const timeoutMs = testTimeout();
        const started = Date.now();
        let models = [];
        let status = 'ok';
        let error = null;
        let balance = null;
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders(provider, base, key) };
        if (!base) {
            status = 'failing';
            error = { code: 'credential.endpoint_required', message: 'this provider needs a base URL' };
        } else {
            try {
                const res = await withDeadline(doFetch(`${base}/models`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) }), timeoutMs);
                if (res.ok) {
                    models = modelIds(await res.json().catch(() => null));
                } else if (res.status === 401 || res.status === 403) {
                    throw Object.assign(new Error(`the provider refused the key (${res.status})`), { status: res.status, code: 'provider.auth' });
                } else {
                    // A provider with no /models endpoint is not a failed key: try the one-token call below.
                    models = [];
                }
            } catch (err) {
                if (err && (err.status === 401 || err.status === 403)) {
                    status = 'failing';
                    error = { code: 'provider.auth', message: scrub(err.message, key) };
                } else if (err && err.code === 'provider.timeout') {
                    status = 'failing';
                    error = { code: 'provider.timeout', message: scrub(err.message, key) };
                } else if (err && err.code === 'EADDRNOTPUBLIC') {
                    // The guarded fetcher's egress rule (https, public address, no credentials in the URL) refused the
                    // endpoint: that is a bad endpoint, not a provider without a model list.
                    status = 'failing';
                    error = { code: 'credential.endpoint_refused', message: scrub(err.message, key) };
                } else {
                    models = [];   // no list: the one-token request decides
                }
            }
            if (!error && !models.length) {
                const model = (JSON.parse(row.models || '{}').chat) || spec.model || DEFAULT_MODEL[provider];
                try {
                    if (!model) throw Object.assign(new Error('no model is known for this provider'), { code: 'credential.no_model' });
                    const url = PROVIDER_KIND[provider] === 'anthropic' ? `${base}/messages` : `${base}/chat/completions`;
                    const body = PROVIDER_KIND[provider] === 'anthropic'
                        ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
                        : { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
                    const res = await withDeadline(doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }), timeoutMs);
                    if (!res.ok) {
                        const text = await bodyText(res);
                        const auth = res.status === 401 || res.status === 403;
                        throw Object.assign(new Error(`${auth ? 'the provider refused the key' : 'the provider did not answer the test request'} (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`), { status: res.status, code: auth ? 'provider.auth' : 'provider.http' });
                    }
                } catch (err) {
                    status = 'failing';
                    error = {
                        code: err.status === 401 || err.status === 403 ? 'provider.auth'
                            : err.code === 'provider.timeout' ? 'provider.timeout'
                                : err.code === 'EADDRNOTPUBLIC' ? 'credential.endpoint_refused' : 'provider.http',
                        message: scrub(err.message, key),
                    };
                }
            }
            if (!error) balance = await balanceOf(provider, base, key, doFetch, timeoutMs);
        }
        const checkedAt = iso(clock.now());
        await db.prepare('UPDATE subject_credentials SET status = ?, checked_at = ?, last_error = ?, models_count = ? WHERE owner = ? AND subject = ? AND provider = ?')
            .run(status, checkedAt, error ? error.message : null, models.length, SELF_OWNER, subject, provider);
        return {
            ok: status === 'ok', models_count: models.length, sample_models: models.slice(0, 5),
            latency_ms: Math.max(0, Date.now() - started), balance, error,
        };
    }

    /**
     * The providers a person allowed this service for, that they also hold a key for. Names only: no key, no hint,
     * no count (plan L55 C3).
     */
    async function allowedProvidersWithKey(subject, service) {
        if (!grants) return [];
        const allowed = await grants.allowedProviders(subject, service);
        if (!allowed.length) return [];
        const have = new Set((await selfRows(subject)).map((r) => r.provider));
        if (allowed.includes('*')) return [...have].sort();
        return allowed.filter((p) => have.has(p)).sort();
    }

    /**
     * Did this run use the person's own key with the person's consent (plan L55 C3)? { service, subject,
     * provider } when it did, null when the service used a credential of its own (nothing to consent to) or when the
     * person did not allow it.
     */
    async function consentUse(owner, subject, provider) {
        if (!grants || !provider) return null;
        if (await getRow(owner, subject, provider)) return null;
        if (!await getRow(SELF_OWNER, subject, provider)) return null;
        return (await grants.allows(subject, owner, provider)) ? { service: owner, subject, provider } : null;
    }

    return {
        put, get, remove, admit, forRun, spentToday, providerKeyFor,
        listSelf, hasSelf, selfForRun, selfForAllRuns, putSelf, removeSelf, testSelf, markFailed,
        allowedProvidersWithKey, consentUse,
    };
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
    /**
     * GET /api/v1/allowed-keys/:subject (ai.run.create): which providers this person allowed THIS service to use
     * their own key for, and that they hold a key for. Names only, never key material. A person who did not allow
     * this service gets nothing at all: 404, and no word about their keys.
     */
    const runGuard = auth.requireCap('ai.run.create');
    r.get('/api/v1/allowed-keys/:subject', runGuard, async (req, res) => {
        try {
            const o = owner(req);
            const subject = String(req.params.subject || '');
            if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject)) throw new AiError(404, 'credential.not_found', 'no keys are available to this service for that person');
            const providers = await credentials.allowedProvidersWithKey(subject, o);
            if (!providers.length) throw new AiError(404, 'credential.not_found', 'no keys are available to this service for that person');
            res.set('Cache-Control', 'no-store').json({ subject, service: o, providers });
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

module.exports = {
    createCredentials, credentialsRouter, providerKeyFor, aadFor, PROVIDERS, PROVIDER_BASE_URL, PROVIDER_KIND,
    CREDENTIAL_PROVIDERS, SELF_OWNER, DEFAULT_MODEL, scrub, hintOf,
};
