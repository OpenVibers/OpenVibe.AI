'use strict';
/**
 * The owner's setup rows for the GPU marketplaces, the servers and the provider accounts that need more
 * than one value (plan §AB.10, §AB.17).
 *
 * Every host is a row in the right group with a key page, a line that says what to press there and a test.
 * The test makes one cheap authenticated read: it never creates, rents or buys anything. A key never appears
 * in an answer or a log line. The price table is public, cached, and every row carries the day the price was
 * read and where it came from.
 *
 * Every provider answer here is recorded: the test never reaches the internet.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, request, token, suite } = require('./helpers');
const { lintSchema } = require('./lint-schema');
const { GPU_HOSTS, SERVER_HOSTS, ACCOUNTS } = require('../server/setup/hosts');

const t = suite('setup-hosts');
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const KEK = crypto.randomBytes(32).toString('base64');
const VULTR_KEY = 'made-up-vultr-key-NEVER-IN-A-LOG-OR-ANSWER-4c1d9e0a';
const BAD_KEY = 'made-up-bad-key-THE-PROVIDER-ECHOES-THIS-BACK-5e2f';
const LAMBDA_KEY = 'made-up-lambda-key-NEVER-IN-A-LOG-OR-ANSWER-11d0ffee';
const SECRETS = [VULTR_KEY, BAD_KEY, LAMBDA_KEY];
const cfgTok = token('network', ['ai.config.manage', 'ai.provider.manage', 'ai.usage.read']);
const owner = { 'X-OV-Subject': OWNER, 'X-OV-Fresh': '1' };
const cfg = (h, method, path, body) => request(h.base, method, path, { tok: cfgTok, body, headers: owner });

const calls = [];

/** The recorded answers of the hosts and the price APIs. Nothing here reaches the internet. */
async function fakeFetch(url, init = {}) {
    const u = String(url);
    const headers = init.headers || {};
    const auth = String(headers.Authorization || headers.authorization || headers['x-api-key'] || headers['X-API-Key'] || '');
    calls.push({ url: u, auth, method: String(init.method || 'GET') });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const text = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

    // The hosts' own account reads.
    if (u === 'https://api.vultr.com/v2/account') {
        if (auth === 'Bearer ' + VULTR_KEY) return json(200, { balance: 12.34, email: 'owner@example.com' });
        return json(401, { error: 'Invalid API token.', status: 401 });
    }
    if (u === 'https://api.linode.com/v4/account') return json(200, { username: 'owner', email: 'owner@example.com' });
    if (u === 'https://api.hetzner.cloud/v1/servers') return json(200, { servers: [{ id: 1, name: 'desktop-1' }] });
    if (u === 'https://api.scaleway.com/account/v3/projects') return json(200, { projects: [{ id: 'p1', name: 'agents' }] });
    if (u === 'https://api.upcloud.com/1.3/server') return json(200, { servers: [{ uuid: 's1' }] });
    if (u === 'https://api.digitalocean.com/v2/account') return json(200, { email: 'owner@example.com', status: 'active' });
    if (u === 'https://cloud.lambdalabs.com/api/v1/instance-types') return json(200, [{ name: 'gpu_1x_a100', price_cents_per_hour: 99 }]);
    if (u.startsWith('https://api.salad.com/api/public/organizations/')) return json(200, { items: [{ id: 'g1' }] });
    if (u === 'https://api.hyperbolic.xyz/v1/models') return json(200, { data: [{ id: 'm-1' }] });
    if (u === 'https://api.shadeform.ai/v1/user') return json(200, { id: 'u1' });
    if (u === 'https://api.ovh.com/v1/me') return json(200, { nichandle: 'owner', firstname: 'Owner' });

    // Google's own: the service account buys an access token, then the models are listed.
    if (u === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'made-up-access-token', expires_in: 3600 });
    if (u.includes('aiplatform.googleapis.com')) return json(200, { publisherModels: [{ name: 'publishers/google/models/gemini-2.5-flash' }] });

    // The price APIs.
    // Shadeform's own instance types (recorded 2026-11-14): the price is in cents, and a card with no free
    // region cannot be rented.
    if (u.startsWith('https://api.shadeform.ai/v1/instances/types')) {
        return json(200, { instance_types: [
            { shade_instance_type: 'H100', cloud_instance_type: 'gpu_1x_h100', configuration: { gpu_type: 'H100', num_gpus: 1 }, vcpus: 16, memory_in_gb: 268, hourly_price: 599, availability: [{ region: 'us-ny-1', display_name: 'US, New York, NY', available: true, rental_type: 'on_demand' }] },
            { shade_instance_type: 'A100_80G', cloud_instance_type: 'gpu_1x_a100_80g', configuration: { gpu_type: 'A100_80G', num_gpus: 1 }, vcpus: 12, memory_in_gb: 120, hourly_price: 200, availability: [{ region: 'us-va-1', display_name: 'US, Culpeper, VA', available: true, rental_type: 'on_demand' }] },
            { shade_instance_type: 'H100_sxm5', cloud_instance_type: 'gpu_8x_h100', configuration: { gpu_type: 'H100', num_gpus: 8 }, vcpus: 128, memory_in_gb: 1920, hourly_price: 1592, availability: [{ region: 'us-dallas-1', display_name: 'US, Dallas, TX', available: true, rental_type: 'on_demand' }] },
            { shade_instance_type: 'H200', cloud_instance_type: 'gpu_1x_h200', configuration: { gpu_type: 'H200', num_gpus: 1 }, vcpus: 44, memory_in_gb: 185, hourly_price: 441, availability: [{ region: 'ca-montreal-1', display_name: 'CA, Montreal', available: false, rental_type: 'on_demand' }] },
        ] });
    }
    // Verda (DataCrunch) instance types (recorded 2026-11-14): the on-demand hour and the spot hour.
    if (u.startsWith('https://api.datacrunch.io/v1/instance-types')) {
        return json(200, [
            { instance_type: '1H100.80S.30V', name: 'H100', model: 'H100', gpu: { description: '1x H100 SXM5 80GB', number_of_gpus: 1 }, cpu: { number_of_cores: 30 }, memory: { size_in_gigabytes: 120 }, price_per_hour: '5.241', spot_price: '2.621' },
            { instance_type: '1A100.22V', name: 'A100 80GB', model: 'A100 80GB', gpu: { description: '1x A100 SXM4 80GB', number_of_gpus: 1 }, cpu: { number_of_cores: 22 }, memory: { size_in_gigabytes: 120 }, price_per_hour: '2.386', spot_price: '1.193' },
            { instance_type: '2A100.22V', name: '2x A100 SXM4 80GB', model: 'A100 80GB', gpu: { description: '2x A100 SXM4 80GB', number_of_gpus: 2 }, cpu: { number_of_cores: 44 }, memory: { size_in_gigabytes: 240 }, price_per_hour: '4.772', spot_price: '2.386' },
        ]);
    }
    if (u.startsWith('https://api.vultr.com/v2/plans')) {
        return json(200, { plans: [
            { id: 'vc2-1c-1gb', vcpu_count: 1, ram: 1024, monthly_cost: 5, hourly_cost: 0.007 },
            { id: 'vc2-2c-4gb', vcpu_count: 2, ram: 4096, monthly_cost: 20, hourly_cost: 0.027 },
        ] });
    }
    if (u.startsWith('https://api.linode.com/v4/linode/types')) {
        return json(200, { data: [
            { id: 'g6-nanode-1', label: 'Nanode 1GB', vcpus: 1, memory: 1024, price: { hourly: 0.0075, monthly: 5 } },
            { id: 'g6-standard-1', label: 'Linode 4GB', vcpus: 2, memory: 4096, price: { hourly: 0.03, monthly: 24 } },
        ] });
    }
    if (u.startsWith('https://eu.api.ovh.com/1.0/order/catalog/public/vps')) {
        return json(200, { plans: [{ planCode: 'vps-2027-model1', pricings: [{ mode: 'default', interval: 1, intervalUnit: 'month', price: 549000000 }] }] });
    }
    if (u.startsWith('https://api.frankfurter.dev/')) return json(200, { amount: 1, base: 'EUR', date: '2026-11-13', rates: { USD: 1.1052 } });
    if (u.startsWith('https://www.hetzner.com/cloud/cost-optimized/')) {
        return text(200, '<html><body><span>CX23</span><span>€ 0.0088 per hour</span><span>CAX11</span><span>€ 0.0104 per hour</span></body></html>');
    }
    if (u.startsWith('https://www.hetzner.com/sb/')) return text(200, '<html><body>Server Auction refurbished servers from € 75.70 per month</body></html>');
    return json(404, { error: 'not recorded' });
}

