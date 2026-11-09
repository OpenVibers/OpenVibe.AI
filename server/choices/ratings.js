'use strict';
// Public Report evidence. Unknown stays unknown; a failed read never invents a ranking.
function createRatings({fetchImpl=globalThis.fetch,clock={now:()=>Date.now()}}={}) {
 let rows=[],at=0;
 return async()=>{
  if(clock.now()-at<120000)return rows;
  try {const res=await fetchImpl('https://openvibe.report/api/v1/ai/leaderboard?limit=1000',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(3000)});if(res.ok){const body=await res.json();rows=Array.isArray(body.rows)?body.rows:[];at=clock.now();}}
  catch { /* measurements are optional */ }
  return rows;
 };
}
module.exports={createRatings};
