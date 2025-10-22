const BASE_PATH = (window.__RUNTIME_CONFIG__ && window.__RUNTIME_CONFIG__.BASE_PATH) || '/swarm/';
const STATS_MS = (window.__RUNTIME_CONFIG__ && window.__RUNTIME_CONFIG__.STATS_INTERVAL) || 5000;

const $hdr = document.getElementById('matrix-header');
const $body = document.getElementById('matrix-body');
const $status = document.getElementById('status');
const $stream = document.getElementById('stream-indicator');
const $clock = document.getElementById('clock');
const $selStack = document.getElementById('stack-filter');

let lastState = null;
let lastFooter = { time: null, services: 0, nodes: 0 };

// transizioni
const transitionsByTask = new Map();
const pendingTransition = new Map();
const MAX_TRANSITIONS = 3;

// Aggiornamento età task
const AGE_TICK_MS = 1000;

function parseTs(ts) {
  // ts ISO: usa Timestamp o StartedAt come fallback
  if (!ts) return NaN;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : NaN;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

function computeAgeText(ts) {
  const t0 = parseTs(ts);
  if (!Number.isFinite(t0)) return '—';
  return fmtDuration(Date.now() - t0);
}

// Aggiorna tutti i badge di età presenti nel DOM
function updateAllAges() {
  const ages = document.querySelectorAll('.pill .bot .age');
  const now = Date.now();
  for (const el of ages) {
    const ts = el.getAttribute('data-ts') || '';
    const t0 = parseTs(ts);
    const txt = Number.isFinite(t0) ? fmtDuration(now - t0) : '—';
    el.textContent = txt;
  }
}
setInterval(updateAllAges, AGE_TICK_MS);

function fmtMB(b){ return Math.round((b||0)/1024/1024) + 'MB'; }
function fmtCPU(x){ return `${Math.round(((x||0))*10)/10}%`; }
function nowISO(){ const d = new Date(); return d.toISOString().slice(0,19).replace('T',' '); }
setInterval(()=>{ if($clock) $clock.textContent = nowISO(); }, 1000);

async function j(path){ const r = await fetch(BASE_PATH+path, { cache:'no-store' }); if(!r.ok) throw new Error(`${path} -> ${r.status}`); return r.json(); }

function sortNodesForColumns(nodes){
  const man = nodes.filter(n => (n.role||'').toLowerCase()==='manager').sort((a,b)=> a.name.localeCompare(b.name));
  const wor = nodes.filter(n => (n.role||'').toLowerCase()!=='manager').sort((a,b)=> a.name.localeCompare(b.name));
  return [...man, ...wor];
}
function gridTemplateCols(n){
  const root = getComputedStyle(document.documentElement);
  const svc = root.getPropertyValue('--svc-col') || '240px';
  const tl  = root.getPropertyValue('--tl-col')  || '32px';
  return `${svc.trim()} ${tl.trim()} repeat(${n}, minmax(0, 1fr))`;
}
function renderHeader(nodes){
  const cols = gridTemplateCols(nodes.length);
  $hdr.style.gridTemplateColumns = cols;
  const cells = [`<div class="hcell"></div>`,`<div class="hcell"></div>`];
  for(const n of nodes){
    cells.push(`
      <div class="hcell node ${n.role} ${n.leader ? 'leader' : ''}">
        <div class="name">${n.name}</div>
        <div class="meta">${n.role}${n.leader ? ' (leader)' : ''} • ${n.ip || ''}</div>
        <div class="kpi">cpu: ${fmtCPU(n.cpu)} | mem: ${fmtMB(n.memBytes)}</div>
      </div>
    `);
  }
  $hdr.innerHTML = cells.join('');
}
function stateClassFor(s){
  const x=(s||'').toLowerCase();
  if(['failed','rejected'].includes(x)) return 'st-failed';
  if(['shutdown'].includes(x)) return 'st-shutdown';
  if(['complete'].includes(x)) return 'st-complete';
  if(['pending','assigned','accepted'].includes(x)) return 'st-pending';
  if(['preparing','starting','ready'].includes(x)) return 'st-starting';
  return 'st-running';
}
function pillHTML(task, stat){
  const cpu = fmtCPU(stat?.cpu);
  const mem = fmtMB(stat?.memBytes);
  const title = task.Label;
  const state = (task.State || '').toLowerCase();
  const pend = pendingTransition.get(task.ID);
  const isTrans = !!(pend && pend.to !== state);

  const classes = ['pill', stateClassFor(state)];
  if (isTrans) classes.push('is-transition');

  // Timestamp del task dall'API (server già lo espone come Timestamp)
  const ts = task.Timestamp || '';

  return `
    <div class="${classes.join(' ')}" data-task-id="${task.ID}" data-container-id="${task.ContainerID || ''}" title="${task.LabelFull || title}">
      <div class="top">
        <span class="chip cpu">cpu: ${cpu}</span>
        <span class="chip mem">mem: ${mem}</span>
      </div>
      <div class="mid">${title}</div>
      <div class="bot">
        <span class="state">${state}</span>
        <span class="age" data-ts="${ts}">${computeAgeText(ts)}</span>
      </div>
    </div>
  `;
}
function renderBody(st, nodes, activeStack){
  const cols = gridTemplateCols(nodes.length);
  $body.style.gridTemplateColumns = cols;

  const bySvc = new Map();
  for(const t of st.tasks){
    if(!bySvc.has(t.ServiceID)) bySvc.set(t.ServiceID, []);
    bySvc.get(t.ServiceID).push(t);
  }

  const services = [...st.services].sort((a,b)=>{
    const A=(a.stack||'')+(a.nameNoStack||a.name||''); const B=(b.stack||'')+(b.nameNoStack||b.name||'');
    return A.localeCompare(B);
  });

  const grouped = new Map();
  for(const s of services){
    if(activeStack && activeStack!=='__all__' && s.stack!==activeStack) continue;
    const k = s.stack || '(no-stack)';
    if(!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(s);
  }

  const stats = st.stats || {};
  const rows = [];
  for(const [stack, list] of grouped.entries()){
    rows.push(`<div class="stack-sep">${stack}</div>`);
    for(const s of list){
      const svcCell = `
        <div class="cell svc">
          <div class="svcwrap">
            <div class="svcname" title="${s.nameNoStack || s.name}">${s.nameNoStack || s.name}</div>
            <div class="svcstack">${stack}</div>
          </div>
        </div>`;
      const tlCell  = `<div class="cell tl"><span class="vline"></span></div>`;

      const Ts = bySvc.get(s.ID) || [];
      const byNode = new Map();
      for(const t of Ts){
        if(!byNode.has(t.NodeID)) byNode.set(t.NodeID, []);
        byNode.get(t.NodeID).push(t);
      }

      const taskCells = nodes.map(n=>{
        const NT = byNode.get(n.ID) || [];
        if(!NT.length) return `<div class="cell task"></div>`;
        const pills = NT.map(t => pillHTML(t, stats[t.ContainerID])).join('');
        return `<div class="cell task">${pills}</div>`;
      }).join('');

      rows.push(svcCell + tlCell + taskCells);
    }
  }
  $body.innerHTML = rows.join('');
}
function patchPills(st){
  if (!st || !st.tasks) return;

  const stats = st.stats || {};
  const byTask = new Map(st.tasks.map(t => [t.ID, t]));
  const pills = Array.from(document.querySelectorAll('#matrix-body .pill'));

  for (const el of pills) {
    const tid = el.getAttribute('data-task-id');
    const cid = el.getAttribute('data-container-id');

    const t = byTask.get(tid);
    if (!t) {
      el.remove();
      pendingTransition.delete(tid);
      continue;
    }

    const stt = cid ? stats[cid] : null;
    const cpuEl = el.querySelector('.chip.cpu');
    const memEl = el.querySelector('.chip.mem');
    if (stt && cpuEl) cpuEl.textContent = `cpu: ${fmtCPU(stt.cpu)}`;
    if (stt && memEl) memEl.textContent = `mem: ${fmtMB(stt.memBytes)}`;

    const state = (t.State || '').toLowerCase();
    const stateEl = el.querySelector('.bot .state');
    if (stateEl) stateEl.textContent = state;

    // classi stato/transizione
    el.classList.remove('is-transition','st-running','st-shutdown','st-failed','st-complete','st-pending','st-starting');
    el.classList.add(stateClassFor(state));
    const pend = pendingTransition.get(tid);
    if (pend && pend.to !== state) el.classList.add('is-transition');
    else if (pend && pend.to === state) pendingTransition.delete(tid);

    // health bordo
    const h = (stt && stt.health) ? String(stt.health).toLowerCase() : null;
    el.classList.remove('health-healthy','health-unhealthy','health-starting');
    if (h === 'healthy')      el.classList.add('health-healthy');
    else if (h === 'unhealthy') el.classList.add('health-unhealthy');
    else if (h === 'starting')  el.classList.add('health-starting');

    // timestamp + età
    const ageEl = el.querySelector('.bot .age');
    if (ageEl) {
      const ts = t.Timestamp || '';
      ageEl.setAttribute('data-ts', ts);
      ageEl.textContent = computeAgeText(ts);
    }
  }
}
function updateFooter(){
  if (lastFooter.time) {
    const t = new Date(lastFooter.time).toLocaleTimeString();
    $status.textContent = `Aggiornato: ${t} • Servizi: ${lastFooter.services} • Nodi: ${lastFooter.nodes}`;
  }
}
const debouncedReload = (()=>{ let t; return ()=>{ clearTimeout(t); t=setTimeout(()=>loadState(true), 200); }; })();

async function loadState(full = true){
  const st = await j('api/state');
  lastState = st;
  lastFooter = { time: st.time, services: st.services.length, nodes: st.nodes.length };
  updateFooter();

  if (full || !$body.children.length) {
    const nodes = sortNodesForColumns(st.nodes);
    renderHeader(nodes);
    populateStackFilter(st.services);
    renderBody(st, nodes, $selStack.value || '__all__');
  } else {
    patchPills(st);
  }
}

let es=null, reconnectTimer=null, backoffMs=2000;
function openSSE(){
  es = new EventSource(BASE_PATH + 'api/events');
  es.onopen = ()=>{ if($stream) $stream.textContent='Event stream connesso'; };
  es.onmessage = (e)=>{
    try{
      const msg = JSON.parse(e.data);
      const type = (msg?.Type || '').toLowerCase();
      if (type === 'task') {
        const tid = msg?.Actor?.ID;
        const curr = (msg?.Actor?.Attributes?.state || '').toLowerCase();
        if (tid && curr) {
          const arr = transitionsByTask.get(tid) || [];
          const prev = arr.length ? arr[arr.length-1].to : null;
          const tr = { from: prev || '?', to: curr, t: Date.now() };
          if (!prev || prev !== curr) {
            arr.push(tr); if (arr.length>12) arr.shift();
            transitionsByTask.set(tid, arr); pendingTransition.set(tid, tr);
          }
        }
        debouncedReload();
      } else if (type === 'service' || type === 'node') {
        debouncedReload();
      } else {
        loadState(false).catch(()=>{});
      }
    }catch{ loadState(false).catch(()=>{}); }
  };
  es.onerror = ()=>{
    if (es && es.readyState !== EventSource.CLOSED) es.close();
    if ($stream) $stream.textContent='Event stream: riconnessione…';
    clearTimeout(reconnectTimer);
    const jitter = Math.floor(Math.random()*500);
    reconnectTimer = setTimeout(openSSE, backoffMs + jitter);
    backoffMs = Math.min(backoffMs*2, 30000);
  };
}

setInterval(()=>{ if(document.visibilityState==='visible') loadState(false).catch(()=>{}); }, STATS_MS);

function populateStackFilter(services){
  const stacks = Array.from(new Set(services.map(s => s.stack || '(no-stack)'))).sort();
  const cur = $selStack.value || '__all__';
  $selStack.innerHTML = `<option value="__all__">Tutti</option>` + stacks.map(s=>`<option value="${s}">${s}</option>`).join('');
  if (Array.from($selStack.options).some(o => o.value===cur)) $selStack.value = cur;
}
$selStack.addEventListener('change', ()=>{
  if (!lastState) return;
  const nodes = sortNodesForColumns(lastState.nodes);
  renderBody(lastState, nodes, $selStack.value || '__all__');
});

(async function main(){
  try{
    if($clock) $clock.textContent = nowISO();
    await loadState(true);
    openSSE();
  }catch(e){
    console.error(e);
    if($status) $status.textContent = 'Errore: ' + e.message;
  }
})();
