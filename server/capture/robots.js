'use strict';
/**
 * robots.txt, respected before a browser is started.
 *
 * The group is the one for our own user agent (`OpenVibeDeepDive`) when a site names it, else `*`; the longest
 * matching Allow/Disallow rule wins, `*` and `$` wildcards included (RFC 9309's matching, the same rule Google
 * publishes). A 404/410 means no robots at all (allowed); a 401/403 or a 5xx means the site does not want
 * robots reading it, so the page is skipped and the report says so. The answer is cached per origin for an hour,
 * and the fetch goes through the same public-address guard as everything else.
 */
const { guardedFetch } = require('../providers/guarded-fetch');
const { publicTarget } = require('../search/transport');

const UA = 'OpenVibeDeepDive';
const TTL_MS = 60 * 60 * 1000;

function parse(text) {
    const groups = [];
    let current = null;
    let inAgents = false;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const i = line.indexOf(':');
        if (i < 0) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        const value = line.slice(i + 1).trim();
        if (key === 'user-agent') {
            if (!inAgents || !current) { current = { agents: [], rules: [] }; groups.push(current); }
            current.agents.push(value.toLowerCase());
            inAgents = true;
        } else if (key === 'allow' || key === 'disallow') {
            if (!current) continue;
            current.rules.push({ allow: key === 'allow', path: value });
            inAgents = false;
        } else if (key === 'sitemap') {
            inAgents = false;
        }
    }
    return groups;
}

function patternRe(path) {
    const anchored = path.endsWith('$');
    const body = (anchored ? path.slice(0, -1) : path).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function allowedBy(groups, path, ua = UA) {
    const mine = groups.filter((g) => g.agents.some((a) => a && (a === ua.toLowerCase() || a === '*')));
    const specific = mine.filter((g) => g.agents.some((a) => a !== '*'));
    const use = specific.length ? specific : mine;
    if (!use.length) return true;
    let best = null;
    for (const g of use) {
        for (const r of g.rules) {
            if (!r.path) continue;      // an empty Disallow is no rule
            if (!patternRe(r.path).test(path)) continue;
            if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
        }
    }
    return best ? best.allow : true;
}

function createRobots({ fetchImpl = guardedFetch, now = () => Date.now(), log = console, timeoutMs = 8000 } = {}) {
    const cache = new Map();     // origin -> { at, robots }

    async function load(origin) {
        const hit = cache.get(origin);
        if (hit && now() - hit.at < TTL_MS) return hit.robots;
        const url = `${origin}/robots.txt`;
        let robots = { exists: false, groups: [] };
        try {
            await publicTarget(url);
            const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': `${UA}/1.0 (+https://openvibe.exchange/deep-dive)`, accept: 'text/plain' } });
            if (res.status === 401 || res.status === 403) robots = { exists: true, groups: [{ agents: ['*'], rules: [{ allow: false, path: '/' }] }] };
            else if (res.status === 404 || res.status === 410) robots = { exists: false, groups: [] };
            else if (res.status >= 500) robots = { exists: true, groups: [{ agents: ['*'], rules: [{ allow: false, path: '/' }] }] };
            else if (res.ok) robots = { exists: true, groups: parse(await res.text()) };
        } catch (err) {
            // A robots.txt that cannot be read is treated as no robots: the page itself still goes through the
            // address guard, and a site that is down is reported as a skipped capture, not a silent read.
            log.warn(`[capture] robots ${origin}: ${String((err && err.message) || err).slice(0, 160)}`);
            robots = { exists: false, groups: [] };
        }
        cache.set(origin, { at: now(), robots });
        if (cache.size > 500) cache.delete(cache.keys().next().value);
        return robots;
    }

    /** { allowed, reason } for a URL; reason is what the report shows when it is not. */
    async function check(url) {
        let u;
        try { u = new URL(String(url)); } catch { return { allowed: false, reason: 'not a valid URL' }; }
        if (!/^https?:$/.test(u.protocol)) return { allowed: false, reason: 'not an http(s) URL' };
        const robots = await load(u.origin);
        if (!robots.groups.length) return { allowed: true, reason: null };
        const path = `${u.pathname}${u.search || ''}` || '/';
        return allowedBy(robots.groups, path) ? { allowed: true, reason: null } : { allowed: false, reason: 'robots.txt disallows this page' };
    }

    return { check, parse, allowedBy, clear: () => cache.clear() };
}

module.exports = { createRobots, parse, allowedBy, UA };
