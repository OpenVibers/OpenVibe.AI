'use strict';
/**
 * Plan E5: abuse prevention for the free tier (OpenVibe.AI's server; the Exchange is the service token `exchange`).
 *
 * The pieces, each with its own seam in this module:
 *
 *   trust       server/abuse/trust.js       Network's signals decide the daily free allowance: a quarter for a
 *                                           new account, half after 7 days, the full one when verified, plus kudos
 *   network     server/abuse/asn.js         a client address becomes an ASN and a salted /24 or /48 hash; a hosting
 *                                           ASN gets the new tier and a lower rate. The address is never stored
 *   device      this module                 a signed, HttpOnly device cookie (or a first-party service forwarding
 *                                           it); more than three accounts on one device share one allowance
 *   proof       server/abuse/pow.js         an in-house hashcash challenge for the anonymous Try it, single use
 *   anomaly     this module                 free tokens per minute against the last week's baseline, per ASN,
 *                                           device and input bucket; above it a 429 and an operator event
 *
 * What is stored (migrations/0034_abuse.sql, docs/abuse-prevention.md): keyed hashes of the device id and the
 * /24–/48 prefix, the ASN, token counters and the challenge hash. No raw address, no raw device id, no prompt.
 * The prefix row lives 24 h; velocity rows are kept for the 7-day baseline; daily counters are per UTC day.
 */
const crypto = require('crypto');
const net = require('net');
const express = require('express');
const { AiError, iso, parseJson, sendError } = require('../util');
const trust = require('./trust');
const asnLib = require('./asn');
const { createNetworkSignals } = require('./network');
const { createPow } = require('./pow');

const USR = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const RING_CAP = 2000;
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;

function isLoopback(address) {
    const a = String(address || '');
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** The first address of an `x-forwarded-for`-shaped value (still never stored). */
function firstAddress(value) {
    const v = String(value || '').split(',')[0].trim();
    return net.isIP(v) ? v : null;
}

function cookiesOf(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const at = part.indexOf('=');
        if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
    }
    return out;
}

