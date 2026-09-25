'use strict';
/**
 * OpenVibe.AI entry point.
 *
 *   node server/index.js            (systemd: openvibe-ai.service)
 *
 * start() is also what the tests use: it takes a config (server/config.js load()) plus injectable
 * clock/fetch/env/log, and returns handles to every part so they can be driven directly.
 */
const { load } = require('./config');
const { openDb } = require('./db');
const { createRegistry } = require('./registry');
const { createProviderPool } = require('./providers');
const { createFetcher } = require('./fetcher');
const { createEngine } = require('./workflows/engine');
const { createCache } = require('./cache');
const { createQuotas } = require('./quota');
const { createRuns } = require('./runs');
const { seed } = require('./workflows/seed');
const { createKeyStore, createAuth } = require('./auth');
const schemas = require('./schemas');
const { createApp } = require('./app');

async function start({ config, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, env = process.env, log = console, listen = true } = {}) {
    config = config || load(env);
    schemas.configure(config.schemaCache);
    const db = openDb(config.dbPath);
    const registry = createRegistry(db, { clock, env });
    const quotas = createQuotas(db, { clock, registry });
    const cache = createCache(db, { clock });
    const pool = createProviderPool({ db, registry, config, clock, fetchImpl, env, log });
    const fetcher = createFetcher(config);
    const engine = createEngine({ registry, pool, fetcher });
    // ai.run.* to OpenVibe.Events through the outbox (server/events.js); before recovery, so its failures are announced.
    require('./events').init(db, { log });
    // ai.preferences (read) and ai.usage_summary (written): Network user modules (server/user-modules.js).
    const userModules = require('./user-modules').createUserModules({ db, config, env, fetchImpl, clock, log });
    userModules.ensureSchema();
    const runs = createRuns({ db, registry, engine, cache, quotas, config, clock, log, userModules });
    seed({ registry, quotas, config, env, db });
    const interrupted = runs.recoverInterrupted();
    if (interrupted) log.warn(`[ai] marked ${interrupted} interrupted run(s) failed (run.interrupted); callers can retry them`);

    const keys = createKeyStore({ urls: [config.networkInternalUrl, config.networkUrl], pem: config.networkPublicKey, fetchImpl, log });
    const auth = createAuth({ config, keys });
    const app = createApp({ config, db, registry, pool, quotas, cache, runs, auth, keys, log });
    const keyLoaded = keys.start().catch(() => null);

    const housekeeping = setInterval(() => {
        try {
            const pruned = runs.prune();
            const expired = cache.prune();
            if (pruned || expired) log.log(`[ai] retention: ${pruned} old run(s), ${expired} expired cache entr${expired === 1 ? 'y' : 'ies'}`);
        } catch (err) { log.error(`[ai] retention failed: ${err.message}`); }
    }, 60 * 60 * 1000);
    housekeeping.unref?.();

    let server = null;
    if (listen) userModules.start();
    if (listen) {
        server = await new Promise((resolve, reject) => {
            const s = app.listen(config.port, config.host, () => resolve(s));
            s.on('error', reject);
        });
        server.keepAliveTimeout = 65000;
        server.headersTimeout = 66000;
        server.requestTimeout = config.runs.maxWaitMs + 30000;
        log.log(`[ai] listening on http://${config.host}:${server.address().port} (${config.nodeEnv})`);
        const shared = registry.getProvider('shared');
        log.log(`[ai] shared provider: ${shared.kind} ${shared.status}, credentials ${registry.publicProvider(shared).credentials}; stub fallback ${config.stubFallback ? 'on' : 'off'}`);
    }

    async function close() {
        clearInterval(housekeeping);
        userModules.stop();
        keys.stop();
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        }
        await runs.drain();
        const w = pool.adapter('whisper');
        if (w && w.adapter.killActive) w.adapter.killActive();
        db.close();
    }

    return { config, db, registry, pool, quotas, cache, fetcher, engine, runs, keys, keyLoaded, auth, app, server, close };
}

if (require.main === module) {
    require('dotenv').config();
    start().then((handles) => {
        const shutdown = (sig) => {
            console.log(`[ai] ${sig}: shutting down`);
            handles.close().then(() => process.exit(0), () => process.exit(1));
            setTimeout(() => process.exit(1), 10000).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }).catch((err) => {
        console.error(`[ai] failed to start: ${err.stack || err}`);
        process.exit(1);
    });
}

module.exports = { start };
