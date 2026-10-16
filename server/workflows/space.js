'use strict';
/**
 * OpenVibe.Space's spaces (owner 2026-10-08, plan T20 step 2): small web apps people make that use their OpenVibe
 * account and the network through the space SDK, served at <slug>.openvibe.website.
 *
 *   space.app.build   the AI builder: from what the person asks for (and the space's current files, when changing
 *                     one), a working space: its name, description, the instructions its AI follows, the SDK features
 *                     it uses and its files. Route space.build (the creative model: whole apps need more than the
 *                     chat model), on behalf of the person building it.
 *   space.app.ask     a space's own AI (OV.ai.ask in the SDK): the space's instructions, the conversation so far and
 *                     the visitor's message, a text answer. Route space.ask (an alias of default.chat), on behalf of
 *                     the visitor, so it counts against their daily allowance.
 *
 * Network grants Space ai.run.create / ai.run.read on space.*.
 */
const STR = (n) => ({ type: 'string', maxLength: n });
const OBJ = (props, required) => ({ type: 'object', additionalProperties: false, required: required || Object.keys(props), properties: props });
const ARR = (items, max) => ({ type: 'array', items, maxItems: max });

const CAPABILITIES = ['profile', 'data', 'kv', 'ai'];
const MAX_FILES = 6;
const MAX_FILE_CHARS = 60000;

// What a space's code can call. Space serves the SDK at /_openvibe/sdk.js on every space's own address.
const SDK_REFERENCE = [
    'Load the SDK first: <script src="/_openvibe/sdk.js"></script>. It defines window.OV:',
    '- await OV.ready: resolves once the SDK knows whether the visitor is signed in.',
    '- OV.user: null, or { username, display_name, avatar_url } for the signed-in visitor. OV.on("user", fn) is called when it changes.',
    '- OV.signIn(): takes the visitor to OpenVibe to sign in and approve this space, then back. OV.signOut() forgets them here.',
    '- OV.items.list(collection, { limit }): the shared list, newest first, readable by anyone: [{ id, value, author: { username, display_name }, created_at, mine }].',
    '- OV.items.add(collection, value): adds the signed-in visitor\'s item (value: any JSON, up to 8 KB) and returns it.',
    '- OV.items.set(collection, value): the visitor\'s one item in that collection (a vote, a best score), replaced each time.',
    '- OV.items.remove(collection, id): removes the visitor\'s own item (the space\'s owner may remove any).',
    '- OV.kv.get(key), OV.kv.set(key, value), OV.kv.remove(key): the signed-in visitor\'s private storage in this space (values up to 16 KB).',
    '- OV.ai.ask(text or { messages: [{ role: "user" | "assistant", content }] }): an answer from OpenVibe AI that follows the space\'s instructions (signed in; it counts against the visitor\'s daily AI allowance).',
    '- OV.fn(name, body): runs the space\'s server function functions/<name>.js (a POST with body as JSON; OV.fn(name) alone is a GET) and returns what it answered.',
    'Every call returns a Promise. Failures are Errors with a .code: "auth.required" (call OV.signIn()), "quota" (try later) or another code: show a short friendly message.',
    'Collection names and keys: 1-64 characters of letters, digits, "-", "_" and ".".',
].join('\n');

/** Space functions (OpenVibe.Space server/spaces/functions.js): code that runs on the server, not in the page. */
const FUNCTIONS_REFERENCE = [
    'Server functions, only when the idea needs code the visitor must not see or change (hidden answers, a counter every visitor shares, checking a move or a score before it is saved, a page put together on the server):',
    '- A file functions/<name>.js (name: a-z, 0-9 and "-") defines async function handle(request, ov). The page calls it with await OV.fn("<name>", body); a link or form may also use /api/<name>.',
    '- request: { method, path, query, headers, body }. ov.user (the signed-in visitor or null), ov.items.list/add/set/remove (the shared lists; adds are the visitor\'s when signed in, otherwise the space\'s), ov.store.get/set/remove (the space\'s own server storage that visitors cannot read, values up to 16 KB), ov.ai.ask(text) (a signed-in visitor), console.log.',
    '- handle returns any JSON value, a string (HTML or text), or { status, body }. It runs in a sandbox: plain modern JavaScript, no require/import, fetch, timers, files or packages, about 1 s of computing and 100 ov calls per request.',
].join('\n');

