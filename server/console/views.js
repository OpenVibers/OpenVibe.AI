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
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}button.danger{border-color:var(--bad);color:var(--bad)}
button.link{border:0;background:none;padding:0;color:var(--accent);text-decoration:underline}
fieldset{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0;min-width:0}legend{padding:0 6px;font-weight:600}
dl{display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;min-width:0}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px;align-items:start}
details{margin:6px 0 12px}summary{cursor:pointer;color:var(--accent)}
.pager{display:flex;gap:14px;flex-wrap:wrap;margin:0 0 14px}.m0{margin:0}.mt{margin:10px 0 0}
@media (max-width:600px){.who{margin-left:0}h1{font-size:20px}}
`;
const CSS_HASH = `sha256-${crypto.createHash('sha256').update(CSS).digest('base64')}`;
const CSP = `default-src 'none'; style-src '${CSS_HASH}'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

// ── Formatting ───────────────────────────────────────────────
const n = (v) => Number(v || 0).toLocaleString('en-US');
function usd(v) {
    const x = Number(v) || 0;
    if (x === 0) return '$0';
    return `$${x < 0.01 ? x.toFixed(6) : x.toFixed(x < 100 ? 4 : 2)}`;
}
const when = (s) => (s ? html`<time datetime="${s}">${String(s).replace('T', ' ').slice(0, 19)} UTC</time>` : '—');
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
const GOOD = new Set(['succeeded', 'active', 'closed', 'configured', 'ok', 'cached', 'not_required']);
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
    ['/console', 'Overview', 'overview'], ['/console/providers', 'Providers', 'providers'], ['/console/routes', 'Routes', 'routes'],
    ['/console/templates', 'Templates', 'templates'], ['/console/workflows', 'Workflows', 'workflows'], ['/console/runs', 'Runs', 'runs'],
    ['/console/quotas', 'Quotas', 'quotas'], ['/console/usage', 'Usage', 'usage'], ['/console/cache', 'Cache', 'cache'], ['/console/audit', 'Audit', 'audit'],
];

