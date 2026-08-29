// How often does the executing leg carry a MULTI-MOVE sequence, and does the
// agent ever get past move 0? progress is rebuilt every decision, so it cannot.
'use strict';
const fs=require('fs'), path=require('path');
const ROOT=path.join(process.env.HOME,'rr-agent','turns');
const N={98:'Mienshao',112:'Diggersby',139:'Lanturn',102:'Lilligant',95:'Breloom',108:'Victreebel'};
let planned=0, multi=0, playedFirst=0, playedLater=0;
const repeats={};
for(const d of fs.readdirSync(ROOT).filter(x=>/^2026-/.test(x)).sort()){
  const dir=path.join(ROOT,d); if(!fs.statSync(dir).isDirectory()) continue;
  const rows=fs.readdirSync(dir).filter(x=>/^turn\d+\.json$/.test(x)).sort()
    .map(f=>{try{return JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));}catch(e){return null;}})
    .filter(r=>r&&r.obs&&r.obs.me&&r.planJobs&&r.planJobs.length);
  let prevMove=null, run=0;
  for(const r of rows){
    const o=r.obs, act=N[o.me.maxhp];
    const alive={}, frac={};
    (o.party||[]).forEach(p=>{ if(p.hp>0) alive[N[p.maxhp]]=true; frac[N[p.maxhp]]=p.hp/p.maxhp; });
    // the leg policy.js would execute (selfHp skips only; enough for this)
    let li=0;
    while(li<r.planJobs.length && !alive[r.planJobs[li].mon]) li++;
    while(li<r.planJobs.length-1){
      const u=r.planJobs[li].until;
      if(u && u.selfHp!==undefined && frac[r.planJobs[li].mon]<=u.selfHp){ li++;
        while(li<r.planJobs.length && !alive[r.planJobs[li].mon]) li++; }
      else break;
    }
    const leg=r.planJobs[li]; if(!leg||leg.mon!==act) { prevMove=null; run=0; continue; }
    planned++;
    const mv=leg.moves||[];
    if(mv.length>1 && mv.indexOf('*')<0){
      multi++;
      if(r.played===mv[0]) playedFirst++;
      else if(mv.indexOf(r.played)>0) playedLater++;
      const key=mv.join('>');
      repeats[key]=repeats[key]||{n:0, first:0};
      repeats[key].n++; if(r.played===mv[0]) repeats[key].first++;
    }
    // consecutive identical repeats of a non-damaging first move
    if(r.played===prevMove){ run++; } else { prevMove=r.played; run=1; }
  }
}
console.log('decisions where the executing leg is the active Pokemon : '+planned);
console.log('  ... and that leg carries a MULTI-MOVE sequence        : '+multi
  +' ('+Math.round(100*multi/Math.max(1,planned))+'%)');
console.log('      played the FIRST move of the sequence             : '+playedFirst);
console.log('      played any LATER move of the sequence             : '+playedLater);
console.log('\nmost common sequences and how often move 0 was played:');
Object.keys(repeats).sort((a,b)=>repeats[b].n-repeats[a].n).slice(0,8).forEach(k=>
  console.log('   '+String(repeats[k].n).padStart(4)+'x  '+k
    +'   -> first move played '+repeats[k].first+'/'+repeats[k].n));
