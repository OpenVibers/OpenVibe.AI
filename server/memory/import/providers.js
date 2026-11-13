'use strict';
/**
 * The cloud import adapters (OpenVibe Memory M3): ChatGPT, Claude and Gemini exports, and the answer to the
 * extraction prompt. This file turns an export into *candidate* memory items; it never stores anything and it
 * never returns raw conversation text. Only a sentence that looks like a memory survives, already redacted.
 *
 * The formats, read from the vendors' own exports:
 *   ChatGPT  a zip with conversations.json: an array of { title, create_time, mapping }, where a message has
 *            `author.role` and `content.parts`.
 *   Claude   a zip with conversations.json ({ chat_messages[] } with `sender` and content blocks) and, on plans
 *            that have memory, memories.json ({ content, created_at }). The saved memories are the strongest signal.
 *   Gemini   Google Takeout: Takeout/My Activity/Gemini Apps/My Activity.json (activity records with a `title`
 *            holding the prompt), and, on some accounts, Gemini/conversations/*.json.
 *
 * The extraction prompt is the method Claude's own memory import uses: ask the assistant to list what it remembers,
 * then paste the answer back. The answer is parsed as bullets, with an optional [preference] / [fact] / … label.
 *
 * Redaction runs before a candidate is returned, so a secret never reaches the preview, the browser or the store.
 * The store redacts again in its batch import; two passes are deliberate.
 */

const { redact, onlySecret } = require('openvibe-sdk/redact');

const MAX_ITEMS = 200;
const MAX_ITEM_CHARS = 600;
const MAX_MESSAGES = 200000;

const EXTRACTION_PROMPT = [
    'List everything you remember about me as short bullet points.',
    'For each bullet, give only the memory in one sentence, then a label in square brackets: [preference], [fact],',
    '[project rule], [procedure], [decision] or [lesson]. Include saved memories, custom instructions and things you',
    'have learned about how I work. Do not guess. Do not include passwords, keys, tokens or anything else secret.',
].join(' ');

