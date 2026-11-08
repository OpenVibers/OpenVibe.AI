'use strict';
/**
 * The native batcher: the providers' own batch APIs, behind one queue (BA2).
 *
 * What it does:
 *
 *   - An item whose run has latency_class 'batch' waits here, in the batch_queue table. The run itself
 *     is created at once (the customer can see it, and its class says 'batch'), but it holds no execution
 *     slot and no quota until the provider answers.
 *   - Items are grouped by provider + model. A group is submitted to the provider's own batch API when it
 *     reaches a size limit (config.batches.native.maxItemsPerGroup) or an age limit (maxAgeMs): a small
 *     group waits, so the provider's file is worth sending.
 *   - One worker polls the batches the provider is working on. The claim is taken from the database and
 *     expires on its own, so several workers are safe and a dead worker blocks nothing.
 *   - When the answers arrive, each one is written onto its own run (the status, the output, the tokens and
 *     the cost at the provider's batch price) and the run finishes on the ordinary path: the same settle,
 *     the same receipt, the same events. A customer watching the run sees nothing new.
 *   - A deadline the provider cannot meet re-routes the item: the run goes back to the ordinary
 *     (background or standard) path, and the item says so.
 *
 * The money rule: the cost written on the run is what the provider really charges for the tier it really
 * ran on, which is its own list price multiplied by its own batch discount (server/batch/providers). When a
 * provider's batch price is not known, the item never runs there: the network never claims a saving it
 * cannot see. This queue is not a ledger: the money is the ordinary runs' money, held and settled by
 * Billing.
 */
const crypto = require('crypto');
const { AiError, providerSecret } = require('../util');
const { retailRate, accessOf } = require('../providers/model-catalog');
const { retailChargeNano } = require('../credits');
const { providerConfig } = require('./providers');
const { createOpenAiCompatibleAdapter } = require('./providers/openai-compatible');
const { createAnthropicAdapter } = require('./providers/anthropic');
const { createGeminiAdapter } = require('./providers/gemini');

const ADAPTERS = {
    'openai-compatible': createOpenAiCompatibleAdapter,
    anthropic: createAnthropicAdapter,
    gemini: createGeminiAdapter,
};

/** The nano-USD a decimal amount of dollars is, without a float anywhere near the money. */
const NANO_PER_USD = 1000000000n;

/**
 * The provider's own price for its batch tier: the list price (the registry's card) with every rate
 * multiplied by the provider's batch discount. The discount is a fixed fraction of a million, so the
 * multiplication is exact in BigInt and never a float.
 */
function scaleCard(card, discount) {
    if (!card) return null;
    const d = BigInt(Math.round(Number(discount) * 1000000));
    const scale = (v) => (v == null ? null : (BigInt(String(v)) * d / 1000000n).toString());
    const perM = card.nano_usd_per_m || {};
    return {
        version: `${card.version || 'retail'}:batch-${String(discount)}`,
        nano_usd_per_m: {
            input: scale(perM.input),
            cached_read: scale(perM.cached_read),
            cache_write: scale(perM.cache_write),
            output: scale(perM.output),
        },
        per_request_nano_usd: scale(card.per_request_nano_usd == null ? '0' : card.per_request_nano_usd),
    };
}

/** The retail card in the shape the Balance ledger counts (the shape retailOf() produces). */
function toCard(rate) {
    if (!rate) return null;
    const put = (v) => (v == null ? null : String(v));
    return {
        version: String(rate.version || 'retail'),
        nano_usd_per_m: {
            input: put(rate.input_nano_usd_per_m),
            cached_read: put(rate.cached_read_nano_usd_per_m),
            cache_write: put(rate.cache_write_nano_usd_per_m),
            output: put(rate.output_nano_usd_per_m),
        },
        per_request_nano_usd: put(rate.per_request_nano_usd == null ? '0' : rate.per_request_nano_usd),
    };
}