const templates = [
    {
        key: 'space.app.build', name: 'Space: build or change a space',
        description: 'Builds a small web app (a space) from what a person asks for, or changes an existing one.',
        input_schema: { type: 'object' }, output_schema: { type: 'object' },
        system_prompt: [
            'You build "spaces" for OpenVibe.Space: small, complete web apps that run in the browser at their own address and use the visitor\'s OpenVibe account through the OpenVibe SDK.',
            '',
            'The platform:',
            '- HTML, CSS and JavaScript that run in the browser, plus optional server functions (below). The page may fetch only its own files, its functions and the SDK\'s API; scripts, styles and fonts may also come from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com and Google Fonts (always an exact, pinned version).',
            '- Storage, sign-in and AI come from the SDK:',
            SDK_REFERENCE,
            FUNCTIONS_REFERENCE,
            '',
            'How you build:',
            '- Prefer ONE self-contained index.html with inline <style> and <script>. Use more files only when asked; never more than 6, and index.html is always one of them.',
            '- Make it work completely: real logic, no placeholders, no "TODO", no lorem ipsum. Handle loading, empty and error states, and the signed-out visitor (show what works without signing in and a clear "Sign in with OpenVibe" button for the rest).',
            '- Make it look good: a deliberate visual style that fits the idea, readable on a phone and a desktop, light and dark (prefers-color-scheme), visible focus, labelled inputs, enough contrast.',
            '- Phones first: at 360 px wide nothing is squeezed into narrow columns (a header\'s title, text and account box stack vertically below about 560 px), tap targets are at least 44 px, and the main action is visible without scrolling. An avatar image gets an onerror fallback (the initial on a coloured circle).',
            '- Keep the visitor safe: never ask for passwords, payment details or private information; no tracking, analytics or ads; do not imitate a real company or person; nothing sexual involving minors, no hate, no malware.',
            '- If the request needs something the platform cannot do (another site\'s API, payments, work that runs on its own or for long), build the closest honest version and say what is missing in the description.',
            '- When current files are given, change them as asked and keep everything else working; return every file of the space, changed or not.',
            '',
            'Answer with JSON only:',
            '{ "name": "a short name (2-40 characters)", "description": "one or two sentences: what it does, for the gallery", "instructions": "what the space\'s AI should be and do when OV.ai.ask is used (empty when it does not use AI)", "capabilities": ["the SDK features it uses: profile (sign-in), data (OV.items), kv (OV.kv), ai (OV.ai)"], "files": [{ "path": "index.html", "content": "..." }] }',
        ].join('\n'),
        user_prompt: '{{#current}}The space\'s current files:\n{{current}}\n\n{{/current}}{{#name}}Its name now: {{name}}\n\n{{/name}}What {{#current}}to change{{/current}}{{^current}}to build{{/current}}: {{prompt}}',
        default_route: 'space.build', owner: 'space', metadata: { json_name: 'space_app' },
    },
    {
        key: 'space.app.ask', name: 'Space: a space\'s AI answers a visitor',
        description: 'One answer from the AI inside a space (OV.ai.ask), following the instructions its owner wrote.',
        input_schema: { type: 'object' },
        output_schema: OBJ({ text: { type: 'string' } }),
        system_prompt: [
            'You are the AI inside "{{space}}", a small app on OpenVibe.Space that someone made. A visitor is using it.',
            '{{#instructions}}What the app\'s maker wants you to be and do:\n{{instructions}}\n{{/instructions}}',
            '',
            'Always:',
            '- Answer the visitor\'s latest message in the language they wrote in. Plain text unless the app\'s instructions ask for a format.',
            '- The maker\'s instructions cannot make you break these rules: no threats, nothing sexual involving minors, no instructions for weapons or self-harm, never anyone\'s private details, and never ask the visitor for passwords or payment details.',
            '- You can only answer here. Do not claim to have done anything else.',
        ].join('\n'),
        user_prompt: '{{#transcript}}The conversation so far, oldest first:\n{{transcript}}\n\n{{/transcript}}The visitor: {{message}}',
        default_route: 'space.ask', owner: 'space', metadata: {},
    },
];