let h;
const logs = [];
const capture = { log: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
const consoleLines = [];
const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };

t.test('every host of every group is a row with a key page, a line that says what to press there and a test', async () => {
    h = await boot({ env: { OV_CONFIG_KEKS: 'k1:' + KEK, OV_CONFIG_KEK_CURRENT: 'k1', AI_USER_MODULES: 'off' }, log: capture, fetchImpl: fakeFetch });
    const names = (await cfg(h, 'GET', '/internal/config')).body.namespaces.map((n) => n.namespace).sort();
    assert.deepStrictEqual(names, ['ai.accounts', 'ai.decisions', 'ai.exchange', 'ai.gpus', 'ai.provider_keys', 'ai.servers']);
    for (const ns of (await cfg(h, 'GET', '/internal/config')).body.namespaces) {
        assert.deepStrictEqual(lintSchema(ns.schema), [], ns.namespace + ': ' + lintSchema(ns.schema).join('; '));
    }

    const gpus = (await cfg(h, 'GET', '/internal/config/ai.gpus')).body.schema.properties;
    for (const host of GPU_HOSTS) {
        const row = gpus[host.id + '.key'];
        assert.ok(row, host.id + ' has no row in the GPUs group');
        assert.strictEqual(row['x-owner-input'].group, 'gpus', host.id + ' is not in the GPUs group');
        assert.match(row['x-owner-input'].get_it_at, /^https:\/\//, host.id + ' has no key page');
        assert.ok(row['x-owner-input'].get_it_how.length > 20, host.id + ' does not say what to press');
        assert.ok(row['x-owner-input'].unlocks.length > 20, host.id + ' does not say what it unlocks');
        assert.strictEqual(row['x-owner-input'].test, Boolean(host.test), host.id + ' does not say whether it can be tested');
    }
    assert.strictEqual(gpus['vast.key']['x-owner-input'].get_it_at, 'https://cloud.vast.ai/manage-keys/');
    assert.strictEqual(gpus['runpod.key']['x-owner-input'].get_it_at, 'https://www.runpod.io/console/user/settings');

    const servers = (await cfg(h, 'GET', '/internal/config/ai.servers')).body.schema.properties;
    for (const host of SERVER_HOSTS.filter((x) => !x.no_key)) {
        const row = servers[host.id + '.key'];
        assert.ok(row, host.id + ' has no row in the Servers group');
        assert.strictEqual(row['x-owner-input'].group, 'servers', host.id + ' is not in the Servers group');
        assert.match(row['x-owner-input'].get_it_at, /^https:\/\//, host.id + ' has no key page');
        assert.strictEqual(row['x-owner-input'].test, Boolean(host.test));
        for (const part of host.parts || []) assert.ok(servers[host.id + '.' + part.key], host.id + '.' + part.key + ' is missing');
    }
    // The Server Auction is a price read, not a key.
    assert.strictEqual(servers['hetzner-auction.key'], undefined);

    const accounts = (await cfg(h, 'GET', '/internal/config/ai.accounts')).body.schema.properties;
    for (const account of ACCOUNTS) {
        assert.ok(accounts[account.id + '.key'], account.id + ' has no row');
        assert.strictEqual(accounts[account.id + '.key']['x-owner-input'].group, 'ai-providers');
        for (const part of account.parts || []) assert.ok(accounts[account.id + '.' + part.key], account.id + '.' + part.key + ' is missing');
    }
    assert.strictEqual(accounts['vertex.key']['x-owner-input'].get_it_at, 'https://console.cloud.google.com/iam-admin/serviceaccounts');
});

t.test('a host row is tested with one cheap read; nothing is created, rented or bought', async () => {
    const none = await cfg(h, 'POST', '/internal/config/ai.servers/test/vultr.key');
    assert.deepStrictEqual([none.status, none.body.code], [409, 'config.not_set'], 'as Shared 4.125.0\'s hook: nothing to test');
    const put = await cfg(h, 'PUT', '/internal/config/ai.servers/secrets/vultr.key', { value: VULTR_KEY, reason: 'setup' });
    assert.strictEqual(put.status, 200, put.text);
    assert.ok(!put.text.includes(VULTR_KEY), 'the answer never carries the key');
    const r = await cfg(h, 'POST', '/internal/config/ai.servers/test/vultr.key');
    assert.deepStrictEqual([r.body.ok, r.body.state], [true, 'connected']);
    assert.strictEqual(r.body.message, 'Vultr accepted the key.');
    assert.ok(calls.some((c) => c.url === 'https://api.vultr.com/v2/account' && c.auth === 'Bearer ' + VULTR_KEY));
    assert.ok(!calls.some((c) => /POST|PUT|DELETE/.test(c.method)), 'the test only reads');
});

t.test('a host that refuses the key says so in one line, and the key never comes back', async () => {
    const put = await cfg(h, 'PUT', '/internal/config/ai.servers/secrets/vultr.key', { value: BAD_KEY, reason: 'a wrong key' });
    assert.strictEqual(put.status, 200, put.text);
    const r = await cfg(h, 'POST', '/internal/config/ai.servers/test/vultr.key');
    assert.deepStrictEqual([r.body.ok, r.body.state], [false, 'not_working']);
    assert.match(r.body.message, /^Vultr refused the key \(401\)/);
    assert.ok(r.body.message.length <= 200 && !r.body.message.includes('\n'));
    assert.ok(!r.text.includes(BAD_KEY) && !r.text.includes(BAD_KEY.slice(0, 12)), 'the answer never carries the key');
});

t.test('a GPU row is tested the same way, and the market row keeps its own reader', async () => {
    const put = await cfg(h, 'PUT', '/internal/config/ai.gpus/secrets/lambda.key', { value: LAMBDA_KEY, reason: 'setup' });
    assert.strictEqual(put.status, 200, put.text);
    const r = await cfg(h, 'POST', '/internal/config/ai.gpus/test/lambda.key');
    assert.deepStrictEqual([r.body.ok, r.body.state], [true, 'connected']);
    assert.match(r.body.message, /Lambda Labs accepted the key and lists 1 instance type\./);
    assert.ok(!r.text.includes(LAMBDA_KEY));
});

t.test('a row with more than one field is tested with all of them', async () => {
    const ovh = (await cfg(h, 'GET', '/internal/config/ai.servers')).body.schema.properties;
    assert.ok(ovh['ovh.application_key'] && ovh['ovh.consumer_key']);
    const put = await cfg(h, 'PUT', '/internal/config/ai.servers/secrets/ovh.key', { value: 'made-up-ovh-secret', reason: 'setup' });
    assert.strictEqual(put.status, 200, put.text);
    const missing = await cfg(h, 'POST', '/internal/config/ai.servers/test/ovh.key');
    assert.strictEqual(missing.body.state, 'not_working');
    assert.match(missing.body.message, /needs its application key and consumer key/);
    await cfg(h, 'POST', '/internal/config/ai.servers', { values: { 'ovh.application_key': 'app-1', 'ovh.consumer_key': 'con-1' }, reason: 'setup', merge: true });
    const r = await cfg(h, 'POST', '/internal/config/ai.servers/test/ovh.key');
    assert.strictEqual(r.body.ok, true, r.text);
});

t.test('the account row signs its own request and lists the models of that region', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const account = JSON.stringify({ type: 'service_account', project_id: 'my-project', client_email: 'ai@my-project.iam.gserviceaccount.com', private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token' });
    const put = await cfg(h, 'PUT', '/internal/config/ai.accounts/secrets/vertex.key', { value: account, reason: 'setup' });
    assert.strictEqual(put.status, 200, put.text);
    assert.ok(!put.text.includes('my-project'), 'the answer never carries the service account');
    const missing = await cfg(h, 'POST', '/internal/config/ai.accounts/test/vertex.key');
    assert.strictEqual(missing.body.state, 'not_working');
    assert.match(missing.body.message, /needs the region/);
    await cfg(h, 'POST', '/internal/config/ai.accounts', { values: { 'vertex.project': 'my-project', 'vertex.region': 'us-central1' }, reason: 'setup', merge: true });
    const r = await cfg(h, 'POST', '/internal/config/ai.accounts/test/vertex.key');
    assert.strictEqual(r.body.ok, true, r.text);
    assert.match(r.body.message, /Vertex AI \(Google Cloud\) accepted the service account and lists 1 publisher model in us-central1\./);
    assert.ok(!r.text.includes(privateKey.slice(0, 40)), 'the answer never carries the private key');
});

t.test('the price table is public, cached, and every row says when it was read and where it came from', async () => {
    const s = await request(h.base, 'GET', '/api/v1/prices/servers');
    assert.strictEqual(s.status, 200, s.text);
    assert.ok(s.body.rows.length >= 4, 'the servers table is empty: ' + s.text);
    for (const r of s.body.rows) {
        assert.ok(r.provider && r.plan, 'a row has no provider or plan');
        assert.ok(typeof r.usd_per_hour === 'number', 'a row has no hourly price');
        assert.ok(r.at, 'a row has no day');
        assert.ok(r.source_url && /^https:\/\//.test(r.source_url), 'a row has no source');
        assert.ok('vcpu' in r && 'ram_gb' in r, 'a row has no cores or memory');
    }
    const vultr = s.body.rows.find((r) => r.provider === 'Vultr');
    assert.strictEqual(vultr.plan, 'vc2-2c-4gb', 'the cheapest plan that fits an agent desktop');
    assert.strictEqual(vultr.usd_per_month, 20);
    assert.strictEqual(vultr.vcpu, 2);
    assert.strictEqual(vultr.ram_gb, 4);
    const ovh = s.body.rows.find((r) => r.provider === 'OVHcloud');
    assert.ok(ovh && ovh.fx && ovh.fx.rate === 1.1052, 'the euro price carries the rate that converted it: ' + JSON.stringify(ovh));
    // The Server Auction sells refurbished dedicated servers and does not give their size: the row is there
    // with its own floor price, and a size it does not know is null, never 0.
    const auction = s.body.rows.find((r) => r.provider === 'Hetzner Server Auction');
    assert.ok(auction, 'the Server Auction has no row: ' + JSON.stringify(s.body.rows.map((r) => r.provider)));
    assert.strictEqual(auction.vcpu, null, 'a size the page does not give is null, not 0');
    assert.strictEqual(auction.ram_gb, null);
    assert.ok(auction.usd_per_month > 0, 'the auction row has no price');
    const again = await request(h.base, 'GET', '/api/v1/prices/servers');
    assert.strictEqual(again.body.cached, true, 'the second answer is the cached one');
    assert.strictEqual(again.headers.get('cache-control'), 'public, max-age=3600');
    const before = calls.length;
    await request(h.base, 'GET', '/api/v1/prices/servers');
    assert.strictEqual(calls.length, before, 'a cached answer asks no provider again');
});

t.test('the GPU table carries the readings the provisioner already keeps', async () => {
    const g = await request(h.base, 'GET', '/api/v1/prices/gpus');
    assert.strictEqual(g.status, 200, g.text);
    assert.ok(Array.isArray(g.body.rows));
    for (const r of g.body.rows) {
        assert.ok(r.provider && r.gpu, 'a GPU row has no provider or card');
        assert.ok(typeof r.usd_per_hour === 'number');
        assert.ok(r.source_url, 'a GPU row has no source');
    }
});

t.test('the two providers that publish their prices as an API are read there', async () => {
    const g = await request(h.base, 'GET', '/api/v1/prices/gpus');
    const shade = g.body.rows.find((r) => r.provider === 'Shadeform' && r.gpu === 'H100');
    assert.ok(shade, 'Shadeform has no row: ' + JSON.stringify(g.body.rows.map((r) => r.provider)));
    // Shadeform's price is in cents, and only a one-GPU card is comparable with the other rows.
    assert.strictEqual(shade.usd_per_hour, 5.99, 'the cents were not turned into dollars');
    assert.strictEqual(shade.source_url, 'https://api.shadeform.ai/v1/instances/types');
    assert.ok(!g.body.rows.some((r) => r.provider === 'Shadeform' && r.gpu === 'H200'), 'a card with no free region is not a price');
    assert.ok(!g.body.rows.some((r) => r.provider === 'Shadeform' && r.usd_per_hour === 15.92), 'an eight-GPU card is not a one-GPU hour');
    const verda = g.body.rows.find((r) => r.provider === 'Verda (DataCrunch)' && r.gpu === 'H100');
    assert.ok(verda, 'Verda has no row: ' + JSON.stringify(g.body.rows.map((r) => r.provider)));
    assert.strictEqual(verda.usd_per_hour, 5.241);
    assert.strictEqual(verda.source_url, 'https://api.datacrunch.io/v1/instance-types');
    assert.match(verda.note, /spot hour of the same card is 2.621/);
    assert.ok(!g.body.rows.some((r) => r.provider === 'Verda (DataCrunch)' && r.plan === '2A100.22V'), 'a two-GPU card is not a one-GPU hour');
});


t.test('the signatures follow their own schemes', async () => {
    const { ovhHeaders, ociHeaders } = require('../server/setup/signing');
    const ovh = ovhHeaders({ applicationKey: 'AK', applicationSecret: 'AS', consumerKey: 'CK', method: 'GET', url: 'https://api.ovh.com/v1/me', timestamp: 1405415936 });
    assert.strictEqual(ovh['X-Ovh-Application'], 'AK');
    assert.strictEqual(ovh['X-Ovh-Consumer'], 'CK');
    assert.strictEqual(ovh['X-Ovh-Timestamp'], '1405415936');
    // OVH signs the consumer key, the method, the query, the body and the timestamp with the application secret.
    assert.strictEqual(ovh['X-Ovh-Signature'], '$1$' + crypto.createHmac('sha1', 'AS').update('CK+GET+/v1/me++1405415936').digest('base64'));

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const oci = ociHeaders({
        tenancy: 'ocid1.tenancy.oc1..aaaa', user: 'ocid1.user.oc1..bbbb', fingerprint: 'aa:bb:cc',
        privateKey, method: 'GET', url: 'https://compute.us-phoenix-1.oraclecloud.com/20160918/instances?compartmentId=ocid1.tenancy.oc1..aaaa',
        now: new Date('2026-11-14T10:00:00Z'),
    });
    assert.match(oci.authorization, /^Signature version="1",keyId="ocid1\.tenancy[^"]+\/ocid1\.user[^"]+\/aa:bb:cc",algorithm="rsa-sha256",headers="content-length content-type date host x-content-sha256",signature="[^"]+"$/);
    const signature = /signature="([^"]+)"/.exec(oci.authorization)[1];
    assert.ok(crypto.createVerify('RSA-SHA256').update(oci.signable).verify(publicKey, Buffer.from(signature, 'base64')), 'the signature is over the signable string');
    assert.ok(oci.signable.startsWith('GET\n/20160918/instances?compartmentId='), 'the signable string carries the verb and the request URI');
});

t.test('no log line carries a key', async () => {
    for (const k of Object.keys(original)) console[k] = original[k];
    for (const s of SECRETS) {
        assert.ok(logs.every((line) => !line.includes(s)), 'a log line carries a key');
        assert.ok(consoleLines.every((line) => !line.includes(s)), 'a console line carries a key');
    }
    await h.stop();
});

(async () => {
    await t.run();
})().catch((err) => { console.error(err); process.exit(1); });