const PROVIDERS = [
    {
        id: 'chatgpt',
        name: 'ChatGPT',
        what: 'Your chats. ChatGPT does not put its saved-memory list in the data export, so paste the extraction prompt too if you want that list.',
        url: 'https://chatgpt.com/#settings/DataControls',
        export_label: 'Settings, then Data controls, then Export data',
        steps: [
            'Open Settings, then Data controls, then Export data and choose Export.',
            'OpenAI emails you a download link; the file is a .zip.',
            'Drop the .zip here. We read conversations.json and skip the HTML copy.',
        ],
        arrives: 'A .zip with conversations.json, chat.html, user.json and a few small JSON files.',
        time: 'Usually a few minutes. A very large history can take up to 24 hours; the link is emailed to you.',
        prompt_where: 'Start a new chat in ChatGPT and paste the prompt below, then paste its answer back here.',
    },
    {
        id: 'claude-ai',
        name: 'Claude',
        what: 'Claude’s own memory list, when your plan exports it, plus the chats in the same export.',
        url: 'https://claude.ai/settings/data-privacy-controls',
        export_label: 'Settings, then Privacy, then Export data',
        steps: [
            'Open Settings, then Privacy, then Export data (Claude emails you a link when it is ready).',
            'Download the .zip and drop it here.',
            'We read memories.json first, then conversations.json for things you asked Claude to remember.',
        ],
        arrives: 'A .zip with conversations.json, memories.json (on plans with memory), projects.json and users.json.',
        time: 'Usually minutes, sometimes a few hours. The link is valid for a limited time.',
        prompt_where: 'Start a new chat in Claude and paste the prompt below, then paste its answer back here.',
    },
    {
        id: 'gemini-apps',
        name: 'Gemini',
        what: 'Your Gemini Apps activity from Google Takeout. The separate “Gemini” Takeout option is Gems, not chats.',
        url: 'https://takeout.google.com',
        export_label: 'Takeout, then My Activity, then Gemini Apps',
        steps: [
            'In Google Takeout choose Deselect all, then select My Activity.',
            'Open All activity data included, deselect all, and tick only Gemini Apps (called Bard on older accounts).',
            'Export once as a .zip, download it and drop it here.',
        ],
        arrives: 'Takeout/My Activity/Gemini Apps/My Activity.json, and sometimes Gemini/conversations/*.json.',
        time: 'A few minutes to several hours; Google emails you when it is ready. The download link expires in 7 days.',
        prompt_where: 'Start a new chat in Gemini and paste the prompt below, then paste its answer back here.',
    },
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
const ALIASES = { chatgpt: 'chatgpt', openai: 'chatgpt', claude: 'claude-ai', 'claude-ai': 'claude-ai', claudeai: 'claude-ai', gemini: 'gemini-apps', bard: 'gemini-apps', 'gemini-apps': 'gemini-apps', takeout: 'gemini-apps', paste: 'paste', other: 'paste' };
const SOURCE_NAMES = { chatgpt: 'ChatGPT', 'claude-ai': 'Claude', 'gemini-apps': 'Gemini', paste: 'Pasted memory' };

class ImportError extends Error {
    constructor(message, code = 'import.invalid') {
        super(message);
        this.code = code;
        this.status = 422;
    }
}

function normalizeProvider(value, fallback = null) {
    const key = String(value == null ? '' : value).trim().toLowerCase();
    return ALIASES[key] || fallback;
}

function providerName(id) {
    return SOURCE_NAMES[id] || String(id || 'memory');
}

/** An ISO date-time from a vendor timestamp (seconds as a number, milliseconds, or a string). */
function when(value, fallback) {
    if (value == null || value === '') return fallback || null;
    let d;
    if (typeof value === 'number') d = new Date(value < 1e12 ? value * 1000 : value);
    else d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : (fallback || null);
}

function clip(text, max = MAX_ITEM_CHARS) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

const MARKERS = [
    /\bremem(?:ber|bered)\b/i,
    /\bdon'?t forget\b/i,
    /\bkeep (?:this )?in mind\b/i,
    /\bmy name is\b/i,
    /\bcall me\b/i,
    /\bi(?:'m| am) (?:a|an)\b/i,
    /\bi (?:live|work|grew up) (?:in|at|on|for)\b/i,
    /\bi (?:prefer|like|love|hate|avoid|use|always|never|usually)\b/i,
    /\bmy (?:favourite|favorite|preferred|timezone|birthday|team|company|role|job|editor|setup|stack|repo|project)\b/i,
    /\bwe (?:decided|agreed|chose|use|always|never)\b/i,
    /\b(?:in|for) this (?:project|repo|repository|codebase|app)\b/i,
    /\bplease (?:always|never|use|keep|remember)\b/i,
    /\bfrom now on\b/i,
    /\b(?:always|never) (?:use|do|run|write|name|call|put)\b/i,
];

const KIND_LABELS = {
    preference: 'preference', preferred: 'preference', fact: 'fact', 'project rule': 'project_rule',
    'project-rule': 'project_rule', project_rule: 'project_rule', procedure: 'procedure', process: 'procedure',
    skill: 'procedure', decision: 'decision', lesson: 'lesson',
};

function guessKind(text) {
    const s = String(text || '');
    if (/\b(?:decid(?:ed|e)|decision|agreed|settled on|chose)\b/i.test(s)) return 'decision';
    if (/\b(?:learned|learnt|lesson|mistake|realized|realised)\b/i.test(s)) return 'lesson';
    if (/\b(?:project|repo|repository|codebase|our stack|this app)\b/i.test(s)
        && /\b(?:use|rule|convention|always|never|keep|must)\b/i.test(s)) return 'project_rule';
    if (/\b(?:run|install|command|step|workflow|process|procedure)\b/i.test(s)
        && /\b(?:to|then|first|before|after|use)\b/i.test(s)) return 'procedure';
    if (/\b(?:prefer|favourite|favorite|like|love|hate|rather|always|never|avoid)\b/i.test(s)) return 'preference';
    return 'fact';
}

/** A stored-memory candidate, after redaction. Null means it was blank or nothing but a secret. */
function candidate(text, details) {
    const raw = clip(text);
    if (raw.length < 8) return null;
    const clean = clip(redact(raw).text);
    if (!clean || onlySecret(clean)) return null;
    return {
        text: clean,
        kind: KIND_LABELS[String(details.label || '').toLowerCase()] || details.kind || guessKind(clean),
        scope: details.scope || 'user',
        source: details.source,
        source_ref: details.source_ref || null,
        seen_at: details.seen_at || null,
        confidence: details.confidence == null ? 0.55 : details.confidence,
    };
}

function splitSentences(text) {
    return String(text || '')
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function stripRemember(text) {
    return String(text || '')
        .replace(/^\s*(?:please\s+)?(?:do\s+)?remember(?:\s+that)?[:,]?\s+/i, '')
        .replace(/^\s*(?:please\s+)?don'?t forget(?:\s+that)?[:,]?\s+/i, '')
        .replace(/^\s*keep in mind(?:\s+that)?[:,]?\s+/i, '')
        .replace(/^[-*•\d.)\s]+/, '')
        .trim();
}

/** The user's own sentences that announce a durable memory; assistant text is never a candidate by itself. */
function candidatesFromText(text, details) {
    const out = [];
    for (const sentence of splitSentences(text)) {
        if (sentence.length < 12 || sentence.length > 1200) continue;
        if (!MARKERS.some((re) => re.test(sentence))) continue;
        const item = candidate(stripRemember(sentence), details);
        if (item) out.push(item);
    }
    return out;
}

/* ── ChatGPT ─────────────────────────────────────────────────────────────────────────────────────────────── */

function chatgptText(message) {
    const content = message && message.content;
    if (!content || typeof content !== 'object') return '';
    if (!Array.isArray(content.parts)) return '';
    return content.parts.map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
    }).filter(Boolean).join('\n');
}

/** The current branch of a conversation, root → leaf. A mapping is a tree; only the branch the person sees. */
function chatgptMessages(conversation) {
    const mapping = conversation && conversation.mapping;
    if (!mapping || typeof mapping !== 'object') return [];
    const chain = [];
    let id = conversation.current_node;
    const seen = new Set();
    while (id && mapping[id] && !seen.has(id)) {
        seen.add(id);
        chain.push(mapping[id]);
        id = mapping[id].parent;
    }
    if (!chain.length) chain.push(...Object.values(mapping));
    chain.reverse();
    const out = [];
    for (const node of chain) {
        const message = node && node.message;
        if (!message) continue;
        const role = String((message.author && message.author.role) || '');
        const text = chatgptText(message);
        if (!text) continue;
        out.push({ role, text, at: when(message.create_time) });
    }
    return out;
}

function parseChatgpt(conversations, file, summary) {
    const out = [];
    for (const conversation of Array.isArray(conversations) ? conversations : []) {
        if (!conversation || typeof conversation !== 'object') continue;
        const title = clip(conversation.title || 'ChatGPT conversation', 300);
        const messages = chatgptMessages(conversation);
        summary.conversations++;
        summary.messages += messages.length;
        const at = when(conversation.create_time, messages.find((m) => m.at)?.at);
        for (const message of messages) {
            if (message.role !== 'user') continue;
            out.push(...candidatesFromText(message.text, {
                source: 'chatgpt', source_ref: { path: file, heading: title }, seen_at: message.at || at,
            }));
        }
    }
    return out;
}

/* ── Claude ──────────────────────────────────────────────────────────────────────────────────────────────── */

function claudeText(message) {
    if (Array.isArray(message && message.content)) {
        return message.content.map((block) => (block && typeof block.text === 'string' ? block.text : '')).filter(Boolean).join('\n');
    }
    return String((message && message.text) || '');
}

function parseClaude(conversations, file, summary) {
    const out = [];
    for (const conversation of Array.isArray(conversations) ? conversations : []) {
        if (!conversation || typeof conversation !== 'object') continue;
        const title = clip(conversation.name || conversation.title || 'Claude conversation', 300);
        const messages = Array.isArray(conversation.chat_messages) ? conversation.chat_messages
            : Array.isArray(conversation.messages) ? conversation.messages : [];
        summary.conversations++;
        summary.messages += messages.length;
        const at = when(conversation.created_at, messages.find((m) => m.created_at)?.created_at);
        for (const message of messages) {
            const sender = String((message && (message.sender || message.role)) || '');
            if (sender !== 'human' && sender !== 'user') continue;
            out.push(...candidatesFromText(claudeText(message), {
                source: 'claude-ai', source_ref: { path: file, heading: title }, seen_at: when(message.created_at, at),
            }));
        }
    }
    return out;
}

/** Claude's saved memory list: every entry is already a memory, so no marker is needed. */
function parseMemories(list, file, source) {
    const out = [];
    const entries = Array.isArray(list) ? list : (list && Array.isArray(list.memories) ? list.memories : []);
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const text = entry.content || entry.memory || entry.text || entry.value;
        if (typeof text !== 'string') continue;
        const item = candidate(text, {
            source, source_ref: { path: file, heading: 'Saved memory' },
            seen_at: when(entry.created_at || entry.updated_at), confidence: 0.9,
        });
        if (item) out.push(item);
    }
    return out;
}

