'use strict';
/**
 * The search circuit breaker (plan §W.2 step 3, 11-13).
 *
 * When an engine fails, the breaker opens for that engine and the next searches skip it instead of paying for
 * another failure. The state lives in Valkey when the service has one, so every process sees the same open
 * circuit: the key is `search:circuit:<scope>:<engine>`, the value is the time the circuit opens again and the
 * TTL is that same time, so an open circuit disappears on its own.
 *
 * The scope says whose key failed: `shared` for a key the service holds, `k:<hash>` for a person's own key.
 * Without Valkey (tests, a small install) the breaker is a Map in this process.
 */
const OPEN_MS = 60000;

function createCircuit({ valkey = null, now = () => Date.now(), openMs = OPEN_MS } = {}) {
    const local = new Map();
    const key = (scope, engine) => (valkey ? valkey.key('search', 'circuit', scope, engine) : 'search:circuit:' + scope + ':' + engine);
    const localKey = (scope, engine) => scope + '\u0000' + engine;
    // Valkey unreachable: the breaker fails open (the search still runs). A broken store must not stop the service.
    async function openUntil(scope, engine) {
        if (valkey) {
            try {
                const v = await valkey.client.get(key(scope, engine));
                return v ? Number(v) || 0 : 0;
            } catch { return 0; }
        }
        const until = local.get(localKey(scope, engine)) || 0;
        return until > now() ? until : 0;
    }
    /** Open the circuit for this engine until `until` (epoch ms). */
    async function trip(scope, engine, until) {
        const stop = until || now() + openMs;
        if (valkey) {
            try {
                const seconds = Math.max(1, Math.ceil((stop - now()) / 1000));
                await valkey.client.set(key(scope, engine), String(stop), 'EX', seconds);
            } catch { /* the breaker fails open */ }
            return;
        }
        local.set(localKey(scope, engine), stop);
        if (local.size > 1000) local.delete(local.keys().next().value);
    }
    /** The engine answered: the circuit closes. */
    async function clear(scope, engine) {
        if (valkey) {
            try { await valkey.client.del(key(scope, engine)); } catch { /* the breaker fails open */ }
            return;
        }
        local.delete(localKey(scope, engine));
    }
    return { openUntil, trip, clear };
}

module.exports = { createCircuit, OPEN_MS };
