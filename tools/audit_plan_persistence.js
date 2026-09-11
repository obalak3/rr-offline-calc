'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const ROOT=require('os').homedir()+'/rr-agent/turns';
const pairs=[];
for(const d of fs.readdirSync(ROOT).filter(x=>/^2026-08-29-0[45]/.test(x)).sort()){
  const dir=path.join(ROOT,d);
  const fl=fs.readdirSync(dir).filter(f=>/^turn\d+\.json$/.test(f)).sort();
  for(let i=0;i+1<fl.length;i++){
    let a,b; const fa=path.join(dir,fl[i]), fb=path.join(dir,fl[i+1]);
    try{a=JSON.parse(fs.readFileSync(fa,'utf8'));b=JSON.parse(fs.readFileSync(fb,'utf8'));}catch(e){continue;}
    if(!a.planJobs||!b.planJobs||b.obs.turn!==a.obs.turn+1) continue;
    if(a.obs.foe.maxhp!==b.obs.foe.maxhp||b.obs.kind==='forced') continue;
    if(JSON.stringify(a.planJobs)===JSON.stringify(b.planJobs)) continue;
    if(!/^switch/.test(b.played||'')) continue;
    pairs.push([fa,fb,b.played]);
  }
}
const step=Math.max(1,Math.floor(pairs.length/14));
const sample=pairs.filter((_,i)=>i%step===0).slice(0,14);
console.log('switch-after-plan-change pairs: '+pairs.length+', sampling '+sample.length+'\n');
let n=0, incumbentWins=0, nowStays=0;
for(const [fa,fb,playedLive] of sample){
  let out;
  try{ out=cp.execSync('RR_PROBE_PREV='+fa+' node tools/agent.js --probe '+fb+' 2>&1',
    {cwd:process.cwd(),encoding:'utf8',timeout:120000}); }catch(e){ out=(e.stdout||'')+''; }
  const m=/chooseAction -> (\{[^}]*\})\s+(.*)/.exec(out);
  if(!m) continue;
  n++;
  const why=m[2].trim();
  if(/already being followed/.test(why)){ incumbentWins++;
    if(!/switch/.test(m[1])) nowStays++;
    console.log('  '+path.basename(fb)+'  live played '+playedLive
      +'  -> now keeps the plan: '+m[1].slice(0,32)); }
}
console.log('\npairs compared: '+n);
console.log('  the re-offered plan now WINS : '+incumbentWins);
console.log('     ... and it is not a switch: '+nowStays);
