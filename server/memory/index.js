'use strict';
/**
 * OpenVibe Memory M2a: the person's memory store (spec research-2026-10-30/memory-m2-spec.md).
 *
 * The text belongs to one person. It is sealed with AI_MEMORY_KEY (AES-256-GCM, `m1:` + iv + tag + body) and bound
 * to owner, item id and scope as additional data, so a row moved to another person or scope does not decrypt. The
 * dedupe MAC is HMAC-SHA256 of the normalized text, keyed from the same secret through HKDF-SHA256 (info
 * `memory-mac`), so dedupe never needs plaintext. Plaintext exists only while one request runs: it is never logged,
 * never in an error message, never in a span or an event payload.
 *
 * The API:
 *   POST   /api/v1/memory/items:batch     import up to 200 items (person token, or a service acting on_behalf_of)
 *   GET    /api/v1/memory/items           the person's own items (?scope=&status=&q=; q is in-process, max 2,000 rows)
 *   GET    /api/v1/memory/items/:id
 *   PATCH  /api/v1/memory/items/:id       text, kind, scope or status
 *   DELETE /api/v1/memory/items/:id
 *   DELETE /api/v1/memory/items?source=   everything from one source
 *   POST   /api/v1/memory/items/:id/split   undo a merge: the item and the one it swallowed go apart again
 *   POST   /api/v1/memory/items/:id/settle  the person settles a conflict: { keep: <id> } keeps one and archives the other
 *   GET    /api/v1/memory/profile?scope=  the cached profile, rebuilt by the cheap tier only when its items_hash moved,
 *                                         at most once an hour per owner and scope
 *   GET    /api/v1/memory/search?q=&scopes=  for agents (ai.memory.read + on_behalf_of): active items only, in the
 *                                         granted scopes, at most 8, audited in memory_reads with ids and never text
 *
 * Every SQL query that reads or changes a memory table is scoped by `owner = $…` (test/memory.test.js greps for it).
 * The account export decrypts the person's own items for their own export; deletion removes the rows.
 *
 * M2c (this stage): the meaning of an item.
 *   - Every new or edited item gets an embedding from AI's own embed route, called in-process (the platform's
 *     budget, never the person's allowance). The vector is stored sealed, with the same AES-256-GCM scheme as the
 *     text and the AAD `memory|<owner>|<id>|<scope>|emb`: an embedding leaks meaning (a nearest neighbour inverts
 *     it), so it is as private as the text it came from, and only this module ever opens it.
 *   - Two active items of one owner and scope that say the same thing (cosine at least 0.92) become one item with
 *     two sources: the newer text wins, the older row is archived and keeps its id in `merged_into`. The person can
 *     split them again (POST /items/:id/split).
 *   - Two active items that are near each other but disagree (cosine 0.75 to 0.92) are judged by one cheap-tier
 *     call that sees only those two notes, and both are marked `status = 'conflict'` with a `conflict_with` link:
 *     a conflict never reaches an agent. The person settles it (POST /items/:id/settle { keep }).
 *   - The profile is built from at most 60 active notes, newest first, passes noLooks and is at most about a
 *     thousand tokens. It is cached by items_hash and rebuilt at most once an hour per owner and scope.
 *   - The store's own maintenance runs in the background (server/memory/jobs.js): owner by owner, with a per-run
 *     cap, off in test mode and off in a drill.
 */
const crypto = require('crypto');
const express = require('express');
const { ids, http, capabilities } = require('openvibe-contracts');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { redact, onlySecret } = require('openvibe-sdk/redact');
const { noLooks } = require('openvibe-sdk/no-looks');
const { AiError, iso, sha256 } = require('../util');
const { bearer, isAppClaims, principalSubject } = require('../auth');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SCOPE_RE = /^(user|project:[a-z0-9][a-z0-9._-]{0,63})$/;
const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const KINDS = ['preference', 'fact', 'project_rule', 'procedure', 'decision', 'lesson'];
const STATUSES = ['active', 'suggested', 'archived', 'conflict'];
/** Items from these sources were produced by an AI, so they are suggestions and pass noLooks. */
const AI_SOURCES = new Set(['actor', 'vibe', 'know']);
const PROFILE_INTERVAL_MS = 60 * 60 * 1000;
/* M2c: the meaning of an item. Two items of one owner and scope that say the same thing (cosine at least
 * SAME_MEANING) become one item with two sources; two that are near each other but disagree (CONFLICT_MIN to
 * SAME_MEANING) are marked and hidden until the person settles them. */
const SAME_MEANING = 0.92;
const CONFLICT_MIN = 0.75;
const EMBED_ROUTE = 'default.embedding';
const CHEAP_ROUTE = 'default.chat';
const PROFILE_ITEMS = 60;          // the profile is built from at most this many notes, newest first
const PROFILE_MAX_TOKENS = 1000;   // and the result is at most about this many tokens
const PROFILE_MAX_CHARS = 4000;
const RECONCILE_ROWS = 200;        // the rows compared per owner and scope
const PROFILE_ID = 'profile';
const MAX_BATCH = 200;
const MAX_LIST = 2000;
const MAX_SEARCH = 8;

const READ_CAP = (claims) => capabilities.check(claims, 'ai.memory.read');
const WRITE_CAP = (claims) => capabilities.check(claims, 'ai.memory.write');

function unauthorized(detail) { return new AiError(401, 'token.invalid', detail || 'a Network token (audience openvibe.ai) or a person token is required'); }

/** The grant a service token names for an agent's memory search: `user` always, plus the exact scopes it lists. */
function grantedScopes(claims) {
    const out = new Set(['user']);
    const list = Array.isArray(claims.memory_scopes) ? claims.memory_scopes : Array.isArray(claims.scopes) ? claims.scopes : [];
    for (const s of list) if (typeof s === 'string' && SCOPE_RE.test(s)) out.add(s);
    const project = claims.project_slug || claims.project;
    if (typeof project === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(project)) out.add(`project:${project}`);
    // A run that names its project in its namespace grant (project:demo or project.demo) may read that project's scope.
    for (const n of Array.isArray(claims.ns) ? claims.ns : []) {
        const m = /^project[:.]([a-z0-9][a-z0-9._-]{0,63})$/.exec(String(n));
        if (m) out.add(`project:${m[1]}`);
    }
    return out;
}

