'use strict';
/**
 * The public price table (plan §AB.10, §AB.17): what a GPU hour and an agent desktop cost.
 *
 *   GET /api/v1/prices/gpus      every GPU marketplace the estate reads, one row per card and kind
 *   GET /api/v1/prices/servers   one row per host: the cheapest plan that fits an agent desktop
 *
 * Public and cached for an hour, so Exchange (or anybody else) can rank the hosts by what they cost without
 * a token. A row is { provider, plan, vcpu, ram_gb, gpu?, usd_per_hour, usd_per_month, at, source_url }: the
 * price, the day it was read and where it came from. The owner\'s own keys are used to read the prices only
 * a provider gives to an account (DigitalOcean, UpCloud, Lambda), and the key never leaves this process.
 *
 * Nothing here spends anything: a read is a list, a catalog or a price page.
 */
const express = require('express');
const { prices } = require('../setup/prices');

/** The two routes, one function. */
function pricesRouter({ settings = null, gpuMarket = null, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, log = console } = {}) {
    const r = express.Router();

    /** The owner\'s own keys, for the hosts whose price only an account sees. */
    function ownerKeys() {
        const keys = {};
        const parts = {};
        try {
            if (settings && settings.gpus && typeof settings.gpus.values === 'function') {
                const g = settings.gpus.values();
                Object.assign(keys, g.provider_keys || {});
                Object.assign(parts, g.parts || {});
            }
            if (settings && settings.servers && typeof settings.servers.values === 'function') {
                const s = settings.servers.values();
                Object.assign(keys, s.keys || {});
                Object.assign(parts, s.parts || {});
            }
        } catch (err) {
            (log.warn || log.log).call(log, '[prices] the owner\'s settings could not be read: ' + String(err && err.message || err).slice(0, 160));
        }
        return { keys, parts };
    }

    const send = async (req, res, kind) => {
        try {
            const { keys, parts } = ownerKeys();
            const out = await prices(kind, { fetchImpl, gpuMarket, keys, parts, now: clock.now });
            res.set('Cache-Control', 'public, max-age=3600');
            return res.json({ ok: true, kind: out.kind, rows: out.rows, count: out.rows.length, at: out.at, cached: out.cached });
        } catch (err) {
            (log.warn || log.log).call(log, '[prices] the ' + kind + ' prices could not be read: ' + String(err && err.message || err).slice(0, 200));
            return res.status(503).json({ ok: false, error: 'The prices could not be read', code: 'prices.unavailable' });
        }
    };

    r.get('/gpus', (req, res) => send(req, res, 'gpus'));
    r.get('/servers', (req, res) => send(req, res, 'servers'));
    return r;
}

module.exports = { pricesRouter };