function createAbuse({ db, config, env = process.env, clock = { now: () => Date.now() }, log = console, registry = null, community = null, fetchImpl = globalThis.fetch, tokens = null } = {}) {
    const cfg = (config && config.abuse) || {};
    const enabled = cfg.enabled !== false;
    // A per-boot salt when the owner has not set one: hashes and device signatures then cannot be linked across
    // restarts (and a cookie issued by the previous boot is replaced), which is the safe default. Production should
    // set AI_ABUSE_SALT so signed device cookies survive a deploy.
    const salt = String(cfg.salt || '').trim() || crypto.randomBytes(32).toString('hex');
    if (enabled && !String(cfg.salt || '').trim() && config && config.isProduction) {
        log.warn('[abuse] AI_ABUSE_SALT is not set: hashes cannot be linked across restarts and device cookies are re-issued on deploy');
    }
    const keyed = (kind, value) => crypto.createHmac('sha256', salt).update(`${kind}:${value}`).digest('hex');
    const now = () => clock.now();
    const baseTokens = Math.max(0, Math.floor(Number(cfg.dailyTokens) || 0));
    const firstParty = new Set((cfg.firstPartyServices || ['exchange']).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
    const asn = asnLib.createAsnTable({
        v4File: cfg.ip2asnV4 || '', v6File: cfg.ip2asnV6 || '', hostingAsns: cfg.hostingAsns || [], log,
    });
    const signals = createNetworkSignals({ config, env, fetchImpl, clock, log, tokens });
    const pow = createPow({ db, clock, bits: cfg.powBits, ttlMs: cfg.powTtlMs, log });
    const cookieName = String(cfg.deviceCookieName || 'ovai_device').trim() || 'ovai_device';
    const cookieDomain = String(cfg.deviceCookieDomain || '').trim();
    const cookieSecure = cfg.deviceCookieSecure !== false;
    const cookieSameSite = cfg.deviceCookieSameSite || 'Lax';

    // ── Signed device ids ─────────────────────────────────
    function signDevice(id) {
        const body = Buffer.from(id, 'utf8').toString('base64url');
        return `d1.${body}.${keyed('device-sign', body).slice(0, 43)}`;
    }
    function verifyDevice(token) {
        const raw = String(token || '').trim();
        const m = /^d1\.([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{16,64})$/.exec(raw);
        if (!m) return null;
        const want = keyed('device-sign', m[1]).slice(0, 43);
        const have = m[2];
        if (have.length !== want.length) return null;
        try {
            if (!crypto.timingSafeEqual(Buffer.from(have), Buffer.from(want))) return null;
        } catch { return null; }
        let id;
        try { id = Buffer.from(m[1], 'base64url').toString('utf8'); } catch { return null; }
        return /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
    }
    function newDevice() {
        const id = crypto.randomBytes(18).toString('base64url');
        return { id, token: signDevice(id) };
    }
    function cookieHeader(token) {
        const parts = [`${cookieName}=${token}`, 'Path=/', 'HttpOnly', `SameSite=${cookieSameSite}`, `Max-Age=${COOKIE_MAX_AGE_S}`];
        if (cookieDomain) parts.push(`Domain=${cookieDomain}`);
        if (cookieSecure) parts.push('Secure');
        return parts.join('; ');
    }

    // ── Request metadata: no address is kept here, only what a trust decision needs ──
    const rate = new Map();      // key -> { minute, count }
    const throttleRing = [];     // { at, kind }

    function middleware() {
        return (req, res, next) => {
            try {
                const cookies = cookiesOf(req.headers.cookie);
                const forwarded = String(req.headers['x-ov-device-id'] || '').trim();
                let id = verifyDevice(forwarded) || verifyDevice(cookies[cookieName]);
                if (!id) {
                    const made = newDevice();
                    id = made.id;
                    // A Domain cookie is only valid from a host inside that domain: ai.openvibe.services must not
                    // try to set .openvibe.exchange. Elsewhere the request still gets a device for this call.
                    const host = String(req.hostname || '').toLowerCase();
                    const base = cookieDomain.replace(/^\./, '');
                    if (!base || host === base || host.endsWith(`.${base}`)) {
                        const prev = res.getHeader('Set-Cookie');
                        res.setHeader('Set-Cookie', prev ? [].concat(prev, cookieHeader(made.token)) : [cookieHeader(made.token)]);
                    }
                }
                req.abuse = {
                    deviceHash: keyed('device', id),
                    explicitIp: firstAddress(req.headers['x-ov-client-ip']),
                    reqIp: req.ip || null,
                    loopback: isLoopback(req.socket && req.socket.remoteAddress),
                    pow: String(req.headers['x-ov-pow'] || '').trim() || null,
                    at: now(),
                };
            } catch (err) {
                log.warn(`[abuse] request metadata: ${err && err.message}`);
                req.abuse = { at: now() };
            }
            return next();
        };
    }

    /** The address a trust decision may use: a first-party service's header, or the loopback proxy's own answer. */
    function clientIp(meta, principal) {
        if (!meta) return null;
        const service = principal && principal.subject && principal.subject.type === 'service' ? principal.subject.id : null;
        if (meta.explicitIp && service && firstParty.has(String(service).toLowerCase())) return meta.explicitIp;
        if (meta.loopback) return firstAddress(meta.reqIp);
        return null;
    }

    async function touchNetwork(prefixHash, info, at) {
        const ts = iso(at);
        await db.prepare(`INSERT INTO abuse_network_seen (prefix_hash, asn, hosting, first_seen, last_seen, expires_at)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (prefix_hash) DO UPDATE SET asn = excluded.asn, hosting = excluded.hosting,
            last_seen = excluded.last_seen, expires_at = excluded.expires_at`)
            .run(prefixHash, info.asn == null ? null : Number(info.asn), info.hosting ? 1 : 0, ts, ts, iso(at + DAY_MS));
        if (Math.random() < 0.01) await db.prepare('DELETE FROM abuse_network_seen WHERE expires_at < ?').run(ts).catch(() => {});
    }

    async function networkOf(meta, principal) {
        const ip = clientIp(meta, principal);
        if (!ip) return { asn: null, hosting: false, prefixHash: null, asnHash: null };
        const look = asn.lookup(ip);
        const prefix = asnLib.prefixOf(ip);
        const prefixHash = prefix ? keyed('prefix', prefix.prefix) : null;
        if (prefixHash) await touchNetwork(prefixHash, look, now());
        return {
            asn: look.asn == null ? null : Number(look.asn), hosting: Boolean(look.hosting), prefixHash,
            asnHash: look.asn == null ? (prefixHash ? keyed('asn', `unknown:${prefixHash}`) : null) : keyed('asn', String(look.asn)),
        };
    }

    async function touchDevice(deviceHash, subject, allowance, at) {
        if (!deviceHash || !subject) return;
        const ts = iso(at);
        await db.prepare(`INSERT INTO abuse_devices (device_hash, subject, tier_tokens, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT (device_hash, subject) DO UPDATE SET last_seen = excluded.last_seen,
            tier_tokens = COALESCE(excluded.tier_tokens, abuse_devices.tier_tokens)`)
            .run(deviceHash, subject, allowance == null ? null : Math.max(0, Math.floor(Number(allowance) || 0)), ts, ts);
        if (Math.random() < 0.01) await db.prepare('DELETE FROM abuse_devices WHERE last_seen < ?').run(iso(at - 180 * DAY_MS)).catch(() => {});
    }

    async function accountsOn(deviceHash) {
        const row = await db.prepare('SELECT COUNT(*) AS n, MIN(tier_tokens) AS cap FROM abuse_devices WHERE device_hash = ?').get(deviceHash);
        return { accounts: Number(row && row.n) || 0, cap: row && row.cap != null ? Number(row.cap) : null };
    }

    function countRate(key, limit, at) {
        if (!key) return true;
        const minute = Math.floor(at / MIN_MS);
        const hit = rate.get(key);
        if (!hit || hit.minute !== minute) {
            rate.set(key, { minute, count: 1 });
            if (rate.size > 20_000) for (const [k, v] of rate) if (v.minute < minute - 2) rate.delete(k);
            return true;
        }
        hit.count++;
        return hit.count <= limit;
    }

    function noteThrottle(kind, at) {
        throttleRing.push({ at, kind });
        while (throttleRing.length > RING_CAP) throttleRing.shift();
    }

    async function audit(action, { reason, kind = null, asn = null, hosting = false, tier = null, shared = false, accounts = null, trace = null } = {}) {
        noteThrottle(reason || action, now());
        if (!registry || typeof registry.audit !== 'function') return;
        try {
            await registry.audit('system', action, 'abuse', `${reason || action}${kind ? `:${kind}` : ''}`, {
                trace,
                metadata: { reason: reason || action, kind, asn, hosting: Boolean(hosting), tier, shared, accounts },
            });
        } catch (err) { log.warn(`[abuse] operator event not written: ${err && err.message}`); }
    }

    /** Free tokens in the current minute against the last week's per-minute baseline, per ASN, device and input. */
    async function velocityHit(keys, at) {
        const minute = Math.floor(at / MIN_MS);
        const since = minute - 7 * 24 * 60;
        const floor = Math.max(1, Math.floor(Number(cfg.velocityMinTokensPerMin) || 10_000));
        const factor = Math.max(1, Number(cfg.velocityFactor) || 10);
        for (const k of keys) {
            if (!k || !k.key) continue;
            const cur = await db.prepare('SELECT COALESCE(tokens, 0) AS tokens FROM abuse_velocity WHERE kind = ? AND key_hash = ? AND minute = ?').get(k.kind, k.key, minute);
            if (!cur || !Number(cur.tokens)) continue;
            const base = await db.prepare('SELECT COALESCE(SUM(tokens), 0) AS tokens FROM abuse_velocity WHERE kind = ? AND key_hash = ? AND minute >= ? AND minute < ?').get(k.kind, k.key, since, minute);
            const minutes = 7 * 24 * 60 - 1;
            const baseline = Number(base && base.tokens) / minutes;
            const limit = Math.max(floor, baseline * factor);
            if (Number(cur.tokens) >= limit) {
                return { kind: k.kind, tokens: Number(cur.tokens), baseline_per_minute: baseline, limit_per_minute: limit };
            }
        }
        return null;
    }

    /**
     * Admit a run: track the device, then (for a free run) decide the allowance, the rate, the proof of work and
     * the velocity. Returns the admission recorded on the run context, or null when the run pays its own way.
     *
     *   free       the run has no payer (ctx.freeUse)
     *   anonymous  the Exchange's anonymous Try it (no account, no Balance)
     */
    async function admit({ principal = null, ctx = {}, request = null, inputHash = null, free = false, anonymous = false, selfKeys = false } = {}) {
        if (!enabled) return null;
        const at = now();
        const meta = request || {};
        const subject = ctx.onBehalfOf && USR.test(String(ctx.onBehalfOf)) ? String(ctx.onBehalfOf)
            : (ctx.requesterType === 'user' && USR.test(String(ctx.requesterId || '')) ? String(ctx.requesterId) : null);
        const deviceHash = meta.deviceHash && /^[0-9a-f]{64}$/.test(String(meta.deviceHash)) ? String(meta.deviceHash) : null;
        // A device is remembered for every person's run, paid or free: the count is about accounts, not spend.
        if (deviceHash && subject) await touchDevice(deviceHash, subject, null, at);
        if (!free && !anonymous) return null;
        if (ctx.requesterType === 'app') return null;

        const network = await networkOf(meta, principal);
        let account = { available: false, reason: 'no account' };
        let kudos = 0;
        if (subject) {
            account = await signals.get(subject);
            if (community && typeof community.kudosBonus === 'function') {
                try { kudos = Math.max(0, Number(await community.kudosBonus(subject)) || 0); } catch { kudos = 0; }
            }
        }
        const tierInfo = trust.tierFor({ signals: account, kudos, hosting: network.hosting, base: baseTokens });
        if (deviceHash && subject) await touchDevice(deviceHash, subject, tierInfo.allowance, at);
        const onDevice = deviceHash ? await accountsOn(deviceHash) : { accounts: 0, cap: null };
        const shared = onDevice.accounts > 3;
        const allowance = shared ? Math.min(tierInfo.allowance, onDevice.cap == null ? tierInfo.allowance : onDevice.cap) : tierInfo.allowance;
        const key = shared ? `device:${deviceHash}` : (subject ? `user:${subject}` : `anon:${deviceHash || network.prefixHash || 'unknown'}`);
        const admission = {
            key, day: iso(at).slice(0, 10), subject, anonymous: Boolean(anonymous && !subject),
            allowance, tier: tierInfo.tier, tier_reasons: tierInfo.reasons, shared, accounts: onDevice.accounts,
            deviceHash, prefixHash: network.prefixHash, asn: network.asn, asnHash: network.asnHash,
            hosting: network.hosting, inputKey: inputHash ? keyed('input', String(inputHash)) : null,
            at,
        };
        // L36 Y1: a run that may use the person's own provider key must never be held by the free allowance. The
        // admission is still returned, so a fallback to free capacity is recorded; the read only skips the refusal.
        if (selfKeys) return { ...admission, exempt: 'own_key' };
        const rateKey = deviceHash ? `device:${deviceHash}` : (network.prefixHash ? `prefix:${network.prefixHash}` : `key:${key}`);
        const limit = trust.rateFor({ hosting: network.hosting, normal: cfg.ratePerMin, hostingRate: cfg.hostingRatePerMin });
        if (!countRate(rateKey, limit, at) || (network.asnHash && !countRate(`asn:${network.asnHash}`, limit, at))) {
            await audit('abuse.rate_limited', { reason: network.hosting ? 'hosting' : 'network', kind: 'rate', asn: network.asn, hosting: network.hosting, tier: admission.tier, shared, accounts: onDevice.accounts, trace: ctx.trace || null });
            throw new AiError(429, 'ai.rate_limited', 'Too many free requests from this network or device right now. Wait a minute and try again.', { retry_after_seconds: 60 });
        }

        if (admission.anonymous && cfg.powRequired) {
            if (!meta.pow) {
                throw new AiError(403, 'ai.pow_required', 'This Try it needs a small proof of work. Ask GET /api/v1/exchange/tryit/challenge for one first.');
            }
            const ok = await pow.verify(meta.pow, { deviceHash });
            if (!ok) throw new AiError(403, 'ai.pow_invalid', 'That proof of work is missing, used, expired or wrong. Ask for a new challenge.');
        }

        if (subject) {
            const used = await db.prepare('SELECT COALESCE(tokens, 0) AS tokens FROM abuse_daily_usage WHERE subject = ? AND day = ?').get(key, admission.day);
            const spent = Number(used && used.tokens) || 0;
            if (allowance <= 0 || spent >= allowance) {
                const next = Date.parse(`${admission.day}T00:00:00.000Z`) + DAY_MS;
                throw new AiError(402, 'ai.allowance_spent', allowance <= 0
                    ? 'The free AI allowance is switched off on this service.'
                    : `The free AI allowance for today is spent (${spent} of ${allowance} tokens). It resets at midnight UTC, or use your own key.`,
                { retry_after_seconds: Math.max(1, Math.ceil((next - at) / 1000)), allowance: { tier: admission.tier, tokens: allowance, used: spent, shared } });
            }
        }

        const keys = [
            { kind: 'asn', key: admission.asnHash },
            { kind: 'device', key: deviceHash },
            { kind: 'input', key: admission.inputKey },
        ].filter((k) => k.key);
        const hit = await velocityHit(keys, at);
        if (hit) {
            await audit('abuse.throttled', { reason: 'velocity', kind: hit.kind, asn: network.asn, hosting: network.hosting, tier: admission.tier, shared, accounts: onDevice.accounts, trace: ctx.trace || null });
            throw new AiError(429, 'ai.abuse_throttled', 'Free use from this network or device is going much faster than usual, so it is paused for a moment. Wait a minute and try again.', {
                retry_after_seconds: 60, abuse: { reason: 'velocity', kind: hit.kind, limit_per_minute: Math.floor(hit.limit_per_minute), baseline_per_minute: Number(hit.baseline_per_minute.toFixed(2)) },
            });
        }
        return admission;
    }

    /** Record what a finished free run spent: its allowance counter and the three velocity buckets. */
    async function record({ admission, tokens = 0, inputHash = null } = {}) {
        if (!enabled || !admission || !admission.key) return;
        const n = Math.max(0, Math.floor(Number(tokens) || 0));
        if (!n) return;
        const at = now();
        const ts = iso(at);
        const day = admission.day || iso(at).slice(0, 10);
        if (admission.subject) {
            await db.prepare(`INSERT INTO abuse_daily_usage (subject, day, tokens, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (subject, day) DO UPDATE SET tokens = abuse_daily_usage.tokens + excluded.tokens, updated_at = excluded.updated_at`)
                .run(admission.key, day, n, ts);
        }
        const minute = Math.floor(at / MIN_MS);
        const keys = [
            { kind: 'asn', key: admission.asnHash },
            { kind: 'device', key: admission.deviceHash },
            { kind: 'input', key: inputHash ? keyed('input', String(inputHash)) : admission.inputKey },
        ].filter((k) => k.key);
        for (const k of keys) {
            await db.prepare(`INSERT INTO abuse_velocity (kind, key_hash, minute, tokens, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (kind, key_hash, minute) DO UPDATE SET tokens = abuse_velocity.tokens + excluded.tokens, updated_at = excluded.updated_at`)
                .run(k.kind, k.key, minute, n, ts);
        }
        if (Math.random() < 0.01) await db.prepare('DELETE FROM abuse_velocity WHERE minute < ?').run(minute - 8 * 24 * 60).catch(() => {});
    }

    async function issueChallenge({ meta = {}, principal = null } = {}) {
        if (!enabled) throw new AiError(503, 'ai.abuse_unavailable', 'The free tier is not available on this service.');
        const network = await networkOf(meta, principal);
        const rateKey = meta.deviceHash ? `challenge:device:${meta.deviceHash}` : `challenge:prefix:${network.prefixHash || 'unknown'}`;
        if (!countRate(rateKey, Math.max(1, Number(cfg.powChallengesPerMinute) || 10), now())) {
            throw new AiError(429, 'ai.rate_limited', 'Too many challenge requests right now. Wait a minute and try again.', { retry_after_seconds: 60 });
        }
        return pow.issue({ deviceHash: meta.deviceHash || null, prefixHash: network.prefixHash || null });
    }

    /** Hourly housekeeping: every table has an expiry; the daily counters keep 30 days for a month's view. */
    async function prune() {
        const at = now();
        const out = {};
        for (const [name, sql, arg] of [
            ['network', 'DELETE FROM abuse_network_seen WHERE expires_at < ?', iso(at)],
            ['pow', 'DELETE FROM abuse_pow WHERE expires_at < ?', iso(at - DAY_MS)],
            ['velocity', 'DELETE FROM abuse_velocity WHERE minute < ?', Math.floor(at / MIN_MS) - 8 * 24 * 60],
            ['daily', 'DELETE FROM abuse_daily_usage WHERE day < ?', iso(at - 30 * DAY_MS).slice(0, 10)],
            ['devices', 'DELETE FROM abuse_devices WHERE last_seen < ?', iso(at - 180 * DAY_MS)],
        ]) {
            try { out[name] = (await db.prepare(sql).run(arg)).changes || 0; } catch (err) { log.warn(`[abuse] prune ${name}: ${err && err.message}`); }
        }
        return out;
    }

    /** The operator console page's read: recent events, today's counters and the current signal sizes. */
    async function overview({ limit = 50 } = {}) {
        const at = now();
        const day = iso(at).slice(0, 10);
        const since = iso(at - DAY_MS);
        const events = await db.prepare("SELECT id, at, action, target_id, metadata FROM audit_log WHERE action IN ('abuse.throttled', 'abuse.rate_limited') AND at >= ? ORDER BY id DESC LIMIT ?").all(since, Math.min(200, Math.max(1, limit)));
        const usage = await db.prepare('SELECT subject, tokens FROM abuse_daily_usage WHERE day = ? ORDER BY tokens DESC LIMIT ?').all(day, Math.min(100, limit));
        const devices = await db.prepare('SELECT COUNT(*) AS n FROM abuse_devices').get();
        const shared = await db.prepare('SELECT COUNT(*) AS n FROM (SELECT device_hash FROM abuse_devices GROUP BY device_hash HAVING COUNT(*) > 3) x').get();
        const network = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(hosting), 0) AS hosting FROM abuse_network_seen WHERE expires_at > ?').get(iso(at));
        const pow = await db.prepare('SELECT COUNT(*) AS n FROM abuse_pow WHERE used_at IS NULL AND expires_at > ?').get(iso(at));
        return {
            day,
            events: events.map((e) => ({ id: Number(e.id), at: e.at, action: e.action, target: e.target_id, metadata: parseJson(e.metadata, {}) })),
            usage: usage.map((r) => ({ subject: r.subject, tokens: Number(r.tokens) })),
            devices: Number(devices && devices.n) || 0,
            shared_devices: Number(shared && shared.n) || 0,
            network: { prefixes_24h: Number(network && network.n) || 0, hosting: Number(network && network.hosting) || 0 },
            pow: Number(pow && pow.n) || 0,
            asn_table: asn.status(),
            signals: signals.enabled,
        };
    }

    /** The Prometheus gauge: events in the last 15 minutes, by reason (0 when nothing happened). */
    function gaugeValues() {
        const cutoff = now() - 15 * MIN_MS;
        const out = new Map();
        for (const e of throttleRing) if (e.at >= cutoff) out.set(e.kind, (out.get(e.kind) || 0) + 1);
        return ['velocity', 'rate', 'hosting', 'network'].map((reason) => ({ labels: { reason }, value: out.get(reason) || 0 }));
    }

    /** A public endpoint only: the anonymous Try it gets its challenge here. */
    function router() {
        const r = express.Router();
        r.post('/api/v1/exchange/tryit/challenge', async (req, res) => {
            try {
                res.json(await issueChallenge({ meta: req.abuse || {}, principal: req.principal || null }));
            } catch (err) {
                sendError(res, err, req.ov, log);
            }
        });
        return r;
    }

    return {
        enabled, middleware, admit, record, issueChallenge, overview, gaugeValues, router, prune,
        // The tests and the docs use these; nothing else should.
        _test: { signDevice, verifyDevice, keyed, asn, signals, pow, cookieHeader, clientIp, velocityHit, deviceTable: db },
    };
}

module.exports = { createAbuse, firstAddress, isLoopback, cookiesOf };