function layout({ title, section, staff, csrf, notice, error, body }) {
    return `<!doctype html>${render(html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${title} · AI operator console</title><style>${new Raw(CSS)}</style></head>
<body><a class="skip" href="#main">Skip to content</a><header><div class="bar"><span class="brand">OpenVibe.AI · operator console</span>
${staff ? html`<nav aria-label="Console"><ul>${NAV.map(([href, label, id]) => html`<li><a href="${href}"${id === section ? html` aria-current="page"` : ''}>${label}</a></li>`)}</ul></nav>
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

function message({ title, text, staff, csrf, back = '/console' }) {
    return layout({ title, staff, csrf, body: html`<h1>${title}</h1><div class="card"><p>${text}</p><p><a href="${back}">Back</a></p></div>` });
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
<div class="card"><p class="m0">This session may: ${staff.caps.map((c, i) => html`${i ? '; ' : ''}${CAP_LABELS[c] || c}`)}.</p></div>
<div class="grid">
<div class="card"><div class="k">Providers</div><div class="v">${n(st.providers.filter((p) => p.status === 'active').length)} active</div>
<div class="muted">${problems.length ? html`<span class="bad">${problems.length} need attention</span>` : 'no credential or circuit problem'} · stub fallback ${stubFallback ? 'on' : 'off'}</div><a href="/console/providers">Providers</a></div>
<div class="card"><div class="k">Runs, last 24 h</div><div class="v">${n(runs24)}</div>
<div class="muted">${Object.entries(counts24).map(([s, c], i) => html`${i ? ' · ' : ''}${s} ${n(c)}`)}</div><a href="/console/runs">Runs</a></div>
<div class="card"><div class="k">Failed, last 24 h</div><div class="v">${counts24.failed ? html`<span class="bad">${n(counts24.failed)}</span>` : '0'}</div>
<div class="muted">${failures24.length ? failures24.slice(0, 3).map((f, i) => html`${i ? ' · ' : ''}${f.error_code || '(none)'} ${n(f.n)}`) : 'none'}</div><a href="/console/runs?status=failed">Failed runs</a></div>
<div class="card"><div class="k">Spend today (${st.today.day})</div><div class="v">${usd(st.today.cost_usd)}</div><div class="muted">${n(st.today.requests)} provider requests</div><a href="/console/usage">Usage</a></div>
<div class="card"><div class="k">Queue</div><div class="v">${n(queue.running)} running</div><div class="muted">${n(queue.queued)} queued · up to ${n(queue.max_concurrent)} at once, ${n(queue.max_queued)} waiting</div></div>
<div class="card"><div class="k">Definitions</div><div class="v">${n(st.workflows)} workflows</div><div class="muted">${n(st.templates)} templates · ${n(st.routes)} routes</div><a href="/console/workflows">Workflows</a></div>
<div class="card"><div class="k">Cache</div><div class="v">${n(cacheTotals.entries)} entries</div><div class="muted">${n(cacheTotals.hits)} hits served</div><a href="/console/cache">Cache</a></div>
</div>
<h2>Needs attention</h2>
${table('Provider problems', ['Provider', 'Kind', 'Problem'], problems.map((p) => html`<tr><td><code>${p.key}</code></td><td>${p.kind}</td><td class="bad">${p.problem}</td></tr>`), 'none.')}
${table('Failed runs in the last 24 hours, by error code', ['Error code', 'Runs', 'Workflows', 'Last'], failures24.map((f) => html`<tr>
<td><a href="/console/runs${qs({ status: 'failed', code: f.error_code })}"><code>${f.error_code || '(none)'}</code></a></td><td>${n(f.n)}</td><td>${n(f.workflows)}</td><td>${when(f.last_at)}</td></tr>`), 'no failed runs.')}
${table('Busiest quota windows', ['Scope', 'Window', 'Used', 'Limit', 'Resets in'], topQuotas.map((c) => html`<tr>
<td>${c.quota.scope_type} <code>${c.scope_id}</code>${c.quota.workflow_prefix ? html` · <code>${c.quota.workflow_prefix}*</code>` : ''}</td><td>${c.quota.window}</td>
<td>${limitsUsed(c)}</td><td>${limits(c.quota)}</td><td>${secs(c.resets_in_seconds)}</td></tr>`), 'no active quota.')}`,
    });
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

function providers({ staff, csrf, rows, models, canManage, stubFallback, notice, error }) {
    return layout({
        title: 'Providers', section: 'providers', staff, csrf, notice, error, body: html`<h1>Providers and models</h1>
<p class="muted">Credentials are secret <em>references</em> (<code>env:NAME</code>) resolved from the service environment; this page shows the name and whether it resolves, never a value. Routes try their primary and then each fallback in order; the table below is in provider priority order. The deterministic stub joins every route as a last resort: <strong>${stubFallback ? 'on' : 'off'}</strong> (<code>AI_STUB_FALLBACK</code>).</p>
${table('Providers', ['Provider', 'Kind', 'Status', 'Credentials', 'Circuit', 'Base URL', 'Default model', 'Can do', 'Priority / timeout', ...(canManage ? ['Actions'] : [])], rows.map((p) => html`<tr>
<td><code>${p.key}</code><br><span class="muted">${p.display_name}</span></td><td>${p.kind}</td><td>${badge(p.status)}</td>
<td>${badge(p.credentials)}${p.secret_ref ? html`<br><code>${p.secret_ref}</code>` : ''}<br><span class="muted">${p.auth_mode}</span></td>
<td>${badge(p.health.state)}${p.health.consecutive_failures ? html`<br><span class="muted">${n(p.health.consecutive_failures)} failure(s) in a row</span>` : ''}${p.health.last_error ? html`<br><span class="muted">${clip(p.health.last_error, 160)}</span>` : ''}</td>
<td class="mono">${safeUrl(p.base_url)}</td><td>${p.default_model ? html`<code>${p.default_model}</code>` : '—'}</td><td>${(p.capabilities || []).join(', ') || '—'}</td>
<td>${n(p.priority)} · ${n(p.timeout_ms)} ms<br><span class="muted">${p.origin}, updated ${when(p.updated_at)}</span></td>
${canManage ? html`<td><form class="inline" method="post" action="/console/providers/${enc(p.key)}/status">${csrfField(csrf)}<input type="hidden" name="status" value="${p.status === 'active' ? 'disabled' : 'active'}"><button type="submit" class="${p.status === 'active' ? 'danger' : ''}">${p.status === 'active' ? 'Disable' : 'Enable'}<span class="sr-only"> ${p.key}</span></button></form>
${p.health.state !== 'closed' || p.health.consecutive_failures ? html` <form class="inline" method="post" action="/console/providers/${enc(p.key)}/reset">${csrfField(csrf)}<button type="submit">Reset circuit<span class="sr-only"> of ${p.key}</span></button></form>` : ''}</td>` : ''}
</tr>`), 'no providers.')}
${canManage ? '' : html`<p class="muted">Enabling, disabling and circuit resets need <code>ai.provider.manage</code> (the owner's <code>staff.secrets.manage</code>).</p>`}
${table('Models', ['Provider', 'Model', 'Type', 'Status', 'Context / max output', 'Cost per Mtok (in / out / cached)', 'Supports'], models.map((m) => html`<tr>
<td><code>${m.provider_key}</code></td><td><code>${m.model_key}</code></td><td>${m.type}</td><td>${badge(m.status)}</td>
<td>${m.context_window ? n(m.context_window) : '—'} / ${m.max_output ? n(m.max_output) : '—'}</td>
<td>${m.cost.in_per_mtok != null ? usd(m.cost.in_per_mtok) : '—'} / ${m.cost.out_per_mtok != null ? usd(m.cost.out_per_mtok) : '—'} / ${m.cost.cached_per_mtok != null ? usd(m.cost.cached_per_mtok) : '—'}</td>
<td>${Object.entries(m.supports).filter(([, v]) => v).map(([k]) => k).join(', ') || '—'}</td></tr>`), 'no models registered (providers use their default model).')}`,
    });
}

const KINDS = {
    routes: { one: 'route', title: 'Routes', statuses: ['active', 'disabled'] },
    templates: { one: 'template', title: 'Templates', statuses: ['draft', 'active', 'deprecated', 'archived'] },
    workflows: { one: 'workflow', title: 'Workflows', statuses: ['draft', 'active', 'deprecated', 'archived'] },
};
const target = (c) => (c ? html`<code>${c.provider}</code>${c.model ? html` / <code>${c.model}</code>` : ''}` : '—');

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
<p class="muted">Every edit is a new version and old versions stay readable; runs record the versions they used. ${kind === 'routes'
            ? 'A route runs its newest version, which must be active.'
            : 'Runs use the newest active version ("in use"); a newer draft is not used until it is made active.'} Versions are created through the admin API (<code>POST /api/v1/${kind}/:key/versions</code>).</p>
${table(`${k.title} (newest version of each)`, head, body, `no ${kind}.`)}`,
    });
}

