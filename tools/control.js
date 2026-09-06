/**
 * The control panel: a pinned browser tab that can STOP the bot instantly and
 * decide, when the planner has concluded that one of ours has to die, WHICH one.
 *
 * Run: node tools/control.js   then open http://localhost:8420
 *
 * Two jobs James asked for:
 *
 *   1. "I should be able to stop it from playing easily, and I don't mean like
 *      going into scripting and stuff like that." One button. The agent checks
 *      a file before it answers a turn, so stopping takes effect on the next
 *      decision and never leaves the emulator in a half-pressed menu.
 *
 *   2. "if the plan sees that a pokemon needs to die, it should give me the
 *      possible options and I should be able to choose which pokemon dies.
 *      This is also a check for the AI so that it doesn't unnecessarily kill
 *      pokemon." The agent posts the alternatives it priced -- what each one
 *      costs and who it loses -- and waits. Whatever is chosen is played.
 *
 * Visual only, never audio: James rejected a speaking advisor outright.
 *
 * The protocol is files in ~/rr-agent, so nothing here has to be running for
 * the agent to work. No panel means no pause file and no answer file, which is
 * exactly the behaviour the agent had before this existed.
 *
 *   pause        present   -> the agent stops answering turns
 *   ask.json     written by the agent when a choice is needed, then it waits
 *   choice.json  written here; the agent reads it, plays it, deletes both
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = path.join(process.env.HOME, 'rr-agent');
const PAUSE = path.join(DIR, 'pause');
// Hands-off marker (wild or double battle) and James's override for it.
const WILD = path.join(DIR, 'wild');
const FIGHT = path.join(DIR, 'fight');
const ASK = path.join(DIR, 'ask.json');
const CHOICE = path.join(DIR, 'choice.json');
const STATE = path.join(DIR, 'state.json');
const HEARTBEAT = path.join(DIR, 'heartbeat');
const PORT = Number(process.env.RR_PANEL_PORT) || 8420;

const readJSON = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };

function status() {
	const ask = readJSON(ASK);
	const st = readJSON(STATE);
	let beat = null;
	try { beat = Math.round((Date.now() - fs.statSync(HEARTBEAT).mtimeMs) / 1000); }
	catch (e) { beat = null; }
	return {
		line: readJSON(path.join(DIR, 'line_result.json')),
		paused: fs.existsSync(PAUSE),
		handsOff: fs.existsSync(WILD),
		fighting: fs.existsSync(FIGHT),
		// The emulator writes a heartbeat every frame it is alive. Anything
		// beyond a few seconds means the Lua side is not running, which is
		// worth showing rather than leaving the panel looking healthy.
		aliveSeconds: beat,
		turn: st ? st.turn : null,
		us: st && st.me ? {hp: st.me.hp, max: st.me.maxhp} : null,
		them: st && st.foe ? {hp: st.foe.hp, max: st.foe.maxhp} : null,
		ask: ask
	};
}

const PAGE = `<!doctype html><meta charset="utf-8">
<title>Radical Red agent control</title>
<style>
 :root{--bg:#12141a;--fg:#e8eaf0;--dim:#8b91a3;--line:#262a35;--warn:#e0603a;--ok:#3fb27f}
 body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:var(--bg);color:var(--fg);padding:18px}
 h1{font-size:15px;margin:0 0 14px;color:var(--dim);font-weight:600;letter-spacing:.04em}
 button{font:inherit;font-weight:600;border:0;border-radius:9px;padding:14px 18px;cursor:pointer}
 .stop{background:var(--warn);color:#fff;width:100%;font-size:19px;padding:20px}
 .go{background:var(--ok);color:#08130d;width:100%;font-size:19px;padding:20px}
 .row{display:flex;gap:12px;align-items:baseline;color:var(--dim);margin:12px 0 0}
 .row b{color:var(--fg);font-weight:600}
 .card{border:1px solid var(--line);border-radius:11px;padding:14px;margin:10px 0;
       background:#171a22}
 .opt{width:100%;text-align:left;background:#1d2130;color:var(--fg);
      border:1px solid var(--line);margin:7px 0;padding:13px 15px}
 .opt:hover{border-color:var(--ok)}
 .dies{color:var(--warn);font-weight:600}
 .safe{color:var(--ok);font-weight:600}
 .cost{color:var(--dim);font-size:13px}
 .ask{border-color:var(--warn)}
 .quiet{color:var(--dim);font-size:13px;margin-top:16px}
 input{width:100%;box-sizing:border-box;font:inherit;margin-top:10px;padding:12px 14px;
       border-radius:9px;border:1px solid var(--line);background:#0e1016;color:var(--fg)}
 input:focus{outline:0;border-color:var(--ok)}
 .verdict{margin-top:12px;padding:12px 14px;border-radius:9px;background:#0e1016;
          border-left:3px solid var(--line);font-size:13.5px;line-height:1.6}
 .verdict.good{border-left-color:var(--ok)}
 .verdict.bad{border-left-color:var(--warn)}
</style>
<h1>RADICAL RED — AGENT CONTROL</h1>
<div id=btn></div>
<div class=row><span>turn</span><b id=turn>–</b><span>us</span><b id=us>–</b>
  <span>them</span><b id=them>–</b><span>emulator</span><b id=beat>–</b></div>
<div id=ask></div>
<div class=card>
  <b>Your line</b>
  <div class=cost>Say it the way you would out loud: <i>lilligant sleep powder
    then diggersby bulldoze</i>, <i>lanturn, mienshao</i>, <i>switch to lanturn</i>.
    Add <i>x3</i> to repeat a move. It is priced by the same code that prices the
    planner's own lines, so it can simply win; if it loses you get the number
    that says why. Empty the box and submit to drop it.</div>
  <form id=lineform><input id=linebox placeholder="lilligant sleep powder then diggersby bulldoze"
    autocomplete=off spellcheck=false></form>
  <div id=lineout></div>
</div>
<div class=quiet>Stopping takes effect on the next decision, with the emulator
  left on a clean menu rather than mid-press. Close this tab and the agent stops
  asking and plays on by itself.</div>
<script>
let last='';
async function tick(){
  let s; try{ s=await (await fetch('/status')).json(); }catch(e){ return; }
  render(s);
}
function render(s){
  document.getElementById('btn').innerHTML = (s.paused
    ? '<button class=go onclick="send(\\'/resume\\')">RESUME</button>'
    : '<button class=stop onclick="send(\\'/pause\\')">STOP</button>')
    + (s.handsOff && !s.fighting
      ? '<div class=quiet style="margin-top:8px">Wild or double battle: the agent is standing down, this one is yours.</div>'
        + '<button class=go style="margin-top:6px" onclick="send(\\'/fight\\')">FIGHT THIS ONE ANYWAY (singles only)</button>'
      : '');
  document.getElementById('turn').textContent = s.turn ?? '–';
  document.getElementById('us').textContent   = s.us ? s.us.hp+'/'+s.us.max : '–';
  document.getElementById('them').textContent = s.them ? s.them.hp+'/'+s.them.max : '–';
  document.getElementById('beat').textContent =
    s.aliveSeconds===null ? 'not running' : (s.aliveSeconds<5?'live':(s.aliveSeconds+'s ago'));
  const key = JSON.stringify(s.ask);
  if (key !== last) { last = key; drawAsk(s.ask); }
  drawLine(s.line);
}
function drawLine(l){
  const el = document.getElementById('lineout');
  if (!l) { el.innerHTML = ''; return; }
  if (l.error) {
    el.innerHTML = '<div class="verdict bad">' + esc(l.error) + '</div>';
    return;
  }
  const v = l.verdict || {};
  // The three answers worth telling apart at a glance: it won, it is cheaper
  // and lost anyway (a defect), or the planner genuinely disagrees on value.
  const cls = v.won ? 'good'
    : (v.priced && l.winner && v.total < l.winner.total ? 'bad' : '');
  el.innerHTML = '<div class="verdict ' + cls + '">'
    + '<div class=cost>read as: ' + esc(l.reading || '') + ' — vs ' + esc(l.foe || '') + '</div>'
    + esc(l.summary || '').replace(/\\n/g, '<br>') + '</div>';
}
function drawAsk(a){
  const el = document.getElementById('ask');
  if (!a) { el.innerHTML=''; return; }
  // WHAT IS BEING CHOSEN IS THE OUTCOME, not the move. Several lines can open
  // with the same move and still bury different Pokemon three turns later, so
  // rows that look identical on their second line are not duplicates -- and
  // saying so here saves reading them as a bug.
  let h = '<div class="card ask"><b>The plan expects to lose a Pokémon.</b>'
        + '<div class=cost>' + esc(a.position||'') + '</div>'
        + '<div class=cost>Pick who you are willing to lose. It holds for the'
        + ' rest of this opponent, and you are only asked again if that'
        + ' outcome stops being possible.</div>';
  a.options.forEach((o,i)=>{
    const who = o.dead && o.dead.length
      ? '<span class=dies>loses ' + esc(o.dead.join(', ')) + '</span>'
      : '<span class=safe>loses nobody</span>';
    h += '<button class=opt onclick="choose('+i+')">' + who
       + '<br><span class=cost>' + esc(o.why||'') + ' — plays '
       + esc(o.action||'') + ', total cost ' + (o.total??'?') + '</span></button>';
  });
  el.innerHTML = h + '</div>';
}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
async function send(u){ await fetch(u,{method:'POST'}); tick(); }
async function choose(i){
  await fetch('/choose',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({index:i})});
  document.getElementById('ask').innerHTML=''; last=''; tick();
}
// THE PAGE IS DRIVEN BY THE SERVER, not by a timer here. A polling loop looks
// equivalent and is not: Chrome throttles setInterval in a background tab to
// about once a minute, so the moment this panel was not the frontmost tab the
// agent saw a stale heartbeat, concluded nobody was watching, and went back to
// spending Pokemon without asking -- which it did, live, at turn 3510. An open
// event stream is not throttled, and the agent counts connections rather than
// polls, so a backgrounded tab still means somebody is supervising.
const es = new EventSource('/events');
es.onmessage = e => render(JSON.parse(e.data));
document.getElementById('lineform').onsubmit = async e => {
  e.preventDefault();
  const t = document.getElementById('linebox').value;
  document.getElementById('lineout').innerHTML =
    '<div class=verdict>pricing it against the live position…</div>';
  await fetch('/line', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({text: t})});
};
tick();
</script>`;

// PROOF THAT SOMEBODY IS WATCHING is an OPEN TAB, not a running server. Only a
// live viewer earns the right to hold the agent on a question; a panel left
// running in a forgotten terminal would otherwise freeze an unattended run
// overnight on a question nobody is going to answer.
const clients = new Set();
const PANEL = path.join(DIR, 'panel.alive');
setInterval(() => {
	if (!clients.size) return;
	try { fs.writeFileSync(PANEL, String(clients.size)); } catch (e) { /* not fatal */ }
	const line = 'data: ' + JSON.stringify(status()) + '\n\n';
	clients.forEach(res => { try { res.write(line); } catch (e) { clients.delete(res); } });
}, 500);

