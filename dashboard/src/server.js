// src/server.js
import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;
const DOCKER_API_URL = process.env.DOCKER_API_URL || "http://dsproxy_ro:2375";
const DOCKER_API_VER = process.env.DOCKER_API_VERSION || "v1.51";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

function logDebug(...args){ if (LOG_LEVEL === "debug") console.log("[DEBUG]", ...args); }
function logInfo(...args){ console.log("[INFO]", ...args); }
function logWarn(...args){ console.warn("[WARN]", ...args); }
function logError(...args){ console.error("[ERROR]", ...args); }

app.use(express.static("build"));

function labelsMapToArray(map) {
  if (!map || typeof map !== "object") return [];
  return Object.entries(map).map(([name, value]) => ({ name, value: String(value) }));
}
function formatCpu(nano) {
  const n = Number(nano);
  if (!Number.isFinite(n) || n <= 0) return "";
  return (n / 1e9).toString();
}
function formatMem(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return "";
  const mib = Math.round((b / (1024 * 1024)) * 10) / 10;
  return `${mib}Mi`;
}
function desiredReplicas(spec){
  const mode = (spec && spec.Mode) || {};
  if (mode.Replicated && typeof mode.Replicated.Replicas === "number") return mode.Replicated.Replicas;
  return 0;
}
function computeStateFromStatus(svc){
  const ss = svc.ServiceStatus || {};
  const running = Number(ss.RunningTasks || 0);
  const desired = Number(ss.DesiredTasks || 0);
  if (desired > 0 && running === desired) return "running";
  if (running > 0 && running < desired) return "degraded";
  return "stopped";
}

async function dockerGet(path, params){
  const url = new URL(`${DOCKER_API_URL}/${DOCKER_API_VER}${path}`);
  Object.entries(params || {}).forEach(([k,v]) => url.searchParams.set(k, v));
  logDebug("GET", url.toString());
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await r.text();
  logDebug("HTTP", r.status, text.slice(0, 200));
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function countRunningTasks(serviceID){
  const filters = encodeURIComponent(JSON.stringify({ service: [serviceID], "desired-state": ["running"] }));
  const data = await dockerGet("/tasks", { filters });
  return Array.isArray(data) ? data.length : 0;
}

app.get("/api/services", async (_req, res) => {
  try {
    // Filtra solo i servizi con autoscale.enable=true e chiedi lo status aggregato
    const filters = encodeURIComponent(JSON.stringify({ label: ["autoscale.enable=true"] }));
    let list = await dockerGet("/services", { filters, status: "true" });

    if (!Array.isArray(list)) list = [];
    // Costruisci output e fallback su /tasks se ServiceStatus assente
    const out = await Promise.all(list.map(async (svc) => {
      const spec = svc.Spec || {};
      const tt = spec.TaskTemplate || {};
      const resrc = tt.Resources || {};
      const limits = resrc.Limits || {};
      const reserv = resrc.Reservations || {};

      const cpuLimit = formatCpu(limits.NanoCPUs);
      const ramLimit = formatMem(limits.MemoryBytes);
      const cpuRes = formatCpu(reserv.NanoCPUs);
      const ramRes = formatMem(reserv.MemoryBytes);

      let state = computeStateFromStatus(svc);
      let replicas = (svc.ServiceStatus && svc.ServiceStatus.RunningTasks) || 0;
      if (!svc.ServiceStatus) {
        // Fallback robusto
        replicas = await countRunningTasks(svc.ID);
        state = replicas > 0 ? "running" : "stopped";
      }
      if (!replicas) {
        // ulteriore fallback alle repliche desiderate
        replicas = desiredReplicas(spec);
      }

      return {
        id: svc.ID,
        name: spec.Name || "",
        state,
        replicas,
        labels: labelsMapToArray(spec.Labels || {}),
        resources: {
          limit: { cpu: cpuLimit, memory: ramLimit },
          reservation: { cpu: cpuRes, memory: ramRes },
        },
      };
    }));

    logInfo(`/api/services -> ${out.length} autoscalabili`);
    res.json(out);
  } catch (e) {
    logError("services error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// Diagnostica base
app.get("/api/health", async (_req, res) => {
  try {
    const ping = await fetch(`${DOCKER_API_URL}/_ping`).then(r => r.text()).catch(()=>"");
    const ver = await dockerGet("/version", {});
    res.json({ ok: true, ping, version: ver });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("*", (_req, res) => res.sendFile(process.cwd() + "/build/index.html"));

app.listen(PORT, () => {
  console.log(`Dashboard server listening on :${PORT}`);
});
