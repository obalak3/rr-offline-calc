'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const ROOT='/Users/omerbalak/rr-agent/turns';
const runs=[];
for(const d of fs.readdirSync(ROOT).filter(x=>/^2026-08-29-0[45]/.test(x)).sort()){
  const dir=path.join(ROOT,d);
  const fl=fs.readdirSync(dir).filter(f=>/^turn\d+\.json$/.test(f)).sort();
  for(let i=0;i+1<fl.length;i++){
    const fa=path.join(dir,fl[i]), fb=path.join(dir,fl[i+1]);
    let a,b; try{a=JSON.parse(fs.readFileSync(fa,'utf8'));b=JSON.parse(fs.readFileSync(fb,'utf8'));}catch(e){continue;}
    if(!a.planJobs||!b.planJobs||b.obs.turn!==a.obs.turn+1) continue;
    if(a.obs.foe.maxhp!==b.obs.foe.maxhp||b.obs.kind==='forced') continue;
    runs.push([fa,fb]);
  }
}
const step=Math.max(1,Math.floor(runs.length/14));
const sample=runs.filter((_,i)=>i%step===0).slice(0,14);
console.log('consecutive same-foe pairs: '+runs.length+', sampling '+sample.length+'\n');
const grab=f=>{
  let o; try{o=cp.execSync('RR_EXPLAIN=1 node tools/agent.js --probe '+f+' 2>&1',
    {cwd:process.cwd(),encoding:'utf8',timeout:120000});}catch(e){o=(e.stdout||'')+'';}
  const l=(o.split('\n').find(x=>/^\[explain\] #0 /.test(x))||'');
  const h=/here=([0-9.-]+)/.exec(l), a=/ahead=([0-9.?]+)/.exec(l);
  return {here:h?+h[1]:null, ahead:(a&&a[1]!=='?')?+a[1]:null};
};
let dh=[], da=[];
for(const [fa,fb] of sample){
  const A=grab(fa), B=grab(fb);
  if(A.here===null||B.here===null||A.ahead===null||B.ahead===null) continue;
  dh.push(Math.abs(B.here-A.here)); da.push(Math.abs(B.ahead-A.ahead));
  console.log('  '+path.basename(fa)+' -> '+path.basename(fb)
    +'   here '+A.here.toFixed(2)+' -> '+B.here.toFixed(2)
    +'   ahead '+A.ahead.toFixed(2)+' -> '+B.ahead.toFixed(2)
    +'   |dAhead|='+Math.abs(B.ahead-A.ahead).toFixed(2));
}
const mean=x=>x.reduce((s,v)=>s+v,0)/Math.max(1,x.length);
console.log('\nturn-to-turn movement of the winning line, same opponent:');
console.log('  mean |change in immediate cost|  : '+mean(dh).toFixed(2));
console.log('  mean |change in lookahead|       : '+mean(da).toFixed(2));
console.log('  lookahead jumps of 4 or more     : '+da.filter(v=>v>=4).length+' of '+da.length);
