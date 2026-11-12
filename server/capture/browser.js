'use strict';
/**
 * Headless Chrome for a deep dive's captures (playwright-core on the host's /usr/bin/google-chrome).
 *
 * One browser at a time (server/capture/index.js queues the calls). Each URL is opened in a fresh context with
 * no cookies and no stored state, at 390 and 1280 px, in light and — when the site actually changes with
 * prefers-color-scheme — dark. The page is scrolled slowly to the bottom first, because lazy sections only
 * paint when they come into view, then the whole page is photographed. The DOM facts are read from the live
 * page and the Expert extras (axe-core, LCP/CLS/INP, menus, hover and focus states, a short frame strip) are
 * taken on the 1280 light visit. Every page has a 45 s budget; a page that runs over is reported, never waited on.
 *
 * The browser goes through server/capture/proxy.js: no request, redirect or WebSocket reaches a private address.
 */
const fs = require('fs');
const path = require('path');
const { METRICS_INIT, collectDom, readMetrics } = require('./dom');

const AXE = (() => {
    try { return fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { return null; }
})();

const VIEWPORTS = { phone: 390, desktop: 1280 };
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OpenVibeDeepDive/1.0 (+https://openvibe.exchange/deep-dive)';
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

function deadline(ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    t.unref?.();
    return { signal: c.signal, clear: () => clearTimeout(t) };
}

class BudgetError extends Error {
    constructor(message) { super(message); this.name = 'BudgetError'; this.code = 'capture.timeout'; }
}

async function slowScroll(page, budget) {
    const { height, step } = await page.evaluate(() => ({ height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), step: Math.max(300, Math.round(innerHeight * 0.8)) }));
    let y = 0;
    const started = Date.now();
    while (y < height && Date.now() - started < Math.min(9000, budget)) {
        y += step;
        await page.evaluate((to) => scrollTo(0, to), y);
        await sleep(220);
        const now = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
        if (y > now) break;
    }
    await page.evaluate(() => scrollTo(0, 0));
    await sleep(450);
    return page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
}

async function shot(page, upload, { name, viewport, theme, runId, owner, sourceUrl, capturedAt, extra = {}, full = false, height = null, maxHeight = 12000 }) {
    const tall = Number(height) > maxHeight;
    const buf = full && !tall
        ? await page.screenshot({ type: 'png', fullPage: true, caret: 'hide', animations: 'allow' })
        : await page.screenshot({ type: 'png', fullPage: false, caret: 'hide', animations: 'allow', ...(full && tall ? { clip: { x: 0, y: 0, width: viewport, height: maxHeight } } : {}) });
    const out = await upload({ bytes: buf, mime: 'image/png', filename: name, owner, metadata: { source_url: sourceUrl, captured_at: capturedAt, viewport, theme, deep_dive: runId, ...extra } });
    return { media_id: out.media_id, width: out.width || viewport, height: out.height || null };
}

async function crop(page, upload, { name, y, viewport, theme, runId, owner, sourceUrl, capturedAt }) {
    await page.evaluate((to) => scrollTo(0, to), y);
    await sleep(220);
    const box = await page.evaluate(() => ({ height: innerHeight }));
    const buf = await page.screenshot({ type: 'png', fullPage: false, caret: 'hide' });
    const out = await upload({ bytes: buf, mime: 'image/png', filename: name, owner, metadata: { source_url: sourceUrl, captured_at: capturedAt, viewport, theme, deep_dive: runId, crop_y: y, crop_height: box.height } });
    return { media_id: out.media_id, y, height: out.height || box.height };
}

/** Does the site paint differently under prefers-color-scheme: dark? Compare the body, the header and the text. */
async function looksDark(browser, url, proxy, timeoutMs, log = console) {
    const v = VIEWPORTS.desktop;
    let light = null; let dark = null;
    for (const scheme of ['light', 'dark']) {
        const ctx = await browser.newContext({ viewport: { width: v, height: 900 }, colorScheme: scheme, locale: 'en-US', userAgent: UA, serviceWorkers: 'block', reducedMotion: 'no-preference' });
        const page = await ctx.newPage();
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
            await page.waitForTimeout(350);
            const value = await page.evaluate(() => {
                const cs = (el) => (el ? getComputedStyle(el) : null);
                const body = cs(document.body);
                const header = cs(document.querySelector('header, nav, [role="banner"]'));
                const h1 = cs(document.querySelector('h1'));
                return [body && body.backgroundColor, body && body.color, header && header.backgroundColor, h1 && h1.color].filter(Boolean);
            });
            if (scheme === 'light') light = value; else dark = value;
        } catch (err) { log.warn(`[capture] theme probe ${scheme}: ${String((err && err.message) || err).slice(0, 160)}`); return false; } finally { await ctx.close().catch(() => {}); }
    }
    if (!light || !dark || light.length !== dark.length) return false;
    // One changed value can be a hover or a placeholder; two (the page's own background and text, usually) is
    // a site that really answers prefers-color-scheme, and only then is the extra pair of captures worth it.
    const changed = light.filter((v, i) => v && dark[i] && v !== dark[i]).length;
    return changed >= 2;
}

