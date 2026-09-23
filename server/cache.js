'use strict';
/**
 * The run cache. A cached output is only ever served to a request with the same scope:
 *
 *   private  requester principal + on_behalf_of actor + target + attribution   (the default)
 *   service  requester principal only — for workflows whose inputs are public text and whose
 *            outputs are the same for every user of that service (translation of a public chat
 *            line, footer copy). Still never shared across services.
 *   none     never cached
 *
 * The scope is part of the hashed key AND stored beside it, and get() compares both, so an entry
 * written for actor A cannot be read by actor B even on a hash collision. The key also covers the
 * workflow, template and route versions and the input hash, so any new version misses cleanly.
 * Synthetic (stub) outputs are never cached.
 */
const { sha256, iso, parseJson } = require('./util');

function createCache(db, { clock = { now: () => Date.now() } } = {}) {
    function scopeFor(mode, ctx) {
        if (mode === 'none') return null;
        const req = `${ctx.requesterType}:${ctx.requesterId}`;
        if (mode === 'service') return `service|${req}`;
        return `private|${req}|actor:${ctx.actorKey || '-'}|target:${ctx.targetKey || '-'}|attr:${ctx.attributionKey || '-'}`;
    }

    function keyFor({ scope, workflowKey, workflowVersion, templateVersion, routeKey, routeVersion, inputHash }) {
        return sha256({ scope, w: workflowKey, wv: workflowVersion, tv: templateVersion || null, r: routeKey || null, rv: routeVersion || null, i: inputHash });
    }

    function get(key, scope) {
        const row = db.prepare('SELECT * FROM cache_entries WHERE cache_key = ?').get(key);
        if (!row) return null;
        if (row.scope !== scope) return null;                 // belt and braces: never cross scope
        if (row.expires_at <= clock.now()) { db.prepare('DELETE FROM cache_entries WHERE cache_key = ?').run(key); return null; }
        db.prepare('UPDATE cache_entries SET hits = hits + 1 WHERE cache_key = ?').run(key);
        return { ...row, output: parseJson(row.output, null) };
    }

    function put({ key, scope, privacy, workflowKey, workflowVersion, templateVersion, routeKey, routeVersion, model, inputHash, output, runId, ttlSec }) {
        db.prepare(`INSERT INTO cache_entries (cache_key, scope, workflow_key, workflow_version, template_version, route_key, route_version, model_key, input_hash, privacy, output, run_id, hits, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET output = excluded.output, run_id = excluded.run_id, model_key = excluded.model_key, created_at = excluded.created_at, expires_at = excluded.expires_at`)
            .run(key, scope, workflowKey, workflowVersion, templateVersion || null, routeKey || null, routeVersion || null, model || null, inputHash, privacy,
                JSON.stringify(output), runId, iso(clock.now()), clock.now() + ttlSec * 1000);
    }

    function stats() {
        return db.prepare('SELECT workflow_key, privacy, COUNT(*) AS entries, SUM(hits) AS hits FROM cache_entries WHERE expires_at > ? GROUP BY workflow_key, privacy ORDER BY entries DESC').all(clock.now());
    }

    function purge({ workflow } = {}) {
        const r = workflow ? db.prepare('DELETE FROM cache_entries WHERE workflow_key = ?').run(workflow) : db.prepare('DELETE FROM cache_entries').run();
        return r.changes;
    }

    function prune() { return db.prepare('DELETE FROM cache_entries WHERE expires_at <= ?').run(clock.now()).changes; }

    return { scopeFor, keyFor, get, put, stats, purge, prune };
}

module.exports = { createCache };
