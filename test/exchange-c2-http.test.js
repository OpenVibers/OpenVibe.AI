'use strict';
const assert = require('node:assert/strict');
const { boot, token, ALL } = require('./helpers');
(async () => {
    const h = await boot();
    try {
        const auth = 'Bearer ' + token('live', ALL);
        const call = async (path, body, extra = {}) =>
            fetch(h.base + path, {
                method: 'POST',
                headers: {
                    authorization: auth,
                    'content-type': 'application/json',
                    ...extra,
                },
                body: JSON.stringify(body),
            });
        for (const path of ['/v1/routing/preview', '/v1/presets/import/preview']) assert.equal(
            (
                await fetch(h.base + path, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: '{}',
                })
            ).status,
            401,
        );
        const listProviders = h.registry.listProviders;
        const listModels = h.registry.listModels;
        const realFetch = global.fetch;
        const createRun = h.runs.create;
        let upstreamCalls = 0;
        let modelCalls = 0;
        global.fetch = (url, ...args) => {
            if (String(url).startsWith(h.base + '/')) return realFetch(url, ...args);
            upstreamCalls++;
            throw new Error('Preview attempted an account or provider fetch');
        };
        h.runs.create = () => { modelCalls++; throw new Error('Preview attempted inference'); };
        h.registry.listProviders = async () => [
            { key: 'public-fixture', kind: 'openai', status: 'active', provider_access: 'OWN_DEPLOYMENT', metadata: {} },
            { key: 'hidden-fixture', kind: 'openai', status: 'active', metadata: { hidden: true } },
            { key: 'restricted-fixture', kind: 'openai', status: 'active', provider_access: 'RESTRICTED' },
            { key: 'byok-fixture', kind: 'openai', status: 'active', provider_access: 'CUSTOMER_BYOK' },
        ];
        h.registry.listModels = async () => [
            ...['public-fixture', 'hidden-fixture', 'restricted-fixture', 'byok-fixture'].map((provider_key) => ({ provider_key, model_key: provider_key + '-model', status: 'active', metadata: {}, cost: {} })),
            ...[{ hidden: true }, { provider_access: 'RESTRICTED' }, { provider_access: 'CUSTOMER_BYOK' }].map((metadata, i) => ({ provider_key: 'public-fixture', model_key: 'private-model-' + i, status: 'active', metadata, cost: {} })),
        ];
        try {
        const preview = await call('/v1/routing/preview', {
            model: 'openvibe/auto',
            provider: {},
        });
        assert.equal(preview.status, 200);
        const visible = await preview.json();
        assert.equal(visible.executable, false);
        assert.deepEqual(visible.candidates, [{ provider: 'public-fixture', model: 'public-fixture-model' }]);
        assert.deepEqual(visible.excluded, []);
        const sensitive = 'submitted-private-marker';
        for (const [path, input] of [
            ['/v1/routing/preview', { model: sensitive, provider: { only: [sensitive] } }],
            ['/v1/routing/preview', { provider: { [sensitive]: sensitive } }],
            ['/v1/presets/import/preview', { name: sensitive, model: sensitive, system: sensitive, provider: { only: [sensitive] }, response_format: { [sensitive]: sensitive } }],
            ['/v1/presets/import/preview', { name: 'test', model: sensitive, [sensitive]: sensitive }],
        ]) {
            const response = await call(path, input);
            assert.ok([200, 400].includes(response.status));
            assert.equal((await response.text()).includes(sensitive), false);
        }
        assert.equal(
            (await call('/v1/routing/preview', { provider: { unknown: 'x' } }))
                .status,
            400,
        );
        const imported = await call('/v1/presets/import/preview', {
            name: 'writer',
            model: 'openvibe/auto',
        });
        assert.equal(imported.status, 200);
        assert.equal((await imported.json()).valid, true);
        assert.equal(upstreamCalls, 0, 'previews never fetch an account or provider');
        assert.equal(modelCalls, 0, 'previews never create a run');
        assert.equal((await h.db.prepare('SELECT id FROM runs').all()).length, 0);
        assert.equal((await h.db.prepare('SELECT id FROM exchange_key_usage').all()).length, 0);
        } finally {
            global.fetch = realFetch;
            h.runs.create = createRun;
            h.registry.listProviders = listProviders;
            h.registry.listModels = listModels;
        }
        const body = {
            model: 'openvibe',
            messages: [{ role: 'user', content: 'Hello' }],
        };
        const first = await call('/v1/chat/completions', body, {
            'idempotency-key': 'c2-repeat-request-001',
        });
        assert.equal(first.status, 200);
        const a = await first.json();
        const again = await call('/v1/chat/completions', body, {
            'idempotency-key': 'c2-repeat-request-001',
        });
        assert.equal(again.status, 200);
        assert.equal(again.headers.get('x-openvibe-replayed'), '1');
        assert.equal((await again.json()).id, a.id);
        const changed = await call(
            '/v1/chat/completions',
            { ...body, messages: [{ role: 'user', content: 'Different' }] },
            { 'idempotency-key': 'c2-repeat-request-001' },
        );
        assert.equal(changed.status, 409);
        const messagesBody = { model: 'openvibe', max_tokens: 20, messages: body.messages };
        const messagesFirst = await call('/v1/messages', messagesBody, { 'idempotency-key': 'messages-repeat-001' });
        assert.equal(messagesFirst.status, 200);
        const messagesResult = await messagesFirst.json();
        const messagesAgain = await call('/v1/messages', messagesBody, { 'idempotency-key': 'messages-repeat-001' });
        assert.equal(messagesAgain.status, 200);
        assert.equal(messagesAgain.headers.get('x-openvibe-replayed'), '1');
        assert.deepEqual(await messagesAgain.json(), messagesResult);
        const { createKeys } = require('../server/platform/keys');
        const keys = createKeys({ db: h.db });
        const key = await keys.create('usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', {
            name: 'replay',
            monthly_cap_usd: 1,
            allowed_models: [],
        });
        const keyHeaders = {
            authorization: 'Bearer ' + key.secret,
            'idempotency-key': 'key-repeat-request-001',
        };
        const prepare = h.db.prepare.bind(h.db);
        let holdStatements = 0;
        h.db.prepare = (sql) => {
            if (sql.includes('SET reserved = x.reserved + m.take')) holdStatements++;
            return prepare(sql);
        };
        const keyFirst = await call('/v1/chat/completions', body, keyHeaders);
        assert.equal(keyFirst.status, 200);
        const keyResult = await keyFirst.json();
        await new Promise((r) => setTimeout(r, 100));
        const before = await h.db.prepare('SELECT * FROM exchange_key_usage WHERE key_id = ?').all(key.key.id);
        assert.equal(before.length, 1);
        assert.equal(before[0].status, 'settled');
        // A replay must succeed even when no additional hold would fit.
        await h.db.prepare('UPDATE exchange_key_months SET spent = 1 WHERE key_id = ?').run(key.key.id);
        const keyAgain = await call('/v1/chat/completions', body, keyHeaders);
        assert.equal(keyAgain.status, 200);
        assert.equal(keyAgain.headers.get('x-openvibe-replayed'), '1');
        assert.deepEqual(await keyAgain.json(), keyResult);
        assert.equal(holdStatements, 1, 'a replay never takes a second hold');
        assert.deepEqual(await h.db.prepare('SELECT * FROM exchange_key_usage WHERE key_id = ?').all(key.key.id), before);
        assert.deepEqual(await h.db.prepare('SELECT spent,reserved FROM exchange_key_months WHERE key_id = ?').get(key.key.id), { spent: 1, reserved: 0 });
        const conflict = await call('/v1/chat/completions', { ...body, messages: [{ role: 'user', content: 'Changed' }] }, keyHeaders);
        assert.equal(conflict.status, 409);
        assert.equal(holdStatements, 1);

        const sameOwner = await keys.create('usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', { name: 'same owner', monthly_cap_usd: 0, allowed_models: [] });
        const sameReplay = await call('/v1/chat/completions', body, { ...keyHeaders, authorization: 'Bearer ' + sameOwner.secret });
        assert.equal(sameReplay.status, 200, 'idempotency belongs to the owner across their keys');
        assert.equal((await sameReplay.json()).id, keyResult.id);
        assert.equal(holdStatements, 1);

        // Lookup rejects an expired key before the replay shortcut or any new hold.
        await h.db.prepare('UPDATE exchange_api_keys SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', sameOwner.key.id);
        const expired = await call('/v1/chat/completions', body, { ...keyHeaders, authorization: 'Bearer ' + sameOwner.secret });
        assert.equal(expired.status, 401);
        assert.equal(holdStatements, 1);

        const other = await keys.create('usr_01JAB2C3D4E5F6G7H8J9K0MNPR', { name: 'other', monthly_cap_usd: 5, allowed_models: [] });
        const otherHeaders = { ...keyHeaders, authorization: 'Bearer ' + other.secret };
        const own = await call('/v1/chat/completions', body, otherHeaders);
        assert.equal(own.status, 200);
        assert.notEqual((await own.json()).id, keyResult.id, 'one owner cannot replay another owner\'s run');
        assert.equal(own.headers.get('x-openvibe-replayed'), null);

        const holdCount = holdStatements;
        const concurrentHeaders = { ...otherHeaders, 'idempotency-key': 'concurrent-request-001' };
        const concurrent = await Promise.all(Array.from({ length: 4 }, () => call('/v1/chat/completions', body, concurrentHeaders)));
        const answers = await Promise.all(concurrent.map(async (r) => ({ status: r.status, body: await r.json() })));
        assert.ok(answers.some((r) => r.status === 200));
        assert.ok(answers.every((r) => r.status === 200 || r.status === 409));
        assert.equal(holdStatements - holdCount, 1, 'concurrent duplicates claim one hold');
        const concurrentReplay = await call('/v1/chat/completions', body, concurrentHeaders);
        assert.equal(concurrentReplay.status, 200);
        assert.equal((await concurrentReplay.json()).id, answers.find((r) => r.status === 200).body.id);
        assert.equal(holdStatements - holdCount, 1);
        assert.equal((await h.db.prepare("SELECT id FROM runs WHERE requester_type = 'user' AND requester_id = ? AND idempotency_key = ?").all('usr_01JAB2C3D4E5F6G7H8J9K0MNPR', 'concurrent-request-001')).length, 1);
        const { claimRequest } = require('../server/platform/idempotency');
        await claimRequest(h.db, 'pending-owner', 'pending-request-001', body);
        await assert.rejects(claimRequest(h.db, 'pending-owner', 'pending-request-001', body), (e) => e.code === 'idempotency.in_progress');
        assert.equal(holdStatements - holdCount, 1, 'an interrupted admission stays closed without a second hold');
        h.db.prepare = prepare;
        console.log(
            'Authenticated preview, import validation and idempotent chat replay passed',
        );
    } finally {
        await h.stop();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
