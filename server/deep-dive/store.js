'use strict';
/**
 * The deep dive's durable state and its 7-day capture cache (migrations/0079_deep_dives.sql).
 *
 * The run row is the record; this row is what the page reads while the run is still working: the steps and their
 * status, the candidates after Choosing, the decision that release them to Capture, the captures as they land and
 * the final report. Every write is small and immediate, so a deploy that interrupts a run leaves a page that says
 * what happened rather than one that spins. capture_cache is per URL, viewport and theme (and whether the Expert
 * extras were taken): the same page at the same size is never photographed twice inside seven days.
 */
const crypto = require('crypto');

const iso = (v) => (v ? new Date(v).toISOString() : null);
const parse = (v, d) => { try { return v == null ? d : (typeof v === 'string' ? JSON.parse(v) : v); } catch { return d; } };
const key = (url, viewport, theme, extras) => crypto.createHash('sha256').update(`${url}|${viewport}|${theme}|${extras ? 1 : 0}`).digest('hex');

function createDeepDiveStore({ db, clock = { now: () => Date.now() }, log = console } = {}) {
    const getRow = async (id) => await db.prepare('SELECT * FROM deep_dives WHERE id = ?').get(String(id));

    function decode(r) {
        if (!r) return null;
        return {
            id: r.id, run_id: r.run_id, owner: r.owner_type ? { type: r.owner_type, id: r.owner_id } : null,
            status: r.status, step: r.step, progress: Number(r.progress) || 0,
            question: r.question, depth: r.depth, site_limit: r.site_limit, price_usd: Number(r.price_usd) || 0,
            steps: parse(r.steps, []), candidates: parse(r.candidates, []), decision_at: iso(r.decision_at),
            captures: parse(r.captures, []), report: parse(r.report, null), gaps: parse(r.gaps, []),
            error: r.error_code ? { code: r.error_code, detail: r.error_detail } : null,
            created_at: iso(r.created_at), updated_at: iso(r.updated_at), finished_at: iso(r.finished_at),
        };
    }

    async function ensure({ runId, question, depth, siteLimit, priceUsd, owner = null }) {
        const now = iso(clock.now());
        await db.prepare(`INSERT INTO deep_dives (id, run_id, owner_type, owner_id, status, step, progress, question, depth, site_limit, price_usd, steps, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'queued', 'plan', 0, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`)
            .run(runId, runId, owner && owner.type || null, owner && owner.id || null, String(question).slice(0, 500), depth, siteLimit, priceUsd, JSON.stringify([]), now, now);
        return decode(await getRow(runId));
    }

    async function get(id) { return decode(await getRow(id)); }

    async function patch(id, fields) {
        const cols = { status: 'status', step: 'step', progress: 'progress', steps: 'steps', candidates: 'candidates', decision_at: 'decision_at', captures: 'captures', report: 'report', gaps: 'gaps', error_code: 'error_code', error_detail: 'error_detail', finished_at: 'finished_at' };
        const sets = []; const args = [];
        for (const [k, v] of Object.entries(fields || {})) {
            if (!cols[k]) continue;
            sets.push(`${cols[k]} = ?`);
            args.push(v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
        }
        if (!sets.length) return get(id);
        sets.push('updated_at = ?'); args.push(iso(clock.now()));
        await db.prepare(`UPDATE deep_dives SET ${sets.join(', ')} WHERE id = ?`).run(...args, String(id));
        return get(id);
    }

    /** Set one step's status and the overall progress; returns the updated row. */
    async function setStep(id, key, status, { progress = null, detail = null, startedAt = null, finishedAt = null } = {}) {
        const row = await get(id);
        if (!row) return null;
        const steps = (row.steps || []).map((s) => ({ ...s }));
        if (!steps.length) for (const k of ['plan', 'search', 'choose', 'capture', 'analyse', 'synthesise', 'report']) steps.push({ key: k, status: 'pending', detail: null, started_at: null, finished_at: null });
        const s = steps.find((x) => x.key === key);
        if (s) {
            s.status = status;
            if (detail != null) s.detail = String(detail).slice(0, 300);
            if (startedAt) s.started_at = startedAt;
            if (finishedAt) s.finished_at = finishedAt;
            if (status === 'running' && !s.started_at) s.started_at = iso(clock.now());
            if ((status === 'done' || status === 'failed' || status === 'skipped') && !s.finished_at) s.finished_at = iso(clock.now());
        }
        return patch(id, { steps, ...(progress != null ? { progress } : {}), step: key });
    }

    async function cacheGet(url, viewport, theme, extras) {
        const k = key(url, viewport, theme, extras);
        const row = await db.prepare('SELECT * FROM capture_cache WHERE key = ? AND expires_at > ?').get(k, iso(clock.now()));
        if (!row) return null;
        return { ...parse(row.result, null), cached: true, captured_at: iso(row.captured_at) };
    }

    async function cachePut(url, viewport, theme, extras, result, days = 7) {
        if (!(Number(days) > 0) || !result || !result.media_id) return;
        const now = clock.now();
        const at = result.captured_at || iso(now);
        const expires = iso(now + Number(days) * 86400000);
        const k = key(url, viewport, theme, extras);
        await db.prepare(`INSERT INTO capture_cache (key, url, viewport, theme, extras, result, captured_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET result = EXCLUDED.result, captured_at = EXCLUDED.captured_at, expires_at = EXCLUDED.expires_at`)
            .run(k, url, viewport, theme, extras ? 1 : 0, JSON.stringify(result), at, expires).catch((err) => log.warn(`[deep-dive] cache write failed: ${err.message}`));
    }

    async function pruneCache() {
        await db.prepare('DELETE FROM capture_cache WHERE expires_at <= ?').run(iso(clock.now())).catch(() => {});
    }

    return { ensure, get, patch, setStep, cacheGet, cachePut, pruneCache, key };
}

module.exports = { createDeepDiveStore };
