'use strict';
/**
 * The batches: many prompts submitted at once, answered later, at half the retail price.
 *
 * How a batch works:
 *
 *   - Submitting it queues it, with a deadline (the customer sets it, 1 to 72 hours; the default is 24).
 *     The prompts are answered when the capacity is there, and they expire at the deadline if it is not.
 *   - The money goes through Billing like every other request: a batch item is an ordinary run, and the
 *     run's Balance session is charged with the half-price retail card. This table is the queue and the
 *     status, never a second ledger.
 *   - The owner is the account that pays: a person (their personal Balance) or a developer app (its
 *     project's Balance). A service token with no account of its own may not open a batch, because
 *     nobody could be charged for it.
 *   - A batch carries at most config.batches.maxItems prompts. A bigger one is refused at the door.
 *
 * The capacity rule (server/batch/capacity.js): a batch is half price for the customer, so it may only run
 * where the route really costs the network at most half of the retail card: OpenVibe's own GPU and local
 * capacity and free providers, a community offer that asks at most half, or a paid provider inside a
 * price-book off-peak window. The scheduler holds an item until such a route exists.
 *
 * The settle check: the run settles only if the route it really used costs at most what the customer was
 * charged. If it does not, the settle is refused and the item keeps waiting; nothing is charged.
 *
 * The owner's loss budget (ai.batches.loss_budget_usd_per_day): when it is above zero, an item that reaches
 * its deadline may run on ordinary capacity, and the network absorbs the difference, up to that budget per
 * UTC day. Every absorbed amount is written on the item, and the batch says it ran on regular capacity.
 *
 * The queue lives in the database, so it survives a restart. Several workers run this service, so a worker
 * claims one item at a time (the claim expires on its own if that worker dies) and takes the oldest item
 * first.
 */
const crypto = require('crypto');
const { AiError } = require('../util');
const { hasCap } = require('../auth');
const { retailRate } = require('../providers/model-catalog');
const { toCard } = require('./batcher');
const { batchCapacity, chargeOf, meetsDeadline, totalCost, routeReason } = require('./capacity');
const { retailChargeNano } = require('../credits');

const DEFAULT_MAX_ITEMS = 1000;
const EXPIRED_REASON = 'No low-cost capacity came free before your deadline. You were not charged.';
const CANCELLED_REASON = 'The batch was cancelled before this prompt ran. You were not charged.';
const SENT_REASON = 'Already sent to the provider: it finishes and is charged.';

/**
 * The grant a first-party service needs to open a batch of the network's own (BA2). It is checked here,
 * not by the contracts: the capability entry comes later (BA3), and a pinned contracts build refuses an
 * id it does not know. The grant is a local rule: the token must carry it, exactly or through its family.
 */
const BATCH_CAP = 'ai.batches.create';

