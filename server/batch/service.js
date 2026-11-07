'use strict';
/**
 * The batches: many prompts submitted at once, answered later, at half the retail price.
 *
 * How a batch works:
 *
 *   - Submitting it queues it. The answers are not waited for: the batch is a row, and GET
 *     /api/v1/batches/:id says where it stands (queued, running, succeeded, failed) and what each
 *     prompt was answered with.
 *   - The money goes through Billing like every other request: a batch item is an ordinary run, and
 *     the run's Balance session is charged with the half-price retail card. This table is the queue
 *     and the status, never a second ledger.
 *   - The owner is the account that pays: a person (their personal Balance) or a developer app (its
 *     project's Balance). A service token with no account of its own may not open a batch, because
 *     nobody could be charged for it.
 *   - A batch carries at most config.batches.maxItems prompts. A bigger one is refused at the door.
 *
 * The queue lives in the database, so it survives a restart: a batch that was queued before a deploy
 * is still there after it. Several workers run this service, so a worker claims the batch before it
 * works on it, and the claim expires on its own if that worker dies.
 */
const crypto = require('crypto');
const { AiError } = require('../util');

const DEFAULT_MAX_ITEMS = 1000;

function createBatchService({ db, runs, config = {}, clock = { now: () => Date.now() }, log = console, waitMs = 120000 }) {
    const settings = {
        enabled: true,
        // The cap: how many prompts one batch may carry.
        maxItems: DEFAULT_MAX_ITEMS,
        // How many batches one worker may work on at a time.
        maxInFlight: 5,
        // How long a claimed batch holds the claim.
        claimTtlMs: 15 * 60 * 1000,
        // How often the worker looks for a queued batch.
        tickMs: 60 * 1000,
        // The price a batch is charged at. "half" is the retail rate with every component halved.
        discount: 'half',
        ...(config.batches || {}),
    };
    const maxItems = Math.max(1, Number(settings.maxItems) || DEFAULT_MAX_ITEMS);
    const iso = () => new Date(clock.now()).toISOString();
    const who = `batch:${crypto.randomBytes(4).toString('hex')}`;
    let running = false;
    let timer = null;

    /**
     * The account a batch is billed to. A person pays from their own Balance; an app pays from its
     * project's. A first-party service has no account of its own, so it may not open a batch.
     */
    function ownerOf(principal) {
        const p = principal || {};
        if (p.kind === 'user') {
            const id = p.subject && p.subject.id;
            if (!id) throw new AiError(403, 'batch.no_payer', 'a batch is billed to an account; this token names none');
            return { type: 'user', id: String(id), projectId: null };
        }
        if (p.kind === 'app') {
            const id = p.appId || (p.subject && p.subject.id);
            const project = p.projectId || p.projectKey || null;
            if (!id) throw new AiError(403, 'batch.no_payer', 'a batch is billed to an account; this token names none');
            return { type: 'app', id: String(id), projectId: project ? String(project) : null };
        }
        throw new AiError(403, 'batch.no_payer', 'a batch is billed to an account; a service token with no account of its own may not open one');
    }

    /** The principal a batch item's run is made with: the owner, as it was at the door. */
    function principalFor(batch) {
        if (batch.owner_type === 'user') {
            return { kind: 'user', sub: `usr:${batch.owner_id}`, subject: { type: 'user', id: batch.owner_id }, onBehalfOf: null };
        }
        return {
            kind: 'app', sub: `app:${batch.owner_id}`, subject: { type: 'app', id: batch.owner_id },
            appId: batch.owner_id, projectId: batch.project_id, projectKey: batch.project_id, env: 'production',
        };
    }

    /** The text of a finished run's answer, whatever shape the operation returned it in. */
    function textOf(run) {
        let out = run && run.output;
        if (typeof out === 'string') { try { out = JSON.parse(out); } catch { return out; } }
        if (!out || typeof out !== 'object') return null;
        if (typeof out.text === 'string') return out.text;
        // ai.complete keeps the completion's choices (server/workflows/engine.js); ai.messages a message.
        const choice = (out.choices && out.choices[0]) || (out.completion && out.completion.choices && out.completion.choices[0]);
        if (choice && choice.message && typeof choice.message.content === 'string') return choice.message.content;
        if (choice && typeof choice.text === 'string') return choice.text;
        if (out.message && typeof out.message.content === 'string') return out.message.content;
        if (Array.isArray(out.content) && out.content.length && typeof out.content[0].text === 'string') return out.content[0].text;
        if (typeof out.output === 'string') return out.output;
        return null;
    }

    /**
     * Submit a batch: it is queued, and the answers come later.
     * → the batch, as GET /api/v1/batches/:id shows it.
     */
    async function submit({ principal, items, model = null }) {
        if (settings.enabled === false) throw new AiError(503, 'batch.disabled', 'batches are not open on this service');
        const owner = ownerOf(principal);
        const list = Array.isArray(items) ? items : [];
        if (!list.length) throw new AiError(422, 'input.invalid', 'a batch needs at least one prompt');
        // The cap: a bigger batch is refused before anything is stored.
        if (list.length > maxItems) {
            throw new AiError(422, 'batch.too_large', `a batch carries at most ${maxItems} prompts; this one carries ${list.length}`);
        }
        const prompts = list.map((item) => {
            const prompt = typeof item === 'string' ? item : (item && typeof item.prompt === 'string' ? item.prompt : null);
            if (!prompt || !prompt.trim()) throw new AiError(422, 'input.invalid', 'every batch item needs a prompt');
            if (prompt.length > 20000) throw new AiError(422, 'input.invalid', 'a batch prompt is at most 20000 characters');
            return prompt;
        });
        const id = `bat_${crypto.randomBytes(12).toString('hex')}`;
        const at = iso();
        await db.tx(async () => {
            await db.prepare(`INSERT INTO batches (id, owner_type, owner_id, project_id, status, items, discount, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
                .run(id, owner.type, owner.id, owner.projectId, prompts.length, String(settings.discount), at, at);
            for (let i = 0; i < prompts.length; i++) {
                await db.prepare(`INSERT INTO batch_items (batch_id, idx, status, model, prompt, created_at, updated_at)
                    VALUES (?, ?, 'queued', ?, ?, ?, ?)`)
                    .run(id, i, model, prompts[i], at, at);
            }
        });
        return get(id, principal);
    }

    /** One batch and its items, as the owner sees them (or null when it is not theirs). */
    async function get(id, principal) {
        const row = await db.prepare('SELECT * FROM batches WHERE id = ?').get(String(id)).catch(() => null);
        if (!row) return null;
        const owner = ownerOf(principal);
        if (!(row.owner_type === owner.type && String(row.owner_id) === owner.id)) return null;
        const items = await db.prepare('SELECT idx, status, model, run_id, answer, error_code, error_detail, charged_nano_usd, created_at, updated_at FROM batch_items WHERE batch_id = ? ORDER BY idx').all(row.id);
        // The row's count of prompts is "item_count" here; "items" is the list itself.
        const { items: count, ...rest } = row;
        return { ...rest, item_count: count, items: items || [] };
    }

    /** The caller's own batches, newest first. */
    async function list(principal) {
        const owner = ownerOf(principal);
        const rows = await db.prepare('SELECT * FROM batches WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 100').all(owner.type, owner.id);
        return rows || [];
    }

    /**
     * Claim the next queued batch: one worker at a time. The claim is taken by the database, so two
     * workers that tick at the same moment cannot both work on the same batch, and a worker that dies
     * does not block the batch for ever (the claim expires).
     */
    async function claimNext() {
        const until = new Date(clock.now() + Math.max(1000, Number(settings.claimTtlMs) || 0)).toISOString();
        const at = iso();
        const row = await db.prepare(`UPDATE batches SET status = 'running', claimed_until = ?, claimed_by = ?, updated_at = ?
            WHERE id = (SELECT id FROM batches WHERE status = 'queued' AND (claimed_until IS NULL OR claimed_until <= ?::timestamptz)
                ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING *`).get(until, who, at, at).catch(() => null);
        return row || null;
    }

    /** Run one prompt of the batch: an ordinary run, billed with the half-price card. */
    async function runItem(batch, item) {
        await db.prepare("UPDATE batch_items SET status = 'running', updated_at = ? WHERE batch_id = ? AND idx = ?").run(iso(), batch.id, item.idx);
        const principal = principalFor(batch);
        const body = { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: item.prompt }] } };
        if (batch.owner_type === 'user') body.on_behalf_of = { type: 'user', id: batch.owner_id };
        // An app's run is its project's: the attribution is the project (the EntityRef the run API uses).
        else if (batch.project_id) body.attribution = { service: 'network', type: 'project', id: batch.project_id };
        try {
            const created = await runs.create(body, principal, { requestId: `batch-${batch.id}-${item.idx}`, discount: String(settings.discount) });
            const run = await runs.wait(created, waitMs);
            const ok = run && run.status === 'succeeded';
            const answer = ok ? textOf(run) : null;
            await db.prepare(`UPDATE batch_items SET status = ?, run_id = ?, answer = ?, error_code = ?, error_detail = ?, updated_at = ?
                WHERE batch_id = ? AND idx = ?`)
                .run(ok ? 'succeeded' : 'failed', (run && run.id) || null, answer,
                    ok ? null : ((run && run.error && run.error.code) || 'run_failed'),
                    ok ? null : String((run && run.error && (run.error.detail || run.error.message)) || 'the run did not succeed').slice(0, 500),
                    iso(), batch.id, item.idx);
            return ok;
        } catch (err) {
            await db.prepare("UPDATE batch_items SET status = 'failed', error_code = ?, error_detail = ?, updated_at = ? WHERE batch_id = ? AND idx = ?")
                .run((err && err.code) || 'batch_item_failed', String((err && err.message) || err).slice(0, 500), iso(), batch.id, item.idx);
            return false;
        }
    }

    /**
     * One pass of the worker: take a queued batch and answer its prompts. A batch that fails on one
     * prompt still answers the others: the item that failed says so.
     */
    async function runOnce() {
        if (running) return { skipped: 'running' };
        if (settings.enabled === false) return { skipped: 'disabled' };
        running = true;
        try {
            const batch = await claimNext();
            if (!batch) return { skipped: 'no batch' };
            const items = await db.prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY idx').all(batch.id);
            let failed = 0;
            for (const item of items || []) {
                const ok = await runItem(batch, item);
                if (!ok) failed++;
            }
            const status = failed ? 'failed' : 'succeeded';
            await db.prepare("UPDATE batches SET status = ?, claimed_until = NULL, claimed_by = NULL, finished_at = ?, updated_at = ? WHERE id = ?")
                .run(status, iso(), iso(), batch.id);
            log.log(`[batch] ${batch.id}: ${(items || []).length} prompt(s), ${failed} failed`);
            return { batch: batch.id, items: (items || []).length, failed };
        } catch (err) {
            log.warn('[batch] the worker stopped early: ' + String((err && err.message) || err));
            return { error: String((err && err.code) || 'error') };
        } finally {
            running = false;
        }
    }

    /** The worker looks for a queued batch every tick; the queue itself is in the database. */
    function start() {
        if (timer) return timer;
        const every = Math.max(5000, Number(settings.tickMs) || 60000);
        timer = setInterval(() => { runOnce().catch(() => {}); }, every);
        timer.unref?.();
        return timer;
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    return { submit, get, list, runOnce, start, stop, settings, maxItems };
}

module.exports = { createBatchService, DEFAULT_MAX_ITEMS };
