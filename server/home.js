'use strict';

/**
 * The product home of OpenVibe.AI (ai.openvibe.services, plan T6: AI as a developer product). The OpenVibe Frame
 * (openvibe-shared/shell) around openvibe-shared/showcase sections for developers. Every claim restates the README
 * (API, Developer apps, OpenAI-compatible endpoint, Providers, Local model) and the code. The numbers and the model
 * table are the /stats rows (provider_stats_daily and the rate cards, nothing per caller), passed in by the route.
 *
 *   renderHome({ siteUrl, stats })   the whole document (siteUrl: the public origin, config.baseUrl; stats: { days, rows })
 *   HOME_CSP                  its Content-Security-Policy (the Frame's scripts and calls to the Network)
 *   llmsTxt({ siteUrl })      /llms.txt, the same facts as plain text
 */
const shell = require('openvibe-shared/shell');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const ovServe = require('openvibe-shared/serve');
const appIcon = require('openvibe-shared/app-icon');
const seo = require('openvibe-shared/seo');

const SITE_NAME = 'OpenVibe.AI';
const NETWORK_URL = 'https://openvibe.network';
const PROJECTS_URL = 'https://openvibe.services/projects';
const API_DOCS_URL = 'https://openvibe.services/docs/api';
const SOURCE = 'https://github.com/OpenVibers/OpenVibe.AI';
const GUIDE = `${SOURCE}#developer-apps`;
const DESCRIPTION = 'One API for chat, summaries, extraction and embeddings across many models, OpenAI-compatible. Every run says which model answered, why and what it cost.';
// The longer line for AI readers (the page summary): the same facts, with the sandbox.
const SUMMARY = 'One API for chat, generation, summaries, classification, extraction and embeddings across many models. '
    + 'Every run says which model answered, why it was chosen and what it cost, and sandbox apps run on free and local capacity.';

const HOME_CSP = [
    "default-src 'self'",
    // Cloudflare Web Analytics: Cloudflare injects its beacon at the edge on this zone; script-src loads it and connect-src
    // is where it reports (performance timing only, no cookies).
    "script-src 'self' 'unsafe-inline' https://openvibe.network https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://openvibe.network https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://openvibe.network https://openvibe.events https://cloudflareinsights.com",
    "frame-src 'self' https://openvibe.network",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://openvibe.network",
].join('; ');

const n = (v) => Number(v || 0).toLocaleString('en-US');
const usd = (v) => { const x = Number(v); return `$${x >= 0.01 || x === 0 ? x.toFixed(2) : x.toPrecision(2)}`; };
const esc = showcase.esc;

/** The week in numbers, from the /stats rows: runs answered, models that answered, the share of calls that succeeded. */
function numbers(stats) {
    const rows = (stats && stats.rows) || [];
    const ok = rows.reduce((a, r) => a + (Number(r.ok) || 0), 0);
    const calls = rows.reduce((a, r) => a + (Number(r.requests) || 0), 0);
    if (!ok) return '';
    const models = rows.filter((r) => Number(r.ok) > 0).length;
    const pct = (100 * ok) / calls;
    const items = [
        [n(ok), `calls answered in the last ${stats.days} days`],
        [n(models), models === 1 ? 'model answered them' : 'models answered them'],
        [`${pct >= 99.95 ? '100' : pct.toFixed(1)}%`, 'of provider calls succeeded'],
    ];
    return `<section class="sc-sec ai-num" aria-label="The last ${esc(stats.days)} days in numbers"><ul>${items.map(([v, label]) => `<li><a href="/stats"><b>${esc(v)}</b><span>${esc(label)}</span></a></li>`).join('')}</ul></section>`;
}

