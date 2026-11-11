'use strict';
/**
 * The capture worker's front door: robots, the address guard, one browser at a time and a queue cap per person.
 *
 * A deep dive asks for one URL (both viewports, light and dark where supported, Expert extras on request); this
 * module checks robots.txt first (a disallowed page is skipped and the report says so), checks that the URL is a
 * public https address before a browser exists, waits its turn (one browser at a time: the host has about 5 GB
 * free) and a short gap when the same host is asked twice, then hands it to server/capture/browser.js. The 7-day
 * cache lives beside the run (server/deep-dive/store.js), so a cache hit never starts Chrome.
 */
const path = require('path');
const { createBrowserEngine } = require('./browser');
const { createRobots } = require('./robots');
const { publicTarget } = require('../search/transport');

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };
const cleanUrl = (u, { upgrade = true } = {}) => {
    try {
        const x = new URL(String(u));
        x.hash = '';
        if (upgrade && x.protocol === 'http:') x.protocol = 'https:';
        return x.href;
    } catch { return null; }
};
const cacheKey = (url, viewport, theme, extras) => `${url}|${viewport}|${theme}|${extras ? 1 : 0}`;

function createCapture({ config = {}, env = process.env, clock = { now: () => Date.now() }, log = console, engine = null, robots = null, upload = null, allowLocal = false } = {}) {
    const cfg = config.capture || {};
    const chrome = cfg.chrome || '/usr/bin/google-chrome';
    const browser = engine || createBrowserEngine({ config, log, allowLocal });
    const robot = robots || createRobots({ now: () => clock.now(), log });
    const chromeOk = () => {
        try { require('fs').accessSync(chrome, require('fs').constants.X_OK); return true; } catch { return false; }
    };
    const drill = /^(1|true|yes|on)$/i.test(String(process.env.AI_DRILL || process.env.LIVE_DRILL || ''));
    const enabled = config.deepDive ? config.deepDive.enabled !== false && !drill : true;

    // One browser at a time: a promise chain, with how many calls each owner is waiting in.
    const waiting = new Map();
    let tail = Promise.resolve();
    const hostAt = new Map();

    function available() {
        return enabled && chromeOk();
    }

    async function gapFor(url) {
        const host = hostOf(url);
        if (!host) return;
        const last = hostAt.get(host) || 0;
        const wait = Math.max(0, (cfg.hostDelayMs || 0) - (clock.now() - last));
        if (wait) await new Promise((r) => { const t = setTimeout(r, wait); t.unref?.(); });
        hostAt.set(host, clock.now());
    }

    /**
     * Capture one URL. Returns { url, title, final_url, combos, warnings, ms, skipped, reason }.
     * skipped: robots_disallowed | not_public | no_chrome | drill | busy.
     */
    async function captureSite({ url, runId, owner, extras = false, signal = null, upload: uploadFn = upload, log: logFn = log } = {}) {
        const target = cleanUrl(url, { upgrade: !allowLocal });
        if (!target) return { url: String(url || ''), combos: [], warnings: ['not a valid URL'], skipped: 'not_public', reason: 'not a valid http(s) URL', ms: 0 };
        if (!enabled) return { url: target, combos: [], warnings: ['capture is off under a drill'], skipped: 'drill', reason: 'capture is off under a drill', ms: 0 };
        if (!chromeOk()) return { url: target, combos: [], warnings: ['headless Chrome is not installed'], skipped: 'no_chrome', reason: 'headless Chrome is not installed on this host', ms: 0 };
        if (!uploadFn) return { url: target, combos: [], warnings: ['Media is not configured'], skipped: 'no_media', reason: 'screenshots have nowhere private to go', ms: 0 };
        try {
            if (!allowLocal) await publicTarget(target);
        } catch (err) {
            return { url: target, combos: [], warnings: [String(err && err.message || err)], skipped: 'not_public', reason: `refused: ${String(err && err.message || err).slice(0, 160)}`, ms: 0 };
        }
        const allowed = await robot.check(target);
        if (!allowed.allowed) return { url: target, combos: [], warnings: [allowed.reason], skipped: 'robots_disallowed', reason: allowed.reason, ms: 0 };

        const who = owner || 'anonymous';
        const mine = waiting.get(who) || 0;
        if (mine >= (cfg.maxPerOwner || 3)) {
            return { url: target, combos: [], warnings: ['this person already has captures waiting'], skipped: 'busy', reason: 'too many captures waiting for this person; try again shortly', ms: 0 };
        }
        waiting.set(who, mine + 1);
        const run = tail.then(async () => {
            if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'run.cancelled' });
            await gapFor(target);
            if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'run.cancelled' });
            const result = await browser.captureSite({ url: target, runId, owner, upload: uploadFn, signal, extras, log: logFn });
            return { url: target, skipped: null, reason: null, ...result };
        });
        tail = run.catch(() => {});
        try {
            return await run;
        } finally {
            const left = (waiting.get(who) || 1) - 1;
            if (left > 0) waiting.set(who, left); else waiting.delete(who);
        }
    }

    return { captureSite, available, enabled: () => enabled, cacheKey, cleanUrl, chrome };
}

module.exports = { createCapture, cacheKey, cleanUrl };
