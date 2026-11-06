'use strict';
/**
 * The recorded marketplace: the answers Vast.ai gave when the offer search, the rental, the instance,
 * the list and the health check ran (test/fixtures/gpu/vast.json). The fake serves them, so no test
 * reaches the network and every run sees the same offers. The instance answers are the recorded ones
 * with the port the rental was given.
 *
 *   api.dead          the first endpoint stops answering (the instance died)
 *   api.destroyFails  every destroy is refused (the marketplace will not give the instance back)
 *   api.extra         the instances the account holds that carry our label (the orphans)
 */
const fs = require('fs');
const path = require('path');

const RECORDED = JSON.parse(fs.readFileSync(path.join(__dirname, 'gpu', 'vast.json'), 'utf8'));

/** A fake Vast.ai. */
function createGpuFetch() {
    const calls = { search: 0, create: [], show: 0, destroy: [], health: 0, list: 0 };
    const rented = new Map();      // the instances this account rented, id -> { id, label, state }
    let created = 0;
    const api = {
        calls,
        dead: false,
        destroyFails: false,
        extra: [],
        fetchImpl: async (url, opts = {}) => {
            const u = String(url);
            const method = String(opts.method || 'GET');
            const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
            if (u.includes('/api/v0/bundles')) {
                calls.search += 1;
                return reply(200, RECORDED.search);
            }
            if (u.includes('/api/v0/asks/')) {
                const body = JSON.parse(opts.body || '{}');
                calls.create.push({ url: u, body });
                created += 1;
                const id = 'inst-' + created;
                rented.set(id, { id, label: String(body.label || ''), state: 'running' });
                return reply(200, { success: true, new_contract: id });
            }
            if (u.includes('/api/v1/instances')) {
                calls.list += 1;
                return reply(200, { instances: [...rented.values(), ...api.extra] });
            }
            if (u.includes('/api/v0/instances/')) {
                if (method === 'DELETE') {
                    calls.destroy.push(u);
                    if (api.destroyFails) return reply(500, { detail: 'the marketplace refused to give the instance back' });
                    rented.delete(u.split('/').pop());
                    return reply(200, { success: true, msg: 'destroyed' });
                }
                calls.show += 1;
                const id = u.split('/').pop();
                const port = 12345 + Math.max(0, created - 1);
                return reply(200, { ...RECORDED.instance, id, ports: { 8000: { port, proxy: 'https://gw.vast.ai:' + port } } });
            }
            if (u.includes('/v1/models')) {
                calls.health += 1;
                if (api.dead && u.includes(':12345')) return reply(503, { error: 'the endpoint stopped answering' });
                return reply(200, { object: 'list', data: [{ id: 'deepseek-r1-32b' }] });
            }
            return reply(404, { detail: 'no recorded answer for ' + method + ' ' + u });
        },
    };
    return api;
}

module.exports = { createGpuFetch, RECORDED };