/* ── Gemini ─────────────────────────────────────────────────────────────────────────────────────────────── */

function geminiPrompts(record) {
    const raw = String((record && (record.title || record.header)) || '').trim();
    if (!raw) return [];
    // My Activity titles read "Said …", "You said …", "Prompted …", "Asked …".
    const stripped = raw.replace(/^(?:you\s+)?(?:said|prompted|asked|searched for)\s*[:,]?\s*/i, '').replace(/^["“]|["”]$/g, '').trim();
    return stripped && stripped.length >= 8 ? [stripped] : [];
}

function parseGeminiActivity(records, file, summary) {
    const out = [];
    const list = Array.isArray(records) ? records : (records && Array.isArray(records.items) ? records.items : []);
    for (const record of list) {
        if (!record || typeof record !== 'object') continue;
        const prompts = geminiPrompts(record);
        summary.conversations++;
        summary.messages += prompts.length;
        for (const prompt of prompts) {
            out.push(...candidatesFromText(prompt, {
                source: 'gemini-apps', source_ref: { path: file, heading: 'Gemini Apps activity' },
                seen_at: when(record.time || record.timestamp),
            }));
        }
    }
    return out;
}

function geminiMessages(conversation) {
    const messages = Array.isArray(conversation && conversation.messages) ? conversation.messages
        : Array.isArray(conversation && conversation.turns) ? conversation.turns : [];
    return messages.map((message) => ({
        role: String((message && (message.role || message.author)) || ''),
        text: String((message && (message.text || message.content)) || ''),
        at: when(message && (message.createTime || message.created_at || message.time)),
    }));
}

