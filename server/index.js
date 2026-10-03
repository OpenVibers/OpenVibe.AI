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
const { createAuth, createNetworkKeys } = require('./auth');
const { jwksClient } = require('openvibe-sdk/auth');
const schemas = require('./schemas');
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');

async function start({ config, db: givenDb = null, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, env = process.env, log = console, listen = true, credentialFetch = null } = {}) {
    config = config || load(env);
    schemas.configure(config.schemaCache);
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test) hands in a migrated handle.
    const db = givenDb || await openDb(config, { log });
    const registry = createRegistry(db, { clock, env });
    const quotas = createQuotas(db, { clock, registry });
    const cache = createCache(db, { clock });
    const pool = createProviderPool({ db, registry, config, clock, fetchImpl, env, log, credentialFetch });
    const fetcher = createFetcher(config);
    const engine = createEngine({ registry, pool, fetcher, quotas, config, log });
    // ai.run.* to OpenVibe.Events through the outbox (server/events.js); before recovery, so its failures are announced.
    require('./events').init(db, { log });
    // platform.usage-sample@1 readings to OpenVibe.Billing through their own outbox (server/usage-samples.js).
    require('./usage-samples').init(db, { ...config.billing, clientId: config.console.clientId, networkUrl: config.networkInternalUrl, log });
    // ai.preferences (read) and ai.usage_summary (written): Network user modules (server/user-modules.js).
    const userModules = require('./user-modules').createUserModules({ db, config, env, fetchImpl, clock, log });
    // A person's own provider keys (WS-O task 2): stored by the service holding their consent, used by their runs only.
    const credentials = require('./credentials').createCredentials({ db, config, clock });
    const runs = createRuns({ db, registry, engine, cache, quotas, config, clock, log, userModules, credentials });
    await seed({ registry, quotas, config, env, db });
    const interrupted = await runs.recoverInterrupted();
    if (interrupted) log.warn(`[ai] marked ${interrupted} interrupted run(s) failed (run.interrupted); callers can retry them`);

    // The Network signing keys live in the SDK's process-wide JWKS client (one per URL): freshness,
    // last-good-keys, backoff and rotation are its job. A pinned PEM never fetches. Not started under
    // NODE_ENV=test (tests pin a PEM or point the URL at a stub and let the client fetch on first use).
    const keys = createNetworkKeys({ config });
    const auth = createAuth({ config, log });
    const app = createApp({ config, db, registry, pool, quotas, cache, runs, auth, keys, env, clock, fetchImpl, log, credentials });
    let jwks = null;
    let keyLoaded = Promise.resolve(null);
    if (!keys.pinned && config.nodeEnv !== 'test') {
        jwks = jwksClient(config.networkJwksUrl, { log, fetch: fetchImpl }).start();
        keyLoaded = jwks.keys().catch(() => null);   // resolves once the first fetch is done (null if it failed)
    }

    const housekeeping = setInterval(async () => {
        try {
            const pruned = await runs.prune();
            const expired = await cache.prune();
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
        const shared = await registry.getProvider('shared');
        log.log(`[ai] shared provider: ${shared.kind} ${shared.status}, credentials ${registry.publicProvider(shared).credentials}; stub fallback ${config.stubFallback ? 'on' : 'off'}`);
    }

    async function close() {
        clearInterval(housekeeping);
        userModules.stop();
        if (jwks) jwks.stop();
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        }
        await runs.drain();
        await require('./events').stop();   // after the runs: their last ai.run.* rows are queued first
        await require('./usage-samples').stop();   // the readings the runs queued get one last send; unsent rows wait for the next start
        const w = await pool.adapter('whisper');
        if (w && w.adapter.killActive) w.adapter.killActive();
        if (!givenDb) await db.close();
    }

    return { config, db, registry, pool, quotas, cache, fetcher, engine, runs, keys, keyLoaded, auth, app, server, close };
}

if (require.main === module) {
    require('dotenv').config();
    start().then((handles) => {
        // SIGTERM/SIGINT (openvibe-sdk/service, docs/service.md's handles family): requests in flight get 8 s,
        // then handles.close() (runs drained, the relay stopped, the database closed; a rejection exits 1);
        // past 10 s the process exits 1.
        gracefulStop({ name: 'ai', server: handles.server, handles, drainMs: 8000, deadlineMs: 10000 });
    }).catch((err) => {
        console.error(`[ai] failed to start: ${err.stack || err}`);
        process.exit(1);
    });
}

module.exports = { start };