async function runAxe(page) {
    if (!AXE) return { skipped: 'axe-core is not installed' };
    try {
        await page.addScriptTag({ content: AXE });
        const result = await page.evaluate(async () => {
            try {
                const r = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
                return { violations: (r.violations || []).slice(0, 20).map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: (v.nodes || []).length, targets: (v.nodes || []).slice(0, 3).map((n) => n.target) })), passes: (r.passes || []).length };
            } catch (e) { return { error: String(e && e.message || e).slice(0, 240) }; }
        });
        return result;
    } catch (e) { return { error: String(e && e.message || e).slice(0, 240) }; }
}

/** The Expert extras: menus, hover, focus, a frame strip and the measured Web Vitals. */
async function extrasOn(page, upload, { viewport, theme, runId, owner, sourceUrl, capturedAt }) {
    const extras = { metrics: await page.evaluate(readMetrics).catch(() => null), a11y: await runAxe(page), menus: [], hover: null, focus: null, frames: [] };
    const menu = page.locator('button[aria-expanded="false"], [role="button"][aria-expanded="false"], button[aria-label*="menu" i], button[aria-label*="navigation" i]').first();
    if (await menu.count().catch(() => 0)) {
        const label = await menu.getAttribute('aria-label').catch(() => null) || await menu.innerText().catch(() => 'menu');
        const before = await shot(page, upload, { name: 'menu-closed', viewport, theme, runId, owner, sourceUrl, capturedAt, extra: { state: 'menu-closed' } });
        try {
            await menu.click({ timeout: 4000 });
            await page.waitForTimeout(500);
            const after = await shot(page, upload, { name: 'menu-open', viewport, theme, runId, owner, sourceUrl, capturedAt, extra: { state: 'menu-open' } });
            extras.menus.push({ label: String(label || 'menu').slice(0, 80), before: before.media_id, after: after.media_id });
        } catch { /* a menu that does not open is not a failed capture */ }
        await page.keyboard.press('Escape').catch(() => {});
    }
    const link = page.locator('header a, nav a').first();
    if (await link.count().catch(() => 0)) {
        try { await link.hover({ timeout: 3000 }); await page.waitForTimeout(250); extras.hover = (await shot(page, upload, { name: 'hover', viewport, theme, runId, owner, sourceUrl, capturedAt, extra: { state: 'hover' } })).media_id; } catch { /* none */ }
    }
    const focusable = page.locator('input:not([type="hidden"]), button, a').first();
    if (await focusable.count().catch(() => 0)) {
        try { await focusable.focus({ timeout: 3000 }); await page.waitForTimeout(250); extras.focus = (await shot(page, upload, { name: 'focus', viewport, theme, runId, owner, sourceUrl, capturedAt, extra: { state: 'focus' } })).media_id; } catch { /* none */ }
    }
    // A short frame strip: four frames of whatever moves when the first section below the fold comes into view.
    try {
        await page.evaluate(() => scrollTo(0, Math.min(document.body ? document.body.scrollHeight - innerHeight : 0, innerHeight * 1.2)));
        for (let i = 0; i < 4; i++) {
            await page.waitForTimeout(280);
            extras.frames.push((await shot(page, upload, { name: `frame-${i + 1}`, viewport, theme, runId, owner, sourceUrl, capturedAt, extra: { state: 'transition', frame: i + 1 } })).media_id);
        }
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(250);
    } catch { /* frames are best effort */ }
    extras.frames = extras.frames.filter(Boolean);
    return extras;
}