function parseGeminiConversations(conversations, file, summary) {
    const out = [];
    for (const conversation of Array.isArray(conversations) ? conversations : []) {
        if (!conversation || typeof conversation !== 'object') continue;
        const title = clip(conversation.title || 'Gemini conversation', 300);
        const messages = geminiMessages(conversation);
        summary.conversations++;
        summary.messages += messages.length;
        const at = when(conversation.createdTime || conversation.created_at, messages.find((m) => m.at)?.at);
        for (const message of messages) {
            if (message.role !== 'user' && message.role !== 'human') continue;
            out.push(...candidatesFromText(message.text, {
                source: 'gemini-apps', source_ref: { path: file, heading: title }, seen_at: message.at || at,
            }));
        }
    }
    return out;
}

/* ── the extraction prompt's paste-back ─────────────────────────────────────────────────────────────────── */

function labelFrom(text) {
    const bracket = /\[([a-z _-]{3,30})\]/i.exec(text);
    if (bracket) return { label: bracket[1], text: text.replace(bracket[0], ' ') };
    const paren = /\(([a-z _-]{3,30})\)\s*$/i.exec(text);
    if (paren && KIND_LABELS[paren[1].toLowerCase()]) return { label: paren[1], text: text.replace(paren[0], ' ') };
    const colon = /^\s*([a-z _-]{3,30})\s*:\s*/i.exec(text);
    if (colon && KIND_LABELS[colon[1].toLowerCase()]) return { label: colon[1], text: text.slice(colon[0].length) };
    return { label: null, text };
}

