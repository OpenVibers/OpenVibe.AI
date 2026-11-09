'use strict';
const assert=require('assert');
const {boot,request,token,suite,tmpDir,ALL}=require('./helpers');
const {createChoices,choice}=require('../server/choices');
const {executeChoice}=require('../server/choices/execute');
const t=suite('task choices');let h;
const svc=token('design',ALL);
const subject='usr_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const user=role=>token('person',[],{actorType:'user',sub:subject,extra:{subject_id:subject,role}});
const c=model=>({model,source:'openvibe'});
t.test('catalogue, personal isolation and admin role gate',async()=>{
 h=await boot({dir:tmpDir()});
 let r=await request(h.base,'GET','/api/v1/tasks');assert.equal(r.status,200,r.text);assert(r.body.tasks.some(t=>t.name==='design.icon'));
 r=await request(h.base,'PUT','/api/v1/me/choices/design.icon',{tok:svc,body:c('a/b')});assert.equal(r.status,403);
 r=await request(h.base,'PUT','/api/v1/me/choices/design.icon',{tok:user('user'),body:c('a/b')});assert.equal(r.status,200,r.text);
 r=await request(h.base,'GET','/api/v1/admin/task-defaults',{tok:user('user')});assert.equal(r.status,403);
 r=await request(h.base,'GET','/api/v1/admin/task-defaults',{tok:svc});assert.equal(r.status,403);
 r=await request(h.base,'GET','/api/v1/admin/task-defaults',{tok:user('admin')});assert.equal(r.status,200,r.text);assert.equal(r.body.defaults['design.icon'].signed_in.model,'anthropic/claude-opus-5-5');
 r=await request(h.base,'POST','/api/v1/tasks',{tok:svc,body:{name:'wiki.foreign',kind:'text',sentence:'No.',default:c('a/b')}});assert.equal(r.status,422);
});
t.test('a site session saves a choice only from a first-party origin, and search preferences are kept',async()=>{
 const site=token('person',[],{aud:'openvibe.network',actorType:'user',sub:subject,extra:{subject_id:subject,role:'user'}});
 let r=await request(h.base,'PUT','/api/v1/me/choices/design.icon',{tok:site,headers:{Origin:'https://openvibe.blog','Sec-Fetch-Site':'same-origin'},body:c('a/blog')});
 assert.equal(r.status,200,r.text);
 r=await request(h.base,'PUT','/api/v1/me/choices/design.icon',{tok:site,headers:{Origin:'https://evil.example','Sec-Fetch-Site':'same-origin'},body:c('a/bad')});
 assert.deepEqual([r.status,r.body.code],[403,'capability.denied']);
 const prefs={only_my_keys:false,free_first:true,price_ceiling_usd_per_mtok:null,defaults:{text:'auto',code:'auto',vision:'auto',image:'auto',search:'search/commons'}};
 r=await request(h.base,'PUT','/api/v1/me/ai/preferences',{tok:user('user'),body:prefs});assert.equal(r.status,200,r.text);
 assert.equal(r.body.defaults.search,'search/commons');
 r=await request(h.base,'PUT','/api/v1/me/ai/preferences',{tok:user('user'),body:{...prefs,defaults:{...prefs.defaults,search:7}}});assert.equal(r.status,422,r.text);
});
t.test('the seeded search tasks resolve to an engine and refuse a model',async()=>{
 const store=createChoices({db:h.db,registry:h.registry,clock:{now:()=>Date.now()},preferences:{get:async()=>null}});
 let r=await store.resolve('search.web');assert.equal(r.task.kind,'search');assert.equal(r.why,'builtin');assert.equal(r.choice.model,'search/wikipedia');
 r=await store.resolve('wiki.article.images');assert.equal(r.choice.model,'search/commons');
 await assert.rejects(()=>store.save(subject,'search.web',c('anthropic/claude-opus-5-5')),e=>e.code==='choice.invalid');
 const value={signed_out:c('search/openverse'),signed_in:c('openverse/model'),fallbacks:[],image_model:null,search_engines:[],max_cost_usd:null};
 await assert.rejects(()=>store.putDefaults({defaults:[{task:'search.web',value}]},subject),e=>e.code==='choice.invalid');
});
t.test('a search task records a contract-valid run and the engines it considered',async()=>{
 const r=await request(h.base,'POST','/api/v1/runs?wait=10000',{tok:svc,body:{task:'search.web',input:{query:'SQLite'}}});
 assert.equal(r.status,201,r.text);
 assert.equal(r.body.run.status,'succeeded',r.text);
 for(const field of ['objective','reasons','selected','candidates']) assert(Object.hasOwn(r.body.run.explain,field),field);
 assert.equal(r.body.run.explain.selected,'search/wikipedia');
 assert.deepEqual(r.body.run.explain.candidates.map(c=>c.provider),['wikipedia']);
});
t.test('model choices reject extra fields and require machine identity',()=>{assert.throws(()=>choice({model:'x',source:'machines'}));assert.throws(()=>choice({...c('a/b'),api_key:'no'}));});
t.test('precedence, cache expires in 60s, audit and only-my-keys',async()=>{
 let now=100000,prefs={defaults:{code:'kind/model'}};
 const store=createChoices({db:h.db,registry:h.registry,clock:{now:()=>now},preferences:{get:async()=>prefs}});
 let r=await store.resolve('design.icon',{subject,choice:c('run/model')});assert.equal(r.why,'run');
 r=await store.resolve('design.icon',{subject});assert.equal(r.why,'saved');
 const second='usr_01ARZ3NDEKTSV4RRFFQ69G5FAW';r=await store.resolve('design.icon',{subject:second});assert.equal(r.why,'kind');
 prefs={defaults:{}};r=await store.resolve('design.icon',{subject:second});assert.equal(r.why,'owner');assert.equal(r.choice.model,'anthropic/claude-opus-5-5');
 r=await store.resolve('design.icon');assert.equal(r.choice.model,'openvibe/cheapest');
 r=await store.resolve('chat.reply');assert.equal(r.why,'builtin');
 await store.defaults();await h.db.prepare('UPDATE ai_task_defaults SET value = ? WHERE task = ?').run(JSON.stringify({signed_out:c('new/model'),signed_in:c('new/model'),fallbacks:[],max_cost_usd:0.1,search_engines:[]}), 'design.icon');
 assert.equal((await store.resolve('design.icon')).choice.model,'openvibe/cheapest');now+=60000;assert.equal((await store.resolve('design.icon')).choice.model,'new/model');
 prefs={only_my_keys:true,defaults:{}};await assert.rejects(()=>store.resolve('design.icon',{subject:second}),e=>e.code==='ai.needs_key');
 const value={signed_out:c('a/b'),signed_in:c('a/c'),fallbacks:[c('a/d')],image_model:null,search_engines:[],max_cost_usd:0.2};
 await store.putDefaults({defaults:[{task:'design.icon',value}]},subject);
 assert(await h.db.prepare("SELECT * FROM audit_log WHERE action = 'task.defaults'").get());
});
t.test('exact source routing, ordered fallback and no fallback after a delta',async()=>{
 const calls=[];const registry={listModels:async()=>[{provider_key:'a',model_key:'one',status:'active',type:'chat'},{provider_key:'a',model_key:'two',status:'active',type:'chat'}],listProviders:async()=>[{key:'a',status:'active'}]};
 const plan={task:{name:'test.run'},choice:c('a/one'),fallbacks:[c('a/two')],why:'owner',max_cost_usd:null};
 const args={registry,route:{},operation:'chat',req:{},ctx:{taskChoice:plan,choiceBudget:{used:0}},execute:async(route,op,req,ctx)=>{calls.push(ctx.exact.offers[0].model);if(calls.length===1)throw new Error('unavailable');return {model:'two'};}};
 const result=await executeChoice(args);assert.deepEqual(calls,['one','two']);assert.equal(result.explain.task_choice.fallback_index,1);
 calls.length=0;await assert.rejects(()=>executeChoice({...args,ctx:{...args.ctx,onDelta:()=>{}},execute:async(r,o,q,ctx)=>{calls.push('called');ctx.onDelta('hello');throw new Error('broken');}}));assert.equal(calls.length,1);
});
t.test('task run enforces an explicit model and records its source without caching',async()=>{
 await h.registry.upsertProvider({key:'choice-stub',kind:'stub',auth_mode:'none',capabilities:['chat','generate','complete'],default_model:'choice-one'});
 await h.registry.upsertModel({provider_key:'choice-stub',model_key:'choice-one',type:'chat',supports:{streaming:true,vision:true,json:true,tools:true}});
 let r=await request(h.base,'POST','/api/v1/runs?wait=5000',{tok:svc,body:{task:'design.icon',choice:c('choice-stub/choice-one'),input:{messages:[{role:'user',content:'Draw an icon'}]}}});
 assert.equal(r.status,201,r.text);assert.equal(r.body.run.status,'succeeded',r.text);assert.equal(r.body.run.provenance.model,'choice-one');assert.equal(r.body.run.answered.source,'openvibe');assert.equal(r.body.run.answered.model,'choice-one');assert.equal(r.body.run.choice.model,'choice-stub/choice-one');
 r=await request(h.base,'POST','/api/v1/runs?wait=5000',{tok:svc,body:{workflow:'ai.generate',choice:c('choice-stub/choice-one'),input:{prompt:'Every workflow accepts choice'}}});assert.equal(r.body.run.status,'succeeded',r.text);
});
t.test('missing price under a cost ceiling never dispatches',async()=>{
 let dispatched=false;
 await assert.rejects(()=>executeChoice({execute:async()=>{dispatched=true;},registry:{listModels:async()=>[{provider_key:'a',model_key:'one',type:'chat',status:'active'}],listProviders:async()=>[{key:'a',status:'active'}],getProvider:async()=>({kind:'openai'})},poolRates:async()=>null,route:{},operation:'chat',req:{maxTokens:100},ctx:{taskChoice:{task:{name:'test'},choice:c('a/one'),fallbacks:[],max_cost_usd:0.01},choiceBudget:{used:0}}}),e=>e.code==='choice.cost_ceiling');
 assert.equal(dispatched,false);
});
t.test('finish',async()=>h.stop());
t.run();
