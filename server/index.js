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
const { AiError } = require('./util');
const { gracefulStop, telemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink, startTelemetryRetention } = require('openvibe-sdk/telemetry');

async function start({ config, db: givenDb = null, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, env = process.env, log = console, listen = true, credentialFetch = null, valkey = null, research = null, machineModels = null, variantEvidence = null, community: givenCommunity = null, communityEndpoints: givenEndpoints = null, webhooks: givenWebhooks = null, abuse: givenAbuse = null, memoryTransport = null, memoryLookup = null } = {}) {
    config = config || load(env);
    schemas.configure(config.schemaCache);
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test) hands in a migrated handle.
    const db = givenDb || await openDb(config, { log });
    const registry = createRegistry(db, { clock, env });
    // AI Exchange F: Billing Credits for paid managed inference (AI_CREDITS, off). The manager is created when the
    // flag is on, including when an owner turns it on live (D11 onExchange below); runs use the facade.
    let credits = null;
    function ensureCredits() {
        if (credits || !(config.credits && config.credits.enabled)) return credits;
        credits = require('./credits').createCredits({ config, db, registry, env, fetchImpl, clock, log, networkUrl: config.networkInternalUrl });
        if (credits && !(config.modelCatalog && config.modelCatalog.enabled)) {
            log.warn('[credits] AI_CREDITS is on but AI_MODEL_CATALOG is off: no offer declares managed access, so no request is charged');
        }
        if (credits && listen && config.nodeEnv !== 'test') credits.startSettlements();
        return credits;
    }
    // D11 owner settings: ai.exchange and ai.provider_keys on openvibe-shared/config. The provider-key store also
    // refreshes the synchronous vault cache, and its one-time migration runs before any provider is built.
    const settings = await require('./settings').createSettings({ db, config, registry, clock, env, log, onExchange: () => ensureCredits() });
    // The GPU provisioner (the design's "OpenVibe GPUs"): it is off until the owner has set a marketplace
    // API key and a monthly cap in the owner settings (ai.gpus). The reconciler rents, health-checks and
    // scales the instances to zero; it never spends past the cap.
    const gpus = require('./gpu/provisioner').createGpuProvisioner({ db, registry, settings, clock, fetchImpl, env, log });
    const vault = require('./vault').createVault({ settings, clock, log });
    await require('./vault').migrate({ db, config, settings, log }).catch((err) => log.warn(`[Vault] migration failed: ${err.message}`));
    await vault.load().catch((err) => log.warn(`[Vault] ${err.message}`));
    // A person's own machine as their model (server/machines.js), shared with community offers: both reach a machine
    // only through OpenVibe.Bot's bot.machine.ai.
    const machines = machineModels || require('./machines').createMachineModels({ config, env, fetchImpl });
    // Community AI offers (the design's "Offer to the network"; plan E4): read Network's user-owned offers, verify a
    // machine before traffic, and keep its seller ledger. Empty without a Network service secret or Bot.
    // A community endpoint (the design's SDK gap) is registered here with the seller's own developer key and reached
    // through the egress guard; it joins the same offer list, verification and ledger.
    const endpoints = givenEndpoints || (config.community.endpoints && config.community.endpoints.enabled === false
        ? null
        : require('./community/endpoints').createEndpointOffers({ db, config, env, clock, fetchImpl, log }));
    // Exchange webhooks (the plan's "For builders", item 7): the receivers a developer registers, the signed
    // deliveries of usage/earnings/offer.down, and the retry worker. A row per delivery; the worker is off in tests.
    const webhooks = givenWebhooks || require('./exchange/webhooks').createWebhooks({ db, config, clock, log });
    const community = givenCommunity || require('./community').createCommunity({ db, config, env, machines, endpoints, clock, fetchImpl, log });
    // Plan E5: the free tier's allowance by trust, device and network signals, proof of work and anomaly throttling.
    const abuse = givenAbuse || require('./abuse').createAbuse({ db, config, env, clock, fetchImpl, log, registry, community });
    // BENCH-11: Bench's ratings as routing evidence, and the opted-in tie rule inside placement.
    const bench = createBenchEvidence({ db, registry, config, clock, fetchImpl, log });
    // Network owns the 18+ account flag; the adult tier checks it before placement.
    const adultStatus = require('./policy/adult-status').createAdultStatus({ config, env, fetchImpl, clock, log });
    // The price book's off-peak windows (BA1): what a provider's own price is inside the hours it publishes.
    // The router reads them to know when a provider is at its off-peak price (server/providers/tiers.js).
    const offPeak = require('./pricebook/offpeak').createOffPeak({ db, clock });
    const creditGrants = require('./providers/credit-grants').createCreditGrants({ db, env, fetchImpl, clock });
    const pool = createProviderPool({ db, registry, config, clock, fetchImpl, env, log, credentialFetch, machineModels: machines, community, bench, variantEvidence, adultStatus, offPeak, creditGrants });
    // The hourly provider balance probe (server/providers/balance.js): a gauge for the operator alert, started
    // only when the service listens (never in tests) and off under a restore drill.
    const balance = require('./providers/balance').createBalanceProbe({ registry, config, env, fetchImpl, clock, log });
    // T6 step 8: the SaaS tier budgets on openvibe-sdk/govern in Valkey (server/govern.js); off unless AI_GOVERN_TIERS=1.
    const tiers = createTiers({ config, valkey, clock, log });
    // §2.1.8: the provider free allowance per subject, priced off the pool's own rate cards (server/free-allowance.js);
    // with the tiers on, its counter is in their Valkey store.
    const freeAllowance = createFreeAllowance(db, { cardsFor: pool.rateCardsFor, clock, store: tiers.freeStore, bonusFor: (subject) => community.kudosBonus(subject) });
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
    // A person's own provider keys (WS-O task 2; L36 Y1): stored by the service holding their consent, or by the
    // person themselves (owner `self`), used by their runs only. The test seam (a fake fetch) is for tests; production
    // reaches a custom endpoint through the guarded fetcher's egress rules.
    // L55 C3: the apps a person allows to use their own key (per app, per provider or for all). The person's
    // choice; nothing uses a person's key without it.
    const grants = require('./key-grants').createKeyGrants({ db, clock });
    const credentials = require('./credentials').createCredentials({ db, config, clock, fetchImpl: credentialFetch, grants });
    // A person's ai.preferences (L36 Y3): only_my_keys, free_first, a price ceiling and a default model per kind.
    const preferences = require('./person-preferences').createPreferences({ db, clock });
    // The Exchange's routing presets and the receipts of the answered requests (server/exchange/).
    const presets = require('./exchange/presets').createPresets({ db, clock, log });
    const receipts = require('./exchange/receipts').createReceipts({ db, clock, log });
    const projectSecrets = require('./project-secrets').createProjectSecrets({ config, env, fetchImpl });
    ensureCredits();
    // A stable facade: the store may create the Credits manager after boot (AI_CREDITS turned on live), and the runs
    // keep the same object. enabled is the live flag, so turning Credits off stops new holds at once.
    const creditsRef = {
        get enabled() { return Boolean(credits && config.credits && config.credits.enabled); },
        get accessOf() { return credits ? credits.accessOf : require('./credits').accessOfProvider; },
        get manager() { return credits; },
        begin(o) {
            if (!credits) throw new AiError(503, 'billing.unavailable', 'Billing Credits is not configured on this service');
            return credits.begin(o);
        },
        // BA2: the balance check a batch asks before the provider is given the work.
        async probe(o) {
            if (!credits) return { ok: true, skipped: 'no credits' };
            return credits.probe(o);
        },
        pendingSettlements() { return credits ? credits.pendingSettlements() : Promise.resolve([]); },
        drainSettlements(o) { return credits ? credits.drainSettlements(o) : Promise.resolve({ skipped: 'disabled' }); },
        startSettlements() { return credits ? credits.startSettlements() : null; },
        stopSettlements() { return credits ? credits.stopSettlements() : undefined; },
    };
    // A person's own endpoint (the design's product line 6): a private rent on the same GPU provisioner, with a
    // Billing hold before it starts and the exact seconds settled when it stops. It is off until the owner has
    // a GPU key and a monthly cap AND Balance billing is on; the public status says which one is missing.
    const ownEndpoints = require('./gpu/endpoints').createOwnEndpoints({ db, gpus, credits: creditsRef, config, clock, fetchImpl, log });
    gpus.attachEndpoints(ownEndpoints);
    // BA3: the runs and the batcher need each other (a batch-class run is created first, then queued), so
    // the runs hold this facade and the batcher fills it in below, before any request can arrive.
    const batchRef = {};
    const runs = createRuns({ db, registry, engine, cache, quotas, config, clock, log, userModules, credentials, preferences, tiers, projectSecrets, pool, runBudgets, credits: creditsRef, community, presets, receipts, abuse, webhooks, batch: batchRef,
        // BA2: a run that waits for a provider's batch answer is not interrupted by a restart: it stays
        // queued until the batcher finishes it (the provider is still working on it).
        batchWaiting: async (runId) => {
            const row = await db.prepare("SELECT 1 AS one FROM batch_queue WHERE run_id = ? AND status IN ('queued', 'submitted', 'settling') LIMIT 1").get(runId).catch(() => null);
            return Boolean(row);
        } });
    await seed({ registry, quotas, config, env, db });
    // The seed creates or moves providers from the environment: publish their origins (the schema and every key's
    // bind follow), so a key is bound to the host it is for from the first boot.
    await settings.providerKeys.syncOrigins({ actor: { type: 'service', id: 'ai' }, reason: 'providers seeded' })
        .catch((err) => log.warn(`[config] provider origins: ${err.message}`));
    const interrupted = await runs.recoverInterrupted();
    if (interrupted) log.warn(`[ai] marked ${interrupted} interrupted run(s) failed (run.interrupted); callers can retry them`);

    // The Network signing keys live in the SDK's process-wide JWKS client (one per URL): freshness,
    // last-good-keys, backoff and rotation are its job. A pinned PEM never fetches. Not started under
    // NODE_ENV=test (tests pin a PEM or point the URL at a stub and let the client fetch on first use).
    const keys = createNetworkKeys({ config });
    const auth = createAuth({ config, log });
    // The person's memory (Memory M2a): sealed item text, the profile cache and the agent-read audit.
    const memory = require('./memory').createMemory({ db, config, clock, log, registry, pool });
    // The cloud import (Memory M3): parse an export into a sealed, two-hour preview. No note goes to the store
    // until the person chooses it.
    const memoryImport = require('./memory/import').createMemoryImport({ memory, db, config, clock, log });
    // The store's own maintenance (Memory M2c/M3): owner by owner, with a per-run cap, and the expired import
    // drafts. It is off in test mode and off while a provider is in a drill (server/memory/jobs.js).
    const memoryJobs = require('./memory/jobs').createMemoryJobs({ memory, memoryImport, config, clock, log, registry });
    // Memory M5: the memory services with the person's own key (mem0, Letta, Zep), and the store's team sharing.
    // Sharing is null when this deployment has no Network client secret or Events URL; its routes answer 503.
    const memoryServices = require('./memory/services').createMemoryServices({ db, config, clock, log, memory, transport: memoryTransport, lookup: memoryLookup });
    const memorySharing = require('./memory/sharing').createMemorySharing({ db, config, env, clock, log, fetchImpl });
    // The living price book (plan E1): the weekly job that reads every catalogued provider's own price listing and
    // keeps the price the router charges in step with it. A change of more than 20% waits for the owner on the
    // operator console. Off in test mode (the tests replay the recorded listings) and off under a drill.
    const priceBook = require('./pricebook').createPriceBook({ db, registry, config, clock, log, offPeak });
    // The measured refusal rates (server/refusal/): the weekly job that asks every offer the same published,
    // harmless questions and publishes how often it refused them. Due-based, like the price book.
    const refusal = require('./refusal/job').createRefusalJob({ db, registry, pool, config, env, clock, log });
    // The native batcher (BA2): the providers' own batch APIs, behind one queue.
    const batcher = require('./batch/batcher').createBatcher({ db, runs, registry, credits: creditsRef, config, clock, log, env, fetchImpl });
    // BA3: a batch-class run asks the batcher where it may wait, and hands its own run to the queue.
    batchRef.planRun = batcher.planRun;
    batchRef.enqueueRun = batcher.enqueueRun;
    // The half-price batches (server/batch/): many prompts, answered later, billed through Billing.
    const batches = require('./batch/service').createBatchService({ db, runs, registry, community, priceBook: offPeak, batcher, config, clock, log });
    batcher.attach(batches);
    // The Events consumer side: a signed bench.rating.changed webhook, subscribed at boot (server/bench/events.js).
    const accountData = accountDataLib.create({ db, log, memory });
    const accountSend = env.OV_OAUTH_CLIENT_SECRET ? createNetworkSender({
        networkInternalUrl: config.networkInternalUrl, clientId: config.console.clientId,
        clientSecret: env.OV_OAUTH_CLIENT_SECRET, fetch: fetchImpl,
    }) : null;
    const benchEvents = createBenchEvents({ bench, accountData, accountSend, config, log, fetchImpl, clientSecret: env.OV_OAUTH_CLIENT_SECRET });
    const app = createApp({ config, db, registry, pool, quotas, cache, runs, auth, keys, env, clock, fetchImpl, log, credentials, preferences, grants, vault, settings, benchEvents, runBudgets, memory, memoryImport, memoryServices, memorySharing, community, endpoints, webhooks, presets, receipts, balance, creditGrants, gpus, abuse, priceBook, ownEndpoints, refusal, batches });
    let jwks = null;
    let keyLoaded = Promise.resolve(null);
    if (!keys.pinned && config.nodeEnv !== 'test') {
        jwks = jwksClient(config.networkJwksUrl, { log, fetch: fetchImpl }).start();
        keyLoaded = jwks.keys().catch(() => null);   // resolves once the first fetch is done (null if it failed)
    }

    const housekeeping = setInterval(async () => {
        try {
            const pruned = await runs.prune();
            // The receipts go with the runs they belong to (the same retention window).
            await receipts.prune(config.runs.retentionDays, clock.now());
            const expired = await cache.prune();
            // Billing readings never sent go with their runs (server/usage-samples.js expireUnsent).
            const lapsed = await require('./usage-samples').expireUnsent(db, { days: config.runs.retentionDays, now: clock.now() });
            const abusePruned = await abuse.prune();
            if (pruned || expired || lapsed) log.log(`[ai] retention: ${pruned} old run(s), ${expired} expired cache entr${expired === 1 ? 'y' : 'ies'}, ${lapsed} unsent usage reading(s)`);
            if (Object.values(abusePruned).some((n) => n)) log.log(`[ai] abuse retention: ${Object.entries(abusePruned).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}`);
        } catch (err) { log.error(`[ai] retention failed: ${err.message}`); }
    }, 60 * 60 * 1000);
    housekeeping.unref?.();

    // The GPU reconciler: once a minute it fulfils the owner's requests, health-checks the running
    // instances, scales the idle ones to zero and starts the models that are wanted. Never in test mode.
    let gpuReconciler = null;
    if (listen && config.nodeEnv !== 'test') {
        gpuReconciler = setInterval(() => {
            ownEndpoints.tick()
                .then(() => gpus.tick())
                .catch((err) => log.warn('[gpu] the reconciler failed: ' + err.message));
        }, 60 * 1000);
        gpuReconciler.unref?.();
    }

    let server = null;
    let benchSubscription = null;
    let accountSubscription = null;
    if (listen) userModules.start();
    // The signed webhook retry worker: never in test mode (tests call deliverDue with their own clock).
    if (listen && config.nodeEnv !== 'test') webhooks.start();
    if (listen) balance.start();
    let creditTimer = null;
    if (listen && config.balance.enabled) {
        const tickCredits = () => creditGrants.poll().catch((err) => log.warn(`[ai] credit estimate failed: ${String(err && err.message || err).slice(0, 180)}`));
        creditTimer = setInterval(tickCredits, config.balance.intervalMs);
        if (creditTimer.unref) creditTimer.unref();
        setTimeout(tickCredits, 5000).unref?.();
    }
    if (listen && config.memoryJobs && config.memoryJobs.enabled) memoryJobs.start();
    // Team sharing's expiry sweep and delivery queue: production only, so a test's database has no background writers.
    if (listen && config.nodeEnv !== 'test' && memorySharing) memorySharing.start();
    // The price book reads the providers' listings once a week; it never starts in test mode or under a drill.
    if (listen && config.priceBook && config.priceBook.enabled) priceBook.start();
    // The refusal job asks the offers the same questions once a week; it never starts in test mode (the
    // tests drive it by hand) and never under a restore drill.
    if (listen && config.refusal && config.refusal.enabled) refusal.start();
    // The batch worker picks up the queued batches. The queue is in the database, so a restart keeps it.
    if (listen && config.batches && config.batches.enabled && config.nodeEnv !== 'test') batches.start();
    // The native batcher submits the queued groups and settles the answers. It is in the database, so a
    // restart keeps its queue.
    if (listen && config.batches && config.batches.enabled && config.nodeEnv !== 'test') batcher.start();
    // Durable Credit settles: the same jobs rule as Memory (never in test mode, never under a provider drill; the
    // queue's runOnce checks the drill itself).
    if (listen && credits && config.nodeEnv !== 'test') credits.startSettlements();
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
        if (gpuReconciler) clearInterval(gpuReconciler);
        balance.stop();
        if (creditTimer) clearInterval(creditTimer);
        if (benchSubscription) benchSubscription.stop();
        if (accountSubscription) accountSubscription.stop();
        userModules.stop();
        memoryJobs.stop();
        if (memorySharing) memorySharing.stop();
        priceBook.stop();
        refusal.stop();
        batches.stop();
        batcher.stop();
        webhooks.stop();
        if (credits) credits.stopSettlements();
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

    return { config, db, registry, pool, quotas, tiers, cache, fetcher, engine, runs, keys, keyLoaded, auth, app, server, bench, benchEvents, memory, memoryJobs, memoryServices, memorySharing, priceBook, refusal, batches, batcher, credits: creditsRef, settings, vault, community, endpoints, webhooks, gpus, abuse, ownEndpoints, close };
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
