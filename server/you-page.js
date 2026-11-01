'use strict';
/**
 * Your AI (plan L36 Y1, Y3, Y8): GET /you on ai.openvibe.services. A person's own provider keys and how their AI is
 * paid, in one place for every OpenVibe site and agent. Save a key once, test it, replace it or remove it; choose
 * "only my keys" (never anything paid) or "my keys first, then OpenVibe's allowance", free tiers first, and a price
 * ceiling. What it all cost lives on openvibe.report/you (L40, L41).
 *
 * Server-rendered forms on AI's own person session (the run receipt's sign-in, /auth/person/login), each POST behind
 * a strict same-origin check: Sec-Fetch-Site same-origin, or an Origin header naming this site; neither is refused.
 * The page calls the same functions the person's API does (server/credentials.js, server/person-preferences.js), so
 * a key is sealed the same way and only its last four characters ever come back.
 *
 *   GET  /you                              the page (signed out: what it is and a sign-in)
 *   POST /you/keys/:provider               save or replace a key   (key, base_url for "custom")
 *   POST /you/keys/:provider/test          test it now
 *   POST /you/keys/:provider/remove        forget it
 *   POST /you/preferences                  only_my_keys, free_first, price_ceiling_usd_per_mtok
 */
const express = require('express');
const shell = require('openvibe-shared/shell');
const ovServe = require('openvibe-shared/serve');
const appIcon = require('openvibe-shared/app-icon');
const { CREDENTIAL_PROVIDERS, CREDENTIAL_PRESET, byId } = require('./console/presets');
const { HOME_CSP } = require('./home');

