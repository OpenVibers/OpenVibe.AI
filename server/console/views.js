'use strict';
/**
 * Server-rendered pages of the AI operator console. No JavaScript and no external resources: one
 * inline stylesheet allowed by its hash in the Content-Security-Policy. Every interpolated value is
 * HTML-escaped by the `html` tag unless it is itself `html`.
 *
 * Providers are shown as registry.publicProvider shows them: the secret reference NAME (env:NAME)
 * and whether it resolves (configured | missing | not_required), never a value; base URLs lose any
 * user info and query string. Run inputs and outputs arrive already bounded by queries.preview.
 */
const social = require('openvibe-shared/social');
const crypto = require('crypto');

class Raw { constructor(s) { this.s = s; } }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function render(v) {
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(render).join('');
    if (v == null || v === false) return '';
    return esc(v);
}
function html(strings, ...vals) {
    let out = strings[0];
    vals.forEach((v, i) => { out += render(v) + strings[i + 1]; });
    return new Raw(out);
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#15181d;--muted:#555e6c;--card:#fff;--line:#d5dae2;--accent:#1f5fd6;--on-accent:#fff;--ok:#11703b;--bad:#b3261e;--warn:#7a4f00;--warnbg:#fff4d6}
@media (prefers-color-scheme:dark){:root{--bg:#101318;--fg:#e8ebf0;--muted:#a3adbb;--card:#171b22;--line:#2d3440;--accent:#8ab2ff;--on-accent:#0b1220;--ok:#5fd394;--bad:#ff8a80;--warn:#ffcf66;--warnbg:#3a2e0b}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow-wrap:anywhere}
.skip{position:absolute;left:-9999px;top:0;background:var(--card);color:var(--fg);padding:8px 12px;z-index:2}.skip:focus{left:8px;top:8px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
header{background:var(--card);border-bottom:1px solid var(--line)}
.bar{max-width:1240px;margin:0 auto;padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center}
.brand{font-weight:700;margin-right:8px}nav ul{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0;padding:0;list-style:none}
nav a{color:var(--muted);text-decoration:none}nav a[aria-current=page],nav a:hover{color:var(--fg);text-decoration:underline}
.who{margin-left:auto;color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
main{max-width:1240px;margin:0 auto;padding:18px 16px 48px}
h1{font-size:22px;margin:4px 0 14px}h2{font-size:17px;margin:24px 0 8px}h3{font-size:15px;margin:16px 0 6px}
a{color:var(--accent)}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,.tablewrap:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 12px}
.grid .card{margin:0}.card .k{color:var(--muted);font-size:13px}.card .v{font-size:20px;font-weight:650}
.tablewrap{position:relative;overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 14px;max-width:100%}
table{border-collapse:collapse;width:100%;font-size:14px}caption{text-align:left;font-weight:650;padding:9px 10px 4px;caption-side:top}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}td{overflow-wrap:normal;word-break:normal}
th{color:var(--muted);font-weight:600;white-space:nowrap}tbody tr:last-child td{border-bottom:0}
code,.mono,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}td code,td .mono{overflow-wrap:break-word}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;max-height:420px;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 12px}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}.warn{color:var(--warn);font-weight:600}.muted{color:var(--muted)}.nowrap{white-space:nowrap}
.banner{padding:10px 14px;border-radius:8px;margin:0 0 14px;border:1px solid var(--line);background:var(--card)}
.banner.error{background:var(--warnbg);color:var(--warn);border-color:var(--warn)}.banner.done{border-color:var(--ok);color:var(--ok)}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;padding:0;list-style:none}.tabs a{display:inline-block;padding:4px 10px;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:var(--fg)}.tabs a[aria-current=page]{background:var(--fg);color:var(--bg)}
form.inline{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0}form.stack{display:grid;gap:10px;max-width:560px}
.filters{display:flex;flex-wrap:wrap;gap:10px 12px;align-items:flex-end;margin:0 0 14px}.filters label{flex:1 1 150px;min-width:0}.filters .actions{display:flex;gap:10px;align-items:center}
label{display:grid;gap:4px;font-size:14px}label.check{display:flex;gap:8px;align-items:flex-start}
input[type=text],input[type=number],input[type=date],input[type=datetime-local],select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);width:100%;min-width:0}
form.inline select{width:auto}
button{font:inherit;padding:6px 13px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent-strong, var(--accent, #3472d8));border-color:var(--accent-strong, var(--accent, #3472d8));color:var(--on-accent-strong, var(--on-accent))}button.danger{border-color:var(--bad);color:var(--bad)}
button.link{border:0;background:none;padding:0;color:var(--accent);text-decoration:underline}
a.button{display:inline-block;padding:6px 13px;border-radius:7px;background:var(--accent-strong, var(--accent, #3472d8));color:var(--on-accent-strong, var(--on-accent));text-decoration:none;font-weight:600}
tr.sub td{border-top:0;padding-top:0}input.num{width:7em}tr.sub details{margin:2px 0 8px}tr.sub form{margin:6px 0}
fieldset{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0;min-width:0}legend{padding:0 6px;font-weight:600}
dl{display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;min-width:0}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px;align-items:start}
details{margin:6px 0 12px}summary{cursor:pointer;color:var(--accent)}
.pager{display:flex;gap:14px;flex-wrap:wrap;margin:0 0 14px}.m0{margin:0}.mt{margin:10px 0 0}
@media (max-width:600px){.who{margin-left:0}h1{font-size:20px}}
`;
const CSS_HASH = `sha256-${crypto.createHash('sha256').update(CSS).digest('base64')}`;
// script-src/connect-src: only Cloudflare Web Analytics, whose beacon Cloudflare injects at the edge on this zone.
const CSP = `default-src 'none'; style-src '${CSS_HASH}'; img-src 'self'; script-src https://static.cloudflareinsights.com; connect-src https://cloudflareinsights.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

// ── Formatting ───────────────────────────────────────────────
const n = (v) => Number(v || 0).toLocaleString('en-US');
function usd(v) {
    const x = Number(v) || 0;
    if (x === 0) return '$0';
    return `$${x < 0.01 ? x.toFixed(6) : x.toFixed(x < 100 ? 4 : 2)}`;
}
const when = (s) => (s ? html`<time datetime="${s}">${String(s).replace('T', ' ').slice(0, 19)} UTC</time>` : '—');
/** A 0..1 EWMA as a percentage, or an em dash when it was never measured. */
const pct = (v) => (v == null ? '—' : `${(100 * Number(v)).toFixed(1)} %`);
function span(fromIso, toIso) {
    if (!fromIso || !toIso) return '';
    const ms = Date.parse(toIso) - Date.parse(fromIso);
    if (!Number.isFinite(ms) || ms < 0) return '';
    return ms < 1000 ? `${ms} ms` : ms < 120000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`;
}
function secs(s) {
    const v = Math.max(0, Number(s) || 0);
    return v < 120 ? `${v} s` : v < 7200 ? `${Math.round(v / 60)} min` : `${Math.round(v / 3600)} h`;
}
const clip = (s, max = 200) => { const t = String(s == null ? '' : s); return t.length > max ? `${t.slice(0, max)}…` : t; };
const GOOD = new Set(['succeeded', 'sent', 'active', 'closed', 'configured', 'ok', 'cached', 'not_required']);
const BAD = new Set(['failed', 'open', 'disabled', 'missing', 'error', 'timeout', 'archived']);
const badge = (s) => html`<span class="${GOOD.has(s) ? 'ok' : BAD.has(s) ? 'bad' : 'warn'}">${s || '—'}</span>`;
/** A base URL without user info, query or fragment (a key must never ride along in a URL shown here). */
function safeUrl(u) {
    if (!u) return '—';
    try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname}`; } catch { return '(unparseable URL)'; }
}
const qs = (params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : '';
};
const enc = encodeURIComponent;
const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

/** A table with a caption, inside a focusable scroll container (wide tables scroll, the page does not). */
function table(caption, head, rows, empty = 'None.') {
    if (!rows.length) return html`<div class="card"><p class="muted m0"><strong>${caption}:</strong> ${empty}</p></div>`;
    return html`<div class="tablewrap" role="region" tabindex="0" aria-label="${caption}"><table><caption>${caption}</caption>
<thead><tr>${head.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

const NAV = [
    ['/console', 'Overview', 'overview'], ['/console/providers', 'AI providers', 'providers'], ['/console/routes', 'Routing rules', 'routes'],
    ['/console/templates', 'Prompt templates', 'templates'], ['/console/workflows', 'Saved AI tasks', 'workflows'], ['/console/runs', 'Runs', 'runs'],
    ['/console/quotas', 'Limits', 'quotas'], ['/console/usage', 'Usage', 'usage'], ['/console/cache', 'Cache', 'cache'], ['/console/abuse', 'Abuse', 'abuse'], ['/console/audit', 'Audit', 'audit'],
    ['/console/gpus', 'GPUs', 'gpus'],
    ['/console/pricebook', 'Prices', 'pricebook'],
    ['/console/glossary', 'What words mean', 'glossary'],
];

// ── Plain words (the owner-setup design, section 3) ──────────
/** A provider's health as a sentence, never a circuit code (closed / open / half_open stay in grey after it). */
function healthText(h, { breaker = {}, now = Date.now() } = {}) {
    const st = (h && h.state) || 'closed';
    if (st === 'closed') return { text: h && h.consecutive_failures ? `Working (${h.consecutive_failures} error${h.consecutive_failures === 1 ? '' : 's'} in a row so far)` : 'Working', cls: 'ok' };
    if (st === 'half_open') return { text: 'Testing again: the next request tries it once', cls: 'warn' };
    const cooldown = h.exhausted_at ? Number(breaker.exhaustedCooldownMs || 600000) : Number(breaker.cooldownMs || 60000);
    const at = h.opened_at ? new Date(Number(h.opened_at) + cooldown) : null;
    const hhmm = at && Number.isFinite(at.getTime()) ? `${at.toISOString().slice(11, 16)} UTC` : 'soon';
    const why = h.exhausted_at ? 'the provider says the account is out of balance' : `${h.consecutive_failures || 1} error${(h.consecutive_failures || 1) === 1 ? '' : 's'} in a row`;
    void now;
    return { text: `Paused after ${why}; tries again at ${hhmm}`, cls: 'bad' };
}
/** Where a provider's key comes from, in words: entered here, the server's settings file, not set or not needed. */
function keyText(p, hint) {
    if (p.credentials === 'not_required' || p.auth_mode === 'none') return html`<span class="muted">Not needed</span>`;
    const ref = /^env:([A-Z][A-Z0-9_]*)$/.exec(String(p.secret_ref || ''));
    if (hint) return html`<span class="ok">Entered here, locked</span><br><span class="muted">ends ${hint.hint}, set ${when(hint.updated_at)}</span>`;
    if (p.credentials === 'configured' && ref) return html`<span class="ok">From the server's settings file</span> (<code>${ref[1]}</code>)`;
    if (p.credentials === 'configured') return html`<span class="ok">Entered here, locked</span>`;
    return html`<span class="bad">Not set</span>${ref ? html`<br><span class="muted">the settings file has no <code>${ref[1]}</code></span>` : ''}`;
}
/** A billing profile in words. */
const BILLING_WORDS = { metered: 'Spends Credits per request', subscription: 'A plan with a monthly fee shared by everyone', prepaid: 'A prepaid balance at the provider', payg: 'A prepaid balance at the provider', free: 'Free', customer_byok: "The person's own key pays", byok: "The person's own key pays" };
/** What a provider's terms allow, in words. */
const ACCESS_WORDS = { OWN_DEPLOYMENT: 'Runs on our own machine: no provider terms', AUTHORIZED_WHOLESALE: 'Our agreement allows reselling it', CUSTOMER_BYOK: "Only with the person's own key", RESTRICTED: 'Do not sell: their terms forbid it', UNVERIFIED: 'Not checked yet: treated as Do not sell' };
const billingText = (p) => BILLING_WORDS[String((p.billing_profile || (p.metadata && p.metadata.billing_profile) || '')).toLowerCase()] || '';
const accessText = (p) => ACCESS_WORDS[String(p.provider_access || 'UNVERIFIED').toUpperCase()] || '';
/** The queue as a sentence. */
const queueText = (q) => `Doing ${n(q.running)} now, ${n(q.queued)} waiting. At most ${n(q.max_concurrent)} at once; more wait in line (up to ${n(q.max_queued)}).`;
const STUB_WORDS = 'For testing only. When on, people get a canned answer instead of an error.';
/** The words that must stay, each with one line (the console's glossary page, and the admin panel's). */
const GLOSSARY = [
    ['Credits', 'What people spend on AI. A paid request holds Credits before it runs and spends what it used after.'],
    ['BYOK (bring your own key)', "A person's own provider key: their requests run on it and their provider bills them, not OpenVibe."],
    ['Resale', "Selling a provider's models to other people. Only providers whose terms allow it (\"Our agreement allows reselling it\") are offered to others."],
    ['Cache', 'A stored answer. The same request, from the same person, for the same task and versions, gets it back without paying a provider again.'],
    ['Limit (quota)', 'The most requests, tokens or dollars one service, person or app may use in a minute, hour or day. Past it, requests are refused until the window resets.'],
    ['Saved AI task (workflow)', 'A named job such as "summarize a stream", made of steps, each using a prompt template and a routing rule.'],
    ['Prompt template', 'The words sent to the model for a task, with blanks the request fills in.'],
    ['Routing rule (route)', 'Which providers and models may answer a task, and in what order they are tried when one fails.'],
    ['Token', 'The unit models read and write, about three quarters of a word. Prices are per million tokens.'],
    ['Health', 'Whether a provider is answering. After several errors in a row it is paused for a while so requests go elsewhere, then tried once again.'],
    ['Practice answers', 'Canned answers from a built-in test provider, used only when every real provider fails and the switch is on. For testing, never for people.'],
];

// The console's pages are noindex; the one public page drawn with this layout (/stats) passes robots, a description and
// its canonical, and gets the share tags (the site's card from openvibe-shared/social) a shared link needs.
function shareTags({ title, description, canonical }) {
    const image = new URL(social.url('ai') || '/shared/social/ai.jpg', canonical).href;
    return html`<meta property="og:type" content="website"><meta property="og:site_name" content="OpenVibe.AI"><meta property="og:title" content="${title}">${description ? html`<meta property="og:description" content="${description}">` : ''}<meta property="og:url" content="${canonical}"><meta property="og:image" content="${image}"><meta name="twitter:card" content="summary_large_image">`;
}
function layout({ title, section, staff, csrf, notice, error, body, site = 'operator console', robots = 'noindex,nofollow', description = null, canonical = null }) {
    const nav = staff && staff.exchange ? [...NAV, ['/console/exchange', 'Exchange', 'exchange']] : NAV;
    return `<!doctype html>${render(html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="${robots}">${description ? html`<meta name="description" content="${description}">` : ''}${canonical ? html`<link rel="canonical" href="${canonical}">${shareTags({ title: `${title} · AI ${site}`, description, canonical })}` : ''}<meta name="referrer" content="no-referrer"><title>${title} · AI ${site}</title><style>${new Raw(CSS)}</style></head>
<body><a class="skip" href="#main">Skip to content</a><header><div class="bar"><span class="brand">OpenVibe.AI · ${site}</span>
${staff ? html`<nav aria-label="Console"><ul>${nav.map(([href, label, id]) => html`<li><a href="${href}"${id === section ? html` aria-current="page"` : ''}>${label}</a></li>`)}</ul></nav>
<div class="who"><span>${staff.username ? `@${staff.username} ` : ''}<code>${staff.subject}</code> · ${staff.role}</span>
<form class="inline" method="post" action="/auth/logout">${csrfField(csrf)}<button class="link" type="submit">Sign out</button></form></div>` : ''}
</div></header><main id="main" tabindex="-1">
${notice ? html`<div class="banner done" role="status">${notice}</div>` : ''}
${error ? html`<div class="banner error" role="alert"><strong>Refused:</strong> ${error}</div>` : ''}
${body}
</main></body></html>`)}`;
}

// ── Pages ────────────────────────────────────────────────────
function signIn({ next, message }) {
    const href = `/auth/login${next && next !== '/console' ? `?next=${enc(next)}` : ''}`;
    return layout({
        title: 'Sign in', body: html`<h1>AI operator console</h1>
<div class="card"><p>${message || 'Sign in with your OpenVibe.Network account. Only network staff (admins and the owner) can use this console.'}</p>
<p><a href="${href}">Sign in with OpenVibe.Network</a></p></div>`,
    });
}

function message({ title, text, staff, csrf, back = '/console', site = 'operator console' }) {
    return layout({ title, staff, csrf, site, body: html`<h1>${title}</h1><div class="card"><p>${text}</p><p><a href="${back}">Back</a></p></div>` });
}

const CAP_LABELS = {
    'ai.usage.read': 'read everything here (ai.usage.read)',
    'ai.workflow.manage': 'change route, template and workflow version status; cancel runs (ai.workflow.manage)',
    'ai.provider.manage': 'enable/disable providers, reset circuits, edit quotas, purge the cache (ai.provider.manage)',
};

function overview({ staff, csrf, st, counts24, failures24, queue, cacheTotals, problems, stubFallback, topQuotas }) {
    const runs24 = Object.values(counts24).reduce((a, b) => a + b, 0);
    return layout({
        title: 'Overview', section: 'overview', staff, csrf, body: html`<h1>Overview</h1>
<p class="muted">How OpenVibe's AI is doing right now: which providers answer, what ran and failed today, and what it cost. Come here first when something seems slow or wrong; each card links to the page that explains it.</p>
<div class="card"><p class="m0">This session may: ${staff.caps.map((c, i) => html`${i ? '; ' : ''}${CAP_LABELS[c] || c}`)}.</p></div>
<div class="grid">
<div class="card"><div class="k">AI providers</div><div class="v">${n(st.providers.filter((p) => p.status === 'active').length)} switched on</div>
<div class="muted">${problems.length ? html`<span class="bad">${problems.length} need${problems.length === 1 ? 's' : ''} attention</span>` : 'every key works and none is paused'}</div>
<div class="muted">Practice answers when every provider fails: <strong>${stubFallback ? 'on' : 'off'}</strong>. ${STUB_WORDS}</div><a href="/console/providers">AI providers</a></div>
<div class="card"><div class="k">Runs, last 24 h</div><div class="v">${n(runs24)}</div>
<div class="muted">${Object.entries(counts24).map(([s, c], i) => html`${i ? ' · ' : ''}${s} ${n(c)}`)}</div><a href="/console/runs">Runs</a></div>
<div class="card"><div class="k">Failed, last 24 h</div><div class="v">${counts24.failed ? html`<span class="bad">${n(counts24.failed)}</span>` : '0'}</div>
<div class="muted">${failures24.length ? failures24.slice(0, 3).map((f, i) => html`${i ? ' · ' : ''}${f.error_code || '(none)'} ${n(f.n)}`) : 'none'}</div><a href="/console/runs?status=failed">Failed runs</a></div>
<div class="card"><div class="k">Spend today (${st.today.day})</div><div class="v">${usd(st.today.cost_usd)}</div><div class="muted">${n(st.today.requests)} provider requests</div><a href="/console/usage">Usage</a></div>
<div class="card"><div class="k">Queue</div><div class="v">${n(queue.running)} running</div><div class="muted">${queueText(queue)}</div></div>
<div class="card"><div class="k">Saved AI tasks</div><div class="v">${n(st.workflows)}</div><div class="muted">${n(st.templates)} prompt templates · ${n(st.routes)} routing rules. A saved task runs prompt templates on the providers its routing rule allows.</div><a href="/console/workflows">Saved AI tasks</a></div>
<div class="card"><div class="k">Cache</div><div class="v">${n(cacheTotals.entries)} entries</div><div class="muted">${n(cacheTotals.hits)} hits served</div><a href="/console/cache">Cache</a></div>
</div>
<h2>Needs attention</h2>
${table('Provider problems', ['Provider', 'Kind', 'What is wrong'], problems.map((p) => html`<tr><td><code>${p.key}</code></td><td>${p.kind}</td><td class="bad">${p.problem}</td></tr>`), 'none: every switched-on provider has a key and is answering.')}
${table('Failed runs in the last 24 hours, by error code', ['Error code', 'Runs', 'Workflows', 'Last'], failures24.map((f) => html`<tr>
<td><a href="/console/runs${qs({ status: 'failed', code: f.error_code })}"><code>${f.error_code || '(none)'}</code></a></td><td>${n(f.n)}</td><td>${n(f.workflows)}</td><td>${when(f.last_at)}</td></tr>`), 'no failed runs.')}
${table('Limits closest to running out', ['Who it limits', 'Window', 'Used', 'Limit', 'Resets in'], topQuotas.map((c) => html`<tr>
<td>${scopeText(c.quota.scope_type, c.scope_id)}${c.quota.workflow_prefix ? html` · tasks starting <code>${c.quota.workflow_prefix}</code>` : ''}</td><td>${WINDOW_WORDS[c.quota.window] || c.quota.window}</td>
<td>${limitsUsed(c)}</td><td>${limits(c.quota)}</td><td>${secs(c.resets_in_seconds)}</td></tr>`), 'no limit is set.')}`,
    });
}

/** Who a limit applies to, in words; the scope type and id stay in code after it. */
const SCOPE_WORDS = {
    global: { label: 'Everyone together', line: 'One shared limit for every request to AI.' },
    service: { label: 'One OpenVibe service', line: 'A service such as Live or Codes; * gives every service its own limit.' },
    actor: { label: 'One person or agent', line: 'The person or agent a request is made for; * gives each one their own limit.' },
    attribution: { label: "One app's user", line: 'A user of a service as that service names them (live:user:42); * gives each their own limit.' },
};
const WINDOW_WORDS = { minute: 'per minute', hour: 'per hour', day: 'per day (UTC)' };
function scopeText(type, id) {
    const w = SCOPE_WORDS[type];
    const who = id === '*' ? (type === 'global' ? '' : ', each on its own') : '';
    return html`${w ? w.label : type}${who} <code>${id}</code>`;
}

function limits(q) {
    const parts = [];
    if (q.max_requests != null) parts.push(`${n(q.max_requests)} requests`);
    if (q.max_tokens != null) parts.push(`${n(q.max_tokens)} tokens`);
    if (q.max_cost_usd != null) parts.push(usd(q.max_cost_usd));
    return parts.join(' · ') || 'no limit set';
}
function limitsUsed(c) {
    const q = c.quota;
    const pct = (used, max) => (max ? ` (${Math.min(999, Math.round((used / max) * 100))}%)` : '');
    const parts = [];
    if (q.max_requests != null) parts.push(`${n(c.used.requests)} requests${pct(c.used.requests, q.max_requests)}`);
    if (q.max_tokens != null) parts.push(`${n(c.used.tokens)} tokens${pct(c.used.tokens, q.max_tokens)}`);
    if (q.max_cost_usd != null) parts.push(`${usd(c.used.cost_usd)}${pct(c.used.cost_usd, q.max_cost_usd)}`);
    return parts.join(' · ') || `${n(c.used.requests)} requests`;
}

function providers({ staff, csrf, rows, models, canManage, stubFallback, notice, error, keyHints = new Map(), breaker = {}, now = Date.now() }) {
    const healthCell = (p) => {
        const h = healthText(p.health, { breaker, now });
        return html`<span class="${h.cls}">${h.text}</span> <span class="muted">${(p.health && p.health.state) || 'closed'}</span>${p.health && p.health.last_error ? html`<br><span class="muted">last error: ${clip(p.health.last_error, 160)}</span>` : ''}`;
    };
    const termsCell = (p) => {
        const b = billingText(p);
        const a = accessText(p);
        return html`${b || '—'}${a ? html`<br><span class="muted">${a}</span>` : ''}`;
    };
    const manageRow = (p) => (canManage && p.kind !== 'stub' && p.kind !== 'whisper' ? html`<tr class="sub"><td colspan="10"><details><summary>Key and models for <code>${p.key}</code></summary>
<form class="inline" method="post" action="/console/providers/${enc(p.key)}/sync">${csrfField(csrf)}<button type="submit">Read its model list</button> <span class="muted">every model it offers, described (what it does, how strong); new ones arrive switched off</span></form>
<form class="inline" method="post" action="/console/providers/${enc(p.key)}/key">${csrfField(csrf)}<label>New API key <input type="password" name="api_key" required minlength="8" autocomplete="off" spellcheck="false"></label><button type="submit">Replace key</button></form>
<form class="inline" method="post" action="/console/providers/${enc(p.key)}/models">${csrfField(csrf)}<label>Model <input type="text" name="model_key" required maxlength="200" placeholder="deepseek-flash" spellcheck="false"></label>
<label><input type="checkbox" name="vision" value="1"> reads pictures</label> <label><input type="checkbox" name="tools" value="1"> tools</label>
<label>Price per million words read (input), in dollars <input type="number" name="cost_in" step="0.0001" min="0" class="num"></label> <label>Price per million words written (output), in dollars <input type="number" name="cost_out" step="0.0001" min="0" class="num"></label>
<label>Price per million words read from cache, in dollars <input type="number" name="cost_cache_read" step="0.0001" min="0" class="num"></label> <label>Price per million words written to cache, in dollars <input type="number" name="cost_cache_write" step="0.0001" min="0" class="num"></label>
<label>from the price page <input type="url" name="price_source" placeholder="https://…/pricing"></label><button type="submit">Register model</button></form></details></td></tr>` : '');
    return layout({
        title: 'AI providers', section: 'providers', staff, csrf, notice, error, body: html`<h1>AI providers</h1>
<p class="muted">The companies whose models OpenVibe can use, and the key for each. Add one to make its models available; a provider with no working key is skipped.</p>
${canManage ? html`<p><a class="button" href="/console/providers/new">Add a provider</a> <span class="muted">DeepSeek, OpenRouter, Groq, Gemini, Mistral, Together, Fireworks, Cerebras, xAI, OpenAI, Anthropic or any OpenAI-compatible API. Then choose it on a routing rule's page.</span></p>` : ''}
<p class="muted">A key entered here is locked with AI's own lock key, bound to the provider's address and never shown again (only its last four characters). A key from the server's settings file is named, never shown. When a provider fails, the request goes to the next one in this order.</p>
<div class="card"><p class="m0">Practice answers when every provider fails: <strong>${stubFallback ? 'on' : 'off'}</strong> <span class="muted">(<code>AI_STUB_FALLBACK</code>)</span>. ${STUB_WORDS}</p></div>
${table('AI providers, in the order they are tried', ['Provider', 'Kind', 'Status', 'Key', 'Health', 'Who pays · terms', 'Base URL', 'Default model', 'Can do', 'Order · time limit', ...(canManage ? ['Actions'] : [])], rows.map((p) => html`<tr>
<td><code>${p.key}</code><br><span class="muted">${p.display_name}</span></td><td>${p.kind}</td><td>${p.status === 'active' ? html`<span class="ok">On</span>` : html`<span class="bad">Off</span>`}</td>
<td>${keyText(p, keyHints.get(p.key))}</td>
<td>${healthCell(p)}</td><td>${termsCell(p)}</td>
<td class="mono">${safeUrl(p.base_url)}</td><td>${p.default_model ? html`<code>${p.default_model}</code>` : '—'}</td><td>${(p.capabilities || []).join(', ') || '—'}</td>
<td>${n(p.priority)} · ${n(Math.round((p.timeout_ms || 0) / 1000))} s<br><span class="muted">${p.origin}, updated ${when(p.updated_at)}</span></td>
${canManage ? html`<td><form class="inline" method="post" action="/console/providers/${enc(p.key)}/status">${csrfField(csrf)}<input type="hidden" name="status" value="${p.status === 'active' ? 'disabled' : 'active'}"><button type="submit" class="${p.status === 'active' ? 'danger' : ''}">${p.status === 'active' ? 'Disable' : 'Enable'}<span class="sr-only"> ${p.key}</span></button></form>
${p.health.state !== 'closed' || p.health.consecutive_failures ? html` <form class="inline" method="post" action="/console/providers/${enc(p.key)}/reset">${csrfField(csrf)}<button type="submit">Try it again now<span class="sr-only"> (${p.key})</span></button></form>` : ''}</td>` : ''}
</tr>${manageRow(p)}`), 'no providers yet. Add DeepSeek to start: Add a provider.')}
${canManage ? '' : html`<p class="muted">Switching providers on and off and trying a paused one again need <code>ai.provider.manage</code> (the owner's <code>staff.secrets.manage</code>).</p>`}
${table('Models', ['Provider', 'Model', 'Type', 'Status', 'Strength', 'Context / longest answer (tokens)', 'Price per million words, in dollars (read / written / read from cache / written to cache)', 'Supports'], models.map((m) => html`<tr>
<td><code>${m.provider_key}</code></td><td><code>${m.model_key}</code>${m.display_name && m.display_name !== m.model_key ? html`<br><span class="muted">${m.display_name}</span>` : ''}</td><td>${m.type}</td>
<td>${badge(m.status)}${m.metadata && m.metadata.missing_since ? html`<br><span class="muted">no longer listed since ${when(m.metadata.missing_since)}</span>` : ''}${canManage ? html`<form class="inline" method="post" action="/console/models/${enc(m.provider_key)}/${enc(m.model_key)}/status">${csrfField(csrf)}<input type="hidden" name="status" value="${m.status === 'active' ? 'disabled' : 'active'}"><button type="submit">${m.status === 'active' ? 'Turn off' : 'Turn on'}<span class="sr-only"> ${m.model_key}</span></button></form>` : ''}</td>
<td>${m.metadata && m.metadata.tier ? html`${m.metadata.tier}${m.metadata.reasoning ? ', thinks first' : ''}${m.metadata.note ? html`<br><span class="muted">${m.metadata.note}</span>` : ''}` : '—'}</td>
<td>${m.context_window ? n(m.context_window) : '—'} / ${m.max_output ? n(m.max_output) : '—'}</td>
<td>${m.cost.in_per_mtok != null ? usd(m.cost.in_per_mtok) : '—'} / ${m.cost.out_per_mtok != null ? usd(m.cost.out_per_mtok) : '—'} / ${m.cost.cached_per_mtok != null ? usd(m.cost.cached_per_mtok) : '—'} / ${m.cost.cache_write_per_mtok != null ? usd(m.cost.cache_write_per_mtok) : '—'}</td>
<td>${Object.entries(m.supports).filter(([, v]) => v).map(([k]) => k).join(', ') || '—'}</td></tr>`), 'no models registered (providers use their default model).')}`,
    });
}

function providerNew({ staff, csrf, presets, preset, vaultReady, notice, error }) {
    const p = preset || presets.find((x) => x.id === 'deepseek');
    return layout({
        title: 'Add a provider', section: 'providers', staff, csrf, notice, error, body: html`<h1>Add a provider</h1>
<p class="muted">Pick a provider, paste an API key from its site and name its default model. The key is sealed in AI's configuration store, bound to the provider's origin, and never shown again (only its last four characters). Nothing uses the provider until you choose it on a route's page.</p>
${vaultReady ? '' : html`<p class="bad">Keys cannot be stored on this server: the configuration store is unavailable.</p>`}
<nav aria-label="Providers"><ul class="tabs">${presets.map((x) => html`<li><a href="/console/providers/new?preset=${enc(x.id)}"${x.id === p.id ? html` aria-current="page"` : ''}>${x.name}</a></li>`)}</ul></nav>
<form method="post" action="/console/providers" class="stack">${csrfField(csrf)}<input type="hidden" name="preset" value="${p.id}">
<label>Name in OpenVibe <input type="text" name="key" required pattern="[a-z0-9][a-z0-9._-]{1,40}" value="${p.id === 'custom' ? '' : p.id}" spellcheck="false"></label>
<label>Shown as <input type="text" name="display_name" maxlength="80" value="${p.id === 'custom' ? '' : p.name}"></label>
<label>Base URL <input type="url" name="base_url" required value="${p.base_url}" placeholder="https://api.example.com/v1" spellcheck="false"></label>
<label>API key <input type="password" name="api_key" required minlength="8" autocomplete="off" spellcheck="false"></label>${p.keys ? html` <span class="muted">Get one at <a href="${p.keys}" rel="noopener noreferrer">${safeUrl(p.keys)}</a></span>` : ''}
<label>Default model <input type="text" name="default_model" value="${p.model}" placeholder="the model id the provider uses" spellcheck="false"></label>
<label><input type="checkbox" name="vision" value="1"> Its default model reads pictures</label>
<p><button type="submit"${vaultReady ? '' : html` disabled`}>Add ${p.id === 'custom' ? 'the provider' : p.name}</button> <a href="/console/providers">Back</a></p></form>`,
    });
}

const KINDS = {
    routes: { one: 'routing rule', title: 'Routing rules', statuses: ['active', 'disabled'], line: 'A routing rule says which providers and models may answer a task, and in what order they are tried when one fails. Change one to move a task to a cheaper or stronger model.' },
    templates: { one: 'prompt template', title: 'Prompt templates', statuses: ['draft', 'active', 'deprecated', 'archived'], line: 'A prompt template is the words sent to the model for a task, with blanks the request fills in. Change one when answers need different instructions.' },
    workflows: { one: 'saved AI task', title: 'Saved AI tasks', statuses: ['draft', 'active', 'deprecated', 'archived'], line: 'A saved AI task is a named job (summarize a stream, describe a picture) made of steps, each using a prompt template and a routing rule. Services ask for a task by its name.' },
};
const target = (c) => (c ? html`<code>${c.provider}</code>${c.model ? html` / <code>${c.model}</code>` : ''}` : '—');

/** BENCH-11: the evidence an opted-in route used, read-only. Never a form: changing policy is an API edit. */
function benchBlock(bench) {
    if (!bench) return '';
    if (!bench.enabled) return html`<h2>Bench evidence</h2><p class="muted">Learn from Bench is off for this route (<code>learn_from_bench: false</code>); placement keeps its own order.</p>`;
    const rows = bench.evidence || [];
    const tied = new Set((bench.tied || []).map((x) => `${x.provider || ''}|${x.model}`));
    const body = rows.map((r) => html`<tr><td><code>${r.model}</code>${bench.selected && bench.selected.model === r.model ? html` <span class="ok">selected</span>` : tied.has(`${r.provider || ''}|${r.model}`) ? html` <span class="muted">tied</span>` : ''}</td>
<td>${r.provider ? html`<code>${r.provider}</code>` : html`<span class="muted">any</span>`}</td><td>${r.rating == null ? '—' : n(r.rating)}</td>
<td>${r.interval ? `${n(r.interval.lower)} – ${n(r.interval.upper)}` : '—'}</td><td>${n(r.games)}${r.provisional ? ' (provisional)' : ''}</td>
<td>${r.cost_per_solved == null ? '—' : `$${r.cost_per_solved}`}</td><td>${r.updated_at ? when(r.updated_at) : '—'}</td></tr>`);
    return html`<h2>Bench evidence</h2>
<p class="muted">Read-only. ${bench.kind_id ? html`Board <code>${bench.kind_id}</code>` : 'No board named'} · category <code>${bench.category}</code>.
Provisional ratings (under 10 games) never decide a route.</p>
<p><strong>Why:</strong> ${bench.reason}</p>
${bench.leader ? html`<p>Leader: <code>${bench.leader.model}</code> at ${n(bench.leader.rating)} (${n(bench.leader.games)} games, interval ${bench.leader.interval ? `${n(bench.leader.interval.lower)} – ${n(bench.leader.interval.upper)}` : '—'}).</p>` : ''}
${rows.length ? table('Evidence used', ['Model', 'Provider', 'Rating', 'Interval', 'Games', 'Cost / solved', 'Updated'], body, 'no evidence.') : html`<p class="muted">No evidence yet: routing keeps its current order.</p>`}`;
}

function definitions({ staff, csrf, kind, rows, inUse }) {
    const k = KINDS[kind];
    const link = (key) => html`<a href="/console/${kind}/${enc(key)}"><code>${key}</code></a>`;
    const used = (r) => (inUse.get(r.key) ? `v${inUse.get(r.key)}` : html`<span class="bad">none</span>`);
    let head, body;
    if (kind === 'routes') {
        head = ['Route', 'Newest', 'Status', 'Primary', 'Fallbacks, in order', 'Format / timeout', 'Created'];
        body = rows.map((r) => html`<tr><td>${link(r.key)}</td><td>v${r.version}</td><td>${badge(r.status)}</td>
<td>${r.alias_of ? html`alias of <a href="/console/routes/${enc(r.alias_of)}"><code>${r.alias_of}</code></a>` : target(r.primary)}</td>
<td>${r.alias_of ? '—' : r.fallbacks.length ? r.fallbacks.map((f, i) => html`${i ? ' → ' : ''}${target(f)}`) : html`<span class="warn">none</span>`}</td>
<td>${r.response_format}${r.timeout_ms ? ` · ${n(r.timeout_ms)} ms` : ''}</td><td>${r.created_by || '—'}<br>${when(r.created_at)}</td></tr>`);
    } else if (kind === 'templates') {
        head = ['Template', 'Newest', 'Status', 'In use', 'Name', 'Default route', 'Owner / visibility', 'Created'];
        body = rows.map((t) => html`<tr><td>${link(t.key)}</td><td>v${t.version}</td><td>${badge(t.status)}</td><td>${used(t)}</td><td>${t.name}</td>
<td>${t.default_route ? html`<code>${t.default_route}</code>` : '—'}</td><td>${t.owner} · ${t.visibility}</td><td>${t.created_by || '—'}<br>${when(t.created_at)}</td></tr>`);
    } else {
        head = ['Workflow', 'Newest', 'Status', 'In use', 'Namespace', 'Steps', 'Cache', 'Default route', 'Created'];
        body = rows.map((w) => html`<tr><td>${link(w.key)}</td><td>v${w.version}</td><td>${badge(w.status)}</td><td>${used(w)}</td><td>${w.namespace}</td>
<td>${(w.steps || []).map((s) => s.kind + (s.template ? ` (${s.template})` : '')).join(', ')}</td><td>${w.cache_mode}${w.cache_ttl_sec ? ` · ${secs(w.cache_ttl_sec)}` : ''}</td>
<td>${w.default_route ? html`<code>${w.default_route}</code>` : '—'}</td><td>${w.created_by || '—'}<br>${when(w.created_at)}</td></tr>`);
    }
    return layout({
        title: k.title, section: kind, staff, csrf, body: html`<h1>${k.title}</h1>
<p class="muted">${k.line}</p>
<p class="muted">Every edit is a new version and old versions stay readable; runs record the versions they used. ${kind === 'routes'
            ? 'A route runs its newest version, which must be active.'
            : 'Runs use the newest active version ("in use"); a newer draft is not used until it is made active.'} Versions are created through the admin API (<code>POST /api/v1/${kind}/:key/versions</code>).</p>
${table(`${k.title} (newest version of each)`, head, body, `no ${kind}.`)}`,
    });
}

function definition({ staff, csrf, kind, key, versions, selected, inUse, canManage, notice, error, canChoose = false, providers = [], models = [], bench = null }) {
    const k = KINDS[kind];
    const v = selected;
    let content;
    if (kind === 'routes') {
        content = html`<dl><dt>Status</dt><dd>${badge(v.status)}</dd>
${v.alias_of ? html`<dt>Alias of</dt><dd><a href="/console/routes/${enc(v.alias_of)}"><code>${v.alias_of}</code></a></dd>` : html`<dt>Primary</dt><dd>${target(v.primary)}</dd>
<dt>Fallbacks</dt><dd>${v.fallbacks.length ? html`<ol>${v.fallbacks.map((f) => html`<li>${target(f)}</li>`)}</ol>` : html`<span class="warn">none: an outage of the primary fails every run on this route</span>`}</dd>`}
<dt>Learn from Bench</dt><dd>${v.learn_from_bench ? html`on${v.bench_kind ? html` · board <code>${v.bench_kind}</code>` : ''}${v.bench_category ? html` · category <code>${v.bench_category}</code>` : ''}` : 'off'}</dd>
<dt>Response format</dt><dd>${v.response_format}</dd><dt>Max output tokens</dt><dd>${v.max_output_tokens != null ? n(v.max_output_tokens) : '—'}</dd>
<dt>Timeout</dt><dd>${v.timeout_ms ? `${n(v.timeout_ms)} ms` : 'provider default'}</dd><dt>Created</dt><dd>${v.created_by || '—'}, ${when(v.created_at)}</dd></dl>
<h3>Options</h3><pre>${JSON.stringify(v.options || {}, null, 2)}</pre>
${benchBlock(bench)}`;
    } else if (kind === 'templates') {
        content = html`<dl><dt>Status</dt><dd>${badge(v.status)}</dd><dt>Name</dt><dd>${v.name}</dd><dt>Description</dt><dd>${v.description || '—'}</dd>
<dt>Default route</dt><dd>${v.default_route ? html`<a href="/console/routes/${enc(v.default_route)}"><code>${v.default_route}</code></a>` : '—'}</dd>
<dt>Owner / visibility</dt><dd>${v.owner} · ${v.visibility}</dd><dt>Created</dt><dd>${v.created_by || '—'}, ${when(v.created_at)}</dd></dl>
<h3>System prompt</h3><pre>${v.system_prompt || '(empty)'}</pre><h3>User prompt</h3><pre>${v.user_prompt || '(empty)'}</pre>
<details><summary>Input schema</summary><pre>${JSON.stringify(v.input_schema, null, 2)}</pre></details>
<details><summary>Output schema</summary><pre>${JSON.stringify(v.output_schema, null, 2)}</pre></details>
<details><summary>Metadata</summary><pre>${JSON.stringify(v.metadata || {}, null, 2)}</pre></details>`;
    } else {
        content = html`<dl><dt>Status</dt><dd>${badge(v.status)}</dd><dt>Name</dt><dd>${v.name}</dd><dt>Description</dt><dd>${v.description || '—'}</dd>
<dt>Namespace</dt><dd>${v.namespace}</dd><dt>Default route</dt><dd>${v.default_route ? html`<a href="/console/routes/${enc(v.default_route)}"><code>${v.default_route}</code></a>` : '—'}</dd>
<dt>Cache</dt><dd>${v.cache_mode}${v.cache_ttl_sec ? ` · ${secs(v.cache_ttl_sec)}` : ''}</dd><dt>Created</dt><dd>${v.created_by || '—'}, ${when(v.created_at)}</dd></dl>
<h3>Steps</h3>${html`<ol>${(v.steps || []).map((s) => html`<li><code>${s.kind}</code>${s.template ? html` · template <a href="/console/templates/${enc(s.template)}"><code>${s.template}</code></a>` : ''}${s.route ? html` · route <code>${s.route}</code>` : ''}${s.operation ? html` · ${s.operation}` : ''}</li>`)}</ol>`}
<details><summary>Steps as stored</summary><pre>${JSON.stringify(v.steps || [], null, 2)}</pre></details>
<details><summary>Input schema</summary><pre>${JSON.stringify(v.input_schema, null, 2)}</pre></details>
<details><summary>Output schema</summary><pre>${JSON.stringify(v.output_schema, null, 2)}</pre></details>
<details><summary>Metadata</summary><pre>${JSON.stringify(v.metadata || {}, null, 2)}</pre></details>`;
    }
    const statusForm = (x) => html`<form class="inline" method="post" action="/console/${kind}/${enc(key)}/versions/${x.version}/status">${csrfField(csrf)}
<label><span class="sr-only">Status of version ${x.version}</span><select name="status">${k.statuses.map((s) => html`<option value="${s}"${s === x.status ? html` selected` : ''}>${s}</option>`)}</select></label><button type="submit">Set<span class="sr-only"> status of version ${x.version}</span></button></form>`;
    return layout({
        title: `${k.one} ${key}`, section: kind, staff, csrf, notice, error, body: html`<h1>${k.title.slice(0, -1)} <code>${key}</code></h1>
<p>${inUse ? html`Runs use <strong>v${inUse}</strong>.` : html`<span class="bad">No version is in use</span> (none is active).`}
${kind === 'workflows' ? html` <a href="/console/runs${qs({ workflow: key })}">Runs of this workflow</a> · <a href="/console/runs${qs({ workflow: key, status: 'failed' })}">failed runs</a>` : ''}
<a href="/console/audit${qs({ kind: 'all', target_type: k.one, target_id: key })}">Changes to it</a></p>
${table('Versions', ['Version', 'Status', 'Created by', 'Created', ...(canManage ? ['Change status'] : [])], versions.map((x) => html`<tr>
<td><a href="/console/${kind}/${enc(key)}${qs({ version: x.version })}"${x.version === v.version ? html` aria-current="true"` : ''}>v${x.version}</a>${x.version === inUse ? html` <span class="ok">in use</span>` : ''}</td>
<td>${badge(x.status)}</td><td>${x.created_by || '—'}</td><td>${when(x.created_at)}</td>${canManage ? html`<td>${statusForm(x)}</td>` : ''}</tr>`))}
${canManage ? '' : html`<p class="muted">Changing a version's status needs <code>ai.workflow.manage</code> (<code>staff.ai.manage</code>).</p>`}
${kind === 'routes' && canChoose ? html`<h2>Use another provider</h2>
<form class="inline" method="post" action="/console/routes/${enc(key)}/use">${csrfField(csrf)}<label>Provider and model <select name="target">${providers.map((p) => [
        html`<option value="${p.key}|">${p.display_name || p.key} · ${p.default_model || 'its default model'}</option>`,
        ...models.filter((m) => m.provider_key === p.key && m.status === 'active' && m.model_key !== p.default_model).map((m) => html`<option value="${p.key}|${m.model_key}">${p.display_name || p.key} · ${m.model_key}</option>`),
    ])}</select></label><button type="submit">Use for this route</button></form>
<form class="inline" method="post" action="/console/routes/${enc(key)}/use">${csrfField(csrf)}<input type="hidden" name="default" value="1"><button type="submit">Back to the default</button></form>
<p class="muted">A new version of the route: runs use the provider and model you choose, with the route's previous primary as its first fallback. Every change is audited.</p>` : ''}
<h2>Version ${v.version}</h2>${content}`,
    });
}

const RUN_TABS = [['', 'All'], ['failed', 'Failed'], ['running', 'Running'], ['queued', 'Queued'], ['cancelled', 'Cancelled'], ['succeeded', 'Succeeded'], ['cached', 'Cached']];

function runs({ staff, csrf, form, filters, bad, rows, next, facets, failures24 }) {
    const keep = { workflow: form.workflow, requester: form.requester, code: form.code, from: form.from, to: form.to };
    return layout({
        title: 'Runs', section: 'runs', staff, csrf, error: bad.length ? `ignored malformed filter(s): ${bad.join(', ')}` : null, body: html`<h1>Runs</h1>
<nav aria-label="Run status"><ul class="tabs">${RUN_TABS.map(([s, label]) => html`<li><a href="/console/runs${qs({ ...keep, status: s })}"${(filters.status || '') === s ? html` aria-current="page"` : ''}>${label}</a></li>`)}</ul></nav>
<form class="filters" method="get" action="/console/runs" role="search" aria-label="Filter runs">
<label>Status<select name="status"><option value="">any</option>${RUN_TABS.slice(1).map(([s]) => html`<option value="${s}"${filters.status === s ? html` selected` : ''}>${s}</option>`)}</select></label>
<label>Workflow<input type="text" name="workflow" value="${form.workflow}" list="dl-workflows" autocomplete="off" spellcheck="false"></label>
<label>Requester<input type="text" name="requester" value="${form.requester}" list="dl-requesters" placeholder="service:live" autocomplete="off" spellcheck="false"></label>
<label>Error code<input type="text" name="code" value="${form.code}" list="dl-codes" autocomplete="off" spellcheck="false"></label>
<label>From (UTC)<input type="datetime-local" name="from" value="${form.from}"></label>
<label>To (UTC)<input type="datetime-local" name="to" value="${form.to}"></label>
<div class="actions"><button class="primary" type="submit">Filter</button><a href="/console/runs">Clear</a></div>
<datalist id="dl-workflows">${facets.workflows.map((w) => html`<option value="${w}"></option>`)}</datalist>
<datalist id="dl-requesters">${facets.requesters.map((r) => html`<option value="${r}"></option>`)}</datalist>
<datalist id="dl-codes">${facets.codes.map((c) => html`<option value="${c}"></option>`)}</datalist>
</form>
${filters.status === 'failed' && failures24.length ? table('Failed runs in the last 24 hours, by error code', ['Error code', 'Runs', 'Workflows', 'Last'], failures24.map((f) => html`<tr>
<td><a href="/console/runs${qs({ ...keep, status: 'failed', code: f.error_code })}"><code>${f.error_code || '(none)'}</code></a></td><td>${n(f.n)}</td><td>${n(f.workflows)}</td><td>${when(f.last_at)}</td></tr>`)) : ''}
${table(`Runs, newest first${filters.before ? ' (older page)' : ''}`, ['Run', 'Status', 'Workflow', 'Requester', 'Provider / model', 'Attempts', 'Tokens in / out', 'Cost', 'Error', 'Created', 'Took'], rows.map((r) => html`<tr>
<td><a class="mono" href="/console/runs/${enc(r.id)}">${r.id}</a></td><td>${badge(r.status)}${r.synthetic ? html`<br><span class="muted">synthetic</span>` : ''}</td>
<td><code>${r.workflow_key}</code> v${r.workflow_version}</td><td><code>${r.requester_type}:${r.requester_id}</code></td>
<td>${r.provider_key ? html`<code>${r.provider_key}</code>${r.model_key ? html` / <code>${r.model_key}</code>` : ''}${r.fallback_used ? html`<br><span class="warn">fallback</span>` : ''}` : r.cached_from ? 'cache' : '—'}</td>
<td>${n(r.attempts)}</td><td>${n(r.tokens_in)} / ${n(r.tokens_out)}</td><td>${usd(r.cost_usd)}</td><td>${r.error_code ? html`<code>${r.error_code}</code>` : '—'}</td>
<td class="nowrap">${when(r.created_at)}</td><td>${span(r.created_at, r.finished_at)}</td></tr>`), 'no run matches.')}
<div class="pager">${filters.before ? html`<a href="/console/runs${qs({ ...keep, status: filters.status })}">Newest</a>` : ''}${next ? html`<a href="/console/runs${qs({ ...keep, status: filters.status, before: next })}">Older runs</a>` : ''}</div>`,
    });
}

const ref = (x) => (x ? (x.service ? `${x.service}:${x.type}:${x.id}` : `${x.type}:${x.id}`) : '—');

function run({ staff, csrf, r, citations, requests, input, output, canCancel, notice, error }) {
    const g = r.grounding;
    const sampleIds = r.usage.usage_sample_ids || [];
    const open = r.status === 'queued' || r.status === 'running' || r.status === 'waiting';
    return layout({
        title: `Run ${r.id}`, section: 'runs', staff, csrf, notice, error, body: html`<h1>Run <span class="mono">${r.id}</span> ${badge(r.status)}</h1>
<div class="cols"><div class="card"><dl>
<dt>Workflow</dt><dd><a href="/console/workflows/${enc(r.workflow.key)}${qs({ version: r.workflow.version })}"><code>${r.workflow.key}</code> v${r.workflow.version}</a></dd>
<dt>Template</dt><dd>${r.template ? html`<a href="/console/templates/${enc(r.template.key)}${qs({ version: r.template.version })}"><code>${r.template.key}</code> v${r.template.version}</a>` : '—'}</dd>
<dt>Route</dt><dd>${r.route ? html`<a href="/console/routes/${enc(r.route.key)}${r.route.version ? qs({ version: r.route.version }) : ''}"><code>${r.route.key}</code>${r.route.version ? ` v${r.route.version}` : ''}</a>` : '—'}</dd>
<dt>Provider / model</dt><dd>${r.provenance.provider ? html`<code>${r.provenance.provider}</code>` : '—'}${r.provenance.model ? html` / <code>${r.provenance.model}</code>` : ''}${r.provenance.fallback_used ? html` <span class="warn">(fallback)</span>` : ''}</dd>
<dt>Synthetic</dt><dd>${r.synthetic ? html`<span class="warn">yes (stub output)</span>` : 'no'}</dd>
<dt>Attempts</dt><dd>${n(r.usage.attempts)}</dd>
<dt>Tokens</dt><dd>${n(r.usage.tokens_in)} in · ${n(r.usage.tokens_out)} out</dd>
<dt>Cost</dt><dd>${usd(r.usage.cost_usd)}</dd>
<dt>Billing readings</dt><dd>${sampleIds.length ? html`${sampleIds.map((id) => html`<code>${id}</code>`)}` : '—'}${((r.explain && r.explain.usage_readings) || []).map((u) => html` ${badge(u.state)}${u.free_allowance_used != null ? html` <span class="muted">${n(u.free_allowance_used)} free</span>` : ''}${u.last_error ? html`<br><span class="bad">${clip(u.last_error, 300)}</span>` : ''}`)}</dd>
${r.error ? html`<dt>Error</dt><dd><code class="bad">${r.error.code}</code><br>${clip(r.error.detail, 500)}</dd>` : ''}
</dl></div><div class="card"><dl>
<dt>Requester</dt><dd><code>${r.requester.type}:${r.requester.id}</code></dd>
<dt>On behalf of</dt><dd>${r.on_behalf_of ? html`<code>${ref(r.on_behalf_of)}</code>` : '—'}</dd>
<dt>Attribution</dt><dd>${r.attribution ? html`<code>${ref(r.attribution)}</code>` : '—'}</dd>
<dt>Target</dt><dd>${r.target ? html`<code>${ref(r.target)}</code>` : '—'}</dd>
<dt>Idempotency key</dt><dd>${r.idempotency_key ? html`<code>${r.idempotency_key}</code>` : '—'}</dd>
<dt>Trace</dt><dd>${r.trace_id ? html`<code>${r.trace_id}</code>` : '—'}</dd>
${r.retry_of ? html`<dt>Retry of</dt><dd><a class="mono" href="/console/runs/${enc(r.retry_of)}">${r.retry_of}</a></dd>` : ''}
${r.provenance.cached_from ? html`<dt>Cached from</dt><dd><a class="mono" href="/console/runs/${enc(r.provenance.cached_from)}">${r.provenance.cached_from}</a></dd>` : ''}
<dt>Created</dt><dd>${when(r.created_at)}</dd><dt>Started</dt><dd>${when(r.started_at)}</dd>
<dt>Finished</dt><dd>${when(r.finished_at)}${r.finished_at ? html` <span class="muted">(${span(r.created_at, r.finished_at)})</span>` : ''}</dd>
</dl>
${open && canCancel ? html`<form class="stack" method="post" action="/console/runs/${enc(r.id)}/cancel">${csrfField(csrf)}<p class="muted mt">Cancelling ends the run as cancelled; the requester can retry it.</p><button class="danger" type="submit">Cancel this run</button></form>` : ''}
</div></div>
<h2>Grounding</h2>
${g ? html`<div class="card"><p class="m0">${g.cited && g.cited.length ? html`Cites source(s) ${g.cited.join(', ')}.` : 'Cites no source.'}</p>
${g.gaps && g.gaps.length ? html`<p class="m0">Gaps:</p><ul>${g.gaps.map((x) => html`<li>${clip(typeof x === 'string' ? x : JSON.stringify(x), 300)}</li>`)}</ul>` : html`<p class="muted m0">No gap recorded.</p>`}</div>` : html`<div class="card muted">No grounding recorded for this run.</div>`}
${table('Citations', ['#', 'Source type', 'Title', 'URL / id', 'Attached by'], citations.map((c) => html`<tr><td>${c.ordinal}</td><td><code>${c.source_type}</code></td>
<td>${clip(c.title || '—', 160)}</td><td class="mono">${clip(c.url || c.source_id || '—', 200)}</td><td>${c.attached_by || '—'}</td></tr>`), 'none.')}
${table('Provider requests (the request log keeps hashes, never prompts)', ['#', 'Operation', 'Provider / model', 'Route', 'Status', 'Tokens in / out / cached', 'Cost', 'Latency', 'Error'], requests.map((q) => html`<tr>
<td>${q.seq}</td><td>${q.operation}</td><td><code>${q.provider_key}</code>${q.model_key ? html` / <code>${q.model_key}</code>` : ''}${q.fallback ? html`<br><span class="warn">fallback</span>` : ''}</td>
<td>${q.route_key ? html`<code>${q.route_key}</code>${q.route_version ? ` v${q.route_version}` : ''}` : '—'}</td><td>${badge(q.status)}${q.skip_reason ? html`<br><span class="muted">${q.skip_reason}</span>` : ''}</td>
<td>${n(q.tokens_in)} / ${n(q.tokens_out)} / ${n(q.tokens_cached)}${q.tokens_estimated ? html`<br><span class="muted">estimated</span>` : ''}</td><td>${usd(q.cost_usd)}</td><td>${q.latency_ms != null ? `${n(q.latency_ms)} ms` : '—'}</td>
<td>${q.error ? clip(q.error, 200) : '—'}</td></tr>`), 'no provider request (cached, refused before a call, or still queued).')}
<h2>Input</h2><p class="muted">As stored: inline images are kept as hashes and passthrough prompts are not kept at all. Shown here bounded: long strings, long lists and credential-named keys are cut.</p>
${input.text != null ? html`<pre>${input.text}</pre>` : html`<div class="card muted">Nothing stored.</div>`}
<h2>Output</h2>
${output.text != null ? html`<pre>${output.text}</pre>` : html`<div class="card muted">No output${r.status === 'failed' ? ' (the run failed)' : ''}.</div>`}`,
    });
}

function quotas({ staff, csrf, counters, all, canManage, notice, error, form = {} }) {
    const sel = (name, opts, cur) => html`<select name="${name}" id="q-${name}">${opts.map((o) => html`<option value="${o}"${o === cur ? html` selected` : ''}>${o}</option>`)}</select>`;
    const labelled = { scope_type: Object.fromEntries(Object.entries(SCOPE_WORDS).map(([k, v]) => [k, `${v.label}: ${v.line}`])), window: { minute: 'Per minute', hour: 'Per hour', day: 'Per day (UTC)' }, status: { active: 'On: requests past it are refused', disabled: 'Off: kept, but nothing is refused' } };
    const choose = (name, opts, cur) => html`<select name="${name}" id="q-${name}">${opts.map((o) => html`<option value="${o}"${o === cur ? html` selected` : ''}>${(labelled[name] && labelled[name][o]) || o}</option>`)}</select>`;
    void sel;
    return layout({
        title: 'Limits', section: 'quotas', staff, csrf, notice, error, body: html`<h1>Limits</h1>
<p class="muted">A limit caps how many requests, tokens or dollars one service, person or app may use in a minute, hour or day; it is checked before any provider is paid, and a request past it is refused until the window resets (the API answers 429 <code>quota.exceeded</code>). Change one when a service needs more room or to stop one person or app from spending too much.</p>
${table('Limits in use and how much of each is used', ['Who it limits', 'Window', 'Only tasks starting with', 'Limit', 'Used this window', 'Window started', 'Resets in'], counters.map((c) => html`<tr>
<td>${scopeText(c.quota.scope_type, c.scope_id)}</td><td>${WINDOW_WORDS[c.quota.window] || c.quota.window}</td><td>${c.quota.workflow_prefix ? html`<code>${c.quota.workflow_prefix}</code>` : 'every task'}</td>
<td>${limits(c.quota)}</td><td>${limitsUsed(c)}</td><td>${when(c.window_start)}</td><td>${secs(c.resets_in_seconds)}</td></tr>`), 'no limit is in use for a single service, person or app.')}
${table('Every limit', ['#', 'Who it limits', 'Window', 'Only tasks starting with', 'Limit', 'Status', 'Set by', 'Updated'], all.map((q) => html`<tr>
<td>${q.id}</td><td>${scopeText(q.scope_type, q.scope_id)}</td><td>${WINDOW_WORDS[q.window] || q.window}</td><td>${q.workflow_prefix ? html`<code>${q.workflow_prefix}</code>` : 'every task'}</td>
<td>${limits(q)}</td><td>${q.status === 'active' ? html`<span class="ok">On</span>` : html`<span class="muted">Off</span>`} <span class="muted">${q.status}</span></td><td>${q.origin}</td><td>${when(q.updated_at)}</td></tr>`), 'no limits yet. Add one below to cap a service, a person or an app.')}
${canManage ? html`<h2>Add or change a limit</h2>
<form class="stack" method="post" action="/console/quotas">${csrfField(csrf)}
<p class="muted m0">A limit for the same who, window and task prefix is updated in place. Leave a number empty for no limit on it; switch a limit off with its status instead of deleting it.</p>
<label for="q-scope_type">Who it limits${choose('scope_type', ['global', 'service', 'actor', 'attribution'], form.scope_type || 'service')}</label>
<label>Which one (<code>*</code> for everyone, or each one on its own; a service name such as <code>live</code>, a person such as <code>user:usr_…</code>)<input type="text" name="scope_id" maxlength="200" value="${form.scope_id || ''}" autocomplete="off" spellcheck="false" placeholder="live"></label>
<label for="q-window">Window${choose('window', ['minute', 'hour', 'day'], form.window || 'day')}</label>
<label>Most requests in the window<input type="number" name="max_requests" min="0" step="1" value="${form.max_requests || ''}"></label>
<label>Most tokens in the window (a token is about three quarters of a word)<input type="number" name="max_tokens" min="0" step="1" value="${form.max_tokens || ''}"></label>
<label>Most dollars in the window<input type="number" name="max_cost_usd" min="0" step="any" value="${form.max_cost_usd || ''}"></label>
<label>Only saved AI tasks whose name starts with (optional)<input type="text" name="workflow_prefix" maxlength="120" value="${form.workflow_prefix || ''}" autocomplete="off" spellcheck="false" placeholder="live."></label>
<label for="q-status">Status${choose('status', ['active', 'disabled'], form.status || 'active')}</label>
<button class="primary" type="submit">Save limit</button></form>` : html`<p class="muted">Changing limits needs <code>ai.provider.manage</code> (the owner's <code>staff.secrets.manage</code>).</p>`}`,
    });
}

function usageRows(caption, first, rows) {
    return table(caption, [first, 'Requests', 'Tokens in', 'Tokens out', 'Cached', 'Cost'], rows.map((r) => html`<tr><td><code>${r.key}</code></td><td>${n(r.requests)}</td>
<td>${n(r.tokens_in)}</td><td>${n(r.tokens_out)}</td><td>${n(r.tokens_cached)}</td><td>${usd(r.cost_usd)}</td></tr>`), 'no usage in this range.');
}

const day = (ms) => (ms >= 8.64e15 ? 'never' : when(new Date(ms).toISOString()));

function usage({ staff, csrf, form, bad, report, free = [], readings }) {
    const t = report.total;
    return layout({
        title: 'Usage', section: 'usage', staff, csrf, error: bad.length ? `ignored malformed filter(s): ${bad.join(', ')}` : null, body: html`<h1>Usage</h1>
<form class="filters" method="get" action="/console/usage" aria-label="Usage range">
<label>From (UTC day)<input type="date" name="from" value="${form.from}"></label><label>To (UTC day, inclusive)<input type="date" name="to" value="${form.to}"></label>
<label>Requester<input type="text" name="requester" value="${form.requester}" placeholder="service:live" autocomplete="off" spellcheck="false"></label>
<div class="actions"><button class="primary" type="submit">Show</button><a href="/console/usage">Last 7 days</a></div></form>
<div class="grid"><div class="card"><div class="k">Requests</div><div class="v">${n(t.requests)}</div></div>
<div class="card"><div class="k">Tokens</div><div class="v">${n(t.tokens_in + t.tokens_out)}</div><div class="muted">${n(t.tokens_in)} in · ${n(t.tokens_out)} out · ${n(t.tokens_cached)} cached</div></div>
<div class="card"><div class="k">Cost</div><div class="v">${usd(t.cost_usd)}</div></div></div>
${report.truncated ? html`<p class="warn">Only the first 1,000 daily rows are summed; narrow the range.</p>` : ''}
<h2>Breakdown</h2>
${usageRows('By day', 'Day', report.byDay)}${usageRows('By requester', 'Requester', report.byRequester)}
${usageRows('By workflow', 'Workflow', report.byWorkflow)}${usageRows('By provider and model', 'Provider / model', report.byModel)}
<h2>Free allowance this period</h2>
${table('Free allowance by subject, provider and metric', ['Subject', 'Provider', 'Metric', 'Free used', 'Allowance', 'Remaining', 'Period ends'], free.map((f) => html`<tr><td><code>${f.subject}</code></td><td><code>${f.provider}</code></td>
<td><code>${f.metric}</code></td><td>${n(f.free_used)}</td><td>${n(f.free_allowance)}</td><td>${n(f.remaining)}</td><td>${day(f.period_end)}</td></tr>`), 'no free allowance used this period.')}
<h2>Billing readings</h2>
${readings ? html`<p class="muted">${readings.relay ? 'Sending to Billing.' : readings.enabled ? 'Queued only: Billing sending is not configured.' : 'Readings are off (USAGE_SAMPLES=off).'}</p>
${table('Readings by delivery state', ['Queued', 'Retrying', 'Sent', 'Failed'], [html`<tr><td>${n(readings.counts.queued)}</td><td>${n(readings.counts.retrying)}</td><td>${n(readings.counts.sent)}</td><td>${n(readings.counts.failed)}</td></tr>`])}
${table('Last send errors', ['Reading', 'Run', 'State', 'Attempts', 'Queued', 'Last error'], readings.failures.map((f) => html`<tr><td><code>${f.idempotency_key}</code></td>
<td>${f.run_id ? html`<a class="mono" href="/console/runs/${enc(f.run_id)}">${f.run_id}</a>` : '—'}</td><td>${badge(f.state)}</td><td>${n(f.attempts)}</td><td>${when(f.queued_at)}</td><td>${clip(f.last_error, 300)}</td></tr>`), 'no send error.')}` : ''}`,
    });
}

function creditsSection({ csrf, credits, canResolve }) {
    const c = credits.counts;
    const usage = credits.review_usage;
    const rows = credits.review.map((r) => html`<tr>
<td><code>${r.hold_id}</code></td><td>${r.request_id ? html`<code>${r.request_id}</code>` : '—'}</td><td>${n(r.tries)}</td>
<td>${r.last_error ? clip(r.last_error, 300) : '—'}</td><td class="nowrap">${when(r.created_at)}</td>
${canResolve ? html`<td><form class="inline" method="post" action="/console/exchange/credits/${enc(r.id)}/resolve">${csrfField(csrf)}<button type="submit">Mark resolved<span class="sr-only"> ${r.hold_id}</span></button></form></td>` : ''}</tr>`);
    return html`<h2>Credits settle queue</h2>
<div class="grid">
<div class="card"><div class="k">Queued</div><div class="v">${n(c.queued)}</div></div>
<div class="card"><div class="k">Sent</div><div class="v">${n(c.sent)}</div></div>
<div class="card"><div class="k">Review</div><div class="v">${n(c.review)}</div></div>
<div class="card"><div class="k">Oldest queued</div><div class="v">${credits.oldest_queued_seconds == null ? '—' : secs(credits.oldest_queued_seconds)}</div>
<div class="muted">${credits.oldest_queued_at ? when(credits.oldest_queued_at) : 'nothing queued'}</div></div>
</div>
<p class="muted">Rows shown: ${n(credits.review.length)}${credits.review_truncated ? ` of ${n(credits.review_total)}` : ''} · tokens in ${n(usage.input_tokens)} · cached read ${n(usage.cached_read_tokens)} · cache write ${n(usage.cache_write_tokens)} · out ${n(usage.output_tokens)}. These are the only settle-body usage counts this page reads.</p>
${table('Settle rows in review', ['Hold id', 'Request id', 'Tries', 'Last error', 'Created', ...(canResolve ? ['Action'] : [])], rows, 'no settle row is waiting for review.')}
${canResolve ? '' : html`<p class="muted">Marking a review row resolved needs <code>ai.workflow.manage</code> (<code>staff.ai.manage</code>). It never retries the settle.</p>`}`;
}

function routingSection({ routing }) {
    const deployments = routing.deployments.map((r) => html`<tr>
<td><code>${r.provider_key}${r.model_key ? `:${r.model_key}` : ''}</code></td><td>${n(r.sample_count)}</td>
<td>${r.sample_count ? pct(r.success_rate) : '—'}</td><td>${r.sample_count ? pct(r.timeout_rate) : '—'}</td>
<td>${r.ttft_ms == null ? '—' : html`${n(Math.round(r.ttft_ms))} ms<br><span class="muted">n=${n(r.ttft_samples)}</span>`}</td>
<td>${r.decode_tps == null ? '—' : html`${Number(r.decode_tps).toFixed(1)}<br><span class="muted">n=${n(r.decode_samples)}</span>`}</td>
<td>${r.cache_hit_ratio == null ? '—' : pct(r.cache_hit_ratio)}${r.cache_samples ? html`<br><span class="muted">n=${n(r.cache_samples)}</span>` : ''}</td></tr>`);
    const incumbents = routing.incumbents.map((r) => html`<tr><td><code>${r.decision_key}</code></td>
<td>${r.provider_key ? html`<code>${r.provider_key}${r.model_key ? `:${r.model_key}` : ''}</code>` : '—'}</td>
<td>${r.challenger_provider ? html`<code>${r.challenger_provider}${r.challenger_model ? `:${r.challenger_model}` : ''}</code>` : '—'}</td>
<td>${n(r.challenger_streak)}</td><td class="nowrap">${when(r.updated_at)}</td></tr>`);
    return html`<h2>Routing evidence</h2>
<p class="muted">Measured per deployment: success and timeout rates, the TTFT and decode EWMA, and the cache-hit ratio. A metric with no measurement is shown as —, never as zero.</p>
${table('Deployments', ['Deployment', 'Samples', 'Success rate', 'Timeout rate', 'TTFT', 'Decode tokens/s', 'Cache-hit ratio'], deployments, 'no deployment has been measured.')}
${table('Routing incumbents', ['Decision key', 'Incumbent', 'Challenger', 'Streak', 'Updated'], incumbents, 'no incumbent recorded.')}`;
}

function exchange({ staff, csrf, credits, routing, canResolve, notice, error }) {
    return layout({
        title: 'AI Exchange', section: 'exchange', staff, csrf, notice, error, body: html`<h1>AI Exchange</h1>
<p class="muted">Operational state of the AI Exchange, read-only.${credits ? html` A settle row in review can be marked resolved below; that never retries it.` : ''}</p>
${credits ? creditsSection({ csrf, credits, canResolve }) : ''}
${routing ? routingSection({ routing }) : ''}`,
    });
}

/** The GPU money as a dollar string: nano-USD in, exact dollars out (never a float). */
function usdNano(nano) {
    const n = BigInt(nano == null ? 0 : nano);
    const abs = n < 0n ? -n : n;
    const whole = abs / 1000000000n;
    const frac = (abs % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
    return (n < 0n ? '-' : '') + '$' + whole.toString() + (frac ? '.' + frac : '');
}

/** A measured cold start: from the launch to the first answered request. */
function coldStart(ms) {
    const n = Math.max(0, Math.round(Number(ms) || 0));
    if (n < 1000) return n + ' ms';
    return (n / 1000).toFixed(1) + ' s';
}

/** The price of one second of a GPU, from its hourly nano-USD rate (Vast and RunPod bill per second). */
function usdPerSecond(hourlyNano) {
    const n = BigInt(hourlyNano == null ? 0 : hourlyNano);
    return usdNano(n / 3600n);
}

function gpuModelRow(m, canManage, csrf) {
    return html`<tr>
  <td><code>${m.key}</code><br><span class="muted">${m.display_name}</span><br><span class="muted">${clip(m.weights_url, 90)}</span></td>
  <td>${m.marketplace}</td><td>${m.runtime}</td>
  <td>${m.instance ? m.instance.gpu_name + ' · $' + m.instance.price_per_hour + '/h' : '—'}</td>
  <td>${m.instance ? badge(m.instance.status) : html`<span class="muted">stopped</span>`}</td>
  <td>${m.cold_start_ms == null ? html`<span class="muted">not measured yet</span>` : coldStart(m.cold_start_ms)}</td>
  <td>${canManage ? html`<form class="inline" method="post" action="/console/gpus/${enc(m.key)}/${m.instance ? 'stop' : 'launch'}">${csrfField(csrf)}<button type="submit">${m.instance ? 'Stop' : 'Start'}</button></form>` : ''}</td>
</tr>`;
}

function gpuInstanceRow(i) {
    return html`<tr>
  <td><code>${i.model_key}</code></td><td>${i.marketplace}</td><td>${i.gpu_name}</td><td>$${i.price_per_hour}/h · ${usdPerSecond(i.hourly_nano)}/s</td>
  <td>${badge(i.status)}</td><td>${i.endpoint ? html`<span class="muted">${clip(i.endpoint, 60)}</span>` : '—'}</td>
  <td>${when(i.started_at)}</td><td>${i.cold_start_ms == null ? '—' : coldStart(i.cold_start_ms)}</td><td>${usdNano(i.reserved_nano)}</td><td>${usdNano(i.spent_nano)}</td>
</tr>`;
}

/**
 * The GPU page: the instances AI rents, what they cost this month and the cap they may never pass.
 * The actions only ask (a request row); the reconciler does the work, so a click is never a second
 * implementation of the provisioner.
 */
function gpus({ staff, csrf, state, canManage, notice, error }) {
    const st = state || {};
    const models = st.models || [];
    const instances = st.instances || [];
    const mk = st.marketplaces || {};
    return layout({
        title: 'OpenVibe GPUs', section: 'gpus', staff, csrf, notice, error, body: html`<h1>OpenVibe GPUs</h1>
<p class="muted">The GPUs AI rents by the second to run open models: what is running, what it cost this month, and the monthly cap it may never pass. Come here to start or stop a model's GPU, or to see why none is running; the keys and the cap are set in the admin panel's Setup tab.</p>
<div class="grid">
  <div class="card"><div class="k">Renting GPUs</div><div class="v">${st.enabled ? 'On' : 'Off'}</div><div class="muted">${st.enabled ? 'a marketplace key and a monthly cap are set' : html`Off because ${st.reason || 'no marketplace key or monthly cap is set'}. Nothing is rented and nothing is spent until both are set.`}</div></div>
  <div class="card"><div class="k">Spent this month</div><div class="v">${usdNano(st.spent_nano)}</div><div class="muted">${st.month}</div></div>
  <div class="card"><div class="k">Could still cost</div><div class="v">${usdNano(st.committed_nano)}</div><div class="muted">the most the GPUs running now may cost before they are given back</div></div>
  <div class="card"><div class="k">Monthly cap</div><div class="v">${st.cap_nano ? usdNano(st.cap_nano) : 'Not set'}</div><div class="muted">${st.cap_nano ? 'AI never starts a GPU that could pass it' : 'without a cap nothing is rented'}</div></div>
</div>
<p class="muted">An unused GPU is given back after ${n(st.idle_minutes)} minute${Number(st.idle_minutes) === 1 ? '' : 's'}; one GPU runs at most ${n(st.max_runtime_minutes)} minutes; ${st.warm_window ? `GPUs stay ready ${st.warm_window} UTC` : 'no hours keep GPUs ready'}; GPUs are rented in ${st.region}. Vast.ai key: ${mk.vast ? 'set' : 'not set'} · RunPod key: ${mk.runpod ? 'set' : 'not set'}.</p>
<p class="muted">Vast.ai and RunPod bill by the second, so only the seconds a GPU really ran are charged; the price per second is next to the price per hour. "First answer after" is the time from renting a GPU to its first answer.</p>
${table('Models that can run on a rented GPU', ['Model', 'Marketplace', 'Runs with', 'GPU', 'Status', 'First answer after', 'Actions'], models.map((m) => gpuModelRow(m, canManage, csrf)), 'no model is set up to run on a rented GPU yet.')}
${table('GPUs rented', ['Model', 'Marketplace', 'GPU', 'Price per hour', 'Status', 'Address', 'Started', 'First answer after', 'Most it may cost', 'Spent'], instances.map((i) => gpuInstanceRow(i)), 'no GPU has been rented.')}
`,
    });
}

function cache({ staff, csrf, stats, canManage, notice, error }) {
    const entries = stats.reduce((a, s) => a + s.entries, 0);
    const hits = stats.reduce((a, s) => a + (s.hits || 0), 0);
    return layout({
        title: 'Cache', section: 'cache', staff, csrf, notice, error, body: html`<h1>Cache</h1>
<p class="muted">Cached outputs are served only within their scope (private: requester + actor + target + attribution; service: requester only) and only for the same workflow, template and route versions and input. Synthetic output is never cached.</p>
<div class="grid"><div class="card"><div class="k">Live entries</div><div class="v">${n(entries)}</div></div><div class="card"><div class="k">Hits served</div><div class="v">${n(hits)}</div><div class="muted">by the live entries</div></div></div>
${table('Live entries by workflow', ['Workflow', 'Privacy', 'Entries', 'Hits'], stats.map((s) => html`<tr><td><code>${s.workflow_key}</code></td><td>${s.privacy}</td><td>${n(s.entries)}</td><td>${n(s.hits || 0)}</td></tr>`), 'the cache is empty.')}
${canManage ? html`<h2>Purge</h2>
<form class="stack" method="post" action="/console/cache/purge">${csrfField(csrf)}
<label>Workflow key (exact; empty = every entry)<input type="text" name="workflow" maxlength="120" list="dl-cached" autocomplete="off" spellcheck="false"></label>
<datalist id="dl-cached">${stats.map((s) => html`<option value="${s.workflow_key}"></option>`)}</datalist>
<label class="check"><input type="checkbox" name="confirm_all" value="yes"> Yes, purge <strong>every</strong> entry when no workflow is given</label>
<button class="danger" type="submit">Purge</button></form>` : html`<p class="muted">Purging needs <code>ai.provider.manage</code> (the owner's <code>staff.secrets.manage</code>).</p>`}`,
    });
}

const TARGET_LINKS = { run: 'runs', workflow: 'workflows', template: 'templates', route: 'routes' };
/** Audit metadata as key=value; URLs lose their query and user info here too (provider.* rows carry base_url). */
function metaText(m) {
    const s = Object.entries(m || {}).filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k}=${/url$/i.test(k) && typeof v === 'string' ? safeUrl(v) : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
    return clip(s, 400);
}

function abusePage({ staff, csrf, report }) {
    if (!report) return layout({ title: 'Abuse', section: 'abuse', staff, csrf, body: html`<h1>Abuse prevention</h1><p class="muted">Abuse prevention is not configured on this service.</p>` });
    const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
    return layout({
        title: 'Abuse', section: 'abuse', staff, csrf,
        body: html`<h1>Abuse prevention</h1>
<p class="muted m0">Plan E5: the free allowance grows with trust, a signed device id counts accounts per device, a hosting ASN gets the new tier, an in-house proof of work guards the anonymous Try it, and free tokens per minute are checked against the last week. Nothing here stores a raw address or device id.</p>
<div class="cards">
<section class="card"><h2>Signals</h2><p>IP-to-ASN table: <strong>${n(report.asn_table.v4_ranges)}</strong> IPv4 ranges, <strong>${n(report.asn_table.v6_ranges)}</strong> IPv6 ranges, <strong>${n(report.asn_table.hosting_asns)}</strong> operator hosting ASNs. Network trust signals: <strong>${report.signals ? 'on' : 'off'}</strong>.</p>
<p>Prefixes seen in the last 24 h: <strong>${n(report.network.prefixes_24h)}</strong> (<strong>${n(report.network.hosting)}</strong> hosting). Open proof-of-work challenges: <strong>${n(report.pow)}</strong>.</p></section>
<section class="card"><h2>Devices</h2><p>Known device/account pairs: <strong>${n(report.devices)}</strong>. Devices shared by more than three accounts: <strong>${n(report.shared_devices)}</strong>.</p>
<p class="muted">Accounts on one shared device draw from one allowance: the lowest tier among them.</p></section>
<section class="card"><h2>Today</h2><p>Free tokens claimed on <strong>${report.day}</strong> (UTC), by counter:</p>
${table('Daily free allowance', ['Counter', 'Tokens'], report.usage.map((u) => html`<tr><td><code>${u.subject}</code></td><td>${n(u.tokens)}</td></tr>`), 'nothing claimed today.')}
</section></div>
${table('Throttles and refusals in the last 24 h', ['When', 'Action', 'Target', 'Metadata'], report.events.map((e) => html`<tr>
<td>${when(e.at)}</td><td><code>${e.action}</code></td><td><code>${clip(e.target, 80)}</code></td><td class="mono muted">${metaText(e.metadata)}</td></tr>`), 'nothing was throttled or refused.')}
<p class="muted">The live gauge is <code>ai_abuse_throttles{reason}</code> on <code>/metrics</code>; OpenVibe.Host alerts when the total stays high. The full audit trail is on the <a href="/console/audit?kind=abuse">Audit page</a>.</p>`,
    });
}

function audit({ staff, csrf, form, bad, rows, next, names, kinds }) {
    const keep = { kind: form.kind, action: form.action, actor: form.actor, target_type: form.target_type, target_id: form.target_id };
    const actor = (a) => (names.get(a) ? html`@${names.get(a)} <code>${a}</code>` : html`<code>${a}</code>`);
    const tgt = (r) => {
        if (!r.target_type) return '—';
        const page = TARGET_LINKS[r.target_type];
        return page && r.target_id ? html`${r.target_type} <a class="mono" href="/console/${page}/${enc(r.target_id)}">${r.target_id}</a>` : html`${r.target_type} <code>${r.target_id || ''}</code>`;
    };
    return layout({
        title: 'Audit', section: 'audit', staff, csrf, error: bad.length ? `ignored malformed filter(s): ${bad.join(', ')}` : null, body: html`<h1>Audit log</h1>
<p class="muted">Append-only. Every provider, model, route, template, workflow, quota and cache change, from the admin API (actor <code>svc:…</code>), this console (actor <code>usr_…</code>) or boot seeding (<code>seed</code>/<code>system</code>); every run create, cancel and retry; circuit changes and fallbacks; console sign-ins and refused requests.</p>
<nav aria-label="Audit kind"><ul class="tabs">${Object.entries(kinds).map(([k, v]) => html`<li><a href="/console/audit${qs({ ...keep, kind: k })}"${form.kind === k ? html` aria-current="page"` : ''}>${v.label}</a></li>`)}</ul></nav>
<form class="filters" method="get" action="/console/audit" role="search" aria-label="Filter the audit log"><input type="hidden" name="kind" value="${form.kind}">
<label>Action<input type="text" name="action" value="${form.action}" placeholder="provider.update" autocomplete="off" spellcheck="false"></label>
<label>Actor<input type="text" name="actor" value="${form.actor}" placeholder="svc:live or usr_…" autocomplete="off" spellcheck="false"></label>
<label>Target type<input type="text" name="target_type" value="${form.target_type}" placeholder="workflow" autocomplete="off" spellcheck="false"></label>
<label>Target id<input type="text" name="target_id" value="${form.target_id}" autocomplete="off" spellcheck="false"></label>
<div class="actions"><button class="primary" type="submit">Filter</button><a href="/console/audit">Clear</a></div></form>
${table('Audit rows, newest first', ['#', 'At', 'Actor', 'Action', 'Target', 'Details', 'Trace'], rows.map((r) => html`<tr><td>${r.id}</td><td class="nowrap">${when(r.at)}</td><td>${actor(r.actor)}</td>
<td><code>${r.action}</code></td><td>${tgt(r)}</td><td class="mono muted">${metaText(r.metadata)}</td><td class="mono muted">${r.trace_id ? clip(r.trace_id, 40) : ''}</td></tr>`), 'no audit row matches.')}
<div class="pager">${form.before ? html`<a href="/console/audit${qs(keep)}">Newest</a>` : ''}${next ? html`<a href="/console/audit${qs({ ...keep, before: next })}">Older rows</a>` : ''}</div>`,
    });
}

/**
 * The price book: what the weekly job found, what waits for the owner and what it changed.
 *
 * A price never changes silently. A change of more than 20% waits here until the owner approves it; a smaller
 * one was applied by the job and is in the log. The listing the price was read from is on every row, so the
 * owner can go and read it before saying yes.
 */
const PRICE_FIELD_WORDS = {
    in_per_mtok: 'Price per million words read (input), in dollars',
    out_per_mtok: 'Price per million words written (output), in dollars',
    cached_per_mtok: 'Price per million words read from cache, in dollars',
    cache_write_per_mtok: 'Price per million words written to cache, in dollars',
};
function priceChangeRow(c, { csrf, canManage, actions = false } = {}) {
    const pct = c.change_pct == null ? null : Number(c.change_pct) * 100;
    return html`<tr>
  <td><code>${c.provider_key}</code> / <code>${c.model_key}</code></td>
  <td>${PRICE_FIELD_WORDS[c.field] || c.field.replace(/_per_mtok$/, '')}</td>
  <td>${c.old_price == null ? html`<span class="muted">no price</span>` : usd(Number(c.old_price))}</td>
  <td>${usd(Number(c.new_price))}</td>
  <td>${pct == null ? html`<span class="muted">new price</span>` : (pct >= 0 ? '+' : '') + pct.toFixed(1) + ' %'}</td>
  <td>${c.checked_at}</td>
  <td><span class="muted">${clip(c.source, 70)}</span></td>
  ${actions ? html`<td>${canManage ? html`<form class="inline" method="post" action="/console/pricebook/changes/${enc(c.id)}">${csrfField(csrf)}
      <input type="hidden" name="decision" value="approve"><button type="submit">Approve</button></form>
      <form class="inline" method="post" action="/console/pricebook/changes/${enc(c.id)}">${csrfField(csrf)}
      <input type="hidden" name="decision" value="reject"><button type="submit">Reject</button></form>` : html`<span class="muted">needs ai.provider.manage</span>`}</td>` : ''}
</tr>`;
}

function pricebook({ staff, csrf, report, state, pending, recent, canManage, notice, error }) {
    const st = report || {};
    const unreadable = st.unreadable || [];
    const cross = st.cross_reference || null;
    const row = state || {};
    return layout({
        title: 'Price book', section: 'pricebook', staff, csrf, notice, error, body: html`<h1>Price book</h1>
<p class="muted">What each model costs, read once a week from the provider's own price page. Come here to approve or reject a big price change: a change of more than 20% waits for you, a smaller one is applied at once, and a page that cannot be read leaves every price as it was.</p>
<div class="grid">
  <div class="card"><div class="k">Last run</div><div class="v">${row.last_run_at ? String(row.last_run_at).slice(0, 10) : (st.checked_at || 'never')}</div><div class="muted">${row.last_run_at ? 'finished ' + when(row.last_run_at) : 'the job has not run yet'}</div></div>
  <div class="card"><div class="k">Waiting for the owner</div><div class="v">${n((pending || []).length)}</div><div class="muted">a change of more than 20%</div></div>
  <div class="card"><div class="k">Changed by the job</div><div class="v">${n((st.applied || []).length)}</div><div class="muted">a change of 20% or less</div></div>
  <div class="card"><div class="k">Listings unreadable</div><div class="v">${n(unreadable.length)}</div><div class="muted">their prices stand</div></div>
</div>
${canManage ? html`<form class="inline" method="post" action="/console/pricebook/run">${csrfField(csrf)}<button type="submit">Read the prices now</button></form>` : html`<p class="muted">Reading the prices on demand needs <code>ai.provider.manage</code> (the owner's <code>staff.secrets.manage</code>).</p>`}
${row.claimed_by ? html`<p class="muted">Another instance is running the book right now (${row.claimed_by}).</p>` : ''}
${unreadable.length ? html`${table('Listings that could not be read', ['Listing', 'Why'], unreadable.map((u) => html`<tr><td><code>${u.source}</code></td><td>${u.error}</td></tr>`), 'every listing was read.')}` : ''}
${cross ? html`${table('OpenRouter as a second opinion', ['Models compared', 'The same price', 'A different price'], [html`<tr><td>${n(cross.models)}</td><td>${n(cross.agree)}</td><td>${n(cross.differ)}</td></tr>`], 'nothing was compared.')}` : ''}
<h2>Waiting for the owner</h2>
${table('Pending price changes', ['Model', 'Price', 'Was', 'Now', 'Change', 'Checked', 'Read from', 'Decision'], (pending || []).map((c) => priceChangeRow(c, { csrf, canManage, actions: true })), 'no price change is waiting.')}
<h2>What the job changed</h2>
${table('Applied price changes', ['Model', 'Price', 'Was', 'Now', 'Change', 'Checked', 'Read from'], (recent || []).map((c) => priceChangeRow(c, { csrf, canManage })), 'the job has not changed a price yet.')}
`,
    });
}

/** What the words on these pages mean: the same glossary as the admin panel's. */
function glossary({ staff, csrf }) {
    return layout({
        title: 'What words mean', section: 'glossary', staff, csrf, body: html`<h1>What words mean</h1>
<p class="muted">The few words these pages cannot avoid, each in one line. Everything else on the console is meant to read without them; if something still does not, it is a mistake to fix.</p>
<div class="card"><dl>${GLOSSARY.map(([word, line]) => html`<dt>${word}</dt><dd>${line}</dd>`)}</dl></div>`,
    });
}

// ── Person: one run (GET /runs/:id, signed in) ───────────────
/**
 * A person's receipt for one run: status, workflow, model, cost, times, and the output or the error.
 * It never shows the input, the request log, the trace or anyone else's run. The console's classes
 * and CSS are reused; no script, no form and no external resource.
 */
function runReceipt({ viewer, r, output, outputCut }) {
    const open = r.status === 'queued' || r.status === 'running' || r.status === 'waiting';
    const provider = r.provenance && r.provenance.provider;
    const model = r.provenance && r.provenance.model;
    const usage = r.usage || {};
    const cost = usage.cost_usd == null ? '—' : usd(usage.cost_usd);
    return layout({
        title: `Run ${r.id}`, site: 'your runs', body: html`<h1>Run <span class="mono">${r.id}</span> ${badge(r.status)}</h1>
${viewer && viewer.username ? html`<p class="muted">Signed in as @${viewer.username}.</p>` : ''}
${open ? html`<div class="banner" role="status"><strong>${r.status === 'queued' ? 'Waiting to start' : r.status === 'waiting' ? 'Waiting for you' : 'Running'}</strong> — reload this page for the latest.</div>` : ''}
${r.error ? html`<div class="banner error" role="alert"><strong>${r.error.code || 'The run failed'}</strong><br>${clip(r.error.detail, 1000)}</div>` : ''}
<div class="cols"><div class="card"><dl>
<dt>Status</dt><dd>${badge(r.status)}</dd>
<dt>Workflow</dt><dd><code>${r.workflow.key}</code> v${r.workflow.version}</dd>
<dt>Model</dt><dd>${provider || model ? html`${provider ? html`<code>${provider}</code>` : '—'}${model ? html` / <code>${model}</code>` : ''}` : '—'}</dd>
<dt>Cost</dt><dd>${cost}</dd>
<dt>Created</dt><dd>${when(r.created_at)}</dd>
<dt>Started</dt><dd>${when(r.started_at)}</dd>
<dt>Finished</dt><dd>${when(r.finished_at)}</dd>
${r.created_at && r.finished_at ? html`<dt>Duration</dt><dd>${span(r.created_at, r.finished_at)}</dd>` : ''}
${r.provenance && r.provenance.cached_from ? html`<dt>From cache</dt><dd><a class="mono" href="/runs/${enc(r.provenance.cached_from)}">${r.provenance.cached_from}</a></dd>` : ''}
${r.retry_of ? html`<dt>Retry of</dt><dd><a class="mono" href="/runs/${enc(r.retry_of)}">${r.retry_of}</a></dd>` : ''}
</dl>${r.synthetic ? html`<p class="muted mt">Synthetic: produced by the stub provider.</p>` : ''}</div></div>
<h2>Output</h2>
${output != null ? html`<pre tabindex="0">${output}</pre>${outputCut ? html`<p class="muted">Shown bounded; the run has more.</p>` : ''}` : html`<div class="card muted"><p class="m0">${r.error ? 'No output: the run failed.' : open ? 'No output yet.' : 'This run has no output.'}</p></div>`}
<p class="muted">This page shows only your own run. Its input is not shown.</p>
<p><a href="/">OpenVibe.AI</a></p>`,
    });
}

// ── Public: price and latency (GET /stats, no sign-in) ───────
const ms = (v) => (v == null ? '—' : `${n(v)} ms`);
function rate(ok, total) {
    if (!total) return '—';
    const pct = (100 * ok) / total;
    return `${pct === 100 || pct === 0 ? pct : pct.toFixed(1)} % (${n(ok)} / ${n(total)})`;
}
/** One cell per card set: input · cached · output per million tokens, as the platform.rate-card@1 cards state them. */
function price(cards) {
    if (!cards) return html`<span class="muted">not billed</span>`;
    const per = cards.in.unit_size === 1e6 ? '1M' : n(cards.in.unit_size);
    return html`<span class="nowrap">in ${usd(cards.in.unit_price_usd)}</span> · <span class="nowrap">cached ${usd(cards.cached.unit_price_usd)}</span> · <span class="nowrap">out ${usd(cards.out.unit_price_usd)}</span> <span class="muted nowrap">per ${per} tokens</span>`;
}
function allowance(cards) {
    const free = cards ? [['in', cards.in], ['cached', cards.cached], ['out', cards.out]].filter(([, c]) => Number(c.free_allowance) > 0) : [];
    if (!free.length) return '—';
    return free.map(([k, c], i) => html`${i ? ' · ' : ''}<span class="nowrap">${k} ${n(c.free_allowance)} tokens${c.reset_period === 'none' ? '' : ` / ${c.reset_period}`}</span>`);
}

/** The price and latency cells, as plain HTML strings for the public /stats page (server/home.js renderStats). */
const statsFormat = { ms, rate, price: (cards) => render(price(cards)), allowance: (cards) => render(allowance(cards)) };

module.exports = { CSP, html, esc, safeUrl, statsFormat, healthText, queueText, GLOSSARY, pages: { signIn, message, overview, providers, providerNew, definitions, definition, runs, run, runReceipt, quotas, usage, cache, abuse: abusePage, audit, exchange, gpus, pricebook, glossary } };