function definition({ staff, csrf, kind, key, versions, selected, inUse, canManage, notice, error }) {
    const k = KINDS[kind];
    const v = selected;
    let content;
    if (kind === 'routes') {
        content = html`<dl><dt>Status</dt><dd>${badge(v.status)}</dd>
${v.alias_of ? html`<dt>Alias of</dt><dd><a href="/console/routes/${enc(v.alias_of)}"><code>${v.alias_of}</code></a></dd>` : html`<dt>Primary</dt><dd>${target(v.primary)}</dd>
<dt>Fallbacks</dt><dd>${v.fallbacks.length ? html`<ol>${v.fallbacks.map((f) => html`<li>${target(f)}</li>`)}</ol>` : html`<span class="warn">none: an outage of the primary fails every run on this route</span>`}</dd>`}
<dt>Response format</dt><dd>${v.response_format}</dd><dt>Max output tokens</dt><dd>${v.max_output_tokens != null ? n(v.max_output_tokens) : '—'}</dd>
<dt>Timeout</dt><dd>${v.timeout_ms ? `${n(v.timeout_ms)} ms` : 'provider default'}</dd><dt>Created</dt><dd>${v.created_by || '—'}, ${when(v.created_at)}</dd></dl>
<h3>Options</h3><pre>${JSON.stringify(v.options || {}, null, 2)}</pre>`;
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
    const open = r.status === 'queued' || r.status === 'running';
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
    return layout({
        title: 'Quotas', section: 'quotas', staff, csrf, notice, error, body: html`<h1>Quotas</h1>
<p class="muted">A quota limits requests, tokens and/or cost for one scope in one UTC window, and is checked before any provider call (a refusal is 429 <code>quota.exceeded</code>). Scope <code>*</code> on a service, actor or attribution quota gives each principal its own window.</p>
${table('Active quotas and their current windows', ['Scope', 'Window', 'Workflow prefix', 'Limit', 'Used this window', 'Window started', 'Resets in'], counters.map((c) => html`<tr>
<td>${c.quota.scope_type} <code>${c.scope_id}</code></td><td>${c.quota.window}</td><td>${c.quota.workflow_prefix ? html`<code>${c.quota.workflow_prefix}</code>` : '—'}</td>
<td>${limits(c.quota)}</td><td>${limitsUsed(c)}</td><td>${when(c.window_start)}</td><td>${secs(c.resets_in_seconds)}</td></tr>`), 'no active quota with a single scope.')}
${table('Every quota', ['#', 'Scope', 'Window', 'Workflow prefix', 'Limit', 'Status', 'Origin', 'Updated'], all.map((q) => html`<tr>
<td>${q.id}</td><td>${q.scope_type} <code>${q.scope_id}</code></td><td>${q.window}</td><td>${q.workflow_prefix ? html`<code>${q.workflow_prefix}</code>` : '—'}</td>
<td>${limits(q)}</td><td>${badge(q.status)}</td><td>${q.origin}</td><td>${when(q.updated_at)}</td></tr>`), 'no quotas.')}
${canManage ? html`<h2>Add or change a quota</h2>
<form class="stack" method="post" action="/console/quotas">${csrfField(csrf)}
<p class="muted m0">A quota with the same scope, window and workflow prefix is updated in place. Leave a limit empty for none; disable a quota with its status.</p>
<label for="q-scope_type">Scope type${sel('scope_type', ['global', 'service', 'actor', 'attribution'], form.scope_type || 'service')}</label>
<label>Scope id (<code>*</code> for global, or each principal)<input type="text" name="scope_id" maxlength="200" value="${form.scope_id || ''}" autocomplete="off" spellcheck="false" placeholder="live"></label>
<label for="q-window">Window${sel('window', ['minute', 'hour', 'day'], form.window || 'day')}</label>
<label>Max requests<input type="number" name="max_requests" min="0" step="1" value="${form.max_requests || ''}"></label>
<label>Max tokens<input type="number" name="max_tokens" min="0" step="1" value="${form.max_tokens || ''}"></label>
<label>Max cost (USD)<input type="number" name="max_cost_usd" min="0" step="any" value="${form.max_cost_usd || ''}"></label>
<label>Workflow prefix (optional)<input type="text" name="workflow_prefix" maxlength="120" value="${form.workflow_prefix || ''}" autocomplete="off" spellcheck="false" placeholder="live."></label>
<label for="q-status">Status${sel('status', ['active', 'disabled'], form.status || 'active')}</label>
<button class="primary" type="submit">Save quota</button></form>` : html`<p class="muted">Changing quotas needs <code>ai.provider.manage</code> (the owner's <code>staff.secrets.manage</code>).</p>`}`,
    });
}

function usageRows(caption, first, rows) {
    return table(caption, [first, 'Requests', 'Tokens in', 'Tokens out', 'Cached', 'Cost'], rows.map((r) => html`<tr><td><code>${r.key}</code></td><td>${n(r.requests)}</td>
<td>${n(r.tokens_in)}</td><td>${n(r.tokens_out)}</td><td>${n(r.tokens_cached)}</td><td>${usd(r.cost_usd)}</td></tr>`), 'no usage in this range.');
}

function usage({ staff, csrf, form, bad, report }) {
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
${usageRows('By workflow', 'Workflow', report.byWorkflow)}${usageRows('By provider and model', 'Provider / model', report.byModel)}`,
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

module.exports = { CSP, html, esc, safeUrl, pages: { signIn, message, overview, providers, definitions, definition, runs, run, quotas, usage, cache, audit } };
