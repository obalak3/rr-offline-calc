/**
 * Does Luby's schedule fix the one regression naive doubling caused?
 *
 * Naive doubling gives EVERY opening slice s, then doubles s. If one opening is
 * right but needs more than its slice, you only get back to it a full round
 * later -- which is exactly how GYM LEADER CLAIR regressed.
 *
 * Luby (1,1,2,1,1,2,4,1,1,2,4,8,...) instead interleaves many short cutoffs with
 * occasional long ones, and is provably within a constant factor of the best
 * fixed cutoff for ANY unknown runtime distribution.
 */
const H = require('./lib/harness.js');
const loaded = H.loadEngine();
const dexParts = H.loadDex();
const gen = H.makeGenerator(loaded, dexParts);
const B = loaded.B, X = loaded.X;
const BUDGET = 100000, MAXTURNS = 24, TIME = 20000;

function luby(i){ // 1,1,2,1,1,2,4,...
  for(let k=1;k<31;k++){
    if(i === (1<<k)-1) return 1<<(k-1);
    if(i < (1<<k)-1) return luby(i-((1<<(k-1))-1));
  }
  return 1;
}
function rootKeys(n){const k=['m0','m1','m2','m3'];for(let i=1;i<n;i++)k.push('s'+i);return k;}

function naive(mk){
  const keys=rootKeys(6); let spent=0; const dead=new Set();
  let slice=Math.max(200,Math.floor(BUDGET/(keys.length*4))); const t0=Date.now();
  while(spent<BUDGET && Date.now()-t0<TIME){
    let live=false;
    for(const k of keys){
      if(dead.has(k)||spent>=BUDGET||Date.now()-t0>=TIME) continue;
      B.clearCache(); let r;
      try{ r=X.cleanWin(mk(),{exactBudget:Math.min(slice,BUDGET-spent),maxTurns:MAXTURNS,rootActions:[k]}); }catch(e){dead.add(k);continue;}
      spent+=r.nodes;
      if(r.found) return {found:true,turns:r.line.length,nodes:spent};
      if(r.decided){dead.add(k);continue;}
      live=true;
    }
    if(!live) return {found:false,decided:true,nodes:spent};
    slice*=2;
  }
  return {found:false,decided:false,nodes:spent};
}

function lubyLadder(mk){
  const keys=rootKeys(6); let spent=0; const dead=new Set();
  const unit=Math.max(150,Math.floor(BUDGET/(keys.length*8)));
  const t0=Date.now(); let i=1;
  while(spent<BUDGET && Date.now()-t0<TIME){
    const k=keys[(i-1)%keys.length];
    if(!dead.has(k)){
      const cut=Math.min(luby(i)*unit, BUDGET-spent);
      B.clearCache(); let r;
      try{ r=X.cleanWin(mk(),{exactBudget:cut,maxTurns:MAXTURNS,rootActions:[k]}); }catch(e){dead.add(k);i++;continue;}
      spent+=r.nodes;
      if(r.found) return {found:true,turns:r.line.length,nodes:spent};
      if(r.decided) dead.add(k);
    }
    if(dead.size>=keys.length) return {found:false,decided:true,nodes:spent};
    i++;
  }
  return {found:false,decided:false,nodes:spent};
}

const all = H.earlyBattles(loaded, {maxLevel:100, relativeBase:75});
const picked = all.filter((b,i)=>i%5===0 && H.foeSets(b).length>=4);
const WANT=/CLAIR|BRYCE|MORTY|LAVENDER|ERIKA|BROCK|JARED|BRUNO|CHAMPION/;
console.log('LUBY vs NAIVE doubling, same ' + BUDGET.toLocaleString() + ' node / ' + (TIME/1000) + 's cap\n');
console.log('  fight                        plain              naive              luby');
for (const battle of picked) {
  if(!WANT.test(H.label(battle).toUpperCase())) continue;
  const level = battle.team[0].level.value + 2;
  const party = gen.team(level, 6);
  if(party.length<6) continue;
  const foe=H.foeSets(battle);
  const mk=()=>B.createState(party,foe,{});
  B.clearCache(); let p;
  try{ p=X.cleanWin(mk(),{exactBudget:BUDGET,maxTurns:MAXTURNS,timeLimitMs:TIME}); }catch(e){continue;}
  const n=naive(mk), l=lubyLadder(mk);
  const f=r=>r.found?'FOUND '+r.turns+'T/'+r.nodes:(r.decided?'no-line/'+r.nodes:'undec/'+r.nodes);
  const pv=p.found?'FOUND '+p.line.length+'T/'+p.nodes:(p.decided?'no-line/'+p.nodes:'undec/'+p.nodes);
  let flag='';
  if(!n.found&&l.found) flag='   <== LUBY FIXES IT';
  else if(n.found&&!l.found) flag='   <== luby worse';
  console.log('  '+H.label(battle).slice(0,26).padEnd(27)+pv.padEnd(19)+f(n).padEnd(19)+f(l)+flag);
}
