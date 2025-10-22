// server.js
import express from 'express';
import compression from 'compression';
import morgan from 'morgan';
import pino from 'pino';
import pinoHttp from 'pino-http';
import http from 'http';
import { URL } from 'url';
import dns from 'node:dns/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// Disabilita compressione solo per SSE
const shouldCompress = (req, res) => {
  if ((req.headers.accept || '').includes('text/event-stream')) return false;
  return compression.filter(req, res);
};
app.use(compression({ filter: shouldCompress }));
app.use(pinoHttp({ logger: log }));
app.use(morgan('tiny'));
app.disable('x-powered-by');

// Config
const MANAGER_API_URL = process.env.MANAGER_API_URL || process.env.DOCKER_API_URL || 'http://dsproxy_rw:2375';
const NODE_PROXY_DNS = process.env.READONLY_PROXY_DNS || 'tasks.dsproxy_ro';
const NODE_PROXY_PORT = parseInt(process.env.READONLY_PROXY_PORT || '2375', 10);
const STATS_INTERVAL = parseInt(process.env.STATS_INTERVAL || '5', 10);
const DEFAULT_API_FALLBACK = process.env.DOCKER_API_VERSION || 'v1.41';

// Stati transitori Swarm (sempre visibili quando presenti)
const TRANSIENT_STATES = new Set(['new','pending','assigned','accepted','preparing','starting','ready']);
// Stati statici non-running (TTL = un ciclo)
const STATIC_NON_RUNNING = new Set(['shutdown','complete','failed','rejected','orphaned','remove']);
// TTL statici in ms
const TRANSIENT_TTL_MS = parseInt(process.env.TRANSIENT_TTL_MS || String(STATS_INTERVAL * 1000), 10);

// Traccia prima vista stati statici
const firstSeenStatic = new Map(); // taskID -> ms

// Healthcheck HTTP
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Runtime-config per le due dashboard
app.get('/swarm/runtime-config.js', (req, res) => {
  res.type('application/javascript').send(`
    window.__RUNTIME_CONFIG__ = {
      BASE_PATH: "/swarm/",
      STATS_INTERVAL: ${Number(process.env.STATS_INTERVAL || 5) * 1000}
    };
  `);
});
app.get('/autoscaler/runtime-config.js', (req, res) => {
  res.type('application/javascript').send(`
    window.__RUNTIME_CONFIG__ = {
      BASE_PATH: "/autoscaler/"
    };
  `);
});

// -------------------- Swarm API backend (prefisso /swarm/api) --------------------
const mgrUrl = (pathAndQuery) => new URL(`${MANAGER_API_URL}/${pathAndQuery}`).toString();
const nodeUrl = (base, pathAndQuery) => new URL(`${base}/${pathAndQuery}`).toString();

let API_PREFIX = DEFAULT_API_FALLBACK;
function parseApi(v){ return (v||'').replace(/^v/,''); }
function cmpApi(a,b){
  const [am,an] = parseApi(a).split('.').map(Number);
  const [bm,bn] = parseApi(b).split('.').map(Number);
  if (am!==bm) return am-bm;
  return (an||0)-(bn||0);
}
async function negotiateApiVersion(){
  try{
    const r = await fetch(mgrUrl('version'), { headers:{Accept:'application/json'} });
    if(!r.ok) throw new Error(`/version -> ${r.status}`);
    const v = await r.json();
    const engine = 'v'+(v?.ApiVersion || parseApi(DEFAULT_API_FALLBACK));
    const desired = process.env.DOCKER_API_VERSION || engine;
    API_PREFIX = cmpApi(desired, engine) <= 0 ? desired : engine;
    log.info({ API_PREFIX }, 'negotiated API version');
  }catch(e){
    API_PREFIX = DEFAULT_API_FALLBACK;
    log.warn({ DEFAULT_API_FALLBACK, err: String(e) }, 'using default API version');
  }
}
await negotiateApiVersion();
const api = (path) => `${API_PREFIX}/${path}`;

// Cache Swarm
let cache = { time: 0, nodes: [], services: [], tasks: [] };

// Client per-nodo
let nodeClientMap = new Map();
async function refreshNodeClientMap(){
  try{
    const addrs = await dns.resolve4(NODE_PROXY_DNS);
    const results = await Promise.allSettled(addrs.map(async ip => {
      const base = `http://${ip}:${NODE_PROXY_PORT}`;
      const v = await fetch(nodeUrl(base, 'version'), { headers:{Accept:'application/json'} });
      if(!v.ok) throw new Error(`version ${ip} -> ${v.status}`);
      const i = await fetch(nodeUrl(base, 'info'), { headers:{Accept:'application/json'} });
      if(!i.ok) throw new Error(`info ${ip} -> ${i.status}`);
      const info = await i.json();
      const nid = info?.Swarm?.NodeID || info?.Name || null;
      return { ip, base, nid };
    }));
    const map = new Map();
    for(const r of results){
      if(r.status==='fulfilled' && r.value?.nid) map.set(r.value.nid, r.value.base);
    }
    if (map.size) {
      nodeClientMap = map;
      log.info({ nodes: map.size }, 'node client map refreshed');
    }
  }catch(e){
    log.warn({ err: String(e) }, 'refreshNodeClientMap failed');
  }
}
await refreshNodeClientMap();
setInterval(refreshNodeClientMap, 60_000);