function createBrowserEngine({ config, log = console, allowLocal = false } = {}) {
    const chrome = (config && config.capture && config.capture.chrome) || '/usr/bin/google-chrome';
    const maxHeight = (config && config.capture && config.capture.maxHeight) || 12000;
    const pageBudgetMs = (config && config.capture && config.capture.pageBudgetMs) || 45000;
    const available = () => { try { fs.accessSync(chrome, fs.constants.X_OK); return true; } catch { return false; } };

    /**
     * One URL, light and (when the site supports it) dark, at both viewports. upload: async ({bytes, mime,
     * filename, owner, metadata}) -> { media_id }. Returns { title, final_url, combos: [...], warnings }.
     */
    async function captureSite({ url, runId, owner, upload, signal = null, extras = false, log: logFn = log }) {
        const started = Date.now();
        const out = { title: null, final_url: null, combos: [], warnings: [], ms: 0 };
        if (!available()) throw Object.assign(new Error(`headless Chrome is not at ${chrome}`), { code: 'capture.no_chrome' });
        const { chromium } = require('playwright-core');
        const { createGuardProxy } = require('./proxy');
        const proxy = createGuardProxy({ log, allowLocal });
        const proxyInfo = await proxy.start();
        let browser = null;
        let comboDeadline = null;
        try {
            browser = await chromium.launch({
                executablePath: chrome, headless: true,
                args: ['--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', '--disable-background-networking', '--disable-sync'],
                proxy: { server: proxyInfo.url, bypass: '' },
                timeout: Math.min(20000, pageBudgetMs),
            });
            const capturedAt = new Date().toISOString();
            const base = { runId, owner, sourceUrl: url, capturedAt };
            const schemes = ['light'];
            if ((await looksDark(browser, url, proxyInfo.url, Math.min(20000, pageBudgetMs), log))) schemes.push('dark');
            for (const viewport of [VIEWPORTS.phone, VIEWPORTS.desktop]) {
                for (const theme of schemes) {
                    if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'run.cancelled' });
                    comboDeadline = deadline(pageBudgetMs);
                    const ctx = await browser.newContext({
                        viewport: { width: viewport, height: viewport === VIEWPORTS.phone ? 844 : 900 },
                        colorScheme: theme, locale: 'en-US', userAgent: UA, serviceWorkers: 'block', reducedMotion: 'no-preference', javaScriptEnabled: true,
                    });
                    const page = await ctx.newPage();
                    page.setDefaultTimeout(Math.min(15000, pageBudgetMs));
                    page.setDefaultNavigationTimeout(Math.min(20000, pageBudgetMs));
                    await page.addInitScript(METRICS_INIT);
                    const onAbort = () => { try { page.close(); } catch { /* closed */ } };
                    if (signal) signal.addEventListener('abort', onAbort, { once: true });
                    if (comboDeadline.signal) comboDeadline.signal.addEventListener('abort', onAbort, { once: true });
                    try {
                        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(20000, pageBudgetMs) });
                        out.title = out.title || (await page.title().catch(() => null));
                        out.final_url = page.url();
                        if (res && res.status() >= 400) out.warnings.push(`${url} answered HTTP ${res.status()}`);
                        await page.waitForTimeout(500);
                        const height = await slowScroll(page, pageBudgetMs);
                        const dom = await page.evaluate(collectDom, 4000);
                        const full = await shot(page, upload, { name: `full-${viewport}-${theme}`, viewport, theme, ...base, full: true, height, maxHeight });
                        const crops = [];
                        const viewportHeight = viewport === VIEWPORTS.phone ? 844 : 900;
                        const tops = [0];
                        if (height > viewportHeight * 2) tops.push(Math.floor((height - viewportHeight) / 2));
                        if (height > viewportHeight * 3) tops.push(Math.max(0, height - viewportHeight));
                        for (const [i, y] of tops.entries()) crops.push({ id: `crop-${crops.length + 1}`, ...(await crop(page, upload, { name: `crop-${viewport}-${theme}-${i + 1}`, viewport, theme, y, ...base })) });
                        const combo = { viewport, theme, full_page: true, media_id: full.media_id, width: viewport, height: Math.min(height, maxHeight), crops, title: out.title, final_url: out.final_url, dom, extras: null, captured_at: capturedAt, ms: Date.now() - started, cached: false };
                        if (extras && viewport === VIEWPORTS.desktop && theme === 'light') {
                            try { combo.extras = await extrasOn(page, upload, { viewport, theme, ...base }); } catch (err) { out.warnings.push(`expert extras failed: ${String((err && err.message) || err).slice(0, 160)}`); }
                        }
                        out.combos.push(combo);
                    } catch (err) {
                        out.warnings.push(`${viewport} ${theme}: ${String((err && err.message) || err).slice(0, 200)}`);
                    } finally {
                        comboDeadline.clear();
                        if (signal) signal.removeEventListener('abort', onAbort);
                        await ctx.close().catch(() => {});
                    }
                }
            }
            if (!out.combos.length) throw Object.assign(new Error(out.warnings[0] || 'the page did not load'), { code: 'capture.failed', warnings: out.warnings });
            out.ms = Date.now() - started;
            return out;
        } finally {
            if (comboDeadline) comboDeadline.clear();
            if (browser) await browser.close().catch(() => {});
            proxy.close();
        }
    }

    return { captureSite, available, chrome };
}

module.exports = { createBrowserEngine, VIEWPORTS, UA, BudgetError, looksDark };