function parsePaste(text, provider) {
    const source = provider === 'chatgpt' || provider === 'claude-ai' || provider === 'gemini-apps' ? provider : 'paste';
    const out = [];
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return out;
    let parsed = null;
    if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
    }
    if (parsed) {
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : []);
        for (const entry of list) {
            if (!entry || typeof entry !== 'object') continue;
            const body = entry.text || entry.content || entry.memory || entry.value;
            if (typeof body !== 'string') continue;
            const item = candidate(body, {
                source, source_ref: { path: 'pasted text', heading: providerName(source) }, label: entry.kind, confidence: 0.8,
            });
            if (item) out.push(item);
        }
        return out;
    }
    let fenced = false;
    for (const line of raw.split(/\r?\n/)) {
        if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
        if (fenced) continue;
        if (/^\s*#{1,6}\s/.test(line)) continue;
        const bare = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/^\*\*([^*]{2,40})\*\*\s*:?\s*/, '$1: ').trim();
        if (bare.length < 8) continue;
        const labelled = labelFrom(bare);
        // A paste is prose, not a transcript: a bullet without a label is kept when it announces a memory or starts
        // with the person's own voice ("I …", "My …", "We …"). Ordinary chatter is not a candidate.
        if (!labelled.label && !MARKERS.some((re) => re.test(labelled.text)) && !/^(?:i|my|we|our)\b/i.test(labelled.text)) continue;
        const item = candidate(labelled.text, {
            source, source_ref: { path: 'pasted text', heading: providerName(source) }, label: labelled.label, confidence: 0.8,
        });
        if (item) out.push(item);
    }
    return out;
}

/* ── the export as a whole ────────────────────────────────────────────────────────────────────────────── */

function readJson(file) {
    try { return JSON.parse(file.data.toString('utf8')); }
    catch { throw new ImportError(`The file ${file.name} is not valid JSON.`); }
}

function baseName(name) { return String(name || '').split('/').pop(); }

function detectProvider(files, provider) {
    const explicit = normalizeProvider(provider);
    if (explicit) return explicit;
    const names = files.map((f) => f.name.toLowerCase());
    if (names.some((n) => /(^|\/)my activity\.json$/.test(n) || n.includes('gemini apps/') || n.includes('/bard/'))) return 'gemini-apps';
    for (const file of files) {
        if (!/(^|\/)conversations\.json$/i.test(file.name)) continue;
        const doc = readJson(file);
        if (Array.isArray(doc) && doc.some((c) => c && c.chat_messages)) return 'claude-ai';
        if (Array.isArray(doc) && doc.some((c) => c && c.mapping)) return 'chatgpt';
    }
    if (names.some((n) => /memories\.json$/.test(n))) return 'claude-ai';
    return null;
}

/**
 * Parse one export. `files` is what readZip returned, or `text` is the paste. No bytes are written anywhere.
 * The result is `{ provider, summary, items }`; items are redacted candidates without keys (the importer adds them).
 */