// Helpers fetch
const fetchMgr = async (path) => {
  const res = await fetch(mgrUrl(path), { headers:{Accept:'application/json'} });
  if(!res.ok){ const txt = await res.text().catch(()=> ''); throw new Error(`mgr ${path} -> ${res.status} ${txt.slice(0,180)}`); }
  return res.json();
};
const fetchNode = async (base, path) => {
  const res = await fetch(nodeUrl(base, path), { headers:{Accept:'application/json'} });
  if(!res.ok){ const txt = await res.text().catch(()=> ''); throw new Error(`node ${base} ${path} -> ${res.status} ${txt.slice(0,180)}`); }
  return res.json();
};

// Stato Swarm
async function refreshState(){
  const [nodesR, servicesR, tasksR] = await Promise.allSettled([
    fetchMgr(api('nodes')),
    fetchMgr(api('services')),
    fetchMgr(api('tasks'))
  ]);
  cache = {
    time: Date.now(),
    nodes: nodesR.status==='fulfilled' ? nodesR.value : [],
    services: servicesR.status==='fulfilled' ? servicesR.value : [],
    tasks: tasksR.status==='fulfilled' ? tasksR.value : []
  };
}

// Stats + Health
const statsMap = new Map(); // containerId -> { cpu, memBytes, health, t, raw }
function calcCpuPercent(curr, prev) {
  const cpuDelta = (curr?.cpu_stats?.cpu_usage?.total_usage || 0) - (prev?.cpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = (curr?.cpu_stats?.system_cpu_usage || 0) - (prev?.cpu_stats?.system_cpu_usage || 0);
  const onlineCPUs = curr?.cpu_stats?.online_cpus || curr?.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  if (cpuDelta > 0 && systemDelta > 0) return (cpuDelta / systemDelta) * onlineCPUs * 100.0;
  return 0;
}
async function sampleContainerStats(nodeId, containerId){
  const base = nodeClientMap.get(nodeId);
  if(!base) return;
  const path = api(`containers/${containerId}/stats?stream=false`);
  const now = Date.now();
  const curr = await fetchNode(base, path);
  const prev = statsMap.get(containerId)?.raw || curr;
  const cpu = calcCpuPercent(curr, prev);
  const memBytes = curr?.memory_stats?.usage || 0;
  const prevEntry = statsMap.get(containerId) || {};
  statsMap.set(containerId, { ...prevEntry, cpu, memBytes, t: now, raw: curr });
}
async function fetchContainerInspect(nodeId, containerId){
  const base = nodeClientMap.get(nodeId);
  if(!base) return null;
  const info = await fetchNode(base, api(`containers/${containerId}/json`));
  return info?.State?.Health?.Status || null;
}

// Helpers naming
function nodeName(n) { return n?.Description?.Hostname || n?.ID || 'node'; }
function role(n) { return (n?.Spec?.Role || '').toLowerCase(); }
function nodeIP(n) {
  const addr = n?.Status?.Addr || '';
  // Se l'indirizzo è valido e diverso da 0.0.0.0, usalo
  if (addr && addr !== '0.0.0.0') return addr;
  // Fallback: per i manager, usa ManagerStatus.Addr e togli la porta (es. 10.10.2.50:2377 -> 10.10.2.50)
  const m = n?.ManagerStatus?.Addr || '';
  if (m) {
    const ip = m.split(':')[0] || '';
    return ip;
  }
  return '';
}
function svcStack(s) { const l = s?.Spec?.Labels || {}; return l['com.docker.stack.namespace'] || l['com.docker.stack.name'] || ''; }
function svcFullName(s) { return s?.Spec?.Name || s?.ID || 'service'; }
function svcNameNoStack(s) {
  const st = svcStack(s); const nm = svcFullName(s);
  return (st && nm.startsWith(st + '_')) ? nm.slice(st.length + 1) : nm;
}
function taskLabel(t, s) {
  const slot = t?.Slot || ''; const base = svcNameNoStack(s);
  return slot ? `${base}.${slot}` : `${base}.${(t?.ID || '').slice(0,12)}`;
}
function taskLabelFull(t, s) {
  const slot = t?.Slot || ''; const base = svcFullName(s);
  return slot ? `${base}.${slot}` : `${base}.${(t?.ID || '').slice(0,12)}`;
}

// Selezione task: running + transitori + statici non-running per un ciclo
function selectTasksForDashboard(allTasks){
  const now = Date.now();
  const out = [];

  for (const t of allTasks) {
    const s = (t?.Status?.State || '').toLowerCase();

    if (s === 'running') {
      firstSeenStatic.delete(t.ID);
      out.push(t);
      continue;
    }
    if (TRANSIENT_STATES.has(s)) {
      firstSeenStatic.delete(t.ID);
      out.push(t);
      continue;
    }
    if (STATIC_NON_RUNNING.has(s)) {
      if (!firstSeenStatic.has(t.ID)) {
        firstSeenStatic.set(t.ID, now);
        out.push(t);
      } else {
        const seen = firstSeenStatic.get(t.ID);
        if (now - seen <= TRANSIENT_TTL_MS) out.push(t);
      }
      continue;
    }
    // fallback: mostra stati “sconosciuti” se recenti
    const ts = t?.Status?.Timestamp || t?.UpdatedAt || t?.Status?.StartedAt || null;
    const recent = ts ? (now - Date.parse(ts)) <= TRANSIENT_TTL_MS : false;
    if (recent) out.push(t);
  }

  // cleanup tracce statiche per task non più presenti
  const ids = new Set(allTasks.map(x => x.ID));
  for (const id of Array.from(firstSeenStatic.keys())) {
    if (!ids.has(id)) firstSeenStatic.delete(id);
  }

  return out;
}

// /swarm/api/state
app.get('/swarm/api/state', async (req, res) => {
  try{
    if (Date.now() - cache.time > 2000) await refreshState();

    const tasksDash = selectTasksForDashboard(cache.tasks);

    // KPI nodo: somma solo dei running
    const running = cache.tasks.filter(t => (t?.Status?.State || '').toLowerCase() === 'running');
    const byNodeUsage = new Map();
    for(const t of running){
      const cid = t?.Status?.ContainerStatus?.ContainerID;
      if(!cid) continue;
      const s = statsMap.get(cid);
      if(!s) continue;
      if(!byNodeUsage.has(t.NodeID)) byNodeUsage.set(t.NodeID, { cpu:0, memBytes:0 });
      const acc = byNodeUsage.get(t.NodeID);
      acc.cpu += s.cpu || 0;
      acc.memBytes += s.memBytes || 0;
    }

    const svcById = new Map(cache.services.map(s => [s.ID, s]));

    res.json({
      time: Date.now(),
      nodes: cache.nodes.map(n => ({
        ID: n.ID,
        name: nodeName(n),
        role: role(n),
        ip: nodeIP(n),
        leader: !!(n.ManagerStatus && n.ManagerStatus.Leader),
        cpu: (byNodeUsage.get(n.ID)?.cpu || 0),
        memBytes: (byNodeUsage.get(n.ID)?.memBytes || 0)
      })),
      services: cache.services.map(s => ({
        ID: s.ID,
        name: svcFullName(s),
        nameNoStack: svcNameNoStack(s),
        stack: svcStack(s),
        mode: s?.Spec?.Mode?.Global ? 'global' : 'replicated'
      })),
      tasks: tasksDash.map(t => {
        const svc = svcById.get(t.ServiceID);
        return {
          ID: t.ID,
          NodeID: t.NodeID,
          ServiceID: t.ServiceID,
          State: t?.Status?.State || '',
          DesiredState: t?.DesiredState || '',
          Timestamp: t?.Status?.Timestamp || t?.UpdatedAt || t?.Status?.StartedAt || null,
          Label: taskLabel(t, svc),
          LabelFull: taskLabelFull(t, svc),
          ContainerID: t?.Status?.ContainerStatus?.ContainerID || null
        };
      }),
      stats: Object.fromEntries(Array.from(statsMap.entries())
        .map(([cid, v]) => [cid, { cpu: v.cpu, memBytes: v.memBytes, health: v.health || null, t: v.t }]))
    });
  }catch(e){
    log.error({ err: String(e) }, 'swarm/api/state error');
    res.status(500).json({ error: e.message });
  }
});

// /swarm/api/events (SSE)
app.get('/swarm/api/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`retry: 10000\n\n`);

  const hb = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 15000);
  let closed = false;
  req.on('close', () => { closed = true; clearInterval(hb); });

  const url = mgrUrl(api(`events?filters=${encodeURIComponent(JSON.stringify({
    type: ['task','service','node']
  }))}`));

  try{
    const upstream = await fetch(url);
    if(!upstream.ok || !upstream.body) throw new Error(`/events ${upstream.status}`);
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let nextId = 1;

    while(!closed){
      const { value, done } = await reader.read();
      if(done) break;
      buf += dec.decode(value, { stream:true });
      let i;
      while((i = buf.indexOf('\n')) >= 0){
        const line = buf.slice(0,i).trim();
        buf = buf.slice(i+1);
        if(!line) continue;
        res.write(`id: ${nextId}\n`);
        res.write(`data: ${line}\n\n`);
        nextId++;
      }
    }
  }catch(e){
    try { res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`); } catch {}
  }finally{
    clearInterval(hb);
    try { res.end(); } catch {}
  }
});

// Sampling periodico: stats+health per running e transitori
setInterval(async () => {
  try{
    if (!cache.tasks?.length) await refreshState();

    const interesting = cache.tasks.filter(t => {
      const s = (t?.Status?.State || '').toLowerCase();
      return s === 'running' || TRANSIENT_STATES.has(s);
    });

    if (!nodeClientMap.size) await refreshNodeClientMap();

    const idsByNode = new Map();
    for(const t of interesting){
      const cid = t?.Status?.ContainerStatus?.ContainerID;
      if(!cid) continue;
      if(!idsByNode.has(t.NodeID)) idsByNode.set(t.NodeID, []);
      idsByNode.get(t.NodeID).push(cid);
    }

    const batch = 6;
    for(const [nid, list] of idsByNode.entries()){
      const base = nodeClientMap.get(nid);
      if(!base) continue;

      for(let i=0;i<list.length;i+=batch){
        await Promise.allSettled(list.slice(i,i+batch).map(async cid => {
          await sampleContainerStats(nid, cid);
          try{
            const h = await fetchContainerInspect(nid, cid);
            const prev = statsMap.get(cid) || {};
            statsMap.set(cid, { ...prev, health: h });
          }catch{}
        }));
      }
    }
  }catch(e){
    log.warn({ err: String(e) }, 'stats sampler error');
  }
}, STATS_INTERVAL * 1000);

// -------------------- Static mounts --------------------
// Swarm dashboard
app.use('/swarm', express.static(path.join(__dirname, 'swarm', 'public'), { extensions: ['html'] }));
app.use('/autoscaler', express.static(path.join(__dirname, 'autoscaler', 'public'), { extensions: ['html'] }));

// Fallback SPA: evita asset (.estensione) e API
app.get('/swarm/*', (req, res, next) => {
  const p = req.path || '';
  if (p.startsWith('/swarm/api/')) return next();
  if (p.includes('.')) return next();
  res.sendFile(path.join(__dirname, 'swarm', 'public', 'index.html'));
});

app.get('/autoscaler/*', (req, res, next) => {
  const p = req.path || '';
  if (p.includes('.')) return next();
  if (p.startsWith('/autoscaler/api/')) return next();
  res.sendFile(path.join(__dirname, 'autoscaler', 'public', 'index.html'));
});

app.get('/autoscaler/api/services', async (req, res) => {
  try {
    if (Date.now() - cache.time > 2000) await refreshState(); // riusa la tua cache Swarm
    // Mappa servizio -> task running
    const runningBySvc = new Map();
    for (const t of cache.tasks) {
      const st = (t?.Status?.State || '').toLowerCase();
      if (st === 'running') {
        if (!runningBySvc.has(t.ServiceID)) runningBySvc.set(t.ServiceID, 0);
        runningBySvc.set(t.ServiceID, runningBySvc.get(t.ServiceID) + 1);
      }
    }
    const services = cache.services.map(s => {
      const id = s.ID;
      const name = s?.Spec?.Name || '';
      const labelsObj = s?.Spec?.Labels || {};
      const labels = Object.entries(labelsObj).map(([name, value]) => ({ name, value }));
      const mode = s?.Spec?.Mode || {};
      const desired = mode?.Replicated?.Replicas ?? (mode?.Global ? cache.nodes.length : 0);
      const replicas = runningBySvc.get(id) || 0;
      const state = replicas === 0 ? 'stopped' : (replicas === desired ? 'running' : 'degraded');
      const limits = s?.Spec?.TaskTemplate?.Resources?.Limits || {};
      const reserv = s?.Spec?.TaskTemplate?.Resources?.Reservations || {};
      const toCores = n => (n ? n / 1e9 : "");       // NanoCPUs -> cores
      const cpuLimit = toCores(limits.NanoCPUs);
      const ramLimit = limits.MemoryBytes || "";
      const cpuRes   = toCores(reserv.NanoCPUs);
      const ramRes   = reserv.MemoryBytes || "";
      return {
        id,
        name,
        state,
        replicas,
        labels,
        resources: {
          limit: { cpu: cpuLimit, memory: ramLimit },
          reservation: { cpu: cpuRes, memory: ramRes }
        }
      };
    });
    res.json(services);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
// Avvio
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => log.info({ PORT, MANAGER_API_URL, NODE_PROXY_DNS, API_PREFIX, STATS_INTERVAL, TRANSIENT_TTL_MS }, 'unified dashboards up'));
