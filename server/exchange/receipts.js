'use strict';
/**
 * The receipt of an answered request (the plan of 2026-11-06: "Every answer carries a receipt").
 *
 * A receipt says, in one place:
 *
 *   the offer that answered (provider, model, deployment, its commercial access),
 *   the price it charged (in, out and cached per million tokens, and where that price came from),
 *   the tokens (in, out, the cache read and the cache write) and the latency,
 *   why the router chose it, and the fallbacks it would have used,
 *   who paid (the OpenVibe key, the person's own key at 0 %, their plan, a community offer),
 *   the privacy label of the answer (private, anonymized or community).
 *
 * It never carries the prompt or the answer. It is written once per answered run, kept with the usage
 * (the same retention window), and read by GET /v1/receipts/:id. The same receipt is in the response
 * headers (x-openvibe-receipt, compact) and in the run's own record.
 */
const { parseJson } = require('../util');

/** The receipt of a run: the same answer always has the same receipt id, so a stream can name it early. */
const receiptId = (runId) => `rcpt_${String(runId || '').replace(/^run_/, '')}`;

const round = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 1e6) / 1e6);
const int = (v) => Math.max(0, Math.round(Number(v) || 0));

/**
 * One receipt, from the parts of a finished run.
 *
 *   run        the run row (id, workflow, route, tokens, cost)
 *   explain    the router's explain (why it chose the offer, the candidates, the attempts)
 *   usage      the tokens of the call (input, output, cached, cache_write, reasoning)
 *   price      the prices of the answering offer (in, out, cached per million tokens, and their source)
 *   privacy    the privacy label of the answer (server/exchange/privacy.js)
 *   payer      who paid: { paid_by, detail, fee_rate }
 *   preset     the preset the request named, when it named one
 */
function buildReceipt({ run, explain = null, usage = {}, price = null, privacy = null, payer = null, preset = null, latencyMs = null, ttftMs = null, provider = null, model = null, createdAt = null }) {
    const x = explain || {};
    const attempts = Array.isArray(x.attempts) ? x.attempts : [];
    const ok = attempts.find((a) => a && (a.status === 'ok' || a.status === 'succeeded')) || null;
    const ranked = Array.isArray(x.ranked) ? x.ranked : [];
    const chosen = ok ? `${ok.provider}${ok.model ? `/${ok.model}` : ''}` : (x.selected || null);
    // Why the router chose it: the reason it recorded for the attempt, then the route's own reasons.
    const why = [];
    if (ok && ok.why) why.push(String(ok.why));
    for (const r of (Array.isArray(x.reasons) ? x.reasons : [])) if (why.length < 4 && !why.includes(r)) why.push(String(r));
    // The fallbacks it would have used: the offers it ranked after the one that answered, and the ones it
    // skipped (each with the rule that removed it).
    const fallbacks = [];
    for (const r of ranked) {
        const id = `${r.provider}${r.model ? `/${r.model}` : ''}`;
        if (id === chosen) continue;
        if (fallbacks.some((f) => f.offer === id)) continue;
        fallbacks.push({ offer: id, provider: r.provider, model: r.model || null, why: r.why || null, status: 'ready' });
    }
    for (const a of attempts) {
        if (!a || a.status === 'ok' || a.status === 'succeeded') continue;
        const id = `${a.provider || '?'}${a.model ? `/${a.model}` : ''}`;
        const known = fallbacks.find((f) => f.offer === id);
        if (known) { known.status = a.status; known.reason = a.error || null; continue; }
        fallbacks.push({ offer: id, provider: a.provider || null, model: a.model || null, why: a.why || null, status: a.status || 'skipped', reason: a.error || null });
    }
    // The offers a rule of the preset removed (over the cap, over the ceiling, the wrong region, a community
    // machine the profile does not want): they were not used, and the receipt says which rule removed each.
    for (const c of (Array.isArray(x.candidates) ? x.candidates : [])) {
        if (!c || c.eligible !== false || !c.provider) continue;
        const id = `${c.provider}${c.model ? `/${c.model}` : ''}`;
        const known = fallbacks.find((f) => f.offer === id);
        if (known) { known.reason = c.excluded_reason || known.reason; continue; }
        fallbacks.push({ offer: id, provider: c.provider, model: c.model || null, why: null, status: 'excluded', reason: c.excluded_reason || null });
    }
    const tokens = {
        tokens_in: int(usage.input),
        tokens_out: int(usage.output),
        tokens_cached: int(usage.cached),
        tokens_cache_write: int(usage.cache_write),
        tokens_reasoning: int(usage.reasoning),
        // Speech (ai.speak) is metered per character, like the providers bill: the same count the
        // rate cards priced. Other runs carry no character count and omit the field.
        ...(int(usage.characters) > 0 ? { characters: int(usage.characters) } : {}),
    };
    const paidBy = (payer && payer.paid_by) || 'openvibe_key';
    const byok = paidBy === 'own_key' || paidBy === 'own_machine';
    return {
        ...require('../effort/receipt').receiptEffort(run, explain),
        ...(parseJson(run.options, {}).effort_policy?.kind ? { kind: parseJson(run.options, {}).effort_policy.kind } : {}),
        ...(x.advisor ? { advisor: x.advisor } : {}),
        id: receiptId(run.id),
        run_id: run.id,
        created_at: createdAt || new Date().toISOString(),
        workflow: run.workflow_key || null,
        route: { key: run.route_key || null, version: run.route_version == null ? null : Number(run.route_version) },
        preset: preset ? { name: preset.name, scope: preset.scope || 'owner', policy: preset.policy || {} } : null,
        offer: {
            provider: provider || (ok && ok.provider) || run.provider_key || null,
            model: model || (ok && ok.model) || run.model_key || null,
            deployment: (provider || (ok && ok.provider) || run.provider_key) || null,
            provider_access: (x.openvibe && x.openvibe.provider_access) || null,
            resolved_model: (x.openvibe && x.openvibe.resolved_model) || null,
            // The host's own model answered (local / local2): the receipt says so, beside the provider name.
            local: Boolean(x.provider_local),
            // A community answer says which kind of community source it was: a person's machine or a registered endpoint.
            community: (x.openvibe && x.openvibe.community && x.openvibe.community.kind) || null,
        },
        price: {
            in_per_mtok: round(price && price.in),
            out_per_mtok: round(price && price.out),
            cached_per_mtok: round(price && price.cached),
            source: (price && price.source) || null,
        },
        usage: tokens,
        cost_usd: round(run.cost_usd),
        fee_usd: round(payer && payer.fee_usd),
        fee_rate: payer && payer.fee_rate != null ? Number(payer.fee_rate) : 0,
        paid_by: paidBy,
        paid_by_detail: (payer && payer.detail) || null,
        byok,
        latency_ms: latencyMs == null ? null : int(latencyMs),
        ttft_ms: ttftMs == null ? null : int(ttftMs),
        why,
        fallbacks,
        privacy: privacy || null,
        attempts: attempts.length,
    };
}