function createMemory({ db, config, clock = { now: () => Date.now() }, log = console, registry = null, pool = null, buildProfile = null }) {
    let macCache = null;
    let macCacheFor = null;

    /** The 64-hex key, or 503: no default key is ever invented. */
    function secretKey() {
        const hex = String(config.memoryKey || '');
        if (!/^[0-9a-f]{64}$/i.test(hex)) throw new AiError(503, 'memory.unavailable', 'memory is not configured on this service (AI_MEMORY_KEY)');
        return Buffer.from(hex, 'hex');
    }
    function assertConfigured() { secretKey(); }
    function macKey() {
        const hex = String(config.memoryKey || '');
        if (macCacheFor !== hex || !macCache) {
            macCache = Buffer.from(crypto.hkdfSync('sha256', secretKey(), Buffer.alloc(0), Buffer.from('memory-mac'), 32));
            macCacheFor = hex;
        }
        return macCache;
    }

    /** `memory|<owner>|<id>|<scope>`: a row moved to another owner or scope does not open. */
    function aadFor(owner, id, scope) { return `memory|${owner}|${id}|${scope}`; }

    function seal(plain, aad) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
        c.setAAD(Buffer.from(aad));
        const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
        return `m1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
    }

    /** Opens a sealed value; every failure is the same, and no plaintext or ciphertext goes into the error. */
    function open(sealed, aad) {
        const parts = String(sealed || '').split(':');
        if (parts.length !== 4 || parts[0] !== 'm1') throw new AiError(500, 'memory.unreadable', 'a memory row does not open');
        try {
            const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(parts[1], 'base64'));
            d.setAAD(Buffer.from(aad));
            d.setAuthTag(Buffer.from(parts[2], 'base64'));
            return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
        } catch { throw new AiError(500, 'memory.unreadable', 'a memory row does not open'); }
    }

    /**
     * The statements below write PostgreSQL's `$n` placeholders, which is what the spec's owner-scope grep looks for;
     * the SDK's db layer compiles SQLite-style `?` placeholders, so this adapter maps the written `$n` to `?` and
     * passes the arguments in the order the statement names them.
     */
    function q(sql) {
        const order = [];
        let text = '';
        let last = 0;
        for (const m of sql.matchAll(/\$(\d+)/g)) {
            text += sql.slice(last, m.index) + '?';
            order.push(Number(m[1]) - 1);
            last = m.index + m[0].length;
        }
        text += sql.slice(last);
        const stmt = db.prepare(text);
        const args = (values) => order.map((i) => values[i]);
        return {
            get: (...values) => stmt.get(...args(values)),
            all: (...values) => stmt.all(...args(values)),
            run: (...values) => stmt.run(...args(values)),
        };
    }

    const normalize = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const macOf = (text) => crypto.createHmac('sha256', macKey()).update(normalize(text)).digest('hex');
    // ── M2c: the meaning of an item ───────────────────────────────────────────────────────────────────────────
    /** The AAD of a vector: the text's AAD with the `|emb` suffix, so a vector never opens as text. */
    function embAad(owner, id, scope) { return aadFor(owner, id, scope) + '|emb'; }

    /** The sources of a row, as a list. */
    const sourceList = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

    /** Cosine similarity of two vectors; 0 when they do not fit each other (a different length, an empty one). */
    function cosine(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            const x = Number(a[i]) || 0;
            const y = Number(b[i]) || 0;
            dot += x * y; na += x * x; nb += y * y;
        }
        if (!na || !nb) return 0;
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    /** The vector of a row, opened in-process; null when the row has none or it does not open. */
    function vectorOf(row, owner) {
        if (!row || !row.embedding_enc) return null;
        try {
            const v = JSON.parse(open(row.embedding_enc, embAad(owner, row.id, row.scope)));
            return Array.isArray(v) && v.length ? v : null;
        } catch { return null; }
    }

    /**
     * The embeddings of a few texts, from AI's own embed route, called in-process (never over HTTP to itself):
     * the platform's own budget, never the person's allowance. The texts travel in the request and nowhere else:
     * the pool is not asked to log the request, so the notes are not stored a second time.
     */
    async function embedTexts(texts) {
        const list = (texts || []).map((t) => String(t == null ? '' : t));
        if (!list.length || !registry || !pool) return { model: null, vectors: [] };
        const route = await registry.resolveRoute(EMBED_ROUTE);
        if (!route || route.disabled) return { model: null, vectors: [] };
        const exec = await pool.execute(route, 'embed', { input: list, timeoutMs: route.timeout_ms || 30000 },
            { routeKey: route.key, routeVersion: route.version });
        const vectors = (exec.result && exec.result.vectors) || [];
        if (vectors.length !== list.length) return { model: exec.model || null, vectors: [] };
        return {
            model: exec.model || null,
            vectors: vectors.map((v) => (Array.isArray(v) ? v.map((n) => Number(n)) : null)),
        };
    }

    /** Seals a vector under the item's AAD and stores it with the model that produced it. */
    async function storeEmbedding(owner, row, vector, model) {
        if (!row || !Array.isArray(vector) || !vector.length) return false;
        const payload = JSON.stringify(vector.map((n) => Math.round((Number(n) || 0) * 1e6) / 1e6));
        await q('UPDATE memory_items SET embedding_enc = $1, embedding_model = $2 WHERE owner = $3 AND id = $4')
            .run(seal(payload, embAad(owner, row.id, row.scope)), model || null, owner, row.id);
        return true;
    }

    /** The active items of one owner and scope, newest first, with the vectors they have. */
    async function scopeItems(owner, scope) {
        const rows = await q("SELECT * FROM memory_items WHERE owner = $1 AND scope = $2 AND status = 'active' ORDER BY updated_at DESC LIMIT " + RECONCILE_ROWS)
            .all(owner, scope);
        const out = [];
        for (const row of rows) {
            const vector = vectorOf(row, owner);
            if (vector) out.push({ row, vector });
        }
        return out;
    }

    /** The newer of two items wins; the older one is archived and keeps its id in `merged_into`. */
    function newerFirst(a, b) {
        const at = Date.parse(a.row.updated_at || a.row.created_at || '') || 0;
        const bt = Date.parse(b.row.updated_at || b.row.created_at || '') || 0;
        if (at !== bt) return at > bt ? [a, b] : [b, a];
        return String(a.row.id) > String(b.row.id) ? [a, b] : [b, a];
    }

    /** One item with two sources: the winner keeps its text, the loser is archived and points at the winner. */
    async function mergePair(owner, winner, loser) {
        const at = iso(clock.now());
        const own = winner.row.source_own ? sourceList(winner.row.source_own) : sourceList(winner.row.source);
        const union = [...new Set([...sourceList(winner.row.source), ...sourceList(loser.row.source)])];
        await db.tx(async () => {
            await q('UPDATE memory_items SET source = $1, source_own = $2, updated_at = $3 WHERE owner = $4 AND id = $5')
                .run(union.join(',').slice(0, 500), own.join(',').slice(0, 500), at, owner, winner.row.id);
            await q('UPDATE memory_items SET status = $1, merged_into = $2, updated_at = $3 WHERE owner = $4 AND id = $5')
                .run('archived', winner.row.id, at, owner, loser.row.id);
        });
        return winner.row.id;
    }

    /** A JSON answer, wherever the provider put it. */
    function parseJsonAnswer(value) {
        if (value && typeof value === 'object') return value;
        const text = String(value == null ? '' : value).trim();
        if (!text) return null;
        try { return JSON.parse(text); } catch { /* a model that answered in prose */ }
        const found = /\{[\s\S]*\}/.exec(text);
        if (found) { try { return JSON.parse(found[0]); } catch { return null; } }
        return null;
    }

    /**
     * One cheap-tier call: do these two notes disagree? The call sees these two notes and nothing else: never
     * another person's item, never a third note. The answer is `{ conflict, why }`.
     */
    async function judgePair(owner, a, b) {
        if (!registry || !pool) return { conflict: false, why: '' };
        const route = await registry.resolveRoute(CHEAP_ROUTE);
        if (!route || route.disabled) return { conflict: false, why: '' };
        const textA = open(a.text_enc, aadFor(owner, a.id, a.scope));
        const textB = open(b.text_enc, aadFor(owner, b.id, b.scope));
        const schema = {
            type: 'object', additionalProperties: false, required: ['conflict', 'why'],
            properties: { conflict: { type: 'boolean' }, why: { type: 'string' } },
        };
        const prompt = [
            'Two notes from the same person. Do they disagree?',
            'Answer conflict true only when the two notes cannot both be true as they stand.',
            'Notes about the same thing that are compatible, or that differ only in wording or in detail, are not a conflict.',
            'Answer with conflict (true or false) and why (one short sentence).',
            '',
            'Note A:', textA,
            '',
            'Note B:', textB,
        ].join('\n');
        const exec = await pool.execute(route, 'chat', {
            system: [{ text: 'You judge whether two notes from one person contradict each other. You answer with the schema you are given and nothing else.' }],
            messages: [{ role: 'user', content: prompt }],
            json: { name: 'conflict', schema, strict: true },
            maxTokens: 200, temperature: 0, timeoutMs: 20000,
        }, { routeKey: route.key, routeVersion: route.version });
        const parsed = parseJsonAnswer(exec.result && (exec.result.json || exec.result.text));
        return { conflict: Boolean(parsed && parsed.conflict === true), why: String((parsed && parsed.why) || '').slice(0, 300) };
    }

    /** Both items of a conflicting pair are marked, so neither reaches an agent. */
    async function markConflict(owner, aId, bId) {
        const at = iso(clock.now());
        await db.tx(async () => {
            await q("UPDATE memory_items SET status = 'conflict', conflict_with = $1, updated_at = $2 WHERE owner = $3 AND id = $4")
                .run(bId, at, owner, aId);
            await q("UPDATE memory_items SET status = 'conflict', conflict_with = $1, updated_at = $2 WHERE owner = $3 AND id = $4")
                .run(aId, at, owner, bId);
        });
    }

    /**
     * One owner and one scope: the pairs that say the same thing become one item, and the pairs that are near each
     * other but disagree are marked. `maxModelCalls` caps the cheap-tier calls of this run (0: nothing is judged).
     * Two items are only compared when their vectors come from the same model: two vector spaces are never mixed.
     */
    async function reconcileScope(owner, scope, { maxModelCalls = 0 } = {}) {
        const items = await scopeItems(owner, scope);
        const out = { merged: 0, conflicts: 0, calls: 0 };
        if (items.length < 2) return out;
        const gone = new Set();
        for (let i = 0; i < items.length; i++) {
            if (gone.has(items[i].row.id)) continue;
            for (let j = i + 1; j < items.length; j++) {
                if (gone.has(items[j].row.id)) continue;
                if ((items[i].row.embedding_model || '') !== (items[j].row.embedding_model || '')) continue;
                const cos = cosine(items[i].vector, items[j].vector);
                if (cos >= SAME_MEANING) {
                    const [winner, loser] = newerFirst(items[i], items[j]);
                    await mergePair(owner, winner, loser);
                    gone.add(loser.row.id);
                    out.merged++;
                    continue;
                }
                if (cos >= CONFLICT_MIN && out.calls < maxModelCalls) {
                    out.calls++;
                    const verdict = await judgePair(owner, items[i].row, items[j].row);
                    if (verdict.conflict) {
                        await markConflict(owner, items[i].row.id, items[j].row.id);
                        gone.add(items[i].row.id);
                        gone.add(items[j].row.id);
                        out.conflicts++;
                    }
                }
            }
        }
        return out;
    }

    /** The items of an owner and scope that have no vector yet: they are embedded and stored (the platform's budget). */
    async function embedMissing(owner, scope, limit = 50) {
        const cap = Math.max(0, Math.min(Number(limit) || 0, RECONCILE_ROWS));
        if (!cap) return 0;
        const rows = await q("SELECT * FROM memory_items WHERE owner = $1 AND scope = $2 AND status = 'active' AND embedding_enc IS NULL ORDER BY updated_at DESC LIMIT " + cap)
            .all(owner, scope);
        if (!rows.length) return 0;
        const texts = rows.map((r) => open(r.text_enc, aadFor(owner, r.id, r.scope)));
        const { model, vectors } = await embedTexts(texts);
        let stored = 0;
        for (let i = 0; i < rows.length; i++) {
            if (!vectors[i]) continue;
            if (await storeEmbedding(owner, rows[i], vectors[i], model)) stored++;
        }
        return stored;
    }

    /**
     * After an import: every new item gets an embedding, and the scope is settled. The import never spends a
     * judgement on its own (the job does that, with its cap); it only merges what says the same thing.
     */
    async function embedAndReconcile(owner, ids, scopes) {
        const out = { embedded: 0, merged: 0, conflicts: 0 };
        if (!ids.length) return out;
        const rows = await q('SELECT * FROM memory_items WHERE owner = $1 AND id = ANY($2::text[])').all(owner, ids);
        const texts = rows.map((r) => open(r.text_enc, aadFor(owner, r.id, r.scope)));
        const { model, vectors } = await embedTexts(texts);
        for (let i = 0; i < rows.length; i++) {
            if (!vectors[i]) continue;
            if (await storeEmbedding(owner, rows[i], vectors[i], model)) out.embedded++;
        }
        for (const scope of scopes) {
            const r = await reconcileScope(owner, scope, { maxModelCalls: 0 });
            out.merged += r.merged;
            out.conflicts += r.conflicts;
        }
        return out;
    }

    function validateScope(scope, fallback = 'user') {
        const s = String(scope == null || scope === '' ? fallback : scope);
        if (!SCOPE_RE.test(s)) throw new AiError(422, 'input.invalid', 'scope must be `user` or `project:<slug>` (never an absolute path)');
        return s;
    }
    function validateKind(kind, fallback = 'fact') {
        const k = String(kind == null || kind === '' ? fallback : kind);
        if (!KINDS.includes(k)) throw new AiError(422, 'input.invalid', `kind must be one of ${KINDS.join(', ')}`);
        return k;
    }
    function validateStatus(status, fallback = 'active') {
        const s = String(status == null || status === '' ? fallback : status);
        if (!STATUSES.includes(s)) throw new AiError(422, 'input.invalid', `status must be one of ${STATUSES.join(', ')}`);
        return s;
    }
    function validateSource(source) {
        const s = String(source == null ? '' : source).trim();
        if (!SOURCE_RE.test(s)) throw new AiError(422, 'input.invalid', 'source must be an adapter id or service name');
        return s;
    }
    function validateSourceRef(ref) {
        if (ref == null) return null;
        if (typeof ref !== 'object' || Array.isArray(ref)) throw new AiError(422, 'input.invalid', 'source_ref must be { path, heading }');
        const out = {};
        if (ref.path != null) out.path = String(ref.path).slice(0, 500);
        if (ref.heading != null) out.heading = String(ref.heading).slice(0, 300);
        if (!out.path && !out.heading) throw new AiError(422, 'input.invalid', 'source_ref must name a path or a heading');
        return out;
    }
    function validateTime(value, fallback) {
        if (value == null) return fallback;
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) throw new AiError(422, 'input.invalid', 'a time is not an ISO date-time');
        return d.toISOString();
    }

    function itemView(row) {
        const text = open(row.text_enc, aadFor(row.owner, row.id, row.scope));
        let sourceRef = null;
        if (row.source_ref_enc) {
            try { sourceRef = JSON.parse(open(row.source_ref_enc, aadFor(row.owner, row.id, row.scope))); } catch (err) { throw err instanceof AiError ? err : new AiError(500, 'memory.unreadable', 'a memory row does not open'); }
        }
        return {
            id: row.id, owner: row.owner, scope: row.scope, kind: row.kind, text,
            source: row.source, sources: sourceList(row.source), source_ref: sourceRef, status: row.status, confidence: Number(row.confidence),
            seen_at: row.seen_at, created_at: row.created_at, updated_at: row.updated_at,
            machine: row.machine || null,
            // M2c: the links. merged_into names the item this one was merged into (it is archived); conflict_with
            // names the item this one conflicts with (both are hidden from an agent until the person settles them).
            merged_into: row.merged_into || null,
            conflict_with: row.conflict_with || null,
            ...(AI_SOURCES.has(String(row.source).split(',')[0]) ? { no_looks: true } : {}),
        };
    }

    function requireScope(req, scope) {
        if (req.principal.kind === 'user') return;
        if (!grantedScopes(req.principal.claims).has(scope)) throw new AiError(403, 'memory.scope_denied', `the token's grant does not name ${scope}`);
    }

    /** Import up to 200 items. Dedupe is by text_mac within owner and scope; a repeat updates seen_at and the source. */
    async function batch(req, owner) {
        assertConfigured();
        const items = req.body && req.body.items;
        if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH) throw new AiError(422, 'input.invalid', `items must be an array of 1 to ${MAX_BATCH} items`);
        const serviceCaller = req.principal.kind !== 'user';
        const at = iso(clock.now());
        // Redact and refuse before writing anything: one secret-only item refuses the batch.
        const prepared = items.map((raw, index) => {
            if (!raw || typeof raw !== 'object') throw new AiError(422, 'input.invalid', `items[${index}] is not an object`);
            const clean = redact(String(raw.text == null ? '' : raw.text)).text;
            if (!clean.trim()) throw new AiError(422, 'input.invalid', `items[${index}].text is empty`);
            if (onlySecret(clean)) throw new AiError(422, 'memory.secret_only', `items[${index}] is only a secret and is refused`);
            const scope = validateScope(raw.scope, 'user');
            requireScope(req, scope);
            // A service writes under its own name, never a body source; the person's own token keeps the body source.
            const serviceSource = req.principal.subject && req.principal.subject.id
                ? req.principal.subject.id
                : String(req.principal.sub || '').replace(/^svc:/, '');
            const source = validateSource(serviceCaller ? serviceSource : (raw.source || 'person'));
            // A service is an agent: what it writes is a suggestion, and it passes noLooks. A person may mark their own
            // item as AI-produced too (the Node imports what a coding tool wrote).
            const aiMade = serviceCaller || raw.no_looks === true || AI_SOURCES.has(source);
            let text = aiMade ? noLooks(clean) : clean;
            text = String(text == null ? '' : text);
            if (!text.trim()) throw new AiError(422, 'input.invalid', `items[${index}].text is empty after no-looks`);
            if (onlySecret(text)) throw new AiError(422, 'memory.secret_only', `items[${index}] is only a secret and is refused`);
            const askedConfidence = raw.confidence == null ? null : Number(raw.confidence);
            const confidence = askedConfidence == null || !Number.isFinite(askedConfidence)
                ? (serviceCaller ? 0.5 : 1)
                : Math.max(0, Math.min(serviceCaller ? 0.5 : 1, askedConfidence));
            return {
                id: `mem_${ids.ulid()}`,
                scope,
                kind: validateKind(raw.kind),
                text,
                mac: macOf(text),
                source,
                sourceRef: validateSourceRef(raw.source_ref),
                // A service or an AI may only suggest until the person accepts it; the body cannot raise that.
                status: serviceCaller || aiMade ? 'suggested' : validateStatus(raw.status, 'active'),
                confidence,
                seenAt: validateTime(raw.seen_at, at),
                machine: raw.machine == null ? null : String(raw.machine).slice(0, 100),
            };
        });
        const out = [];
        const createdIds = [];
        const scopes = new Set();
        let created = 0;
        let deduped = 0;
        await db.tx(async () => {
            for (const it of prepared) {
                const prev = await q('SELECT * FROM memory_items WHERE owner = $1 AND scope = $2 AND text_mac = $3 LIMIT 1').get(owner, it.scope, it.mac);
                if (prev) {
                    const sources = String(prev.source || '').split(',').filter(Boolean);
                    if (!sources.includes(it.source)) sources.push(it.source);
                    await q('UPDATE memory_items SET seen_at = $1, updated_at = $2, source = $3 WHERE owner = $4 AND id = $5')
                        .run(it.seenAt > prev.seen_at ? it.seenAt : prev.seen_at, at, sources.join(',').slice(0, 500), owner, prev.id);
                    deduped++;
                    out.push(itemView(await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, prev.id)));
                    continue;
                }
                await q(`INSERT INTO memory_items (id, owner, scope, kind, text_enc, text_mac, source, source_ref_enc, status, confidence, seen_at, created_at, updated_at, machine)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`)
                    .run(it.id, owner, it.scope, it.kind, seal(it.text, aadFor(owner, it.id, it.scope)), it.mac, it.source,
                        it.sourceRef ? seal(JSON.stringify(it.sourceRef), aadFor(owner, it.id, it.scope)) : null,
                        it.status, it.confidence, it.seenAt, at, at, it.machine);
                created++;
                createdIds.push(it.id);
                scopes.add(it.scope);
                out.push(itemView(await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, it.id)));
            }
        });
        // M2c: every new item gets an embedding, and the scopes it touched are settled: what says the same thing
        // becomes one item with two sources. The import spends no judgement of its own: the job does that, with
        // its cap. A failed embedding never fails the import: the job embeds the item later.
        try { await embedAndReconcile(owner, createdIds, [...scopes]); }
        catch (err) { log.warn(`[memory] the embedding of a new item did not finish (${err && err.code ? err.code : 'error'}); the job will do it`); }
        // The answer shows the state after the merge: an item that was swallowed is archived and points at the winner.
        for (let i = 0; i < out.length; i++) {
            const row = await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, out[i].id);
            if (row) out[i] = itemView(row);
        }
        return { items: out, count: created + deduped, created, deduped };
    }

    async function list(req, owner) {
        assertConfigured();
        const scope = req.query.scope ? validateScope(req.query.scope) : null;
        if (scope) requireScope(req, scope);
        const status = req.query.status ? validateStatus(req.query.status) : null;
        const allowed = [...grantedScopes(req.principal.claims)];
        let sql = 'SELECT * FROM memory_items WHERE owner = $1';
        const args = [owner];
        if (scope) { args.push(scope); sql += ` AND scope = $${args.length}`; }
        else if (req.principal.kind !== 'user') { args.push(allowed); sql += ` AND scope = ANY($${args.length}::text[])`; }
        if (status) { args.push(status); sql += ` AND status = $${args.length}`; }
        sql += ' ORDER BY updated_at DESC LIMIT 2000';
        const rows = await q(sql).all(...args);
        const searchText = req.query.q == null ? '' : String(req.query.q).slice(0, 200);
        const items = [];
        for (const row of rows.slice(0, MAX_LIST)) {
            const view = itemView(row);
            if (!searchText || view.text.toLowerCase().includes(searchText.toLowerCase())) items.push(view);
            if (items.length >= 200) break;
        }
        return { items, count: items.length };
    }

    async function get(req, owner, id) {
        assertConfigured();
        const row = await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, id);
        if (!row) throw new AiError(404, 'memory.not_found', 'no such memory item');
        requireScope(req, row.scope);
        return { item: itemView(row) };
    }

    async function patch(req, owner, id) {
        assertConfigured();
        const row = await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, id);
        if (!row) throw new AiError(404, 'memory.not_found', 'no such memory item');
        requireScope(req, row.scope);
        const body = req.body || {};
        const sets = [];
        const args = [];
        const add = (column, value) => { args.push(value); sets.push(`${column} = $${args.length}`); };
        let nextScope = row.scope;
        let nextText = null;
        if (body.scope !== undefined) {
            nextScope = validateScope(body.scope);
            requireScope(req, nextScope);
            add('scope', nextScope);
        }
        if (body.kind !== undefined) add('kind', validateKind(body.kind));
        if (body.status !== undefined) add('status', validateStatus(body.status));
        if (body.text !== undefined) {
            const clean = redact(String(body.text)).text;
            if (!clean.trim()) throw new AiError(422, 'input.invalid', 'text is empty');
            if (onlySecret(clean)) throw new AiError(422, 'memory.secret_only', 'an item that is only a secret is refused');
            nextText = body.no_looks === true ? String(noLooks(clean)) : clean;
            if (onlySecret(nextText)) throw new AiError(422, 'memory.secret_only', 'an item that is only a secret is refused');
            add('text_enc', seal(nextText, aadFor(owner, row.id, nextScope)));
            add('text_mac', macOf(nextText));
        }
        if (body.source !== undefined) add('source', validateSource(body.source));
        if (body.source_ref !== undefined) {
            const ref = validateSourceRef(body.source_ref);
            add('source_ref_enc', ref ? seal(JSON.stringify(ref), aadFor(owner, row.id, nextScope)) : null);
        }
        if (!sets.length) throw new AiError(422, 'input.invalid', 'nothing to change: send text, kind, scope, status, source or source_ref');
        args.push(iso(clock.now()));
        const updatedAt = `$${args.length}`;
        // Re-seal when the scope changed even if only the scope was sent: the AAD names it.
        if (nextScope !== row.scope && nextText === null && !sets.some((s) => s.startsWith('text_enc'))) {
            const text = open(row.text_enc, aadFor(owner, row.id, row.scope));
            add('text_enc', seal(text, aadFor(owner, row.id, nextScope)));
            if (row.source_ref_enc) {
                const ref = open(row.source_ref_enc, aadFor(owner, row.id, row.scope));
                add('source_ref_enc', seal(ref, aadFor(owner, row.id, nextScope)));
            }
        }
        args.push(owner, row.id);
        await q(`UPDATE memory_items SET ${sets.join(', ')}, updated_at = ${updatedAt} WHERE owner = $${args.length - 1} AND id = $${args.length}`).run(...args);
        // A profile built from the old text, kind or scope will not match its items_hash again: drop it now.
        const scopes = [...new Set([row.scope, nextScope])];
        await q('DELETE FROM memory_profiles WHERE owner = $1 AND scope = ANY($2::text[])').run(owner, scopes);
        // M2c: a new text is a new meaning: the item is embedded again, and its scope is settled (what says the same
        // thing becomes one item). A failed embedding never fails the edit: the job embeds the item later.
        if (nextText !== null) {
            const fresh = await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, row.id);
            try {
                const { model, vectors } = await embedTexts([nextText]);
                if (vectors[0]) await storeEmbedding(owner, fresh, vectors[0], model);
                await reconcileScope(owner, nextScope, { maxModelCalls: 0 });
            } catch (err) { log.warn(`[memory] the embedding of an edited item did not finish (${err && err.code ? err.code : 'error'}); the job will do it`); }
        }
        return { item: itemView(await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, row.id)) };
    }

    async function remove(req, owner, id) {
        assertConfigured();
        const row = await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, id);
        if (!row) throw new AiError(404, 'memory.not_found', 'no such memory item');
        requireScope(req, row.scope);
        await db.tx(async () => {
            await q('DELETE FROM memory_items WHERE owner = $1 AND id = $2').run(owner, row.id);
            await q('DELETE FROM memory_profiles WHERE owner = $1 AND scope = $2').run(owner, row.scope);
        });
        return { deleted: 1 };
    }

    async function removeBySource(req, owner) {
        assertConfigured();
        const source = validateSource(req.query.source);
        const rows = await q("SELECT DISTINCT scope FROM memory_items WHERE owner = $1 AND string_to_array(source, ',') @> ARRAY[$2]::text[]").all(owner, source);
        const scopes = rows.map((r) => r.scope);
        let deleted = 0;
        await db.tx(async () => {
            deleted = Number((await q("SELECT COUNT(*)::int AS n FROM memory_items WHERE owner = $1 AND string_to_array(source, ',') @> ARRAY[$2]::text[]").get(owner, source)).n) || 0;
            await q("DELETE FROM memory_items WHERE owner = $1 AND string_to_array(source, ',') @> ARRAY[$2]::text[]").run(owner, source);
            if (scopes.length) await q('DELETE FROM memory_profiles WHERE owner = $1 AND scope = ANY($2::text[])').run(owner, scopes);
        });
        return { deleted };
    }

    /** Items from one scope, active only: what a profile is built from and what an agent may see. */
    async function activeRows(owner, scope) {
        return await q("SELECT * FROM memory_items WHERE owner = $1 AND scope = $2 AND status = 'active' ORDER BY updated_at DESC LIMIT " + PROFILE_ITEMS).all(owner, scope);
    }

    function itemsHash(macs) {
        return sha256([...macs].sort().join('\n'));
    }

    async function summarize({ owner, scope, items }) {
        if (buildProfile) return await buildProfile({ owner, scope, items });
        const notes = items.map((it) => `- (${it.kind}) ${it.text}`).join('\n').slice(0, 40000);
        const prompt = [
            `Write a short profile of the person from their own memory notes for ${scope}.`,
            'Rules: summarize only what the notes say. Never guess or infer facts about the person.',
            'Never describe looks, body, clothing, hair, face, pose, age or a guessed gender: no looks, at any time.',
            'Write at most 600 words and do not add a title.',
            '',
            notes,
        ].join('\n');
        if (!registry || !pool) return notes.split('\n').slice(0, 40).join('\n').slice(0, 4000);
        // The platform's own cheap route, called in-process: no run row, no on_behalf_of and no person attribution,
        // so the notes are not stored again (a run's input would keep their plaintext) and the person's allowance is
        // not spent. A route of its own would be the cheap tier; default.chat is the service's smallest chat pool.
        const route = await registry.resolveRoute('default.chat');
        if (!route || route.disabled) throw new AiError(503, 'memory.profile_failed', 'no route is available to build a profile');
        const exec = await pool.execute(route, 'summarize', {
            system: [{ text: 'You write short, faithful profiles of a person from their own notes. Never guess, never describe looks or a body, and never add a fact the notes do not state.', cache: true }],
            messages: [{ role: 'user', content: prompt }],
            maxTokens: PROFILE_MAX_TOKENS,
            temperature: 0.2,
            timeoutMs: 30000,
        }, { routeKey: route.key, routeVersion: route.version });
        return String((exec.result && exec.result.text) || '');
    }

    /**
     * The builder: the profile of one owner and scope. The cache is keyed by the items_hash (the MACs of the items
     * it was built from) and is rebuilt only when that hash moved and the cache is at least an hour old: at most one
     * build per owner and scope per hour, on the platform's own budget.
     */
    async function profileFor(owner, scope) {
        const rows = await activeRows(owner, scope);
        const hash = itemsHash(rows.map((r) => r.text_mac));
        const now = clock.now();
        const cached = await q('SELECT * FROM memory_profiles WHERE owner = $1 AND scope = $2').get(owner, scope);
        if (cached) {
            const age = now - Date.parse(cached.built_at);
            const fresh = Number.isFinite(age) && age < PROFILE_INTERVAL_MS;
            if (fresh || cached.items_hash === hash) {
                const text = open(cached.text_enc, aadFor(owner, PROFILE_ID, scope));
                return { profile: { scope, text, items_hash: cached.items_hash, built_at: cached.built_at }, rebuilt: false };
            }
        }
        if (!rows.length) {
            const builtAt = iso(now);
            const empty = seal('', aadFor(owner, PROFILE_ID, scope));
            await q(`INSERT INTO memory_profiles (owner, scope, text_enc, items_hash, built_at) VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (owner, scope) DO UPDATE SET text_enc = excluded.text_enc, items_hash = excluded.items_hash, built_at = excluded.built_at`)
                .run(owner, scope, empty, hash, builtAt);
            return { profile: { scope, text: '', items_hash: hash, built_at: builtAt }, rebuilt: true };
        }
        const items = rows.map((r) => ({ kind: r.kind, text: open(r.text_enc, aadFor(owner, r.id, r.scope)) }));
        const text = String(noLooks(await summarize({ owner, scope, items })) || '').slice(0, PROFILE_MAX_CHARS);
        const builtAt = iso(now);
        await q(`INSERT INTO memory_profiles (owner, scope, text_enc, items_hash, built_at) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (owner, scope) DO UPDATE SET text_enc = excluded.text_enc, items_hash = excluded.items_hash, built_at = excluded.built_at`)
            .run(owner, scope, seal(text, aadFor(owner, PROFILE_ID, scope)), hash, builtAt);
        return { profile: { scope, text, items_hash: hash, built_at: builtAt }, rebuilt: true };
    }

    async function profile(req, owner) {
        assertConfigured();
        const scope = validateScope(req.query.scope, 'user');
        requireScope(req, scope);
        return { profile: (await profileFor(owner, scope)).profile };
    }

    /** An agent's search: active items only, the granted scopes, at most 8, and one memory_reads row with ids only. */
    async function search(req, owner) {
        assertConfigured();
        const raw = req.query.scopes == null || req.query.scopes === '' ? 'user' : String(req.query.scopes);
        const scopes = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
        if (!scopes.length) throw new AiError(422, 'input.invalid', 'scopes must name at least one scope');
        for (const s of scopes) {
            validateScope(s);
            requireScope(req, s);
        }
        const searchText = req.query.q == null ? '' : String(req.query.q).slice(0, 500).toLowerCase();
        const rows = await q("SELECT * FROM memory_items WHERE owner = $1 AND status = 'active' AND scope = ANY($2::text[]) ORDER BY updated_at DESC LIMIT 200").all(owner, scopes);
        const items = [];
        for (const row of rows) {
            const view = itemView(row);
            if (!searchText || view.text.toLowerCase().includes(searchText)) items.push(view);
            if (items.length >= MAX_SEARCH) break;
        }
        if (req.principal.kind !== 'user') {
            const purpose = req.query.purpose == null ? (req.query.task == null ? null : String(req.query.task)) : String(req.query.purpose);
            await q('INSERT INTO memory_reads (id, owner, actor, purpose, scopes, item_ids, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)')
                .run(`mrd_${ids.ulid()}`, owner, req.principal.sub, purpose ? purpose.slice(0, 200) : null, JSON.stringify(scopes), JSON.stringify(items.map((i) => i.id)), iso(clock.now()));
        }
        return { items, count: items.length };
    }

    /**
     * Undo a merge: the item and the one it swallowed go apart again. The archived item keeps its own text and its
     * own sources, and the winner's source list goes back to what it was before the merge.
     */
    async function split(req, owner, id) {
        assertConfigured();
        const row = await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, id);
        if (!row) throw new AiError(404, 'memory.not_found', 'no such memory item');
        requireScope(req, row.scope);
        const children = await q("SELECT * FROM memory_items WHERE owner = $1 AND merged_into = $2 AND status = 'archived' ORDER BY created_at ASC")
            .all(owner, row.id);
        if (!children.length) throw new AiError(409, 'memory.not_split', 'this item was not merged with another one');
        const at = iso(clock.now());
        await db.tx(async () => {
            for (const child of children) {
                await q('UPDATE memory_items SET status = $1, merged_into = $2, updated_at = $3 WHERE owner = $4 AND id = $5')
                    .run('active', null, at, owner, child.id);
            }
            const own = row.source_own ? sourceList(row.source_own) : sourceList(row.source);
            await q('UPDATE memory_items SET source = $1, updated_at = $2 WHERE owner = $3 AND id = $4')
                .run(own.join(',').slice(0, 500), at, owner, row.id);
        });
        await q('DELETE FROM memory_profiles WHERE owner = $1 AND scope = $2').run(owner, row.scope);
        const ids = [row.id, ...children.map((c) => c.id)];
        const items = (await q('SELECT * FROM memory_items WHERE owner = $1 AND id = ANY($2::text[])').all(owner, ids)).map(itemView);
        return { items, count: items.length, split: children.length };
    }

    /** The person settles a conflict: the item they keep becomes active again, the other one is archived. */
    async function settle(req, owner, id) {
        assertConfigured();
        const row = await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, id);
        if (!row) throw new AiError(404, 'memory.not_found', 'no such memory item');
        requireScope(req, row.scope);
        const keep = String((req.body && req.body.keep) || '').trim();
        if (!keep) throw new AiError(422, 'input.invalid', 'keep must name the item that stays');
        if (keep === id) throw new AiError(422, 'input.invalid', 'keep must name the other item of the conflict');
        const other = await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, keep);
        if (!other || other.scope !== row.scope) throw new AiError(404, 'memory.not_found', 'no such memory item');
        if (row.conflict_with !== keep && other.conflict_with !== id) throw new AiError(409, 'memory.not_conflict', 'these two items are not in conflict');
        const at = iso(clock.now());
        await db.tx(async () => {
            await q('UPDATE memory_items SET status = $1, conflict_with = $2, updated_at = $3 WHERE owner = $4 AND id = $5')
                .run('active', null, at, owner, other.id);
            await q('UPDATE memory_items SET status = $1, conflict_with = $2, updated_at = $3 WHERE owner = $4 AND id = $5')
                .run('archived', other.id, at, owner, row.id);
        });
        await q('DELETE FROM memory_profiles WHERE owner = $1 AND scope = $2').run(owner, row.scope);
        return {
            kept: itemView(await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, other.id)),
            archived: itemView(await q('SELECT * FROM memory_items WHERE owner = $1 AND id = $2').get(owner, row.id)),
        };
    }

    /**
     * The owners the job has work for. This is the one statement that is not scoped by an owner: it returns owner
     * identifiers and nothing else (no item, no text, no id), so it cannot carry one person's data out. Every other
     * query of the job is owner-scoped.
     */
    async function ownersForJobs(limit) {
        const cap = Math.max(1, Math.min(Number(limit) || 1, 500));
        return await q('SELECT owner, MAX(updated_at) AS last_seen FROM memory_items WHERE owner IS NOT NULL AND owner <> $1 GROUP BY owner ORDER BY last_seen DESC LIMIT $2')
            .all('', cap);
    }

    /** The scopes of one owner that hold items. */
    async function scopesFor(owner, limit) {
        const cap = Math.max(1, Math.min(Number(limit) || 1, 50));
        const rows = await q('SELECT DISTINCT scope FROM memory_items WHERE owner = $1 ORDER BY scope LIMIT $2').all(owner, cap);
        return rows.map((r) => r.scope);
    }

    /** Rebuilds the profile of one owner and scope when it is due (the same rule as the route). */
    async function refreshProfile(owner, scope) {
        assertConfigured();
        return await profileFor(owner, scope);
    }
    /** The person's own export only: decrypted items, profiles and read ids (never another person's rows). */
    async function exportFor(subject) {
        assertConfigured();
        const owner = `user:${subject}`;
        const items = (await q('SELECT * FROM memory_items WHERE owner = $1 ORDER BY created_at DESC LIMIT 5000').all(owner)).map(itemView);
        const profiles = (await q('SELECT * FROM memory_profiles WHERE owner = $1 ORDER BY built_at DESC').all(owner))
            .map((r) => ({ scope: r.scope, text: open(r.text_enc, aadFor(owner, PROFILE_ID, r.scope)), items_hash: r.items_hash, built_at: r.built_at }));
        const reads = await q('SELECT id, actor, purpose, scopes, item_ids, created_at FROM memory_reads WHERE owner = $1 ORDER BY created_at DESC LIMIT 5000').all(owner);
        return [
            { name: 'memory-items.json', content: items },
            { name: 'memory-profiles.json', content: profiles },
            { name: 'memory-reads.json', content: reads.map((r) => ({ ...r, scopes: JSON.parse(r.scopes || '[]'), item_ids: JSON.parse(r.item_ids || '[]') })) },
        ];
    }

    return {
        assertConfigured, batch, list, get, patch, remove, removeBySource, profile, search, exportFor,
        split, settle, aadFor, macOf, seal, open,
        // The store's own maintenance (server/memory/jobs.js) drives the store through these.
        ownersForJobs, scopesFor, embedMissing, reconcileScope, refreshProfile, profileFor,
    };
}