const SITE_NAME = 'OpenVibe.AI';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// The order people look for them in: the big labs, then the fast and cheap, then the routers, then their own.
const ORDER = ['anthropic', 'openai', 'gemini', 'deepseek', 'mistral', 'xai', 'groq', 'cerebras', 'together', 'fireworks', 'openrouter', 'minimax', 'custom'];
const NAMES = { deepseek: 'DeepSeek', minimax: 'MiniMax', custom: 'Another OpenAI-compatible API' };
const providerName = (id) => NAMES[id] || (byId(CREDENTIAL_PRESET[id]) || {}).name || id;
const keysUrl = (id) => (byId(CREDENTIAL_PRESET[id]) || {}).keys || null;
const ago = (iso) => {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

const STYLE = `<style>
.you{max-width:900px;margin:0 auto;padding:clamp(18px,4vw,44px) clamp(16px,3vw,28px) 90px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--text-primary,#e6edf7)}
.you h1,.you h2{font-family:'OV Brand',Nunito,Inter,-apple-system,sans-serif;font-weight:900}
.you-eye{margin:0 0 8px;color:var(--accent,#3b82f6);font-size:12px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}
.you h1{margin:0;font-size:clamp(30px,5vw,48px);line-height:1.06;letter-spacing:-.02em;text-wrap:balance}
.you-lede{margin:12px 0 0;max-width:62ch;color:var(--text-secondary,#96a7c2);font-size:16.5px;line-height:1.6}
.you-state{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 0;padding:0;list-style:none}
.you-state li{padding:5px 12px;border-radius:999px;border:1px solid var(--border,#1f2d47);font-size:13.5px;color:var(--text-secondary,#96a7c2)}
.you-state b{color:var(--text-primary,#e6edf7)}
.you section{margin-top:34px}
.you h2{margin:0 0 6px;font-size:20px}
.you-sub{margin:0 0 14px;color:var(--text-secondary,#96a7c2);font-size:14.5px;line-height:1.55;max-width:66ch}
.you-keys{list-style:none;margin:0;padding:0;border:1px solid var(--border,#1f2d47);border-radius:16px;overflow:hidden}
.you-key{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 14px;align-items:center;padding:14px 16px;border-top:1px solid var(--border,#1f2d47);background:var(--bg-secondary,#101828)}
.you-key:first-child{border-top:0}
.you-key-t{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;min-width:0}
.you-key-t b{font-size:15.5px}
.you-key-n{grid-column:1/-1;color:var(--text-muted,#7d8ba3);font-size:13px;overflow-wrap:anywhere}
.you-pill{padding:2px 9px;border-radius:999px;font-size:12px;font-weight:750;background:var(--bg-primary,#0b1220);color:var(--text-secondary,#96a7c2)}
.you-pill.is-ok{color:#16a34a;background:color-mix(in srgb,#16a34a 15%,transparent)}
.you-pill.is-bad{color:#ef4444;background:color-mix(in srgb,#ef4444 15%,transparent)}
.you-acts{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.you-acts form{margin:0}
.you-btn{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 14px;border-radius:999px;border:1px solid var(--border,#1f2d47);background:transparent;color:var(--text-primary,#e6edf7);font:inherit;font-size:13.5px;font-weight:650;text-decoration:none;cursor:pointer}
.you-btn:hover{background:var(--bg-primary,#0b1220)}
.you-btn.is-go{border-color:transparent;background:var(--accent-strong,var(--accent,#3b82f6));color:var(--on-accent-strong,#fff)}
.you-btn:focus-visible{outline:2px solid var(--accent,#3b82f6);outline-offset:2px}
.you-add{grid-column:1/-1}
.you-add summary{display:inline-flex;cursor:pointer;list-style:none}
.you-add summary::-webkit-details-marker{display:none}
.you-add form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:10px}
.you-add label{display:grid;gap:4px;flex:1 1 220px;font-size:12.5px;font-weight:700;color:var(--text-secondary,#96a7c2)}
.you input[type=password],.you input[type=url],.you input[type=number]{min-height:42px;box-sizing:border-box;width:100%;padding:0 12px;border-radius:10px;border:1px solid var(--border,#1f2d47);background:var(--bg-primary,#0b1220);color:var(--text-primary,#e6edf7);font:inherit;font-size:15px}
.you-pay{display:grid;gap:10px;padding:16px;border-radius:16px;border:1px solid var(--border,#1f2d47);background:var(--bg-secondary,#101828)}
.you-pay fieldset{margin:0;padding:0;border:0;display:grid;gap:8px}
.you-pay legend{margin-bottom:6px;font-weight:700}
.you-opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;border:1px solid var(--border,#1f2d47);cursor:pointer}
.you-opt:has(input:checked){border-color:var(--accent,#3b82f6);background:color-mix(in srgb,var(--accent,#3b82f6) 10%,transparent)}
.you-opt input{margin-top:3px;accent-color:var(--accent,#3b82f6)}
.you-opt span{display:grid;gap:2px}.you-opt small{color:var(--text-secondary,#96a7c2);font-size:13px}
.you-row{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:flex-end}
.you-row>label:not(.you-opt){display:grid;gap:4px;font-size:12.5px;font-weight:700;color:var(--text-secondary,#96a7c2)}
.you-new{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.you-new>li{padding:12px 14px;border-radius:14px;border:1px solid var(--border,#1f2d47);background:var(--bg-secondary,#101828)}
.you-new>li:has(details[open]){grid-column:1/-1}
.you-new summary{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;list-style:none;font-weight:700}
.you-new summary::-webkit-details-marker{display:none}
.you-new summary span{color:var(--accent,#3b82f6);font-size:13px;font-weight:650}
.you-new form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:12px}
.you-new label{display:grid;gap:4px;flex:1 1 220px;font-size:12.5px;font-weight:700;color:var(--text-secondary,#96a7c2)}
.you-empty{padding:16px;border-radius:14px;border:1px dashed var(--border,#1f2d47);color:var(--text-secondary,#96a7c2)}
.you-note{margin:10px 0 0;padding:10px 14px;border-radius:12px;font-size:14px}
.you-note.is-ok{background:color-mix(in srgb,#16a34a 14%,transparent)}.you-note.is-bad{background:color-mix(in srgb,#ef4444 14%,transparent)}
.you-fine{color:var(--text-muted,#7d8ba3);font-size:13px;line-height:1.55;max-width:70ch}
@media (max-width:560px){.you-key{grid-template-columns:minmax(0,1fr)}.you-acts{justify-content:flex-start}}
</style>`;

function frame({ title, body, siteUrl }) {
    return shell.page({
        name: SITE_NAME, service: 'ai', lang: 'en', title, siteName: SITE_NAME,
        description: 'Your own AI keys for every OpenVibe site and agent: saved once, no fee, and you choose how your AI is paid.',
        canonical: `${String(siteUrl).replace(/\/+$/, '')}/you`, robots: 'noindex, nofollow',
        navbar: { service: 'ai', apiBase: 'https://openvibe.network', links: [{ label: 'Your AI', href: '/you', active: true }, { label: 'Prices', href: '/stats' }], history: { type: 'page', title } },
        footer: { service: 'ai', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' },
        home: '/', navLinks: [{ label: 'Your AI', href: '/you' }, { label: 'Prices', href: '/stats' }],
        head: [appIcon.headTags({ site: 'ai' }), STYLE].join('\n'),
        body: `<div id="navbar-mount"></div>\n<main id="main" class="you">${body}</main>`,
    });
}

function signedOut({ siteUrl }) {
    return frame({ siteUrl, title: 'Your AI', body: `<p class="you-eye">Your AI</p><h1>Your keys, on every OpenVibe site.</h1>
<p class="you-lede">Save a key from Anthropic, OpenAI, Google, DeepSeek or any provider once, and every OpenVibe site and agent can use it, with no fee, ever. You choose whether anything else may pay.</p>
<p style="margin-top:20px"><a class="you-btn is-go" href="/auth/person/login?next=${encodeURIComponent('/you')}">Sign in to see yours</a></p>` });
}

/** The app names a grant may name, for a person who reads the list. */
const APP_NAMES = { actor: 'OpenVibe.Actor', codes: 'OpenVibe.Codes', chat: 'OpenVibe.Chat', live: 'OpenVibe.Live', vision: 'OpenVibe.Vision' };
const appName = (id) => APP_NAMES[id] || id;
/** The link a service sends: /you?allow=<app>&provider=<provider>. Only a confirm button follows it; a POST changes it. */
function allowRequest(query) {
    const q = query || {};
    const service = String(q.allow || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{1,39}$/.test(service)) return null;
    const raw = String(q.provider == null ? '*' : q.provider).trim().toLowerCase();
    const provider = raw === '*' || raw === '' ? '*' : (/^[a-z][a-z0-9._-]{0,39}$/.test(raw) ? raw : null);
    if (!provider) return null;
    return { service, provider };
}

function page({ siteUrl, keys = [], prefs = {}, apps = [], allow = null, ok = '', error = '' }) {
    const mine = new Map(keys.map((k) => [k.provider, k]));
    const working = keys.filter((k) => k.status === 'ok').length;
    const keyForm = (id, k) => `<form method="post" action="/you/keys/${esc(id)}"><label>${k ? 'New key' : 'Key'}<input type="password" name="key" required minlength="8" maxlength="400" autocomplete="off" spellcheck="false" placeholder="${id === 'anthropic' ? 'sk-ant-…' : 'sk-…'}"></label>${id === 'custom' ? `<label>Base URL<input type="url" name="base_url" required placeholder="https://…/v1" autocomplete="off"></label>` : ''}<button class="you-btn is-go" type="submit">Save</button>${keysUrl(id) ? `<a class="you-btn" href="${esc(keysUrl(id))}" rel="noopener" target="_blank">Get a key ↗</a>` : ''}</form>`;
    const row = (id) => {
        const k = mine.get(id);
        const pill = k.status === 'ok' ? '<span class="you-pill is-ok">Working</span>'
                : k.status === 'failing' ? '<span class="you-pill is-bad">Not working</span>' : '<span class="you-pill">Not tested yet</span>';
        const note = [`…${esc(k.hint)}`, k.base_url ? esc(k.base_url) : '', k.models_count ? `${k.models_count} models` : '', k.checked_at ? `checked ${ago(k.checked_at)}` : '', k.status === 'failing' && k.last_error ? esc(String(k.last_error).slice(0, 140)) : ''].filter(Boolean).join(' · ');
        return `<li class="you-key"><div class="you-key-t"><b>${esc(providerName(id))}</b>${pill}</div>
<div class="you-acts"><form method="post" action="/you/keys/${esc(id)}/test"><button class="you-btn" type="submit">Test</button></form><form method="post" action="/you/keys/${esc(id)}/remove"><button class="you-btn" type="submit">Remove</button></form></div>
${note ? `<div class="you-key-n">${note}</div>` : ''}
<details class="you-add"><summary class="you-btn">Replace the key</summary>${keyForm(id, k)}</details></li>`;
    };
    const known = ORDER.filter((id) => CREDENTIAL_PROVIDERS.includes(id));
    const saved = known.filter((id) => mine.has(id));
    const toAdd = known.filter((id) => !mine.has(id));
    const addCard = (id) => `<li><details><summary>${esc(providerName(id))}<span>Add</span></summary>${keyForm(id, null)}</details></li>`;
    const only = prefs.only_my_keys === true;
    // L55 C3: the apps the person allowed to use their own key, and the one that is asking.
    const appRow = (g) => `<li class="you-key"><div class="you-key-t"><b>${esc(appName(g.service))}</b><span class="you-pill">${g.provider === '*' ? 'all your keys' : esc(providerName(g.provider))}</span></div>
<div class="you-acts"><form method="post" action="/you/apps/remove"><input type="hidden" name="service" value="${esc(g.service)}"><input type="hidden" name="provider" value="${esc(g.provider)}"><button class="you-btn" type="submit">Remove</button></form></div>
<div class="you-key-n">allowed ${esc(g.created_at ? ago(g.created_at) : 'just now')}</div></li>`;
    const appList = apps.length ? `<ul class="you-keys">${apps.map(appRow).join('')}</ul>` : '<p class="you-empty">No app may use your keys yet. An app that needs one asks you here, and never takes it by itself.</p>';
    const allowBlock = allow ? `<section aria-labelledby="you-allow"><h2 id="you-allow">Let ${esc(appName(allow.service))} use your ${allow.provider === '*' ? 'keys' : esc(providerName(allow.provider)) + ' key'}?</h2><p class="you-sub">${esc(appName(allow.service))} asked to run your work on your own key, so the call costs you nothing. No other app may use it, and you can take it away at any time.</p>
<form method="post" action="/you/apps/allow"><input type="hidden" name="service" value="${esc(allow.service)}"><input type="hidden" name="provider" value="${esc(allow.provider)}"><button class="you-btn is-go" type="submit">Allow</button></form></section>` : '';
    const body = `<p class="you-eye">Your AI</p><h1>Your keys, on every OpenVibe site.</h1>
<p class="you-lede">A key saved here works on every OpenVibe site and agent, with no fee, ever. It is sealed the moment it arrives; only its last four characters are ever shown again.</p>
<ul class="you-state"><li><b>${keys.length}</b> ${keys.length === 1 ? 'key' : 'keys'}${keys.length ? `, ${working} working` : ''}</li><li>${only ? '<b>Only your keys</b>' : 'Your keys first'}</li><li>Free tiers first: <b>${prefs.free_first === false ? 'off' : 'on'}</b></li></ul>
${ok ? `<p class="you-note is-ok" role="status">${esc(ok)}</p>` : ''}${error ? `<p class="you-note is-bad" role="alert">${esc(error)}</p>` : ''}
<section aria-labelledby="you-keys"><h2 id="you-keys">Your keys</h2><p class="you-sub">Each is tested when you save it: one tiny request, and the models it can reach. A key that stops working is marked here and never quietly swapped for a paid one.</p>
${saved.length ? `<ul class="you-keys">${saved.map(row).join('')}</ul>` : '<p class="you-empty">No keys yet. Add one below: Anthropic, OpenAI, Google or DeepSeek are good first ones.</p>'}
<h3 style="margin:22px 0 10px;font-size:15px">Add a key</h3>
<ul class="you-new">${toAdd.map(addCard).join('')}</ul></section>
${allowBlock}
<section aria-labelledby="you-pay"><h2 id="you-pay">How your AI is paid</h2><p class="you-sub">For every site and agent that runs AI for you.</p>
<form class="you-pay" method="post" action="/you/preferences">
<fieldset><legend>When none of your keys can do a job</legend>
<label class="you-opt"><input type="radio" name="only_my_keys" value="0"${only ? '' : ' checked'}><span><b>Use OpenVibe&rsquo;s allowance</b><small>Your keys always go first; a job none of them can do runs on the network&rsquo;s own, within its free allowance.</small></span></label>
<label class="you-opt"><input type="radio" name="only_my_keys" value="1"${only ? ' checked' : ''}><span><b>Only my keys</b><small>Nothing else ever pays for your AI. A job none of your keys can do stops and says which provider would do it.</small></span></label>
</fieldset>
<div class="you-row"><label class="you-opt" style="flex:1 1 260px"><input type="checkbox" name="free_first" value="1"${prefs.free_first === false ? '' : ' checked'}><span><b>Free tiers first</b><small>Use a provider&rsquo;s free tier before anything that costs.</small></span></label>
<label>Most per million tokens (USD)<input type="number" name="price_ceiling_usd_per_mtok" min="0" max="1000" step="0.01" value="${prefs.price_ceiling_usd_per_mtok == null ? '' : esc(prefs.price_ceiling_usd_per_mtok)}" placeholder="No limit"></label>
<button class="you-btn is-go" type="submit">Save</button></div>
</form></section>
<section aria-labelledby="you-apps"><h2 id="you-apps">Apps that may use my keys</h2><p class="you-sub">Only the apps you allow here may run on your own key. Nothing uses it by default, and a key never leaves OpenVibe.AI.</p>
${appList}</section>
<section aria-labelledby="you-cost"><h2 id="you-cost">What it cost</h2><p class="you-sub">Tokens, how much came from cache, what each call cost and whose key paid, across every site: <a href="https://openvibe.report/you">on openvibe.report</a>.</p></section>
<p class="you-fine">Removing a key deletes it from OpenVibe.AI. Keys are personal: one serves your own work and nobody else&rsquo;s. Sites and agents that run AI for you use these settings; the ones you have not opened never see your keys.</p>`;
    return frame({ siteUrl, title: 'Your AI', body });
}

function youPageRouter({ credentials, preferences, grants, personSessions, config, log = console }) {
    const r = express.Router();
    const form = express.urlencoded({ extended: false, limit: '4kb' });
    const site = new URL(config.baseUrl).origin;
    // A POST from this site only: Sec-Fetch-Site same-origin, or an Origin naming this site. Neither is refused.
    const sameSite = (req) => {
        const sfs = req.headers['sec-fetch-site'];
        if (sfs) return sfs === 'same-origin';
        const origin = req.headers.origin;
        if (!origin) return false;
        try { return new URL(origin).origin === site; } catch { return false; }
    };
    const headers = (res) => res.set({ 'Content-Security-Policy': HOME_CSP, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'same-origin' });
    const back = (res, q) => res.redirect(303, `/you?${new URLSearchParams(q)}`);
    async function person(req, res) {
        if (!personSessions) { headers(res).status(503).type('text/plain').send('Sign-in is not configured on this host.\n'); return null; }
        const viewer = await personSessions.read(req);
        if (!viewer) { res.redirect(303, `/auth/person/login?next=${encodeURIComponent('/you')}`); return null; }
        return viewer;
    }
    const guard = (fn) => [form, async (req, res) => {
        if (!sameSite(req)) return headers(res).status(403).type('text/plain').send('Open this form on ai.openvibe.services.\n');
        const viewer = await person(req, res);
        if (!viewer) return;
        try { await fn(req, res, viewer.subject); } catch (err) {
            const word = err && err.status && err.status < 500 ? err.message : 'That did not work this time; try again in a minute.';
            if (!err || !err.status || err.status >= 500) log.warn(`[you] ${req.path}: ${err && err.message}`);
            back(res, { error: String(word).slice(0, 200) });
        }
    }];

    r.get('/you', async (req, res) => {
        headers(res);
        const viewer = personSessions ? await personSessions.read(req) : null;
        if (!viewer) return res.type('html').send(signedOut({ siteUrl: config.baseUrl }));
        const [keys, prefs, apps] = await Promise.all([
            credentials.listSelf(viewer.subject).catch(() => []),
            preferences.get(viewer.subject).catch(() => ({})),
            grants.list(viewer.subject).catch(() => []),
        ]);
        res.type('html').send(page({ siteUrl: config.baseUrl, keys, prefs, apps, allow: allowRequest(req.query), ok: String(req.query.ok || '').slice(0, 200), error: String(req.query.error || '').slice(0, 200) }));
    });
    r.post('/you/keys/:provider', ...guard(async (req, res, subject) => {
        const id = req.params.provider;
        if (!CREDENTIAL_PROVIDERS.includes(id)) return back(res, { error: 'That provider is not one OpenVibe.AI knows.' });
        const body = { provider: id, key: String((req.body || {}).key || '').trim(), ...(id === 'custom' && req.body.base_url ? { base_url: String(req.body.base_url).trim() } : {}) };
        const out = await credentials.putSelf(subject, id, body);
        const tested = out.status === 'untested' && credentials.testSelf ? await credentials.testSelf(subject, id).catch(() => null) : null;
        const okNow = (tested ? tested.ok : out.status === 'ok');
        back(res, okNow ? { ok: `Saved your ${providerName(id)} key, and it works.` } : { error: `Saved your ${providerName(id)} key, but it did not work: ${String((tested && tested.error) || out.last_error || 'the provider refused it').slice(0, 120)}` });
    }));
    r.post('/you/keys/:provider/test', ...guard(async (req, res, subject) => {
        const out = await credentials.testSelf(subject, req.params.provider);
        back(res, out.ok ? { ok: `Your ${providerName(req.params.provider)} key works${out.models_count ? `: ${out.models_count} models` : ''}.` } : { error: `Your ${providerName(req.params.provider)} key did not work: ${String(out.error || 'the provider refused it').slice(0, 120)}` });
    }));
    r.post('/you/keys/:provider/remove', ...guard(async (req, res, subject) => {
        const gone = await credentials.removeSelf(subject, req.params.provider);
        back(res, gone ? { ok: `Removed your ${providerName(req.params.provider)} key.` } : { error: 'There was no key to remove.' });
    }));
    // L55 C3: the person allows an app to use their own key (one provider, or all of them). A POST on this site
    // only; the link an app sends (/you?allow=...) only shows the button.
    r.post('/you/apps/allow', ...guard(async (req, res, subject) => {
        const body = req.body || {};
        const service = String(body.service || '').trim().toLowerCase();
        const provider = String(body.provider == null ? '*' : body.provider).trim().toLowerCase() || '*';
        if (!/^[a-z][a-z0-9._-]{1,39}$/.test(service)) return back(res, { error: 'That is not an app name.' });
        await grants.allow(subject, service, provider);
        back(res, { ok: `${appName(service)} may use your ${provider === '*' ? 'keys' : providerName(provider) + ' key'} now.` });
    }));
    r.post('/you/apps/remove', ...guard(async (req, res, subject) => {
        const body = req.body || {};
        const service = String(body.service || '').trim().toLowerCase();
        const provider = body.provider == null || body.provider === '' ? null : String(body.provider).trim().toLowerCase();
        const gone = await grants.remove(subject, service, provider);
        back(res, { ok: gone ? `${appName(service)} may not use your keys any more.` : 'There was nothing to take away.' });
    }));
    r.post('/you/preferences', ...guard(async (req, res, subject) => {
        const b = req.body || {};
        const cur = await preferences.get(subject).catch(() => ({}));
        const ceiling = String(b.price_ceiling_usd_per_mtok || '').trim();
        await preferences.put(subject, {
            only_my_keys: b.only_my_keys === '1', free_first: b.free_first === '1',
            price_ceiling_usd_per_mtok: ceiling === '' ? null : Number(ceiling),
            defaults: cur.defaults || { text: 'auto', code: 'auto', vision: 'auto', image: 'auto' },
        });
        back(res, { ok: 'Saved how your AI is paid.' });
    }));
    return r;
}

module.exports = { youPageRouter, page, signedOut };