function createBatchService({ db, runs, registry = null, community = null, priceBook = null, batcher = null, config = {}, clock = { now: () => Date.now() }, log = console, waitMs = 120000 }) {
    const settings = {
        enabled: true,
        // The cap: how many prompts one batch may carry.
        maxItems: DEFAULT_MAX_ITEMS,
        // How long a batch may wait for low-cost capacity, when the customer names no deadline.
        deadlineHours: 24,
        // The loss budget: how much the network may absorb per UTC day, in USD, when it runs a batch item
        // on ordinary capacity at the deadline. Zero means it never does.
        lossBudgetUsdPerDay: 0,
        // How long a claimed item holds the claim.
        claimTtlMs: 15 * 60 * 1000,
        // How often the worker looks for the next item.
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
        // A service token's principal carries no 'kind': its subject names the type (svc:<id>).
        if ((p.kind || (p.subject && p.subject.type)) === 'service') {
            // A first-party service with the ai.batches.create grant may open a batch of the network's own:
            // it is billed to the network's account, and the run's attribution names the service.
            if (!hasCap(p.claims || { cap: p.cap }, BATCH_CAP)) {
                throw new AiError(403, 'batch.no_grant', `a service may only open a batch with the ${BATCH_CAP} grant`);
            }
            const id = p.subject && p.subject.id;
            if (!id) throw new AiError(403, 'batch.no_payer', 'a batch is billed to an account; this token names none');
            return { type: 'service', id: String(id), projectId: null };
        }
        throw new AiError(403, 'batch.no_payer', 'a batch is billed to an account; a service token with no account of its own may not open one');
    }

    /** The principal a batch item's run is made with: the owner, as it was at the door. */
    function principalFor(batch) {
        if (batch.owner_type === 'user') {
            return { kind: 'user', sub: `usr:${batch.owner_id}`, subject: { type: 'user', id: batch.owner_id }, onBehalfOf: null };
        }
        if (batch.owner_type === 'service') {
            // A service's batch is billed to the network's own account: there is no Balance session, and the
            // run's attribution names the service that asked.
            return {
                kind: 'service', sub: `svc:${batch.owner_id}`, subject: { type: 'service', id: batch.owner_id },
                onBehalfOf: null, service: true,
            };
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
        const choice = (out.choices && out.choices[0]) || (out.completion && out.completion.choices && out.completion.choices[0]);
        if (choice && choice.message && typeof choice.message.content === 'string') return choice.message.content;
        if (choice && typeof choice.text === 'string') return choice.text;
        if (out.message && typeof out.message.content === 'string') return out.message.content;
        if (Array.isArray(out.content) && out.content.length && typeof out.content[0].text === 'string') return out.content[0].text;
        if (typeof out.output === 'string') return out.output;
        return null;
    }

    /**
     * The registry row of the model a batch item asks for; the default chat route's model when it names none.
     * The model is the item's own (batch_items.model): a batch carries many prompts and each of them may name
     * its own model.
     */
    async function resolveModel(batch, item = null) {
        if (!registry) return null;
        const rows = await registry.listModels();
        const wanted = String((item && item.model) || batch.model || '').trim();
        if (wanted) {
            const found = (rows || []).find((r) => String(r.model_key) === wanted
                || `${r.provider_key}/${r.model_key}` === wanted
                || String(r.display_name || '') === wanted);
            if (found) return found;
        }
        const route = await registry.getRoute('default.chat').catch(() => null);
        const primary = route && route.primary ? route.primary : null;
        if (primary) {
            const found = (rows || []).find((r) => r.provider_key === primary.provider && r.model_key === primary.model);
            if (found) return found;
        }
        return null;
    }

    /** The deadline the customer asked for, in hours: 1 to 72, the default 24. */
    function deadlineHoursOf(hours) {
        if (hours == null || hours === '') return Math.max(1, Math.min(72, Number(settings.deadlineHours) || 24));
        const n = Number(hours);
        if (!Number.isFinite(n)) throw new AiError(422, 'input.invalid', 'deadline_hours must be a number of hours');
        if (n < 1 || n > 72) throw new AiError(422, 'input.invalid', 'deadline_hours is between 1 and 72');
        return Math.trunc(n);
    }

    /**
     * Submit a batch: it is queued, and the answers come later.
     * → the batch, as GET /api/v1/batches/:id shows it.
     */
    async function submit({ principal, items, model = null, deadlineHours = null }) {
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
        const hours = deadlineHoursOf(deadlineHours);
        const id = `bat_${crypto.randomBytes(12).toString('hex')}`;
        const at = iso();
        const deadline = new Date(clock.now() + hours * 3600 * 1000).toISOString();
        await db.tx(async () => {
            await db.prepare(`INSERT INTO batches (id, owner_type, owner_id, project_id, status, items, discount, deadline_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
                .run(id, owner.type, owner.id, owner.projectId, prompts.length, String(settings.discount), deadline, at, at);
            for (let i = 0; i < prompts.length; i++) {
                await db.prepare(`INSERT INTO batch_items (batch_id, idx, status, model, prompt, deadline_at, created_at, updated_at)
                    VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`)
                    .run(id, i, model, prompts[i], deadline, at, at);
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
        const items = await db.prepare(`SELECT idx, status, model, run_id, answer, error_code, error_detail, reason, capacity,
            route_provider, route_model, cost_nano_usd, absorbed_nano_usd, charged_nano_usd, deadline_at, created_at, updated_at
            FROM batch_items WHERE batch_id = ? ORDER BY idx`).all(row.id);
        const { items: count, ...rest } = row;
        return { ...rest, item_count: count, items: items || [] };
    }

    /** The caller's own batches, newest first: the same shape one batch has (the items are not in the list). */
    async function list(principal) {
        const owner = ownerOf(principal);
        const rows = await db.prepare('SELECT * FROM batches WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 100').all(owner.type, owner.id);
        return (rows || []).map((row) => { const { items: count, ...rest } = row; return { ...rest, item_count: count, items: [] }; });
    }

    /**
     * Cancel a batch: only the prompts that never had a run are cancelled, and nothing is charged for them.
     * A prompt that already has a run goes on and settles on its own path: it keeps its status and the answer
     * says so. The prompts that already answered keep their answers.
     * → the batch, as GET /api/v1/batches/:id shows it (or null when it is not the caller's).
     */
    async function cancel(id, principal) {
        const row = await db.prepare('SELECT * FROM batches WHERE id = ?').get(String(id)).catch(() => null);
        if (!row) return null;
        const owner = ownerOf(principal);
        if (!(row.owner_type === owner.type && String(row.owner_id) === owner.id)) return null;
        const at = iso();
        await db.tx(async () => {
            // Only the prompts that never had a run are cancelled: they are not charged for.
            await db.prepare(`UPDATE batch_items SET status = 'cancelled', reason = ?, charged_nano_usd = 0, claimed_until = NULL, claimed_by = NULL, updated_at = ?
                WHERE batch_id = ? AND run_id IS NULL AND status IN ('queued', 'waiting')`).run(CANCELLED_REASON, at, row.id);
            // A prompt that already has a run (BA2 puts one on the provider's own batch API; the ordinary
            // path keeps it) goes on and settles on its own path. It keeps its status and says so: nobody is
            // told it was not charged.
            await db.prepare(`UPDATE batch_items SET reason = ?, updated_at = ?
                WHERE batch_id = ? AND run_id IS NOT NULL AND status IN ('waiting', 'running')`).run(SENT_REASON, at, row.id);
        });
        // The batch is cancelled only when nothing is left in flight: a prompt that has a run finishes on its own.
        const left = await db.prepare(`SELECT COUNT(*) AS n FROM batch_items WHERE batch_id = ? AND run_id IS NOT NULL AND status IN ('waiting', 'running')`).get(row.id);
        if (Number(left && left.n || 0) > 0) {
            await db.prepare(`UPDATE batches SET status = CASE WHEN status IN ('queued', 'running') THEN 'running' ELSE status END,
                claimed_until = NULL, claimed_by = NULL, updated_at = ? WHERE id = ?`).run(at, row.id);
        } else {
            await db.prepare(`UPDATE batches SET status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
                claimed_until = NULL, claimed_by = NULL, finished_at = CASE WHEN status IN ('queued', 'running') THEN ? ELSE finished_at END, updated_at = ?
                WHERE id = ?`).run(at, at, row.id);
        }
        return get(id, principal);
    }

    /**
     * Claim the oldest item that is waiting: one item at a time, oldest first. The claim is taken by the
     * database, so two workers that tick at the same moment cannot work on the same item, and a worker that
     * dies does not block the item for ever (the claim expires).
     */
    async function claimNext() {
        const until = new Date(clock.now() + Math.max(1000, Number(settings.claimTtlMs) || 0)).toISOString();
        const at = iso();
        const row = await db.prepare(`UPDATE batch_items SET claimed_until = ?, claimed_by = ?, updated_at = ?
            WHERE (batch_id, idx) = (
                SELECT batch_id, idx FROM batch_items
                WHERE status IN ('queued', 'waiting')
                    AND (claimed_until IS NULL OR claimed_until <= ?::timestamptz)
                ORDER BY created_at, idx LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING *`).get(until, who, at, at).catch(() => null);
        return row || null;
    }

    /** Give the claim back, so another worker (or this one, later) may take the item. */
    async function release(item, status = 'waiting', waitingReason = null) {
        await db.prepare('UPDATE batch_items SET status = ?, waiting_reason = ?, claimed_until = NULL, claimed_by = NULL, updated_at = ? WHERE batch_id = ? AND idx = ?')
            .run(status, waitingReason == null ? null : String(waitingReason).slice(0, 300), iso(), item.batch_id, item.idx);
    }

    /** What the network absorbed today (the loss budget is per UTC day). */
    async function absorbedToday() {
        const day = iso().slice(0, 10);
        const row = await db.prepare(`SELECT COALESCE(SUM(absorbed_nano_usd), 0) AS total FROM batch_items
            WHERE absorbed_nano_usd > 0 AND updated_at >= ?::timestamptz`).get(`${day}T00:00:00.000Z`).catch(() => null);
        return BigInt((row && row.total) || 0);
    }

    /** May the network absorb a loss today? The budget is in USD; the ledger is in nano. */
    async function budgetLeft() {
        const budgetUsd = Number(settings.lossBudgetUsdPerDay || 0);
        if (!(budgetUsd > 0)) return 0n;
        const budgetNano = BigInt(Math.round(budgetUsd * 1e9));
        const used = await absorbedToday();
        return budgetNano > used ? budgetNano - used : 0n;
    }

    /** The card a route really costs: the route's own price, per million tokens. */
    function costCard(route) {
        const cost = route && route.cost ? route.cost : {};
        return {
            version: route && route.source ? `batch-${route.source}` : 'batch-route',
            nano_usd_per_m: {
                input: cost.input == null ? '0' : String(cost.input),
                cached_read: cost.cached_read == null ? '0' : String(cost.cached_read),
                cache_write: cost.cache_write == null ? '0' : String(cost.cache_write),
                output: cost.output == null ? '0' : String(cost.output),
            },
            per_request_nano_usd: '0',
        };
    }

    /** The settle check of a batch item: the batcher rebuilds it after a restart (the plan carries the route and the charge). */
    function settleCheckFor({ item, route, charge, batch }) { return settleCheck({ item, route, charge, batch }); }

    /**
     * The settle check: the run settles only if the route it really used costs at most what the customer
     * was charged. A route that costs more is refused, and the item keeps waiting.
     */
    function settleCheck({ item, route, charge, batch }) {
        return async ({ usage, retailBase, provider, model }) => {
            const tokens = {
                input: Number(usage.input_tokens || 0),
                cached: Number(usage.cached_read_tokens || 0),
                cacheWrite: Number(usage.cache_write_tokens || 0),
                output: Number(usage.output_tokens || 0),
            };
            const charged = retailChargeNano(charge, tokens);
            // The real cost of the route that answered: the eligible route's own price when it answered,
            // and the answering offer's own list price when the router fell over to another offer.
            const named = route && provider && String(provider) === String(route.provider) && String(model) === String(route.model);
            const real = named ? retailChargeNano(costCard(route), tokens) : retailChargeNano(retailBase, tokens);
            if (real <= charged) return { ok: true, charged: String(charged), absorbed: '0', real: String(real) };
            // The route cost more than the customer paid. The loss budget may cover the difference.
            const left = await budgetLeft();
            const absorbed = real - charged;
            if (left >= absorbed) {
                await db.prepare('UPDATE batch_items SET absorbed_nano_usd = ?, capacity = ?, updated_at = ? WHERE batch_id = ? AND idx = ?')
                    .run(String(absorbed), 'regular', iso(), item.batch_id, item.idx);
                await db.prepare('UPDATE batches SET ran_on_regular_capacity = true, absorbed_nano_usd = absorbed_nano_usd + ?, updated_at = ? WHERE id = ?')
                    .run(String(absorbed), iso(), batch.id);
                return { ok: true, charged: String(charged), absorbed: String(absorbed), real: String(real) };
            }
            // The route cost more than the customer paid: the settle is refused, the item is marked, and
            // it waits for a route it can afford. Nothing is charged.
            await db.prepare("UPDATE batch_items SET error_code = 'batch.cost_exceeded', error_detail = ?, absorbed_nano_usd = 0, updated_at = ? WHERE batch_id = ? AND idx = ?")
                .run('the route cost more than the customer was charged', iso(), item.batch_id, item.idx);
            return { ok: false, reason: 'the route cost more than the customer was charged', charged: String(charged), real: String(real) };
        };
    }

    /**
     * Put one prompt of the batch on the provider's own batch API. The run is created at once (the customer
     * sees it) and waits for the answer; the batcher settles it when the provider answers.
     */
    async function enqueueNative(batch, item, route, charge, model, reason = null) {
        try {
            const principal = principalFor(batch);
            const check = settleCheck({ item, route, charge, batch });
            // The card the customer is charged: the retail card of the model they asked for. The hold takes
            // the half of it, exactly as the ordinary path does.
            const retail = model ? toCard(retailRate(model)) : null;
            const queued = await batcher.enqueue({
                principal,
                provider: route.provider,
                model: route.model,
                prompt: item.prompt,
                kind: 'customer',
                customer: { batchId: batch.id, idx: item.idx },
                deadlineHours: Math.max(1, Math.round((new Date(item.deadline_at).getTime() - clock.now()) / 3600000)) || Number(settings.deadlineHours) || 24,
                discount: String(settings.discount),
                prefer: { provider: route.provider, model: route.model },
                costCheck: check,
                requestId: `batch-${batch.id}-${item.idx}`,
                holdCard: retail,
                route,
                charge,
                servicePaid: principal.kind === 'service',
            });
            await db.prepare(`UPDATE batch_items SET status = 'running', run_id = ?, route_provider = ?, route_model = ?, route_reason = ?, claimed_until = NULL, claimed_by = NULL, updated_at = ?
                WHERE batch_id = ? AND idx = ?`)
                .run(queued.runId || null, route.provider, route.model, reason, iso(), batch.id, item.idx);
            return { ok: true };
        } catch (err) {
            log.warn('[batch] an item could not be queued for the provider\'s batch API: ' + String((err && err.message) || err));
            const code = String((err && err.code) || 'batch.queue_failed');
            // BA2: a customer whose Balance cannot cover the run is refused here, before the provider is
            // given the work: the item fails with the reason and the network owes nobody anything.
            if (err && err.status === 402) {
                await db.prepare("UPDATE batch_items SET status = 'failed', error_code = ?, error_detail = ?, claimed_until = NULL, claimed_by = NULL, updated_at = ? WHERE batch_id = ? AND idx = ?")
                    .run(code, String((err && err.detail) || 'Not enough Balance').slice(0, 300), iso(), batch.id, item.idx);
            }
            return { ok: false, code };
        }
    }

    /** Run one prompt of the batch: an ordinary run, billed with the half-price card. */
    async function runItem(batch, item, route, charge, regular = false, reason = null) {
        const principal = principalFor(batch);
        const body = { workflow: 'ai.complete', input: { messages: [{ role: 'user', content: item.prompt }] } };
        if (batch.owner_type === 'user') body.on_behalf_of = { type: 'user', id: batch.owner_id };
        else if (batch.project_id) body.attribution = { service: 'network', type: 'project', id: batch.project_id };
        // The route the capacity rules named is a soft preference, not a pin: the run is billed through
        // the ordinary path (the Balance hold), and the settle check refuses an answer that came from a
        // route which costs more than the customer paid.
        const prefer = route && route.source !== 'community' && !regular
            ? { provider: route.provider, model: route.model }
            : null;
        const check = settleCheck({ item, route, charge, batch });
        const created = await runs.create(body, principal, {
            requestId: `batch-${batch.id}-${item.idx}`,
            discount: String(settings.discount),
            ...(prefer ? { prefer } : {}),
            ...(route && route.offer_id ? { communityOfferId: route.offer_id } : {}),
            costCheck: check,
        });
        const run = await runs.wait(created, waitMs);
        if (!run || run.status !== 'succeeded') {
            const code = (run && run.error && run.error.code) || 'run_failed';
            // A route that cost more than the customer paid is refused, not failed: the item waits again
            // and the customer is charged nothing.
            const status = code === 'batch.cost_exceeded' ? 'waiting' : 'failed';
            await db.prepare(`UPDATE batch_items SET status = ?, run_id = ?, error_code = ?, error_detail = ?, claimed_until = NULL, claimed_by = NULL, updated_at = ?
                WHERE batch_id = ? AND idx = ?`)
                .run(status, (run && run.id) || null, code, String((run && run.error && (run.error.detail || run.error.message)) || 'the run did not succeed').slice(0, 500),
                    iso(), batch.id, item.idx);
            return { ok: false, code };
        }
        // The settle may have been refused (the route cost more than the customer paid): the item waits
        // again and the customer is charged nothing.
        const marked = await db.prepare('SELECT error_code FROM batch_items WHERE batch_id = ? AND idx = ?').get(batch.id, item.idx);
        if (marked && marked.error_code === 'batch.cost_exceeded') {
            await db.prepare("UPDATE batch_items SET status = 'waiting', run_id = ?, claimed_until = NULL, claimed_by = NULL, updated_at = ? WHERE batch_id = ? AND idx = ?")
                .run(run.id || null, iso(), batch.id, item.idx);
            return { ok: false, code: 'batch.cost_exceeded' };
        }
        const answer = textOf(run);
        await db.prepare(`UPDATE batch_items SET status = 'succeeded', run_id = ?, answer = ?, capacity = ?, route_provider = ?, route_model = ?, route_reason = ?,
            waiting_reason = NULL, claimed_until = NULL, claimed_by = NULL, updated_at = ? WHERE batch_id = ? AND idx = ?`)
            .run(run.id || null, answer, regular ? 'regular' : (route ? route.source : 'low-cost'),
                route ? route.provider : null, route ? route.model : null,
                regular ? 'the deadline passed and the owner\'s loss budget covered ordinary capacity' : reason, iso(), batch.id, item.idx);
        return { ok: true, run };
    }

    /** The item ran on a route that cost more than the charge: it is refused, and the item waits again. */
    async function refuseRoute(item, reason) {
        await db.prepare(`UPDATE batch_items SET status = 'waiting', error_code = 'batch.cost_exceeded', error_detail = ?,
            claimed_until = NULL, claimed_by = NULL, updated_at = ? WHERE batch_id = ? AND idx = ?`)
            .run(String(reason || '').slice(0, 300), iso(), item.batch_id, item.idx);
    }

    /** The item reached its deadline with no low-cost capacity: it expires, and it is never charged. */
    async function expireItem(batch, item) {
        await db.prepare(`UPDATE batch_items SET status = 'expired', reason = ?, charged_nano_usd = 0,
            claimed_until = NULL, claimed_by = NULL, updated_at = ? WHERE batch_id = ? AND idx = ?`)
            .run(EXPIRED_REASON, iso(), item.batch_id, item.idx);
        await db.prepare(`UPDATE batches SET status = CASE WHEN status IN ('queued', 'running') THEN 'expired' ELSE status END, updated_at = ? WHERE id = ?`)
            .run(iso(), batch.id);
    }

    /**
     * One pass of the worker: take the oldest item that is waiting, and either run it on eligible capacity,
     * run it on ordinary capacity when the loss budget covers it, or let it wait.
     */
    async function runOnce() {
        if (running) return { skipped: 'running' };
        if (settings.enabled === false) return { skipped: 'disabled' };
        running = true;
        try {
            const item = await claimNext();
            if (!item) return { skipped: 'no item' };
            const batch = await db.prepare('SELECT * FROM batches WHERE id = ?').get(item.batch_id);
            if (!batch) { await release(item, 'failed'); return { skipped: 'no batch' }; }
            const model = await resolveModel(batch, item);
            const charge = model ? chargeOf(model) : null;
            const deadlinePassed = new Date(item.deadline_at).getTime() <= clock.now();
            const capacity = model && charge
                ? await batchCapacity(model, clock.now(), { registry, community, priceBook })
                : { charge, routes: [] };
            // A route must meet the customer's latest finish time: a provider batch that promises 24
            // hours is not a route for a one-hour deadline. The cheapest of the rest wins.
            const routes = (capacity.routes || []).filter((r) => meetsDeadline(r, item.deadline_at, clock.now())).sort((a, b) => {
                const ai = totalCost(a);
                const bi = totalCost(b);
                return ai < bi ? -1 : ai > bi ? 1 : 0;
            });
            if (routes.length) {
                const route = routes[0];
                const reason = routeReason(route);
                // (d) A provider's own batch API: the item waits for the provider's answer instead of being
                // answered now. The batcher writes the answer onto the run and the run finishes as usual.
                if (route.source === 'native-batch' && batcher) {
                    const res = await enqueueNative(batch, item, route, capacity.charge, model, reason);
                    return { batch: batch.id, item: item.idx, route: route.source, queued: res.ok, error: res.code };
                }
                const res = await runItem(batch, item, route, capacity.charge, false, reason);
                if (res.ok) await finishBatch(batch);
                else await release(item, 'waiting');
                return { batch: batch.id, item: item.idx, route: route.source, ok: res.ok };
            }
            if (!deadlinePassed) {
                // No low-cost capacity yet: the item waits, and the customer is charged nothing.
                const tooLong = (capacity.routes || []).find((r) => !meetsDeadline(r, item.deadline_at, clock.now()));
                await release(item, 'waiting', tooLong
                    ? `${tooLong.provider} batch API promises ${tooLong.window || '24h'}, after this batch's deadline`
                    : 'waiting for a route inside the customer\'s deadline; nothing has been charged');
                return { batch: batch.id, item: item.idx, waiting: true };
            }
            // The deadline passed with no eligible capacity: the loss budget may pay for ordinary capacity.
            const left = await budgetLeft();
            if (left > 0n && model && charge) {
                const res = await runItem(batch, item, null, charge, true);
                if (res.ok) { await finishBatch(batch); return { batch: batch.id, item: item.idx, regular: true }; }
                // The loss budget could not cover the difference: the item expires, uncharged.
                if (res.code === 'batch.cost_exceeded') { await expireItem(batch, item); return { batch: batch.id, item: item.idx, expired: true }; }
                await release(item, 'waiting');
                return { batch: batch.id, item: item.idx, waiting: true };
            }
            await expireItem(batch, item);
            return { batch: batch.id, item: item.idx, expired: true };
        } catch (err) {
            log.warn('[batch] the worker stopped early: ' + String((err && err.message) || err));
            return { error: String((err && err.code) || 'error') };
        } finally {
            running = false;
        }
    }

    /** The batch is done when every item is: no item is waiting any more. */
    async function finishBatch(batch) {
        const left = await db.prepare(`SELECT COUNT(*) AS n FROM batch_items WHERE batch_id = ? AND status IN ('queued', 'waiting', 'running')`).get(batch.id);
        if (left && Number(left.n) > 0) return false;
        const failed = await db.prepare(`SELECT COUNT(*) AS n FROM batch_items WHERE batch_id = ? AND status = 'failed'`).get(batch.id);
        const expired = await db.prepare(`SELECT COUNT(*) AS n FROM batch_items WHERE batch_id = ? AND status = 'expired'`).get(batch.id);
        const status = Number(failed && failed.n) > 0 ? 'failed' : (Number(expired && expired.n) > 0 ? 'expired' : 'succeeded');
        await db.prepare('UPDATE batches SET status = ?, claimed_until = NULL, claimed_by = NULL, finished_at = ?, updated_at = ? WHERE id = ?')
            .run(status, iso(), iso(), batch.id);
        return true;
    }

    /** The worker looks for the next item every tick; the queue itself is in the database. */
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

    return { submit, get, list, cancel, runOnce, start, stop, settings, maxItems, EXPIRED_REASON, CANCELLED_REASON, SENT_REASON, resolveModel, finishBatch, settleCheckFor };
}

module.exports = { createBatchService, DEFAULT_MAX_ITEMS, EXPIRED_REASON, CANCELLED_REASON, SENT_REASON };
