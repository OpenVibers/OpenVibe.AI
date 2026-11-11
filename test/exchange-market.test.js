'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildOffers, pageMarket, createMarket } = require('../server/exchange/market');
const { indexMetadata, createModelMetadata, lookupMetadata, DAY_MS, bare } = require('../server/exchange/model-metadata');
const { recordMarketPrices } = require('../server/pricebook/market-store');
const { SOURCES } = require('../server/pricebook/sources');
const { PROVIDERS } = require('../server/providers/pool-providers');
const { boot, request, suite } = require('./helpers');
const dev = require('./fixtures/market/models-dev.json');
// Each own source saves its page under its own key; discover the extension so a new source does not break the replay.
const fixtureFor = (key) => {
    const dir = path.join(__dirname, 'fixtures/pricebook');
    const name = fs.readdirSync(dir).find((entry) => entry.startsWith(key + '.'));
    if (!name) throw new Error(`no saved pricebook page for ${key}`);
    return name;
};
const observations = [];
for (const s of SOURCES.filter(s => s.role === 'own')) {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures/pricebook', fixtureFor(s.key)), 'utf8');
    for (const [model_key, price] of Object.entries(s.parse(s.kind === 'json' ? JSON.parse(raw) : raw))) observations.push({ provider_key: s.provider, model_key, price, source: s.url, checked_at: '2026-11-09' });
}
const t = suite('exchange-market'); let h;
t.test('production presets and recorded pages include disabled and unregistered offers', () => {
    const offers = buildOffers({ observations, metadata: { entries: indexMetadata(dev) } });
    const snapshot = { generated_at: '2026-11-09T00:00:00Z', metadata: { source: 'https://models.dev/api.json', checked_at: null, stale: true }, offers };
    const page = pageMarket(snapshot, { limit: 500 });
    assert(observations.every(row => offers.some(o => o.provider === row.provider_key && bare(o.provider_model) === bare(row.model_key))), 'every recorded own-page model is listed'); assert(offers.every(o => !o.routed));
    assert(offers.some(o => o.price.in === null)); assert(offers.some(o => o.uncensored));
    const providerFlag = buildOffers({ observations: [{ provider_key: 'refuseless', model_key: 'new-fixture-model', price: { in: null, out: null, cached: null }, source: 'https://refuseless.com', checked_at: '2026-11-09' }] });
    assert.strictEqual(providerFlag.find(o => o.provider_model === 'new-fixture-model').uncensored, true, 'new models retain their provider preset flag');
    const first = pageMarket(snapshot, { limit: 3 }); const second = pageMarket(snapshot, { limit: 3, cursor: first.next_cursor });
    assert.deepStrictEqual([...first.offers,...second.offers], offers.slice(0,6));
    assert.throws(() => pageMarket(snapshot,{limit:'no'})); assert.throws(() => pageMarket(snapshot,{cursor:'bad'}));
    assert.throws(() => pageMarket(snapshot,{open_weights:'unknown'}));
    console.log(`Production-like market fixture: ${page.total_models} models, ${page.total_offers} offers`);
});
t.test('routing belongs to a provider offer; metadata joins dated names, prices stay own-page', () => {
    const p = PROVIDERS.find(p => p.key === 'qwen'); const m = p.models[0];
    const entries = indexMetadata({ qwen: { models: { [m.model_key]: { id: 'qwen/'+m.model_key, open_weights: true, release_date:'2026-11-01', knowledge:'2026-01', license:'Apache-2.0', limit:{context:1,output:42}, modalities:{input:['text'],output:['text']}, cost:{input:999} } } } });
    const offers = buildOffers({ metadata: { entries }, catalogue: { models: [{ offers:[{provider:p.key, model:m.model_key}] }] },
        providers: [{ ...p, status:'disabled', secret_ref:'must-not-be-exported', metadata:{account_id:'private-account'} }] });
    const offer = offers.find(o => o.provider === p.key && o.provider_model === m.model_key);
    const aliasOnly = buildOffers({ catalogue: { models: [{ offers: [{ provider: p.key, model: m.model_key + '-latest' }] }] } });
    assert.strictEqual(aliasOnly.find(o => o.provider === p.key && o.provider_model === m.model_key).routed, false, 'metadata aliases must not mark an unrouted endpoint as routed');
    assert(offer.routed); assert.strictEqual(offer.context,m.context_window); assert.strictEqual(offer.max_output,42);
    assert.strictEqual(offer.licence,'Apache-2.0'); assert.strictEqual(offer.field_sources.licence,'https://models.dev/api.json');
    assert.strictEqual(offer.field_sources.context,m.source); assert.strictEqual(offer.price.in,m.cost.in_per_mtok);
    assert.strictEqual(bare('qwen/'+m.model_key+'-2026-11-09'),bare(m.model_key));
    const page = pageMarket({offers},{maker:'qwen',open_weights:'true',kind:'chat'}); assert(page.offers.includes(offer));
    const latest = buildOffers({ changes: [{ provider_key:p.key, model_key:m.model_key, field:'in_per_mtok', new_price:9, source:m.source, checked_at:'2026-11-09', status:'pending', actor:'private-actor' }] }).find(o => o.provider === p.key && o.provider_model === m.model_key);
    assert.strictEqual(latest.price.in,9); assert.strictEqual(latest.price_checked_at,'2026-11-09');
    const privateRows = buildOffers({ providers: [{ key:'private-provider', provider_access:'UNVERIFIED' }], rows: [{ provider_key:'private-provider', model_key:'private-model', cost:{source:m.source} }] });
    assert(!privateRows.some(o => o.provider === 'private-provider'), 'private endpoints cannot impersonate a pricebook provider by reusing its URL');
    assert(!JSON.stringify(offers).includes('private-account')); assert(!JSON.stringify(offers).includes('secret_ref'));
    assert.strictEqual(lookupMetadata(entries,m.model_key+'-latest','qwen').licence,'Apache-2.0');
});
t.test('metadata persists, refreshes daily, coalesces and survives failure/restart as stale', async () => {
    let time=Date.parse('2026-11-09'); let calls=0; let fail=false;
    const options={db:h.db,now:()=>time,log:{warn(){}},fetchImpl:async()=>{calls++; if(fail)throw Error('offline'); return new Response(JSON.stringify(dev));}};
    const meta=createModelMetadata(options);
    const [one,two]=await Promise.all([meta.read(),meta.read()]); assert.strictEqual(calls,1); assert.deepStrictEqual(one,two); assert(!one.stale);
    await createModelMetadata(options).read(); assert.strictEqual(calls,1);
    time+=DAY_MS+1; fail=true; const stale=await createModelMetadata(options).read(); assert(stale.stale); assert(stale.entries.length); assert.strictEqual(stale.checked_at,one.checked_at);
    fail=false; time+=60_001; assert(!(await meta.read()).stale); assert.strictEqual(calls,3);
});
t.test('unregistered pricebook rows survive and the public route is cached and paginated', async () => {
    const s=SOURCES.find(s=>s.key==='qwen');
    await recordMarketPrices(h.db,s,{'unregistered-fixture':{in:0,out:1,cached:null}},'2026-11-09');
    const r=await request(h.base,'GET','/api/v1/exchange/market?limit=500'); assert.strictEqual(r.status,200);
    assert.strictEqual(r.headers.get('cache-control'),'public, max-age=60');
    assert(r.body.offers.some(o=>o.provider_model==='unregistered-fixture' && o.price.in===0 && !o.routed));
    assert.strictEqual((await request(h.base,'GET','/api/v1/exchange/market?open_weights=bad')).status,422);
    const nginx=fs.readFileSync(path.join(__dirname,'../deploy/nginx/api.openvibe.exchange.conf'),'utf8');
    assert(nginx.includes('location ^~ /api/v1/exchange/'));
    assert(nginx.includes('location = /v1/search/icons'), 'the Exchange icon search reaches OpenVibe.AI from the public API host');
    let time=100; let reads=0;
    const market=createMarket({db:h.db,registry:{listProviders:async()=>{reads++;return[];},listModels:async()=>[]},catalog:async()=>({models:[]}),clock:{now:()=>time},metadata:{read:async()=>({entries:[],checked_at:null,stale:true})}});
    await Promise.all([market.read({limit:1}),market.read({limit:2})]); assert.strictEqual(reads,1);
    time+=60_001; await market.read({}); assert.strictEqual(reads,2);
});
(async()=>{h=await boot(); try{await t.run();}finally{await h.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