function createBatcher({ db, runs, registry, credits = null, config = {}, clock = { now: () => Date.now() }, log = console, env = process.env, fetchImpl = globalThis.fetch, batches = null } = {}) {
    // The batch service is attached after the batcher is built (the service needs the batcher too).
    const native = (config.batches && config.batches.native) || {};
    const settings = {
        enabled: true,
        // How many requests one provider batch carries (the provider's own limit is the ceiling; this is
        // the network's own, so a file is never bigger than it needs to be).
        maxItemsPerGroup: 1000,
        // How long a group waits before it is submitted anyway: a small group still has to go out.
        maxAgeMs: 5 * 60 * 1000,
        // How often the worker submits and polls.
        submitMs: 15000,
        pollMs: 60000,
        // How long a claimed provider batch stays claimed (a dead worker must block nothing).
        claimTtlMs: 5 * 60 * 1000,
        // The provider's own timeout for one call.
        timeoutMs: 60000,
        // The deadline a customer batch item gets when it names none.
        deadlineHours: 24,
        ...native,
    };
    const iso = () => new Date(clock.now()).toISOString();
    const who = `batcher:${crypto.randomBytes(4).toString('hex')}`;
    const adapters = new Map();
    let service = null;
    let running = false;
    let timer = null;

    /** The provider's adapter, built once and kept. */
    async function adapterFor(providerKey) {
        if (adapters.has(providerKey)) return adapters.get(providerKey);
        const cfg = providerConfig(providerKey);
        if (!cfg || !cfg.enabled) throw new AiError(422, 'batch.no_native_api', 'this provider has no verified batch API');
        const row = await registry.getProvider(providerKey);
        if (!row || row.status !== 'active') throw new AiError(422, 'batch.provider_inactive', 'this provider is not active');
        const factory = ADAPTERS[cfg.adapter];
        if (!factory) throw new AiError(422, 'batch.no_native_api', 'this provider has no adapter for its batch API');
        const adapter = factory({
            baseUrl: row.base_url,
            apiKey: providerSecret(row, env),
            fetchImpl,
            limits: cfg.limits,
            timeoutMs: settings.timeoutMs,
        });
        adapters.set(providerKey, adapter);
        return adapter;
    }

    /**
     * The provider's own prices for one model: the list price (the registry's card), the batch price (the
     * list price times the provider's own discount) and the access the provider has (which decides
     * whether a customer's money may be held for it at all).
     */
    async function cardsFor(providerKey, modelKey) {
        const cfg = providerConfig(providerKey);
        const rows = await registry.listModels();
        const row = (rows || []).find((r) => String(r.provider_key) === providerKey && String(r.model_key) === modelKey);
        if (!row) return null;
        const retail = toCard(retailRate(row));
        if (!retail) return null;
        const provider = await registry.getProvider(providerKey);
        return {
            row,
            retail,
            batch: scaleCard(retail, cfg ? cfg.discount : 1),
            discount: cfg ? cfg.discount : 1,
            access: provider ? accessOf(provider) : 'UNVERIFIED',
        };
    }

    /**
     * The plan of a waiting run: what a restarted service needs to finish it. It holds the principal
     * snapshot (only the fields create() reads, never a token), the run's input, the card the run is
     * charged at, and the route it went to.
     */
    function planOf({ principal, input, card, maxTokens, discount, maxCostNano, requestId, route, charge, servicePaid }) {
        return {
            principal: {
                kind: principal.kind || null,
                sub: principal.sub || null,
                subject: principal.subject || null,
                onBehalfOf: principal.onBehalfOf || null,
                jti: principal.jti || null,
                appId: principal.appId || null,
                projectId: principal.projectId || null,
                projectKey: principal.projectKey || null,
                env: principal.env || null,
                cap: Array.isArray(principal.cap) ? principal.cap : null,
                ns: Array.isArray(principal.ns) ? principal.ns : null,
                servicePaid: Boolean(servicePaid),
            },
            input: input || null,
            card: card || null,
            maxTokens: Number(maxTokens) || 4096,
            discount: discount || null,
            maxCostNano: maxCostNano == null ? null : String(maxCostNano),
            requestId: requestId || null,
            route: route || null,
            charge: charge || null,
        };
    }

    /** Who pays for the run, and at what discount: the payer's own view of it. */
    function payerCtx(principal, { discount, maxCostNano, requestId }) {
        const app = principal.kind === 'app';
        const person = !app && principal.subject && principal.subject.type === 'user' ? String(principal.subject.id) : null;
        return {
            ...(app ? { appId: principal.appId || null, projectId: principal.projectId || null } : {}),
            onBehalfOf: person,
            personPays: Boolean(person),
            discount: discount || null,
            maxCostNano: maxCostNano == null ? null : String(maxCostNano),
            runId: requestId || null,
        };
    }

    /**
     * Put one item in the queue. The run is created at once (so the customer sees it, and its latency
     * class says 'batch'), but it waits for the provider instead of running.
     */
    async function enqueue({ principal, provider, model, prompt, kind = 'service', customer = null, deadlineHours = null, discount = null, prefer = null, costCheck = null, requestId = null, maxTokens = 4096, holdCard = null, route = null, charge = null, servicePaid = false, maxCostNano = null }) {
        if (settings.enabled === false) throw new AiError(503, 'batch.disabled', 'native batches are not open on this service');
        const cfg = providerConfig(provider);
        if (!cfg || !cfg.enabled) throw new AiError(422, 'batch.no_native_api', 'this provider has no verified batch API');
        const cards = await cardsFor(provider, model);
        if (!cards) throw new AiError(422, 'batch.no_price_card', 'this provider has no price card for that model');
        const body = { workflow: 'ai.complete', options: { latency: 'batch' }, input: { messages: [{ role: 'user', content: prompt }] } };
        const input = body.input;
        // The money check, before the provider is given the work: a customer whose Balance cannot cover
        // the run at the card it will be charged is refused here, so the network never owes a provider
        // for a run nobody can pay for. The money itself is taken when the answer arrives.
        if (credits && holdCard) {
            const verdict = await credits.probe({
                requestId,
                ctx: payerCtx(principal, { discount, maxCostNano, requestId }),
                input,
                card: holdCard,
                provider,
                model,
                access: cards.access,
                maxTokens,
            });
            if (!verdict.ok) throw new AiError(402, String(verdict.reason || 'billing.insufficient_funds'), String(verdict.detail || 'Not enough Balance'));
        }
        // The principal carries the flag: only the batcher sets it, so no caller can hold a run open.
        const created = await runs.create(body, { ...principal, deferBatch: true, servicePaid: Boolean(servicePaid) }, { requestId, discount, prefer, costCheck });
        const id = `bni_${crypto.randomBytes(10).toString('hex')}`;
        const hours = Number(deadlineHours) > 0 ? Number(deadlineHours) : Number(settings.deadlineHours) || 24;
        const deadline = new Date(clock.now() + hours * 3600 * 1000).toISOString();
        const providerBody = { model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens };
        const plan = planOf({ principal, input, card: holdCard, maxTokens, discount, maxCostNano, requestId, route, charge, servicePaid });
        await db.prepare(`INSERT INTO batch_queue (id, run_id, kind, batch_id, idx, provider, model, prompt, request_body, hold_card, plan, status, deadline_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
            .run(id, created.run.id, kind, customer ? customer.batchId : null, customer ? customer.idx : null,
                provider, model, prompt, JSON.stringify(providerBody),
                holdCard ? JSON.stringify(holdCard) : null, JSON.stringify(plan), deadline, iso(), iso());
        return { id, runId: created.run.id, cards };
    }

    /** The groups that are ready to be sent: a full group, or an old one. */
    async function submitOnce() {
        if (running) return { skipped: 'running' };
        running = true;
        try {
            const groups = await db.prepare(`SELECT provider, model, COUNT(*) AS n, MIN(created_at) AS oldest
                FROM batch_queue WHERE status = 'queued' GROUP BY provider, model`).all();
            const sent = [];
            for (const group of groups || []) {
                const age = clock.now() - new Date(group.oldest).getTime();
                if (Number(group.n) < Number(settings.maxItemsPerGroup) && age < Number(settings.maxAgeMs)) continue;
                const job = await submitGroup(group.provider, group.model);
                if (job) sent.push(job);
            }
            return { sent: sent.length, jobs: sent };
        } catch (err) {
            log.warn('[batch] the submitter stopped early: ' + String((err && err.message) || err));
            return { error: String((err && err.code) || 'error') };
        } finally {
            running = false;
        }
    }

    /** Send one group to the provider's own batch API, as one file and one batch. */
    async function submitGroup(providerKey, modelKey) {
        const items = await db.prepare(`SELECT * FROM batch_queue WHERE provider = ? AND model = ? AND status = 'queued'
            ORDER BY created_at LIMIT ?`).all(providerKey, modelKey, Number(settings.maxItemsPerGroup));
        if (!items || !items.length) return null;
        const adapter = await adapterFor(providerKey);
        const cfg = providerConfig(providerKey);
        const jobId = `pb_${crypto.randomBytes(10).toString('hex')}`;
        const payload = items.map((i) => ({ customId: i.id, body: JSON.parse(i.request_body || '{}') }));
        await db.prepare(`INSERT INTO provider_batches (id, provider, model, adapter, status, item_count, discount, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'submitting', ?, ?, ?, ?)`)
            .run(jobId, providerKey, modelKey, cfg.adapter, items.length, cfg.discount, iso(), iso());
        let submitted;
        try {
            submitted = await adapter.submit({ items: payload, metadata: { display_name: jobId } });
        } catch (err) {
            // The provider refused or could not be reached: the items go back to the queue and are tried
            // again later. Nothing is charged and nothing is lost.
            await db.prepare(`UPDATE provider_batches SET status = 'failed', error_code = ?, error_detail = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
                .run(String((err && err.code) || 'batch.provider_error').slice(0, 80), String((err && err.message) || '').slice(0, 300), iso(), iso(), jobId);
            for (const item of items) {
                await db.prepare(`UPDATE batch_queue SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'queued'`).run(iso(), item.id);
            }
            log.warn(`[batch] the provider refused a batch: ${String((err && err.message) || err)}`);
            return null;
        }
        await db.prepare(`UPDATE provider_batches SET status = 'submitted', provider_batch_id = ?, bytes = ?, completion_window = ?, submitted_at = ?, updated_at = ?, claimed_until = NULL, claimed_by = NULL WHERE id = ?`)
            .run(String(submitted.batchId), String(submitted.bytes || 0), adapter.completionWindow || '24h', iso(), iso(), jobId);
        const placeholders = items.map(() => '?').join(',');
        await db.prepare(`UPDATE batch_queue SET status = 'submitted', job_id = ?, updated_at = ? WHERE id IN (${placeholders})`)
            .run(jobId, iso(), ...items.map((i) => i.id));
        return { job: jobId, provider: providerKey, model: modelKey, items: items.length };
    }

    /** Claim one submitted provider batch: the claim is the database's, so two workers never share one. */
    async function claimJob() {
        const until = new Date(clock.now() + Math.max(1000, Number(settings.claimTtlMs) || 0)).toISOString();
        const at = iso();
        const row = await db.prepare(`UPDATE provider_batches SET claimed_until = ?, claimed_by = ?, updated_at = ?
            WHERE id = (
                SELECT id FROM provider_batches
                WHERE status = 'submitted' AND (claimed_until IS NULL OR claimed_until <= ?::timestamptz)
                ORDER BY submitted_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING *`).get(until, who, at, at).catch(() => null);
        return row || null;
    }

    /** Give the claim back, so another worker (or this one later) may poll this batch. */
    async function releaseJob(job) {
        await db.prepare('UPDATE provider_batches SET claimed_until = NULL, claimed_by = NULL, updated_at = ? WHERE id = ?').run(iso(), job.id);
    }

    /** One pass of the poller: take one submitted batch, ask the provider about it, settle what is ready. */
    async function pollOnce() {
        if (running) return { skipped: 'running' };
        running = true;
        try {
            // An item that was being settled when the service stopped goes back into the queue: the
            // provider's answer is still there, and the run must not wait for ever.
            await db.prepare("UPDATE batch_queue SET status = 'submitted', updated_at = ? WHERE status = 'settling' AND updated_at <= ?")
                .run(iso(), new Date(clock.now() - Math.max(1000, Number(settings.claimTtlMs) || 0)).toISOString());
            const job = await claimJob();
            if (!job) return { skipped: 'no batch' };
            const adapter = await adapterFor(job.provider);
            const state = await adapter.poll({ batchId: job.provider_batch_id });
            if (state.status === 'completed') {
                await finishJob(job, adapter, state);
                return { job: job.id, status: 'completed' };
            }
            if (state.status === 'failed' || state.status === 'expired' || state.status === 'cancelled') {
                await failJob(job, state);
                return { job: job.id, status: state.status };
            }
            // The provider is still working. When the deadline of the items has passed, the provider cannot
            // meet it: the items go back to the ordinary path, and say so.
            if (await overdue(job)) {
                await rerouteJob(job, 'the provider could not meet the deadline');
                return { job: job.id, status: 'rerouted' };
            }
            await releaseJob(job);
            return { job: job.id, status: state.status };
        } catch (err) {
            log.warn('[batch] the poller stopped early: ' + String((err && err.message) || err));
            return { error: String((err && err.code) || 'error') };
        } finally {
            running = false;
        }
    }

    /** The items of a batch whose deadline has passed while the provider was still working. */
    async function overdue(job) {
        const row = await db.prepare(`SELECT COUNT(*) AS n FROM batch_queue
            WHERE job_id = ? AND status = 'submitted' AND deadline_at <= ?::timestamptz`).get(job.id, iso());
        return Boolean(row && Number(row.n) > 0);
    }

    /** The provider answered: every item is written onto its run and the run finishes on the ordinary path. */
    async function finishJob(job, adapter, state) {
        const items = await db.prepare(`SELECT * FROM batch_queue WHERE job_id = ? AND status = 'submitted' ORDER BY created_at`).all(job.id);
        const results = [];
        if (state.outputFileId) {
            const text = await adapter.download({ fileId: state.outputFileId });
            for (const row of adapter.parseResults(text, { raw: state.raw })) results.push(row);
        }
        // The provider's error file: the requests it refused. A partial failure is a failure of that one
        // item only: the other answers are still written onto their runs.
        if (state.errorFileId) {
            const text = await adapter.download({ fileId: state.errorFileId });
            for (const row of adapter.parseResults(text, { raw: state.raw })) results.push(row);
        }
        const byId = new Map();
        for (const row of results) byId.set(String(row.custom_id), row);
        for (const item of items || []) {
            const res = byId.get(String(item.id)) || null;
            await settleItem(item, res);
        }
        await db.prepare(`UPDATE provider_batches SET status = 'completed', finished_at = ?, updated_at = ?, claimed_until = NULL, claimed_by = NULL WHERE id = ?`)
            .run(iso(), iso(), job.id);
    }

    /** The provider gave up on the batch: every item fails, and the customer is charged nothing. */
    async function failJob(job, state) {
        const items = await db.prepare(`SELECT * FROM batch_queue WHERE job_id = ? AND status = 'submitted'`).all(job.id);
        for (const item of items || []) {
            await settleItem(item, { ok: false, error: { code: 'batch.provider_failed', detail: 'the provider did not answer this request' } });
        }
        await db.prepare(`UPDATE provider_batches SET status = 'failed', error_code = ?, error_detail = ?, finished_at = ?, updated_at = ?, claimed_until = NULL, claimed_by = NULL WHERE id = ?`)
            .run(String(state.status || 'failed').slice(0, 40), 'the provider did not finish the batch', iso(), iso(), job.id);
    }

    /**
     * Write one answer onto its run and fire the run's normal completion.
     *
     * The cost written on the run is the provider's BATCH price (its list price times its own batch
     * discount), because that is what the provider really charged for the tier it really ran on.
     */
    async function settleItem(item, res) {
        // Only an item that is still waiting is settled: two pollers can never settle the same one.
        const claimed = await db.prepare(`UPDATE batch_queue SET status = 'settling', updated_at = ? WHERE id = ? AND status = 'submitted' RETURNING id`)
            .get(iso(), item.id).catch(() => null);
        if (!claimed) return false;
        const cards = await cardsFor(item.provider, item.model);
        // The plan the item was queued with: what a restarted service needs to finish this run.
        const plan = item.plan ? JSON.parse(item.plan) : {};
        const usage = (res && res.ok && res.usage) || { input: 0, output: 0, cached: 0, cache_write: 0 };
        const net = Math.max(0, Number(usage.input || 0) - Number(usage.cached || 0) - Number(usage.cache_write || 0));
        const nano = cards && cards.batch
            ? retailChargeNano(cards.batch, { input: net, cached: Number(usage.cached || 0), cacheWrite: Number(usage.cache_write || 0), output: Number(usage.output || 0) })
            : 0n;
        const costUsd = Number(nano) / Number(NANO_PER_USD);
        if (res && res.ok) {
            await runs.completeBatch(item.run_id, {
                ok: true,
                output: res.output || { text: '' },
                usage: { input: Number(usage.input || 0), output: Number(usage.output || 0), cached: Number(usage.cached || 0), cache_write: Number(usage.cache_write || 0) },
                cost: costUsd,
                provider: item.provider,
                model: item.model,
                holdRetail: item.hold_card ? JSON.parse(item.hold_card) : (cards ? cards.retail : null),
                access: cards ? cards.access : 'UNVERIFIED',
                explain: { objective: 'batch', reasons: [`answered by the provider's own batch API (${item.provider})`], selected: `batch:${item.provider}`, candidates: [], attempts: [] },
                serviceTier: 'batch',
                maxTokens: plan.maxTokens || 4096,
            }, { plan, costCheck: await checkFor(item, plan) });
            await db.prepare(`UPDATE batch_queue SET status = 'succeeded', answer = ?, usage = ?, cost_nano_usd = ?, updated_at = ? WHERE id = ?`)
                .run(String((res.output && res.output.text) || '').slice(0, 20000), JSON.stringify(usage), String(nano), iso(), item.id);
        } else {
            const err = (res && res.error) || { code: 'batch.no_answer', detail: 'the provider did not answer this request' };
            await runs.completeBatch(item.run_id, { ok: false, error: { code: String(err.code || 'batch.item_failed').slice(0, 80), detail: String(err.detail || '').slice(0, 400) } }, { plan });
            await db.prepare(`UPDATE batch_queue SET status = 'failed', error_code = ?, error_detail = ?, updated_at = ? WHERE id = ?`)
                .run(String(err.code || 'batch.item_failed').slice(0, 80), String(err.detail || '').slice(0, 400), iso(), item.id);
        }
        await writeBack(item);
        return true;
    }

    /**
     * The deadline passed and the provider cannot meet it: the item goes back to the ordinary path. The
     * run answers through the pool as any other run does, and the item says it was re-routed.
     */
    async function rerouteJob(job, reason) {
        const items = await db.prepare(`SELECT * FROM batch_queue WHERE job_id = ? AND status = 'submitted'`).all(job.id);
        for (const item of items || []) {
            const claimed = await db.prepare(`UPDATE batch_queue SET status = 'settling', updated_at = ? WHERE id = ? AND status = 'submitted' RETURNING id`)
                .get(iso(), item.id).catch(() => null);
            if (!claimed) continue;
            await runs.completeBatch(item.run_id, { reroute: true }, { plan: item.plan ? JSON.parse(item.plan) : {} });
            await db.prepare(`UPDATE batch_queue SET status = 'rerouted', error_code = 'batch.rerouted', error_detail = ?, updated_at = ? WHERE id = ?`)
                .run(String(reason || '').slice(0, 300), iso(), item.id);
            await writeBack(item);
        }
        await db.prepare(`UPDATE provider_batches SET status = 'expired', error_code = 'batch.rerouted', error_detail = ?, finished_at = ?, updated_at = ?, claimed_until = NULL, claimed_by = NULL WHERE id = ?`)
            .run(String(reason || '').slice(0, 300), iso(), iso(), job.id);
    }

    /**
     * The settle check of a customer item, rebuilt after a restart: the batch service knows the rule (the
     * route's own price against what the customer paid, and the loss budget), and the item's row and the
     * plan carry what the rule needs.
     */
    async function checkFor(item, plan) {
        if (!service || !plan.route || !plan.charge || !item.batch_id) return null;
        const batch = await db.prepare('SELECT * FROM batches WHERE id = ?').get(item.batch_id).catch(() => null);
        if (!batch) return null;
        const row = await db.prepare('SELECT * FROM batch_items WHERE batch_id = ? AND idx = ?').get(item.batch_id, item.idx).catch(() => null);
        if (!row) return null;
        return service.settleCheckFor({ item: row, route: plan.route, charge: plan.charge, batch });
    }

    /** Write the item's outcome back onto the customer's batch item, and close the batch when it is done. */
    async function writeBack(item) {
        if (!item.batch_id || item.idx == null) return;
        const row = await db.prepare(`SELECT status, answer, usage, cost_nano_usd, error_code, error_detail FROM batch_queue WHERE id = ?`).get(item.id);
        if (!row) return;
        const status = row.status === 'succeeded' ? 'succeeded' : (row.status === 'rerouted' ? 'waiting' : 'failed');
        await db.prepare(`UPDATE batch_items SET status = ?, run_id = ?, answer = ?, cost_nano_usd = ?, charged_nano_usd = ?, error_code = ?, error_detail = ?,
            capacity = CASE WHEN ? = 'rerouted' THEN 'rerouted' ELSE capacity END, claimed_until = NULL, claimed_by = NULL, updated_at = ?
            WHERE batch_id = ? AND idx = ?`)
            .run(status, item.run_id || null, row.answer || null, row.cost_nano_usd || '0', row.cost_nano_usd || '0',
                row.error_code || null, row.error_detail || null, row.status, iso(), item.batch_id, item.idx);
        if (service && typeof service.finishBatch === 'function') {
            const batch = await db.prepare('SELECT * FROM batches WHERE id = ?').get(item.batch_id).catch(() => null);
            if (batch) await service.finishBatch(batch);
        }
    }

    /** One pass of the whole worker: submit what is ready, then settle what the provider answered. */
    async function runOnce() {
        const submitted = await submitOnce();
        const polled = await pollOnce();
        return { submitted, polled };
    }

    function start() {
        if (timer) return timer;
        const every = Math.max(5000, Number(settings.pollMs) || 60000);
        timer = setInterval(() => { runOnce().catch(() => {}); }, every);
        timer.unref?.();
        return timer;
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    /** The batch service, so that a customer's batch is closed when its items are done. */
    function attach(theService) { service = theService; return api; }

    const api = { enqueue, submitOnce, pollOnce, runOnce, start, stop, settings, cardsFor, scaleCard, attach };
    return api;
}

module.exports = { createBatcher, scaleCard, toCard, ADAPTERS };
