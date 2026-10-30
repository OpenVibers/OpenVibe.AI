'use strict';
/**
 * The background loop behind Memory M2c: the store's own maintenance, owner by owner, with a per-run cap.
 *
 * A run, for one owner and one scope:
 *   1. the items that have no embedding yet get one (the platform's own budget);
 *   2. the pairs that say the same thing become one item, and the pairs that are near each other but disagree are
 *      marked, with at most `modelCalls` cheap-tier judgements in the whole run;
 *   3. the profile of the scope is rebuilt when its items moved and its cache is at least an hour old.
 *
 * The loop stays off in test mode (NODE_ENV=test, the way the JWKS client is) and off while a provider is in a
 * drill (the stub's fail/timeout modes), so a drill never spends the platform's budget. It never writes a note:
 * the log carries counts and error codes only, never text.
 */

const DEFAULT_CAPS = { owners: 10, scopes: 4, embeddings: 100, modelCalls: 20, profiles: 10 };
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

function createMemoryJobs({ memory, config = {}, clock = { now: () => Date.now() }, log = console, registry = null }) {
    const settings = config.memoryJobs || {};
    const caps = {
        owners: Math.max(1, Number(settings.maxOwners) || DEFAULT_CAPS.owners),
        scopes: Math.max(1, Number(settings.maxScopesPerOwner) || DEFAULT_CAPS.scopes),
        embeddings: Math.max(0, Number(settings.maxEmbeddings) || DEFAULT_CAPS.embeddings),
        modelCalls: Math.max(0, Number(settings.maxModelCalls) || DEFAULT_CAPS.modelCalls),
        profiles: Math.max(0, Number(settings.maxProfiles) || DEFAULT_CAPS.profiles),
    };
    let timer = null;
    let running = false;

    /** A provider in a drill must not spend the platform's budget: the run waits for the drill to end. */
    async function drillActive() {
        if (!registry) return false;
        const providers = await registry.listProviders();
        return providers.some((p) => p && p.metadata && (p.metadata.fail || p.metadata.drill));
    }

    /**
     * One run of the loop. It never throws: a failure is counted and the loop goes on to the next owner.
     */
    async function runOnce() {
        if (running) return { skipped: 'running' };
        if (settings.enabled === false) return { skipped: 'disabled' };
        running = true;
        const out = { owners: 0, scopes: 0, embeddings: 0, merged: 0, conflicts: 0, calls: 0, profiles: 0, error: null };
        try {
            if (await drillActive()) return { skipped: 'drill' };
            const owners = await memory.ownersForJobs(caps.owners);
            for (const owner of owners) {
                const who = owner.owner;
                out.owners++;
                const scopes = await memory.scopesFor(who, caps.scopes);
                for (const scope of scopes) {
                    out.scopes++;
                    out.embeddings += await memory.embedMissing(who, scope, caps.embeddings);
                    const settled = await memory.reconcileScope(who, scope, { maxModelCalls: caps.modelCalls - out.calls });
                    out.merged += settled.merged;
                    out.conflicts += settled.conflicts;
                    out.calls += settled.calls;
                    if (out.profiles < caps.profiles) {
                        const profile = await memory.refreshProfile(who, scope);
                        if (profile && profile.rebuilt) out.profiles++;
                    }
                }
            }
        } catch (err) {
            // The error carries a code, never a note: the log must never hold a person's text.
            out.error = err && err.code ? err.code : 'error';
            log.warn(`[memory] the job stopped early: ${out.error}`);
        } finally { running = false; }
        return out;
    }

    function start() {
        if (timer) return timer;
        const every = Math.max(60000, Number(settings.intervalMs) || DEFAULT_INTERVAL_MS);
        timer = setInterval(() => { runOnce().catch(() => {}); }, every);
        timer.unref?.();
        return timer;
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    return { start, stop, runOnce, caps };
}

module.exports = { createMemoryJobs, DEFAULT_CAPS };
