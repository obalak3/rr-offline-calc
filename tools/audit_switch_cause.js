'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const dirs=fs.readdirSync(require('os').homedir()+'/rr-agent/turns').filter(d=>/^2026-08-29-0[45]/.test(d)).sort();
const sw=[];
dirs.forEach(d=>{const full=require('os').homedir()+'/rr-agent/turns/'+d;
  fs.readdirSync(full).filter(f=>/^turn\d+\.json$/.test(f)).sort().forEach(f=>{
    try{const r=JSON.parse(fs.readFileSync(path.join(full,f),'utf8'));
      if(r.obs && r.obs.kind!=='forced' && /^switch/.test(r.played||'')) sw.push(path.join(full,f));}catch(e){}
  });});
const step=Math.max(1,Math.floor(sw.length/20));
const sample=sw.filter((_,i)=>i%step===0).slice(0,20);
console.log('turns where the agent SWITCHED: '+sw.length+', sampling '+sample.length+'\n');
let n=0, stayed=0, aheadSum=0, hereSum=0;
for(const f of sample){
  const run=e=>{try{return cp.execSync(e+' node tools/agent.js --probe '+f+' 2>&1',
    {cwd:process.cwd(),encoding:'utf8',timeout:120000});}catch(x){return (x.stdout||'')+'';}};
  const a=run('RR_EXPLAIN=1'), b=run('RR_NO_LOOKAHEAD=1');
  const pa=/chooseAction -> (\{[^}]*\})/.exec(a), pb=/chooseAction -> (\{[^}]*\})/.exec(b);
  if(!pa||!pb) continue;
  n++;
  const l0=(a.split('\n').find(l=>/^\[explain\] #0 /.test(l))||'');
  const h=/here=([0-9.-]+)/.exec(l0), ah=/ahead=([0-9.?]+)/.exec(l0);
  if(h) hereSum+=Math.abs(+h[1]);
  if(ah&&ah[1]!=='?') aheadSum+=+ah[1];
  if(/switch/.test(pa[1]) && !/switch/.test(pb[1])) stayed++;
}
console.log('switch decisions re-run without the lookahead: '+n);
console.log('  became a NON-switch                        : '+stayed
  +'  ('+Math.round(100*stayed/Math.max(1,n))+'% of switches are caused by the lookahead)');
console.log('\nscale of the two terms on those turns (mean of the top line):');
console.log('  immediate cost  here  : '+(hereSum/Math.max(1,n)).toFixed(2));
console.log('  lookahead       ahead : '+(aheadSum/Math.max(1,n)).toFixed(2));
