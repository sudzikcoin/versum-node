/**
 * The local page — http://127.0.0.1:3311/ — the whole owner UI after install (stage 2d, 2026-10-25).
 *
 * Loopback only. One HTML page (inline CSS and JS, no build step, no CDN) and a JSON API under /api/*:
 *   GET  /api/state         everything the page shows: pairing, scan, share, price, windows, pause, runtime, presence, earnings
 *   GET  /api/log           the last lines of the node's own log (never a key, never job payload)
 *   GET  /api/market        the hub's public capacity board, for the price hint (fetched by the node, cached 60 s)
 *   POST /api/pair          { key, hub, name }   → the key is checked against the hub before it is saved
 *   POST /api/offer         { share, price_per_minute_usd, windows, timezone, mobility, name }
 *   POST /api/pause         { paused }
 *   POST /api/consent       { allow_rootful: true }   one-time consent to a rootful Docker daemon
 *   POST /api/unpair        {}
 *   GET  /health            200 when the hub heard from us within three intervals, else 503 (unchanged)
 * Writes require the header `x-versum-local: 1` and an Origin that is this page or absent — a page on another
 * site cannot drive the node through the browser (no CORS headers are ever sent either).
 */
import http from 'node:http'
import { parseWindowsText } from './config.mjs'

export const UI_HEADER = 'x-versum-local'
const MAX_BODY = 64 * 1024

/** Pure: is this write request ours? Same-origin page (or a tool with no Origin) and the marker header. */
export function writeAllowed(headers, port) {
  if (headers[UI_HEADER] !== '1') return false
  const origin = headers.origin
  if (!origin) return true
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

/** Pure: the share the page sends, clamped to what the machine has; nulls mean "all of it". */
export function clampShare(input, found) {
  const int = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null }
  const cap = (v, max) => (v == null ? null : max == null ? v : Math.min(v, max))
  const s = input ?? {}
  return {
    cpu_cores: cap(int(s.cpu_cores), found?.cpu_cores ?? null),
    ram_mb: cap(int(s.ram_mb), found?.ram_mb ?? null),
    disk_mb: cap(int(s.disk_mb), found?.disk_free_mb ?? null),
    gpu: !!s.gpu && (found?.gpu_count ?? 0) > 0,
    max_parallel_jobs: Math.max(1, Math.min(32, int(s.max_parallel_jobs) ?? 1)),
    max_job_minutes: int(s.max_job_minutes) ?? 240,
    allow_network: !!s.allow_network,
  }
}

/** Pure: the price field → a number of USD per minute, or a refusal. */
export function parsePrice(v) {
  if (v === null || v === undefined || v === '') return { price: null }
  const n = Number(v)
  if (!(n >= 0 && n <= 1000)) return { error: 'price must be USD per minute, 0–1000' }
  return { price: Number(n.toFixed(6)) }
}

/** Pure: the market hint from the public capacity board — the cheapest online price and the middle one. */
export function marketHint(capacity) {
  const prices = (capacity?.nodes ?? []).filter((n) => n.online && n.price_per_minute_usd != null).map((n) => Number(n.price_per_minute_usd)).sort((a, b) => a - b)
  if (!prices.length) return { online: 0, min: null, median: null }
  return { online: prices.length, min: prices[0], median: prices[Math.floor(prices.length / 2)] }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(new Error('body is not JSON')) } })
    req.on('error', reject)
  })
}