/** Every model that answered in the window, most used first: what it does, typical latency and its price card. */
function models(stats) {
    const rows = ((stats && stats.rows) || []).filter((r) => Number(r.ok) > 0).sort((a, b) => b.ok - a.ok);
    if (!rows.length) return '';
    const price = (cards) => (cards && cards.in && cards.out ? `${usd(cards.in.unit_price_usd)} in · ${usd(cards.out.unit_price_usd)} out per ${cards.in.unit_size === 1e6 ? '1M' : n(cards.in.unit_size)} tokens` : 'not billed');
    const caps = (c) => { const list = String(c || '').split(/,\s*/).filter(Boolean); return list.length > 5 ? `${list.slice(0, 5).join(', ')} and ${list.length - 5} more` : list.join(', '); };
    return `<section class="sc-sec" id="models" aria-labelledby="h-models"><h2 id="h-models">Models that answered this week</h2>
<p class="sc-lede">Every model that answered a call in the last ${esc(stats.days)} days, for OpenVibe's own sites and for apps, with what it does, how fast it usually answered and what it costs. Apps on the router get free and local capacity today (a small local model, without tools); name your project's own provider for anything bigger.</p>
<div class="sc-table-wrap" tabindex="0" role="region" aria-labelledby="h-models"><table class="sc-table"><thead><tr><th scope="col">Model</th><th scope="col">Provider</th><th scope="col">Does</th><th scope="col">Answered</th><th scope="col">Typical latency</th><th scope="col">Price</th></tr></thead><tbody>
${rows.map((r) => `<tr><th scope="row"><code>${esc(r.model || '—')}</code></th><td><code>${esc(r.provider)}</code></td><td>${esc(caps(r.capability))}</td><td>${esc(n(r.ok))}</td><td>${r.p50 == null ? '—' : `under ${esc(r.p50 >= 1000 ? `${(r.p50 / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} s` : `${n(r.p50)} ms`)}`}</td><td>${esc(price(r.cards))}</td></tr>`).join('\n')}
</tbody></table></div><p class="sc-note">Latency is the upper bound of a fixed bucket on the slowest day. Every number here, with p95, success rates and free allowances, is on <a href="/stats">Prices and latency</a>.</p></section>`;
}

// The questions developers ask, answered from the README; the FAQPage JSON-LD repeats them word for word.
const FAQ = [
    { q: 'What is OpenVibe.AI for?', a: 'One API for chat, generation, summaries, classification, extraction and embeddings across model providers, used by every OpenVibe site and open to developers.' },
    { q: 'Can I use the OpenAI SDK?', a: 'Yes. Set the client\'s base URL to https://ai.openvibe.services/v1 and pass your app\'s OpenVibe token as the API key. Chat Completions with tools and streaming work, and each answer names the model that ran.' },
    { q: 'Which models can my app use?', a: 'Through the router, free and local capacity: today a small local model without tools. For anything bigger, name your project\'s own OpenAI-format provider; its key stays a project secret, revealed for one run and never stored.' },
    { q: 'How is AI paid for?', a: 'At cost: each project has quotas and budgets, and every run records its model, usage and cost. Sandbox apps use only free and local capacity, so trying it costs nothing.' },
    { q: 'Does it keep my prompts?', a: 'Not on /v1/chat/completions: each request is a run whose usage, cost and explanation are kept, and the prompt is not.' },
    { q: 'Who can read a run?', a: 'Only the project that made it. Runs, usage and the free allowance are per project, and a person\'s own provider key is never used for an app.' },
];
const faq = () => `<section class="sc-sec" id="faq" aria-labelledby="h-faq"><h2 id="h-faq">Questions developers ask</h2><div class="ai-faq">${FAQ.map((p) => `<div><h3>${esc(p.q)}</h3><p>${esc(p.a)}</p></div>`).join('')}</div></section>`;

function sections({ siteUrl, stats }) {
    const token = [
        'TOKEN=$(curl -s -X POST https://openvibe.network/oauth/token \\',
        '  -d grant_type=client_credentials -d client_id=$APP -d client_secret=$SECRET \\',
        '  -d audience=openvibe.ai | jq -r .access_token)',
        '# a five-minute token for your app (app_<ULID>), scoped to its project',
    ].join('\n');
    const chat = [
        `curl -s -X POST ${siteUrl}/api/v1/chat \\`,
        '  -H "Authorization: Bearer $TOKEN" -H \'Content-Type: application/json\' \\',
        '  -d \'{ "messages": [ { "role": "user", "content": "Name three uses for a paperclip." } ] }\'',
        '# → { "run": { "id": "run_…", "status": "succeeded", "output": …, "provenance": …, "explain": … } }',
    ].join('\n');
    const read = [
        `curl -s ${siteUrl}/api/v1/runs/$RUN -H "Authorization: Bearer $TOKEN" | jq .run.explain`,
        '# objective, the provider and model selected, and every candidate with its',
        '# estimated cost, latency and the reason it was passed over',
    ].join('\n');
    const python = [
        '# pip install openai requests',
        'import os, requests',
        'from openai import OpenAI',
        '',
        'token = requests.post("https://openvibe.network/oauth/token", data={',
        '    "grant_type": "client_credentials", "audience": "openvibe.ai",',
        '    "client_id": os.environ["OV_CLIENT_ID"], "client_secret": os.environ["OV_CLIENT_SECRET"],',
        '}).json()["access_token"]                     # lasts five minutes',
        '',
        `client = OpenAI(base_url="${siteUrl}/v1", api_key=token)`,
        'reply = client.chat.completions.create(',
        '    model="auto",                              # the router picks; reply.model names the one that ran',
        '    messages=[{"role": "user", "content": "Name three uses for a paperclip."}],',
        ')',
        'print(reply.model, reply.choices[0].message.content)',
    ].join('\n');
    const node = [
        '// npm i openai',
        "import OpenAI from 'openai';",
        '',
        `const client = new OpenAI({ baseURL: '${siteUrl}/v1', apiKey: token });   // token: as in the Python sample`,
        'const stream = await client.chat.completions.create({',
        "    model: 'auto', stream: true,",
        "    messages: [{ role: 'user', content: 'Name three uses for a paperclip.' }],",
        '});',
        "for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');",
    ].join('\n');
    return showcase.hero({
        eyebrow: 'OpenVibe.AI · part of OpenVibe Services · alpha',
        title: 'Many models, one API.', accent: 'Every answer explained.',
        lede: 'Chat, generate, summarize, classify, extract and embed through one API, or point any OpenAI client at it. OpenVibe.AI picks a '
            + 'model by price, measured latency and health, falls back when a provider fails, and tells you on every run which model answered, '
            + 'why it was chosen and what it cost.',
        actions: [{ label: 'Start building', href: PROJECTS_URL, primary: true }, { label: 'See prices and latency', href: '/stats' }],
        note: 'Alpha. OpenVibe.Live and OpenVibe.Network already run their AI here in production; developer apps start in the sandbox, on free and local capacity.',
    }) + '<section class="sc-sec sc-part-of"><p class="sc-note">Part of <a href="https://openvibe.services/">OpenVibe Services</a>: the building blocks every OpenVibe product runs on, with one console, one account and one SDK.</p></section>' + numbers(stats) + showcase.features({
        title: 'What you get',
        items: [
            { icon: 'ov:text', title: 'Six operations, and OpenAI\'s API', text: 'Chat, generate, summarize, classify, extract and embed, with JSON output on a schema. Any OpenAI client works too: point it at /v1 for Chat Completions with tools.' },
            { icon: 'ov:map', title: 'Routing you can read', text: 'Every run carries an explanation: what it optimised for, the model it picked, and every other candidate with its estimated cost and latency.' },
            { icon: 'ov:history', title: 'Fallbacks on the record', text: 'A provider that is down, out of credentials or too slow is skipped and logged. When a fallback answers, the run says so.' },
            { icon: 'ov:host', title: 'Free and local first', text: 'A small open model runs on OpenVibe\'s own server, beside free providers. Sandbox apps use only that capacity, so trying it costs nothing.' },
            { icon: 'ov:account', title: 'Your project\'s runs', text: 'Runs belong to your project: another project can never read them. Usage is metered per project, with a free allowance first.' },
            { icon: 'ov:code', title: 'Open source', text: 'AGPL-3.0, built in the open. Every guarantee on this page has a test in the repository.' },
        ],
    }) + models(stats) + showcase.code({
        id: 'openai',
        title: 'Use the OpenAI SDK you already have',
        lede: `Point its base URL at ${siteUrl}/v1 and use your app's OpenVibe token as the key. Streaming and tools work; the answer's model names the model that ran.`,
        samples: [
            { label: 'Python', lang: 'python', code: python },
            { label: 'Node, streaming', lang: 'js', code: node },
        ],
    }) + showcase.code({
        id: 'examples',
        title: 'Token, chat, explain',
        lede: 'With an app from OpenVibe.Services: get a token from OpenVibe.Network, call an operation, then read why that model answered.',
        samples: [
            { label: 'Token', lang: 'bash', code: token },
            { label: 'Chat', lang: 'bash', code: chat },
            { label: 'Explain', lang: 'bash', code: read },
        ],
    }) + showcase.steps({
        title: 'Start in four steps',
        items: [
            { title: 'Create a project', text: 'Sign in at openvibe.services/projects with your OpenVibe account and create a project.', href: PROJECTS_URL },
            { title: 'Add an app', text: 'Add an app to it. A confidential app gets a client id and a secret, shown once.' },
            { title: 'Get a token', text: 'Exchange them at OpenVibe.Network for a five-minute token with the audience openvibe.ai.' },
            { title: 'Call an operation', text: 'POST to /api/v1/chat or any of the other five, and keep the run id to read it later.' },
        ],
    }) + showcase.limits({
        title: 'Sandbox and production',
        lede: 'Both environments call the same API; the token says which one an app is in.',
        columns: ['Sandbox', 'Production'],
        rows: [
            { label: 'Access to ai.app.run', values: ['Every sandbox app, without asking', 'Once OpenVibe staff add it to the project'] },
            { label: 'Models', values: ['Free and local capacity only', 'Free and local capacity; metered models open with project budgets'] },
            { label: 'Your project\'s own provider', values: ['On /v1/chat/completions, keyed by a project secret granted to ai', 'The same'] },
            { label: 'Free allowance', values: ['Per project, per provider', 'Per project, per provider'] },
            { label: 'Who can read a run', values: ['The project that made it', 'The project that made it'] },
            { label: 'A person\'s own provider key', values: ['Never used', 'Never used'] },
        ],
    }) + faq() + showcase.nextSteps({
        items: [
            { what: 'Prices and latency', text: 'Measured per provider and model over the last seven days.', href: '/stats' },
            { what: 'Create a project and an app', text: 'Sign in with your OpenVibe account; the sandbox is open to every project.', href: PROJECTS_URL, to: 'services' },
            { what: 'API reference', text: 'The OpenAPI document generated from the published contracts.', href: API_DOCS_URL, to: 'services' },
            { what: 'Developer guide', text: 'Tokens, limits, billing and the sandbox, in full.', href: GUIDE },
        ],
    });
}

// What the kit does not draw: the numbers row, the FAQ cards, and code samples one under another (their lines are long).
const HOME_STYLE = `<style>
.ai-num{margin-top:28px}.ai-num ul{list-style:none;margin:0;padding:0;display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr))}
.ai-num a{display:flex;flex-direction:column;gap:2px;height:100%;padding:14px 16px;border-radius:14px;border:1px solid var(--border,#1f2d47);background:var(--bg-secondary,#101828);color:inherit;text-decoration:none}
.ai-num a:hover,.ai-num a:focus-visible{border-color:var(--accent,#3b82f6)}.ai-num b{font-size:26px;font-weight:800;letter-spacing:-.5px;line-height:1.15}.ai-num span{font-size:13px;line-height:1.35;color:var(--text-secondary,#96a7c2)}
#openai .sc-code,#examples .sc-code{grid-template-columns:minmax(0,1fr)}
#models table{min-width:860px}#models td:nth-child(3){min-width:190px}#models td,#models th{vertical-align:top}#models th code{white-space:nowrap}#models td:nth-child(4),#models td:nth-child(5){white-space:nowrap}
.ai-faq{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))}
.ai-faq>div{padding:16px 18px;border-radius:16px;border:1px solid var(--border,#1f2d47);background:var(--bg-secondary,#101828)}
.ai-faq h3{margin:0 0 6px;font-size:15.5px;line-height:1.35}.ai-faq p{margin:0;font-size:14px;line-height:1.55;color:var(--text-secondary,#96a7c2)}
</style>`;

const NAV_LINKS = [{ label: 'Prices', href: '/stats' }, { label: 'Guide', href: GUIDE }];
const FOOTER = { service: 'ai', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };

/** /updates: what shipped on this site (the network's shared update log, openvibe-shared/frame updatesBody). */
function renderUpdates({ siteUrl }) {
    return shell.page({
        name: SITE_NAME, service: 'ai', lang: 'en',
        title: `What shipped on ${SITE_NAME}`,
        siteName: SITE_NAME,
        description: `Every change deployed to ${SITE_NAME}, newest first.`,
        canonical: `${siteUrl}/updates`, agentLayer: true,
        robots: 'index, follow',
        navbar: { service: 'ai', apiBase: NETWORK_URL, links: NAV_LINKS, history: { type: 'page', title: SITE_NAME } },
        footer: FOOTER, home: '/', navLinks: NAV_LINKS,
        head: appIcon.headTags({ site: 'ai' }),
        body: `<div id="navbar-mount"></div>
<main id="main" class="page">
${frame.updatesBody({ service: 'ai', siteName: SITE_NAME })}
</main>
<script src="${ovServe.url('shipped.js')}" defer></script>`,
    });
}

function renderHome({ siteUrl, stats = null }) {
    const navLinks = NAV_LINKS;
    const nav = { service: 'ai', apiBase: NETWORK_URL, links: navLinks, history: { type: 'page', title: SITE_NAME } };
    const footer = FOOTER;
    const site = String(siteUrl).replace(/\/+$/, '');
    return shell.page({
        name: SITE_NAME, service: 'ai', lang: 'en',
        title: `${SITE_NAME}: many models, one API, every answer explained`,
        siteName: SITE_NAME,
        description: DESCRIPTION,
        summary: SUMMARY,
        canonical: `${siteUrl}/`, agentLayer: true,
        robots: 'index, follow',
        jsonLd: [
            seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
            seo.jsonLd.softwareApp({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, category: 'DeveloperApplication', keywords: 'ai api, llm router, openai compatible api, model routing, ai gateway, open source' }),
            seo.jsonLd.faq(FAQ),
        ],
        navbar: nav, footer, home: '/', navLinks,
        head: [
            appIcon.headTags({ site: 'ai' }),
            `<link rel="stylesheet" href="${ovServe.url(showcase.STYLESHEET)}">`,
            HOME_STYLE,
        ].join('\n'),
        body: `<div id="navbar-mount"></div>
<main id="main" class="page">
${sections({ siteUrl, stats })}
</main>`,
    });
}

function llmsTxt({ siteUrl }) {
    return [
        `# ${SITE_NAME}`,
        '',
        `> ${DESCRIPTION}`,
        '',
        `- Home: ${siteUrl}/`,
        `- Prices and measured latency per provider and model: ${siteUrl}/stats`,
        `- Developer guide (tokens, limits, billing, sandbox): ${GUIDE}`,
        `- API reference (OpenAPI, generated from the contracts): ${API_DOCS_URL}`,
        `- Create a project and an app: ${PROJECTS_URL}`,
        `- Source (AGPL-3.0): ${SOURCE}`,
        '',
        '## Developer apps',
        '',
        '- Token: POST https://openvibe.network/oauth/token with grant_type=client_credentials, your app\'s client id and secret, audience=openvibe.ai (five minutes).',
        `- Operations: POST ${siteUrl}/api/v1/chat, /generate, /summarize, /classify, /extract, /embed; GET ${siteUrl}/api/v1/runs/:id for your own runs.`,
        `- OpenAI-compatible: POST ${siteUrl}/v1/chat/completions (Chat Completions with tools; stream: true streams the upstream's deltas) and GET ${siteUrl}/v1/models, with the same token. Point an OpenAI client's base URL at ${siteUrl}/v1.`,
        `- An app's own provider: add x_openvibe.provider { base_url, model, secret } to name the project's own OpenAI-format API; secret is a project secret granted to ai for reveal to that origin (ADR-056), revealed per run and never stored.`,
        '- Every run response carries explain: the objective, the model selected and every candidate with its estimated cost, latency and excluded reason.',
        '- Sandbox apps run on free and local capacity only; runs, usage and the free allowance are per project; a person\'s own provider key is never used for an app.',
        '',
    ].join('\n');
}

/** The page a browser gets for a path nothing serves: a real document (language, title, the app icon), not JSON. */
function renderNotFound() {
    return ['<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>Not found · ${SITE_NAME}</title>`, '<meta name="robots" content="noindex">', appIcon.headTags({ site: 'ai' }), '</head>',
        '<body style="font-family:system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;line-height:1.5">',
        '<h1>Not found</h1>', `<p>Nothing is here. <a href="/">${SITE_NAME}</a> · <a href="/stats">Prices and latency</a> · <a href="${NETWORK_URL}">OpenVibe</a></p>`, '</body>', '</html>'].join('\n');
}

module.exports = { renderHome, renderUpdates, llmsTxt, HOME_CSP, SITE_NAME, renderNotFound, FAQ, DESCRIPTION };
