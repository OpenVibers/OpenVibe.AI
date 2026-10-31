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
const { createBenchEvidence } = require('./bench/evidence');
const { createBenchEvents } = require('./bench/events');
const accountDataLib = require('./account-data');
const { createNetworkSender, startSubscriptions } = require('openvibe-sdk/account-data');
const { createFetcher } = require('./fetcher');
const { createEngine } = require('./workflows/engine');
const { createCache } = require('./cache');
const { createQuotas } = require('./quota');
const { createRunBudgets } = require('./run-budgets');
const { createFreeAllowance } = require('./free-allowance');
const { createTiers } = require('./govern');
const { createRuns } = require('./runs');
const { seed } = require('./workflows/seed');
const { createAuth, createNetworkKeys } = require('./auth');
const { jwksClient } = require('openvibe-sdk/auth');
const schemas = require('./schemas');
const { createApp } = require('./app');
const { gracefulStop, telemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink, startTelemetryRetention } = require('openvibe-sdk/telemetry');

async function start({ config, db: givenDb = null, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, env = process.env, log = console, listen = true, credentialFetch = null, valkey = null, research = null, machineModels = null } = {}) {
    config = config || load(env);
    schemas.configure(config.schemaCache);
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test) hands in a migrated handle.
    const db = givenDb || await openDb(config, { log });
    const registry = createRegistry(db, { clock, env });
    // Provider keys an owner stored from the console (server/vault.js): into this process before any provider is built.
    const vault = require('./vault').createVault({ db, config, clock, log });
    await vault.load().catch((err) => log.warn(`[Vault] ${err.message}`));
    // BENCH-11: Bench's ratings as routing evidence, and the opted-in tie rule inside placement.
    const bench = createBenchEvidence({ db, registry, config, clock, fetchImpl, log });
    const pool = createProviderPool({ db, registry, config, clock, fetchImpl, env, log, credentialFetch, machineModels, bench });
    // T6 step 8: the SaaS tier budgets on openvibe-sdk/govern in Valkey (server/govern.js); off unless AI_GOVERN_TIERS=1.
    const tiers = createTiers({ config, valkey, clock, log });
    // §2.1.8: the provider free allowance per subject, priced off the pool's own rate cards (server/free-allowance.js);
    // with the tiers on, its counter is in their Valkey store.
    const freeAllowance = createFreeAllowance(db, { cardsFor: pool.rateCardsFor, clock, store: tiers.freeStore });
    const quotas = createQuotas(db, { clock, registry, freeAllowance, tiers });
    // The budget a Codes run token carries (Codes C3), and what that run has spent.
    const runBudgets = createRunBudgets(db, { clock });
    const cache = createCache(db, { clock });
    const fetcher = createFetcher(config);
    // MegaSource (server/research/): the DeepSeek key resolves by name from this environment; tests hand in their own.
    const engine = createEngine({ registry, pool, fetcher, quotas, config, log, research: research || require('./research').createResearch({ config: config.research, env, log }) });
    // ai.run.* to OpenVibe.Events through the outbox (server/events.js); before recovery, so its failures are announced.
    require('./events').init(db, { log });
    // platform.usage-sample@1 readings to OpenVibe.Billing through their own outbox (server/usage-samples.js).
    require('./usage-samples').init(db, { ...config.billing, clientId: config.console.clientId, networkUrl: config.networkInternalUrl, log });
    // ai.preferences (read) and ai.usage_summary (written): Network user modules (server/user-modules.js).
    const userModules = require('./user-modules').createUserModules({ db, config, env, fetchImpl, clock, log });
    // A person's own provider keys (WS-O task 2): stored by the service holding their consent, used by their runs only.
    const credentials = require('./credentials').createCredentials({ db, config, clock });
    const projectSecrets = require('./project-secrets').createProjectSecrets({ config, env, fetchImpl });
    const runs = createRuns({ db, registry, engine, cache, quotas, config, clock, log, userModules, credentials, tiers, projectSecrets, pool, runBudgets });
    await seed({ registry, quotas, config, env, db });
    const interrupted = await runs.recoverInterrupted();
    if (interrupted) log.warn(`[ai] marked ${interrupted} interrupted run(s) failed (run.interrupted); callers can retry them`);

    // The Network signing keys live in the SDK's process-wide JWKS client (one per URL): freshness,
    // last-good-keys, backoff and rotation are its job. A pinned PEM never fetches. Not started under
    // NODE_ENV=test (tests pin a PEM or point the URL at a stub and let the client fetch on first use).
    const keys = createNetworkKeys({ config });
    const auth = createAuth({ config, log });
    // The person's memory (Memory M2a): sealed item text, the profile cache and the agent-read audit.
    const memory = require('./memory').createMemory({ db, config, clock, log, registry, pool });
    // The store's own maintenance (Memory M2c): owner by owner, with a per-run cap. It is off in test mode and off
    // while a provider is in a drill (server/memory/jobs.js).
    const memoryJobs = require('./memory/jobs').createMemoryJobs({ memory, config, clock, log, registry });
    // The Events consumer side: a signed bench.rating.changed webhook, subscribed at boot (server/bench/events.js).
    const accountData = accountDataLib.create({ db, log, memory });
    const accountSend = env.OV_OAUTH_CLIENT_SECRET ? createNetworkSender({
        networkInternalUrl: config.networkInternalUrl, clientId: config.console.clientId,
        clientSecret: env.OV_OAUTH_CLIENT_SECRET, fetch: fetchImpl,
    }) : null;
    const benchEvents = createBenchEvents({ bench, accountData, accountSend, config, log, fetchImpl, clientSecret: env.OV_OAUTH_CLIENT_SECRET });
    const app = createApp({ config, db, registry, pool, quotas, cache, runs, auth, keys, env, clock, fetchImpl, log, credentials, vault, benchEvents, runBudgets, memory });
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
            // Billing readings never sent go with their runs (server/usage-samples.js expireUnsent).
            const lapsed = await require('./usage-samples').expireUnsent(db, { days: config.runs.retentionDays, now: clock.now() });
            if (pruned || expired || lapsed) log.log(`[ai] retention: ${pruned} old run(s), ${expired} expired cache entr${expired === 1 ? 'y' : 'ies'}, ${lapsed} unsent usage reading(s)`);
        } catch (err) { log.error(`[ai] retention failed: ${err.message}`); }
    }, 60 * 60 * 1000);
    housekeeping.unref?.();

    let server = null;
    let benchSubscription = null;
    let accountSubscription = null;
    if (listen) userModules.start();
    if (listen && config.memoryJobs && config.memoryJobs.enabled) memoryJobs.start();
    if (listen) {
        server = await new Promise((resolve, reject) => {
            // Socket activation (2026-10-31): systemd's .socket unit holds the listener across restarts, so a deploy
            // queues requests in the kernel instead of answering 502. Without the socket unit, the usual listen.
            const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
            const s = app.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), () => resolve(s));
            s.on('error', reject);
        });
        server.keepAliveTimeout = 65000;
        server.headersTimeout = 66000;
        server.requestTimeout = config.runs.maxWaitMs + 30000;
        log.log(`[ai] listening on http://${config.host}:${server.address().port} (${config.nodeEnv})`);
        benchSubscription = benchEvents.startSubscriptions({ port: server.address().port });
        if (config.events.subscribe && config.events.url && config.events.secrets.length && env.OV_OAUTH_CLIENT_SECRET) {
            accountSubscription = startSubscriptions({
                eventsUrl: config.events.url, endpoint: config.events.endpoint || `http://127.0.0.1:${server.address().port}/internal/events`,
                secret: config.events.secrets[0], networkInternalUrl: config.networkInternalUrl,
                clientId: config.console.clientId, clientSecret: env.OV_OAUTH_CLIENT_SECRET, fetch: fetchImpl, log,
            });
        }
        const shared = await registry.getProvider('shared');
        log.log(`[ai] shared provider: ${shared.kind} ${shared.status}, credentials ${registry.publicProvider(shared).credentials}; stub fallback ${config.stubFallback ? 'on' : 'off'}`);
    }

    async function close() {
        clearInterval(housekeeping);
        if (benchSubscription) benchSubscription.stop();
        if (accountSubscription) accountSubscription.stop();
        userModules.stop();
        memoryJobs.stop();
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
        await tiers.close();
        if (!givenDb) await db.close();
    }

    return { config, db, registry, pool, quotas, tiers, cache, fetcher, engine, runs, keys, keyLoaded, auth, app, server, bench, benchEvents, memory, memoryJobs, close };
}

if (require.main === module) {
    require('dotenv').config();
    start().then((handles) => {
        // SIGTERM/SIGINT (openvibe-sdk/service, docs/service.md's handles family): requests in flight get 8 s,
        // then handles.close() (runs drained, the relay stopped, the database closed; a rejection exits 1);
        // past 10 s the process exits 1.
        // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
        // class each minute, stored in this service's telemetry_samples table; rows older than 14 days go daily.
        telemetry.init({ service: 'ai', sink: createPgTelemetrySink({ db: handles.db, log: console }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
        const telemetryRetention = startTelemetryRetention({ db: handles.db, log: console, olderThanDays: 14 });
        gracefulStop({ name: 'ai', server: handles.server, handles, drainMs: 8000, deadlineMs: 10000, stop: [async () => { if (telemetryRetention) await telemetryRetention.stop(); await telemetry.stop(); }] });
    }).catch((err) => {
        console.error(`[ai] failed to start: ${err.stack || err}`);
        process.exit(1);
    });
}

module.exports = { start };
