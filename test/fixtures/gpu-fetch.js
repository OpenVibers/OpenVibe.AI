'use strict';
/**
 * The recorded marketplace: the answers Vast.ai gave when the offer search, the rental, the instance
 * and the health check ran (test/fixtures/gpu/vast.json). The fake serves them, so no test reaches
 * the network and every run sees the same offers. The instance answers are the recorded ones with
 * the port the rental was given.
 */
const fs = require('fs');
const path = require('path');

const RECORDED = JSON.parse(fs.readFileSync(path.join(__dirname, 'gpu', 'vast.json'), 'utf8'));

/** A fake Vast.ai. api.dead makes the endpoint stop answering (the instance died). */
function createGpuFetch() {
    const calls = { search: 0, create: [], show: 0, destroy: [], health: 0 };
    let created = 0;
    const api = {
        calls,
        dead: false,
        fetchImpl: async (url, opts = {}) => {
            const u = String(url);
            const method = String(opts.method || 'GET');
            const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
            if (u.includes('/api/v0/bundles')) {
                calls.search += 1;
                return reply(200, RECORDED.search);
            }
            if (u.includes('/api/v0/asks/')) {
                calls.create.push({ url: u, body: JSON.parse(opts.body || '{}') });
                created += 1;
                return reply(200, { success: true, new_contract: 'inst-' + created });
            }
            if (u.includes('/api/v0/instances/')) {
                if (method === 'DELETE') {
                    calls.destroy.push(u);
                    return reply(200, { success: true, msg: 'destroyed' });
                }
                calls.show += 1;
                const id = u.split('/').pop();
                const port = 12345 + Math.max(0, created - 1);
                return reply(200, { ...RECORDED.instance, id, ports: { 8000: { port, proxy: 'https://gw.vast.ai:' + port } } });
            }
            if (u.includes('/v1/models')) {
                calls.health += 1;
                // The death hits the first instance only: the one that replaces it is healthy.
                if (api.dead && u.includes(':12345')) return reply(503, { error: 'the endpoint stopped answering' });
                return reply(200, { object: 'list', data: [{ id: 'deepseek-r1-32b' }] });
            }
            return reply(404, { detail: 'no recorded answer for ' + method + ' ' + u });
        },
    };
    return api;
}

module.exports = { createGpuFetch, RECORDED };