export function startLocalUi({ port, ctl, log = () => {}, intervalSeconds = 30 }) {
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body, null, 2)) }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    try {
      if (req.method === 'GET') {
        if (url.pathname === '/' && !/application\/json/.test(req.headers.accept ?? '')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:" }); res.end(PAGE); return }
        if (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/api/state') {
          const s = ctl.state()
          const age = s.presence.last_heartbeat_at ? (Date.now() - Date.parse(s.presence.last_heartbeat_at)) / 1000 : Infinity
          const ok = s.presence.last_heartbeat_ok === true && age <= intervalSeconds * 3
          return json(res, url.pathname === '/health' && !ok ? 503 : 200, { ok, ...s })
        }
        if (url.pathname === '/api/log') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(ctl.log().join('\n')); return }
        if (url.pathname === '/api/market') return json(res, 200, await ctl.market())
        return json(res, 404, { error: 'not found' })
      }
      if (req.method === 'POST') {
        if (!writeAllowed(req.headers, port)) return json(res, 403, { error: 'writes need the x-versum-local header from this page' })
        const body = await readJson(req)
        switch (url.pathname) {
          case '/api/pair': return json(res, 200, await ctl.pair(body))
          case '/api/offer': return json(res, 200, await ctl.setOffer(body))
          case '/api/pause': return json(res, 200, await ctl.setPaused(!!body.paused))
          case '/api/consent': return json(res, 200, await ctl.consentRootful(body.allow_rootful === true))
          case '/api/unpair': return json(res, 200, await ctl.unpair())
          default: return json(res, 404, { error: 'not found' })
        }
      }
      json(res, 405, { error: 'method not allowed' })
    } catch (e) {
      json(res, e.status && e.status >= 400 && e.status < 600 ? e.status : 400, { error: e.message || String(e), code: e.code ?? null })
    }
  })
  server.on('error', (e) => log(`local page not started: ${e.message}`))
  server.listen(port, '127.0.0.1', () => log(`local page on http://127.0.0.1:${port}/`))
  return server
}

/** The hub's windows as the text the page edits: "Mon-Fri 22:00-07:00, Sat 00:00-24:00". Pure. */
export function windowsToText(windows) {
  const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return (windows ?? []).map((w) => `${w.weekday == null ? '' : D[w.weekday] + ' '}${hm(w.start)}-${hm(w.end)}`).join(', ')
}
export { parseWindowsText }

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Versum node</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--mut:#666;--line:#e3e3e3;--acc:#1a7f37;--warn:#b26a00;--bad:#b3261e;--card:#fafafa}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#9a9a9a;--line:#2a2a2a;--acc:#3fb950;--warn:#e3a008;--bad:#f85149;--card:#181818}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:56rem;margin:0 auto;padding:20px 16px 48px}h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.05rem;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-top:14px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:10px}
.k{color:var(--mut);font-size:.82rem}.v{font-weight:600}.mut{color:var(--mut)}.ok{color:var(--acc)}.warn{color:var(--warn)}.bad{color:var(--bad)}
button{font:inherit;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:999px;padding:7px 14px;cursor:pointer}button.acc{background:var(--acc);color:#fff;border-color:var(--acc)}button:disabled{opacity:.5;cursor:default}
input[type=text],input[type=number],input[type=url],select{font:inherit;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:8px;padding:7px 10px;min-width:0}
input[type=range]{width:100%}label{display:block}.line{font-size:.9rem;margin-top:8px}pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:.78rem;max-height:18rem;overflow:auto;white-space:pre-wrap;word-break:break-all}
code{font-size:.85rem;word-break:break-all}.badge{display:inline-block;border-radius:999px;padding:2px 10px;font-size:.8rem;border:1px solid var(--line)}
.badge.ok{border-color:var(--acc)}.badge.warn{border-color:var(--warn)}.badge.bad{border-color:var(--bad)}.hide{display:none}
</style></head><body><main>
<h1>Versum node <span id="state-badge" class="badge">starting…</span></h1>
<p class="mut" id="headline">This computer shares its spare machine time by the minute. Nothing leaves this page except what you save.</p>

<section class="card" id="pair-card">
  <h2>Pair this computer with your account</h2>
  <p class="mut line">Get a node key on the site (Connect a computer → Get a key). It is shown once there and stored only in this computer's config file.</p>
  <div class="row"><input type="text" id="pair-key" placeholder="llk_…" style="flex:1;min-width:16rem" autocomplete="off" spellcheck="false">
  <select id="pair-hub"><option value="https://launchloop.suverse.io">Versum (production)</option><option value="https://api.suverse.io/launchloop-dev">Versum dev</option><option value="custom">custom hub URL…</option></select>
  <input type="url" id="pair-hub-custom" class="hide" placeholder="https://…" style="min-width:14rem">
  <input type="text" id="pair-name" placeholder="what to call this machine" style="min-width:12rem">
  <button class="acc" id="pair-go">Pair</button></div>
  <p class="line" id="pair-msg"></p>
</section>

<section class="card" id="runtime-card">
  <h2>How jobs run here</h2>
  <p class="line" id="runtime-line">—</p>
  <p class="line mut" id="runtime-note"></p>
  <div id="consent-box" class="hide"><p class="line warn">This Docker daemon runs as root. A job that breaks out of its container would be root on this machine. Rootless Podman is the safe choice; if you accept the risk for this computer, say so once here.</p>
  <button id="consent-go">I understand — allow rootful Docker on this machine</button></div>
