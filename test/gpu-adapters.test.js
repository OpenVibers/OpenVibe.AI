'use strict';
const assert=require('node:assert/strict');
const {runpodAdapter}=require('../server/gpu/runpod');
const {vastAdapter}=require('../server/gpu/vast');
(async()=>{
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  calls.push({url,...options});let data={};
  if(url.includes('/catalog/gpus'))data={gpus:[{id:'gpu',name:'H100',memory:80,maxCount:{secure:8},price:{secure:2},dataCenters:[{id:'US-1',availability:'HIGH'},{id:'DE-1',availability:'HIGH'},{id:'US-2',availability:'NONE'}]}]};
  else if(url.endsWith('/pods') && options.method==='POST')data={id:'pod'};
  else if(url.includes('/asks/'))data={new_contract:'instance'};
  if(options.method==='DELETE')return {ok:true,status:204,text:async()=>''};
  return {ok:true,status:200,text:async()=>JSON.stringify(data)};
 };
 const p=runpodAdapter({fetchImpl,key:'stub'});
 const offers=await p.searchOffers({gpuNames:['H100'],vramMb:80000,numGpus:2,diskGb:60,maxPricePerHour:10,region:'US'});
 assert.equal(offers.length,1);assert.equal(offers[0].price_per_hour,'4');assert.equal(offers[0].gpu_ram_mb,81920);
 await p.createInstance(offers[0],{key:'model',model_key:'model',requirements:{num_gpus:2,disk_gb:60},runtime:{image:'image'}},{command:'run'});
 const body=JSON.parse(calls.find(x=>x.url.endsWith('/pods')).body);
 assert.equal(body.disk,60);assert.equal(body.cloud,'SECURE');assert.equal(body.args,'run');assert.equal(Array.isArray(body.env),false);
 assert.equal(await p.destroyInstance('pod'),true);
 await vastAdapter({fetchImpl,key:'stub'}).createInstance({id:'1'},{key:'m',runtime:{image:'image'},requirements:{disk_gb:60}});
 assert.equal(calls.find(x=>x.url.includes('/asks/')).method,'PUT');
 assert.ok(calls.every(x=>x.redirect==='error' && x.signal));
 console.log('GPU provider wire methods, region, count/VRAM units, request shapes and 204 deletion: passed');
})().catch(e=>{console.error(e);process.exit(1);});
