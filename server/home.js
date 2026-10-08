'use strict';

/**
 * The product home of OpenVibe.AI (ai.openvibe.services, plan T6: AI as a developer product). The OpenVibe Frame
 * (openvibe-shared/shell) around openvibe-shared/showcase sections for developers. Every claim restates the README
 * (API, Developer apps, Providers, Local model) and the code; nothing here reads data. Prices and measured latency
 * are the /stats page, which reads them.
 *
 *   renderHome({ siteUrl })   the whole document (siteUrl: the public origin, config.baseUrl)
 *   HOME_CSP                  its Content-Security-Policy (the Frame's scripts and calls to the Network)
 *   llmsTxt({ siteUrl })      /llms.txt, the same facts as plain text
 */
const shell = require('openvibe-shared/shell');
const showcase = require('openvibe-shared/showcase');
const ovServe = require('openvibe-shared/serve');
const appIcon = require('openvibe-shared/app-icon');

const SITE_NAME = 'OpenVibe.AI';
const NETWORK_URL = 'https://openvibe.network';
const PROJECTS_URL = 'https://openvibe.services/projects';
const API_DOCS_URL = 'https://openvibe.services/docs/api';
const SOURCE = 'https://github.com/OpenVibers/OpenVibe.AI';
const GUIDE = `${SOURCE}#developer-apps`;
const DESCRIPTION = 'One API for chat, generation, summaries, classification, extraction and embeddings across many models. '
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

function sections({ siteUrl }) {
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
    return showcase.hero({
        eyebrow: 'OpenVibe.AI · alpha',
        title: 'Many models, one API.', accent: 'Every answer explained.',
        lede: 'Chat, generate, summarize, classify, extract and embed through one API. OpenVibe.AI picks a model by price, measured latency '
            + 'and health, falls back when a provider fails, and tells you on every run which model answered, why it was chosen and what it cost.',
        actions: [{ label: 'Start building', href: PROJECTS_URL, primary: true }, { label: 'See prices and latency', href: '/stats' }],
        note: 'Alpha. OpenVibe.Live and OpenVibe.Network already run their AI here in production; developer apps start in the sandbox, on free and local capacity.',
    }) + showcase.features({
        title: 'What you get',
        items: [
            { icon: 'ov:text', title: 'Six operations', text: 'Chat, generate, summarize, classify, extract and embed, with structured JSON output when you ask for a schema.' },
            { icon: 'ov:map', title: 'Routing you can read', text: 'Every run carries an explanation: what it optimised for, the model it picked, and every other candidate with its estimated cost and latency.' },
            { icon: 'ov:history', title: 'Fallbacks on the record', text: 'A provider that is down, out of credentials or too slow is skipped and logged. When a fallback answers, the run says so.' },
            { icon: 'ov:host', title: 'Free and local first', text: 'A small open model runs on OpenVibe\'s own server, beside free providers. Sandbox apps use only that capacity, so trying it costs nothing.' },
            { icon: 'ov:account', title: 'Your project\'s runs', text: 'Runs belong to your project: another project can never read them. Usage is metered per project, with a free allowance first.' },
            { icon: 'ov:code', title: 'Open source', text: 'AGPL-3.0, built in the open. Every guarantee on this page has a test in the repository.' },
        ],
    }) + showcase.code({
        id: 'examples',
        title: 'Token, chat, explain',
        lede: 'With an app from OpenVibe.Codes: get a token from OpenVibe.Network, call an operation, then read why that model answered.',
        samples: [
            { label: 'Token', lang: 'bash', code: token },
            { label: 'Chat', lang: 'bash', code: chat },
            { label: 'Explain', lang: 'bash', code: read },
        ],
    }) + showcase.steps({
        title: 'Start in four steps',
        items: [
            { title: 'Create a project', text: 'Sign in at openvibe.services/projects with your OpenVibe account and create a project.' },
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
            { label: 'Models', values: ['Free and local capacity only', 'Free and local capacity; metered models under a project budget'] },
            { label: 'Free allowance', values: ['Per project, per provider', 'Per project, per provider'] },
            { label: 'Who can read a run', values: ['The project that made it', 'The project that made it'] },
            { label: 'A person\'s own provider key', values: ['Never used', 'Never used'] },
        ],
    }) + showcase.nextSteps({
        items: [
            { what: 'Prices and latency', text: 'Measured per provider and model over the last seven days.', href: '/stats' },
            { what: 'Create a project and an app', text: 'Sign in with your OpenVibe account; the sandbox is open to every project.', href: PROJECTS_URL, to: 'codes' },
            { what: 'API reference', text: 'The OpenAPI document generated from the published contracts.', href: API_DOCS_URL, to: 'codes' },
            { what: 'Developer guide', text: 'Tokens, limits, billing and the sandbox, in full.', href: GUIDE },
        ],
    });
}

function renderHome({ siteUrl }) {
    const navLinks = [{ label: 'Prices', href: '/stats' }, { label: 'Guide', href: GUIDE }];
    const nav = { service: 'ai', apiBase: NETWORK_URL, links: navLinks, history: { type: 'page', title: SITE_NAME } };
    const footer = { service: 'ai', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME };
    return shell.page({
        name: SITE_NAME, service: 'ai', lang: 'en',
        title: `${SITE_NAME}: many models, one API, every answer explained`,
        siteName: SITE_NAME,
        description: DESCRIPTION,
        summary: DESCRIPTION,
        canonical: `${siteUrl}/`,
        robots: 'index, follow',
        navbar: nav, footer, home: '/', navLinks,
        head: [
            appIcon.headTags({ site: 'ai' }),
            `<link rel="stylesheet" href="${ovServe.url(showcase.STYLESHEET)}">`,
        ].join('\n'),
        body: `<div id="navbar-mount"></div>
<main id="main" class="page">
${sections({ siteUrl })}
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

module.exports = { renderHome, llmsTxt, HOME_CSP, SITE_NAME, renderNotFound };