/**
 * The memory routes. A person's own Network token acts for themselves; a service token needs the capability and
 * names the person with `on_behalf_of`, but it may only search (audited) and import suggestions. Every other route is
 * person-only: a service gets 403 `capability.denied`.
 */
function memoryRouter({ memory, auth, config, clock = { now: () => Date.now() }, log = console, sendError }) {
    const r = express.Router();
    function guard(check) {
        return async function memoryGuard(req, res, next) {
            const ctx = req.ov;
            const token = bearer(req);
            if (!token) return http.sendProblem(res, 401, 'token.missing', { detail: 'a person token or a service token (audience openvibe.ai) is required', ctx });
            let service = { ok: false };
            try { service = await auth.verify(token); } catch (err) { service = { ok: false, code: 'token.invalid', reason: 'invalid token' }; }
            if (service.ok && !isAppClaims(service.claims)) {
                const decision = check(service.claims);
                if (!decision.allowed) return http.sendProblem(res, 403, decision.code || 'capability.denied', { detail: decision.reason || 'the capability is not granted', ctx });
                req.principal = { kind: 'service', sub: service.claims.sub, subject: principalSubject(service.claims.sub), cap: service.claims.cap, ns: service.claims.ns || [], jti: service.claims.jti, claims: service.claims };
                return next();
            }
            if (service.ok) return http.sendProblem(res, 403, 'capability.denied', { detail: 'app tokens are not accepted on this route', ctx });
            // A person's Network token: the same key and issuer, no principal type. The subject is subject_id (usr_).
            try {
                const claims = await verifyUserToken(token, {
                    ...(config.networkPublicKey ? { publicKey: config.networkPublicKey } : { jwks: config.networkJwksUrl }),
                    issuer: config.issuer,
                    audience: ['openvibe.network', 'openvibe.ai'],
                    now: clock.now(),
                    log,
                });
                const subject = SUBJECT_RE.test(String(claims.subject_id || '')) ? claims.subject_id : (SUBJECT_RE.test(String(claims.sub || '')) ? claims.sub : '');
                if (!subject) throw new AiError(401, 'token.invalid', 'the person token has no usr_ subject');
                req.principal = { kind: 'user', sub: claims.sub, subject: { type: 'user', id: subject }, claims };
                return next();
            } catch (err) {
                return http.sendProblem(res, err.status || 401, err.code || 'token.invalid', { detail: err.detail || 'invalid token', ctx });
            }
        };
    }
    const run = (fn) => async (req, res) => {
        try { res.set('Cache-Control', 'no-store').json(await fn(req)); } catch (err) { sendError(res, err, req.ov); }
    };
    /**
     * The person's own routes. A service with the read or write capability may only search (the audited agent read)
     * and import suggestions; it may not browse, profile, patch or delete the person's memory. The guard runs after
     * `guard`, which has set req.principal.
     */
    function personOnly(req, res, next) {
        if (req.principal.kind === 'service') {
            return http.sendProblem(res, 403, 'capability.denied', { detail: "this route is for the person's own token", ctx: req.ov });
        }
        return next();
    }
    r.post('/api/v1/memory/items\\:batch', guard(WRITE_CAP), run(async (req) => await memory.batch(req, ownerOf(req))));
    r.get('/api/v1/memory/items', guard(READ_CAP), personOnly, run(async (req) => await memory.list(req, ownerOf(req))));
    r.get('/api/v1/memory/items/:id', guard(READ_CAP), personOnly, run(async (req) => await memory.get(req, ownerOf(req), req.params.id)));
    r.patch('/api/v1/memory/items/:id', guard(WRITE_CAP), personOnly, run(async (req) => await memory.patch(req, ownerOf(req), req.params.id)));
    r.delete('/api/v1/memory/items/:id', guard(WRITE_CAP), personOnly, run(async (req) => await memory.remove(req, ownerOf(req), req.params.id)));
    r.delete('/api/v1/memory/items', guard(WRITE_CAP), personOnly, run(async (req) => await memory.removeBySource(req, ownerOf(req))));
    r.get('/api/v1/memory/profile', guard(READ_CAP), personOnly, run(async (req) => await memory.profile(req, ownerOf(req))));
    r.get('/api/v1/memory/search', guard(READ_CAP), run(async (req) => await memory.search(req, ownerOf(req))));
    // M2c: undo a merge, and settle a conflict. Both are the person's own: a service may only search and suggest.
    r.post('/api/v1/memory/items/:id/split', guard(WRITE_CAP), personOnly, run(async (req) => await memory.split(req, ownerOf(req), req.params.id)));
    r.post('/api/v1/memory/items/:id/settle', guard(WRITE_CAP), personOnly, run(async (req) => await memory.settle(req, ownerOf(req), req.params.id)));
    // The owner is resolved after the guard has set the principal.
    function ownerOf(req) {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const supplied = body.on_behalf_of != null ? body.on_behalf_of : req.query && req.query.on_behalf_of;
        if (req.principal.kind === 'user') {
            if (supplied != null && supplied !== req.principal.subject.id) throw new AiError(403, 'capability.denied', 'a person token acts only for its own owner');
            return `user:${req.principal.subject.id}`;
        }
        const claimed = req.principal.claims.on_behalf_of;
        if (supplied != null && claimed != null && String(supplied) !== String(claimed)) throw new AiError(403, 'capability.denied', 'on_behalf_of does not match the token');
        const person = claimed != null ? claimed : supplied;
        if (person == null || !SUBJECT_RE.test(String(person))) throw new AiError(422, 'input.invalid', 'on_behalf_of must name a usr_ subject');
        return `user:${person}`;
    }
    return r;
}

module.exports = { createMemory, memoryRouter, PROFILE_INTERVAL_MS, PROFILE_ITEMS, SAME_MEANING, CONFLICT_MIN };