/** The receipt as it travels in a header: the same facts, in fewer bytes. */
function compact(receipt) {
    if (!receipt) return null;
    const offer = receipt.offer || {};
    return {
        id: receipt.id,
        run_id: receipt.run_id,
        offer: offer.provider ? `${offer.provider}${offer.model ? `/${offer.model}` : ''}` : null,
        local: Boolean(offer.local),
        community: offer.community || null,
        price: { in: receipt.price && receipt.price.in_per_mtok, out: receipt.price && receipt.price.out_per_mtok, cached: receipt.price && receipt.price.cached_per_mtok },
        tokens: { in: receipt.usage && receipt.usage.tokens_in, out: receipt.usage && receipt.usage.tokens_out, cached: receipt.usage && receipt.usage.tokens_cached,
            ...(receipt.usage && receipt.usage.characters ? { characters: receipt.usage.characters } : {}) },
        cost_usd: receipt.cost_usd,
        fee_usd: receipt.fee_usd,
        fee_rate: receipt.fee_rate,
        paid_by: receipt.paid_by,
        byok: Boolean(receipt.byok),
        latency_ms: receipt.latency_ms,
        why: receipt.why || [],
        fallbacks: (receipt.fallbacks || []).map((f) => f.offer),
        privacy: receipt.privacy ? receipt.privacy.label : null,
        preset: receipt.preset ? receipt.preset.name : null,
        advisor: receipt.advisor ? { count: receipt.advisor.count, cost_usd: receipt.advisor.cost_usd } : null,
    };
}

function createReceipts({ db, clock = { now: () => Date.now() }, log = console } = {}) {
    const insert = db.prepare(`INSERT INTO ai_receipts (id, run_id, requester_type, requester_id, owner_type, owner_id, body, created_at)
        VALUES (@id, @run_id, @requester_type, @requester_id, @owner_type, @owner_id, @body, @created_at)
        ON CONFLICT(id) DO UPDATE SET body = excluded.body`);
    const byId = db.prepare('SELECT * FROM ai_receipts WHERE id = ?');
    const byRun = db.prepare('SELECT * FROM ai_receipts WHERE run_id = ?');
    const setRun = db.prepare('UPDATE runs SET receipt_id = ? WHERE id = ?');

    const decode = (row) => (row ? {
        ...((row.body && typeof row.body === 'object') ? row.body : parseJson(row.body, {})),
        id: row.id, run_id: row.run_id, created_at: row.created_at,
        requester: row.requester_type ? { type: row.requester_type, id: row.requester_id } : null,
        owner: row.owner_type ? { type: row.owner_type, id: row.owner_id } : null,
    } : null);

    /** Write (or replace) the receipt of a run. */
    async function record(receipt, { requester = null, owner = null } = {}) {
        if (!receipt || !receipt.id) return null;
        await insert.run({
            id: receipt.id, run_id: receipt.run_id || null,
            requester_type: requester ? requester.type : null, requester_id: requester ? requester.id : null,
            owner_type: owner ? owner.type : null, owner_id: owner ? owner.id : null,
            body: JSON.stringify(receipt), created_at: receipt.created_at || new Date(clock.now()).toISOString(),
        });
        if (receipt.run_id) await setRun.run(receipt.id, receipt.run_id);
        return receipt;
    }

    async function get(id) {
        const row = await byId.get(String(id || ''));
        return decode(row);
    }

    async function forRun(runId) {
        const row = await byRun.get(String(runId || ''));
        return decode(row);
    }

    /** The receipts older than the retention window go with the runs they belong to. */
    async function prune(days = 30, now = clock.now()) {
        const cutoff = new Date(now - days * 86400000).toISOString();
        const old = (await db.prepare('SELECT id FROM ai_receipts WHERE created_at < ?').all(cutoff)).map((r) => r.id);
        for (const id of old) await db.prepare('DELETE FROM ai_receipts WHERE id = ?').run(id);
        return old.length;
    }

    return { record, get, forRun, prune };
}

module.exports = { createReceipts, buildReceipt, compact, receiptId };