</section>

<section class="card" id="offer-card">
  <div class="row"><h2 style="flex:1">What you share</h2><button id="pause-go">Pause</button></div>
  <div class="grid">
    <label><span class="k">CPU cores · <b id="cpu-v">—</b></span><input type="range" id="cpu" min="1" max="1" step="1"></label>
    <label><span class="k">RAM · <b id="ram-v">—</b></span><input type="range" id="ram" min="1" max="1" step="1"></label>
    <label><span class="k">Disk for jobs · <b id="disk-v">—</b></span><input type="range" id="disk" min="1" max="1" step="1"></label>
    <label><span class="k">Jobs at once · <b id="par-v">1</b></span><input type="range" id="par" min="1" max="8" step="1" value="1"></label>
  </div>
  <div class="row line">
    <label><input type="checkbox" id="gpu"> share the GPU <span class="mut" id="gpu-note"></span></label>
    <label><input type="checkbox" id="net"> allow jobs network access (through the node's filtered proxy) <span class="mut" id="net-note"></span></label>
    <label>longest job <input type="number" id="maxmin" min="1" max="1440" step="1" style="width:6rem"> min</label>
  </div>
  <h2 class="line">Price</h2>
  <div class="row"><label>$ <input type="number" id="price" min="0" max="1000" step="0.001" style="width:8rem"> per minute</label><span class="mut" id="market">reading the market…</span></div>
  <h2 class="line">When</h2>
  <div class="row"><input type="text" id="windows" placeholder="always — or e.g. Mon-Fri 22:00-07:00, Sat 00:00-24:00" style="flex:1;min-width:18rem"><span class="mut" id="tz"></span></div>
  <div class="row line"><button class="acc" id="offer-go">Save and send to the hub</button><span id="offer-msg"></span></div>
</section>

<section class="card" id="status-card">
  <h2>Status</h2>
  <div class="grid">
    <div><div class="k">hub</div><div class="v" id="s-hub">—</div></div>
    <div><div class="k">last heartbeat</div><div class="v" id="s-beat">—</div></div>
    <div><div class="k">running now</div><div class="v" id="s-running">0</div></div>
    <div><div class="k">leases · refused</div><div class="v" id="s-leases">0 · 0</div></div>
    <div><div class="k">earned total</div><div class="v" id="s-earned">—</div></div>
    <div><div class="k">paid out</div><div class="v" id="s-paid">—</div></div>
    <div><div class="k">unpaid balance</div><div class="v" id="s-balance">—</div></div>
    <div><div class="k">reputation</div><div class="v" id="s-rep">—</div></div>
  </div>
  <p class="line mut" id="s-machine"></p>
  <div class="row line"><button id="unpair-go">Forget the key (unpair)</button><a class="mut" id="cabinet" href="#" target="_blank" rel="noreferrer">Open My nodes on the site ↗</a></div>
</section>

<section class="card"><h2>Log</h2><pre id="log">…</pre></section>
</main>
<script>
const $=id=>document.getElementById(id);const H={'content-type':'application/json','x-versum-local':'1'};
let S=null,dirty=false;const gb=mb=>mb==null?'?':(mb/1024).toFixed(mb<10240?1:0)+' GB';
async function post(p,b){const r=await fetch(p,{method:'POST',headers:H,body:JSON.stringify(b||{})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.statusText);return j}
function badge(s){const b=$('state-badge');b.className='badge '+(s.paired?(s.presence.last_heartbeat_ok?(s.paused?'warn':'ok'):'bad'):'warn');b.textContent=!s.paired?'not paired':s.paused?'paused':!s.presence.last_heartbeat_ok?'offline':s.running.length?'working':s.runtime.ok?(s.price_per_minute_usd==null?'no price yet':'online · taking jobs'):'online · no runtime'}
function fill(s){S=s;badge(s);$('pair-card').classList.toggle('hide',s.paired);$('offer-card').classList.toggle('hide',!s.paired);$('status-card').classList.toggle('hide',!s.paired);
 const f=s.scan||{};const sh=s.share||{};
 if(!dirty){const set=(id,max,val,fmt)=>{const e=$(id);e.max=max||1;e.value=val==null?(max||1):Math.min(val,max||1);$(id+'-v').textContent=fmt(Number(e.value))};
  set('cpu',f.cpu_cores,sh.cpu_cores,v=>v+' of '+(f.cpu_cores??'?'));set('ram',f.ram_mb,sh.ram_mb,v=>gb(v)+' of '+gb(f.ram_mb));set('disk',f.disk_free_mb,sh.disk_mb,v=>gb(v)+' of '+gb(f.disk_free_mb)+' free');
  $('par').value=sh.max_parallel_jobs||1;$('par-v').textContent=$('par').value;$('gpu').checked=!!sh.gpu;$('gpu').disabled=!(f.gpu_count>0);$('gpu-note').textContent=f.gpu_count>0?'('+f.gpu_model+')':'(no GPU found)';$('net').checked=!!sh.allow_network;$('net-note').textContent='';$('maxmin').value=sh.max_job_minutes||240;
  $('price').value=s.price_per_minute_usd==null?'':s.price_per_minute_usd;$('windows').value=s.windows_text||'';$('tz').textContent=s.timezone||''}
 $('pause-go').textContent=s.paused?'Resume':'Pause';
 const rt=s.runtime||{};const native=rt.kind==='native';
 if(native){$('runtime-line').innerHTML='<b>'+(rt.description||'built-in sandbox').replace(/</g,'&lt;')+'</b> <span class=ok>✓</span>';$('runtime-note').textContent=rt.sandbox==='appcontainer'?'Every job runs as a Windows AppContainer: no network at all, no access to your files (only its own job folder), a memory and CPU ceiling, killed at the time limit, the folder wiped afterwards. Container, GPU and network jobs are not offered to this node.':'Every job runs under macOS sandbox-exec: no network at all, read-only system, writable only inside its own job folder, nothing under /Users, lowered priority, killed at the time or memory limit, the folder wiped afterwards. Container, GPU and network jobs are not offered to this node.'}
 else{$('runtime-line').innerHTML=rt.name?('<b>'+rt.name+' '+(rt.version||'')+'</b> · '+(rt.rootless?'<span class=ok>rootless ✓</span>':(rt.ok?'<span class=warn>rootful, allowed by you</span>':'<span class=bad>ROOTFUL — not used until you allow it</span>'))):'<span class=bad>no runtime found</span> — Linux: install rootless Podman or Docker; Windows/macOS: reinstall the node from the site (the installer brings its own sandbox), then restart it';$('runtime-note').textContent=rt.name?'Every job runs in a fresh container with one mount (its job folder), no network unless you allow it, and is wiped afterwards.':''}
 if(rt.reasons&&rt.reasons.length&&!rt.ok)$('runtime-line').innerHTML+='<br><span class=mut>'+rt.reasons.map(x=>x.replace(/</g,'&lt;')).join('<br>')+'</span>';
 $('consent-box').classList.toggle('hide',!(rt.name&&!native&&!rt.rootless&&!rt.ok));
 if(native){$('gpu').checked=false;$('gpu').disabled=true;$('gpu-note').textContent='(GPU jobs need a container node — Linux, or Docker Desktop with WSL2 as an advanced setup)';$('net').checked=false;$('net').disabled=true;$('net-note').textContent='(the sandbox on this machine has no network; jobs that need it go to container nodes)'}else{$('net').disabled=false}
 $('s-hub').textContent=s.hub||'—';$('s-beat').textContent=s.presence.last_heartbeat_at?Math.round((Date.now()-Date.parse(s.presence.last_heartbeat_at))/1000)+' s ago'+(s.presence.last_heartbeat_ok?'':' (failed: '+(s.presence.last_error||'?')+')'):'never';
 $('s-running').textContent=s.running.length+(s.running.length?' — '+s.running.map(r=>r.note||'running').join(', '):'');$('s-leases').textContent=s.leases+' · '+s.refused;
 const e=s.earnings||{};const usd=v=>v==null?'—':'$'+Number(v).toFixed(4);$('s-earned').textContent=usd(e.earned_usd);$('s-paid').textContent=usd(e.paid_usd);$('s-balance').textContent=usd(e.balance_usd);
 const r=s.reputation;$('s-rep').textContent=r?(r.score!=null?r.score.toFixed(2):'—')+' · '+(r.ratings_count||0)+' ratings · '+(r.attempts||0)+' jobs':'no jobs yet';
 $('s-machine').textContent=(s.name||'')+' · '+(f.cpu_model||'')+' · '+(f.cpu_cores||'?')+' cores · '+gb(f.ram_mb)+' RAM · '+gb(f.disk_free_mb)+' free · '+(f.os||'')+(s.version?' · versum-node '+s.version:'');
 $('cabinet').href=(s.hub||'')+'/nodes'}
async function refresh(){try{const r=await fetch('/api/state',{headers:{accept:'application/json'}});fill(await r.json())}catch(e){$('state-badge').textContent='page lost the node: '+e.message}}
async function logs(){try{const r=await fetch('/api/log');const t=await r.text();const p=$('log');const atEnd=p.scrollTop+p.clientHeight>=p.scrollHeight-8;p.textContent=t||'(nothing yet)';if(atEnd)p.scrollTop=p.scrollHeight}catch{}}
async function market(){try{const r=await fetch('/api/market');const m=await r.json();$('market').textContent=m.online?('market now: '+m.online+' node'+(m.online===1?'':'s')+' online, from $'+m.min.toFixed(4)+'/min, typical $'+m.median.toFixed(4)+'/min — a reference, not a rate'):'no other node is online right now — you set the first price'}catch{$('market').textContent=''}}
for(const id of ['cpu','ram','disk','par','gpu','net','maxmin','price','windows'])$(id).addEventListener('input',()=>{dirty=true;if(id==='cpu')$('cpu-v').textContent=$('cpu').value+' of '+(S?.scan?.cpu_cores??'?');if(id==='ram')$('ram-v').textContent=gb(+$('ram').value)+' of '+gb(S?.scan?.ram_mb);if(id==='disk')$('disk-v').textContent=gb(+$('disk').value)+' of '+gb(S?.scan?.disk_free_mb)+' free';if(id==='par')$('par-v').textContent=$('par').value});
$('pair-hub').addEventListener('change',()=>$('pair-hub-custom').classList.toggle('hide',$('pair-hub').value!=='custom'));
$('pair-go').onclick=async()=>{const hub=$('pair-hub').value==='custom'?$('pair-hub-custom').value.trim():$('pair-hub').value;$('pair-go').disabled=true;$('pair-msg').textContent='checking the key with the hub…';try{const r=await post('/api/pair',{key:$('pair-key').value.trim(),hub,name:$('pair-name').value.trim()});$('pair-msg').innerHTML='<span class=ok>paired as '+(r.name||'')+'</span> — now choose what to share and your price below';dirty=false;await refresh()}catch(e){$('pair-msg').innerHTML='<span class=bad>'+e.message.replace(/</g,'&lt;')+'</span>'}finally{$('pair-go').disabled=false}};
$('offer-go').onclick=async()=>{$('offer-go').disabled=true;$('offer-msg').textContent='sending…';try{const r=await post('/api/offer',{share:{cpu_cores:+$('cpu').value,ram_mb:+$('ram').value,disk_mb:+$('disk').value,gpu:$('gpu').checked,allow_network:$('net').checked,max_parallel_jobs:+$('par').value,max_job_minutes:+$('maxmin').value},price_per_minute_usd:$('price').value===''?null:+$('price').value,windows:$('windows').value});$('offer-msg').innerHTML='<span class=ok>saved · the hub has it'+(r.enabled?' · taking jobs':' · OFF until a price is set')+'</span>';dirty=false;await refresh()}catch(e){$('offer-msg').innerHTML='<span class=bad>'+e.message.replace(/</g,'&lt;')+'</span>'}finally{$('offer-go').disabled=false}};
$('pause-go').onclick=async()=>{try{await post('/api/pause',{paused:!S.paused});await refresh()}catch(e){alert(e.message)}};
$('consent-go').onclick=async()=>{try{await post('/api/consent',{allow_rootful:true});await refresh()}catch(e){alert(e.message)}};
$('unpair-go').onclick=async()=>{if(!confirm('Forget the key? The node stops taking jobs until it is paired again.'))return;try{await post('/api/unpair',{});dirty=false;await refresh()}catch(e){alert(e.message)}};
refresh();logs();market();setInterval(refresh,5000);setInterval(logs,5000);setInterval(market,60000);
</script></body></html>`