function parseExport({ provider, files = [], text = null, filename = '' } = {}) {
    const summary = {
        files: [...new Set(files.map((f) => f.name))].slice(0, 20),
        conversations: 0, messages: 0, found: 0, duplicates: 0, secrets_removed: 0,
        date_from: null, date_to: null, note: '',
    };
    let chosen = normalizeProvider(provider);
    if (text != null && !files.length) {
        chosen = chosen || 'paste';
        const items = parsePaste(text, chosen);
        summary.found = items.length;
        return { provider: chosen, summary, items };
    }
    if (!files.length) throw new ImportError('That file is empty, or it is not a zip archive.');
    chosen = detectProvider(files, chosen);
    if (!chosen) throw new ImportError('This zip is not a ChatGPT, Claude or Gemini export. Choose the assistant, or drop the .zip the export email links to.');
    const seen = new Set();
    const items = [];
    const add = (list) => {
        for (const item of list) {
            const key = item.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            if (!key) continue;
            if (seen.has(key)) { summary.duplicates++; continue; }
            seen.add(key);
            items.push(item);
        }
    };
    const fileNames = files.map((f) => f.name.toLowerCase());
    const conversations = files.filter((f) => /(^|\/)conversations\.json$/i.test(f.name));
    const memories = files.filter((f) => /(^|\/)memories\.json$/i.test(f.name));
    if (chosen === 'chatgpt' || chosen === 'claude-ai') {
        for (const file of memories) add(parseMemories(readJson(file), baseName(file.name), chosen));
        for (const file of conversations) {
            const doc = readJson(file);
            if (!Array.isArray(doc)) throw new ImportError(`The file ${baseName(file.name)} is not the conversations list this import reads.`);
            add(chosen === 'chatgpt' ? parseChatgpt(doc, baseName(file.name), summary) : parseClaude(doc, baseName(file.name), summary));
        }
        if (!conversations.length && !memories.length) throw new ImportError('This zip has no conversations.json or memories.json in it.');
    } else if (chosen === 'gemini-apps') {
        const activity = files.filter((f) => /(^|\/)my ?activity\.json$/i.test(f.name)
            || (f.name.toLowerCase().includes('gemini apps/') && /\.json$/i.test(f.name)));
        for (const file of activity) add(parseGeminiActivity(readJson(file), baseName(file.name), summary));
        const gem = files.filter((f) => /(^|\/)gemini\/conversations\/[^/]+\.json$/i.test(f.name));
        for (const file of gem) {
            const doc = readJson(file);
            add(parseGeminiConversations(Array.isArray(doc) ? doc : [doc], baseName(file.name), summary));
        }
        if (!activity.length && !gem.length) {
            throw new ImportError('This Takeout zip has no Gemini Apps activity JSON. In Takeout, choose My Activity, then Gemini Apps, not “Gemini”.');
        }
    } else if (chosen === 'paste') {
        throw new ImportError('Paste the answer to the extraction prompt, or drop an export zip.');
    }
    // Keep the preview readable: the newest candidates first, at most 200. The rest stay in the person's own file.
    items.sort((a, b) => String(b.seen_at || '').localeCompare(String(a.seen_at || '')));
    for (const item of items) {
        if (!item.seen_at) continue;
        if (!summary.date_from || item.seen_at < summary.date_from) summary.date_from = item.seen_at;
        if (!summary.date_to || item.seen_at > summary.date_to) summary.date_to = item.seen_at;
    }
    summary.found = items.length;
    if (items.length > MAX_ITEMS) summary.note = `Showing the ${MAX_ITEMS} newest of ${items.length} possible notes; the rest stay in your file.`;
    const limited = items.slice(0, MAX_ITEMS);
    summary.secrets_removed = limited.filter((i) => i.text.includes('[redacted]')).length;
    summary.kept = limited.length;
    summary.skipped = Math.max(0, items.length - limited.length);
    summary.filename = filename ? baseName(filename) : null;
    if (!limited.length) summary.note = 'No sentences in this export looked like a memory. The extraction prompt usually finds more.';
    return { provider: chosen, summary, items: limited };
}

module.exports = {
    PROVIDERS, PROVIDER_BY_ID, EXTRACTION_PROMPT, MAX_ITEMS, ImportError,
    normalizeProvider, providerName, parseExport, parsePaste, guessKind, detectProvider,
};
