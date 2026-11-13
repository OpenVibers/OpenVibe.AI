'use strict';
/**
 * The video analysis' durable state (migrations/0088_video_analyses.sql).
 *
 * The run row keeps the input, the output and the receipt; this row is what a page reads while the run
 * is still working: the steps and their status, the frames as they land (with the Media object each
 * JPEG was kept in), and the finished report. Every write is small and immediate, so a deploy that
 * interrupts a run leaves a page that says what happened rather than one that spins.
 */
const iso = (v) => (v ? new Date(v).toISOString() : null);
const parse = (v, d) => { try { return v == null ? d : (typeof v === 'string' ? JSON.parse(v) : v); } catch { return d; } };

function createVideoAnalysisStore({ db, clock = { now: () => Date.now() }, log = console } = {}) {
    const getRow = async (id) => await db.prepare('SELECT * FROM video_analyses WHERE id = ?').get(String(id));

    function decode(r) {
        if (!r) return null;
        return {
            id: r.id, run_id: r.run_id, owner: r.owner_type ? { type: r.owner_type, id: r.owner_id } : null,
            status: r.status, step: r.step, progress: Number(r.progress) || 0,
            media_id: r.media_id, depth: r.depth, input: parse(r.input, {}),
            steps: parse(r.steps, []), frames: parse(r.frames, []), report: parse(r.report, null), gaps: parse(r.gaps, []),
            error: r.error_code ? { code: r.error_code, detail: r.error_detail } : null,
            created_at: iso(r.created_at), updated_at: iso(r.updated_at), finished_at: iso(r.finished_at),
        };
    }

    async function ensure({ runId, input = {}, depth = 'standard', mediaId = null, owner = null }) {
        const now = iso(clock.now());
        await db.prepare(`INSERT INTO video_analyses (id, run_id, owner_type, owner_id, status, step, progress, media_id, depth, input, steps, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'queued', 'probe', 0, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`)
            .run(runId, runId, owner && owner.type || null, owner && owner.id || null, mediaId, depth, JSON.stringify(input), JSON.stringify([]), now, now);
        return decode(await getRow(runId));
    }

    async function get(id) { return decode(await getRow(id)); }

    async function patch(id, fields) {
        const cols = { status: 'status', step: 'step', progress: 'progress', steps: 'steps', frames: 'frames', report: 'report', gaps: 'gaps', error_code: 'error_code', error_detail: 'error_detail', finished_at: 'finished_at', media_id: 'media_id' };
        const sets = []; const args = [];
        for (const [k, v] of Object.entries(fields || {})) {
            if (!cols[k]) continue;
            sets.push(cols[k] + ' = ?');
            args.push(v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
        }
        if (!sets.length) return get(id);
        sets.push('updated_at = ?'); args.push(iso(clock.now()));
        await db.prepare('UPDATE video_analyses SET ' + sets.join(', ') + ' WHERE id = ?').run(...args, String(id));
        return get(id);
    }

    /** The step list, with the keys that have not run yet. */
    function stepsWith(row, updates = {}, keys = []) {
        const base = (row.steps && row.steps.length ? row.steps : keys.map((key) => ({ key, status: 'pending' }))).map((s) => ({ ...s }));
        return base.map((s) => ({ ...s, ...(updates[s.key] || {}) }));
    }

    return { ensure, get, patch, stepsWith, decode };
}

module.exports = { createVideoAnalysisStore };