http.createServer((req, res) => {
	const send = (code, body, type) => {
		res.writeHead(code, {'content-type': type || 'application/json',
			'cache-control': 'no-store'});
		res.end(body);
	};
	if (req.url === '/' ) return send(200, PAGE, 'text/html; charset=utf-8');
	if (req.url === '/status') return send(200, JSON.stringify(status()));
	if (req.url === '/events') {
		res.writeHead(200, {'content-type': 'text/event-stream',
			'cache-control': 'no-store', connection: 'keep-alive'});
		clients.add(res);
		res.write('data: ' + JSON.stringify(status()) + '\n\n');
		req.on('close', () => clients.delete(res));
		return;
	}
	if (req.method === 'POST' && req.url === '/pause') {
		fs.writeFileSync(PAUSE, String(Date.now()));
		return send(200, '{"ok":true}');
	}
	if (req.method === 'POST' && req.url === '/resume') {
		try { fs.unlinkSync(PAUSE); } catch (e) { /* already running */ }
		return send(200, '{"ok":true}');
	}
	if (req.method === 'POST' && req.url === '/fight') {
		// James's call: fight this wild/double encounter after all. The agent
		// honours the marker for this battle only and clears it when the
		// opposing party changes.
		fs.writeFileSync(FIGHT, String(Date.now()));
		try { fs.unlinkSync(WILD); } catch (e) { /* already gone */ }
		return send(200, '{"ok":true}');
	}
	if (req.method === 'POST' && req.url === '/line') {
		let body = '';
		req.on('data', d => { body += d; });
		req.on('end', () => {
			let text = '';
			try { text = String(JSON.parse(body).text || ''); } catch (e) { text = ''; }
			// The agent reads this once and deletes it, then keeps the line for
			// the rest of the duel. Clearing the old verdict here stops a stale
			// answer sitting under a new question.
			try { fs.unlinkSync(path.join(DIR, 'line_result.json')); } catch (e) { /* none */ }
			fs.writeFileSync(path.join(DIR, 'line.json'), JSON.stringify({text: text}));
			send(200, '{"ok":true}');
		});
		return;
	}
	if (req.method === 'POST' && req.url === '/choose') {
		let body = '';
		req.on('data', d => { body += d; });
		req.on('end', () => {
			let idx = 0;
			try { idx = JSON.parse(body).index; } catch (e) { idx = 0; }
			const ask = readJSON(ASK);
			if (!ask) return send(200, '{"ok":false}');
			fs.writeFileSync(CHOICE, JSON.stringify({turn: ask.turn, index: idx}));
			send(200, '{"ok":true}');
		});
		return;
	}
	send(404, '{"error":"no"}');
}).listen(PORT, '127.0.0.1', () => {
	console.log('control panel: http://localhost:' + PORT);
	console.log('  STOP button           -> ' + PAUSE);
	console.log('  sacrifice choices via -> ' + ASK + ' / ' + CHOICE);
});