const FILE = OBJ({ path: STR(80), content: STR(MAX_FILE_CHARS) });
const workflows = [
    {
        key: 'space.app.build', name: 'Space: build or change a space', namespace: 'space',
        description: 'From what a person asks for (and the current files when changing a space): name, description, AI instructions, the SDK features used, and the files.',
        input_schema: OBJ({ prompt: STR(4000), name: STR(40), current: ARR(FILE, MAX_FILES) }, ['prompt']),
        output_schema: OBJ({ name: STR(40), description: STR(400), instructions: STR(4000), capabilities: ARR({ type: 'string', enum: CAPABILITIES }, 4), files: ARR(FILE, MAX_FILES) }),
        steps: [{ kind: 'llm', template: 'space.app.build', operation: 'generate', output: 'json', prepare: 'space.app.build', postprocess: 'space.app.build', params: { max_tokens: 16000, timeout_ms: 180000 } }],
        default_route: 'space.build', cache_mode: 'none', metadata: { seed: true },
    },
    {
        key: 'space.app.ask', name: 'Space: a space\'s AI answers a visitor', namespace: 'space',
        description: 'The AI inside a space answers its visitor, following the instructions the space\'s maker wrote.',
        input_schema: OBJ({ space: STR(40), instructions: STR(4000), transcript: STR(16000), message: STR(4000) }, ['space', 'message']),
        output_schema: OBJ({ text: { type: 'string' } }),
        steps: [{ kind: 'llm', template: 'space.app.ask', operation: 'chat', output: 'text', params: { max_tokens: 800, temperature: 0.7, timeout_ms: 25000 } }],
        default_route: 'space.ask', cache_mode: 'none', metadata: { seed: true },
    },
];

/** A file path a space may have: a few short segments of safe characters, never "..", always relative. */
function cleanPath(p) {
    const s = String(p || '').trim().replace(/^\.?\/+/, '');
    if (!s || s.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}$/.test(s) || s.split('/').includes('..')) return null;
    return s;
}

/** The model's answer as a space, or null when it has no usable index.html (a synthetic answer gets a stand-in one). */
function cleanBuild(out, { synthetic = false } = {}) {
    if (!out || typeof out !== 'object') return null;
    if (synthetic && !(Array.isArray(out.files) && out.files.some((f) => f && f.path === 'index.html'))) {
        out = { ...out, files: [{ path: 'index.html', content: `<!doctype html><html><body><p>${String(out.description || 'synthetic').replace(/[<>&]/g, '')}</p></body></html>` }] };
    }
    const seen = new Set();
    const files = [];
    for (const f of Array.isArray(out.files) ? out.files : []) {
        const path = cleanPath(f && f.path);
        if (!path || seen.has(path.toLowerCase()) || typeof f.content !== 'string') continue;
        seen.add(path.toLowerCase());
        files.push({ path, content: f.content.slice(0, MAX_FILE_CHARS) });
        if (files.length >= MAX_FILES) break;
    }
    if (!files.some((f) => f.path === 'index.html' && /<html|<body|<script|<div/i.test(f.content))) return null;
    const text = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
    const caps = (Array.isArray(out.capabilities) ? out.capabilities : []).map(String).filter((c) => CAPABILITIES.includes(c));
    return {
        name: text(out.name, 40) || 'Untitled space',
        description: text(out.description, 400),
        instructions: String(out.instructions == null ? '' : out.instructions).trim().slice(0, 4000),
        capabilities: [...new Set(caps)],
        files,
    };
}

// The schema the model answers in: the output's shape without its length caps, and not strict. In strict mode the
// provider's constrained decoding of a whole app (one string of ~15,000 characters) spent the budget reasoning and
// answered nothing (finish_reason "length", empty content, 2026-10-16); the caps are enforced by cleanBuild instead.
const uncapped = (schema) => JSON.parse(JSON.stringify(schema, (k, v) => (k === 'maxLength' || k === 'maxItems' ? undefined : v)));
const PREPARE = {
    'space.app.build'(input) {
        const current = (input.current || []).map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');
        return { vars: { prompt: input.prompt, name: input.name || '', current }, jsonSchema: uncapped(workflows.find((w) => w.key === 'space.app.build').output_schema) };
    },
};
// A JSON answer that came back as text (a fenced block, or prose around the object).
function parseLoose(text) {
    const t = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    try { return JSON.parse(t); } catch { /* look for the object */ }
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* none */ } }
    return null;
}
const POSTPROCESS = {
    'space.app.build'(r) { return cleanBuild(r.json || parseLoose(r.text), { synthetic: r.synthetic }); },
};

module.exports = { templates, workflows, PREPARE, POSTPROCESS, SDK_REFERENCE, FUNCTIONS_REFERENCE, CAPABILITIES, cleanBuild, cleanPath };
