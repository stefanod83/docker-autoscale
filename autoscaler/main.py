import os, asyncio, aiohttp, logging, json, socket, time, smtplib
import yaml
from email.mime.text import MIMEText
from utils import cpu_percent_v151, mem_percent, avg, parse_cpuset

# -----------------------
# Config e logging
# -----------------------
LOG_LEVEL = os.getenv("LOG_LEVEL","info").upper()
logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO),
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("autoscaler")

READONLY_DNS = os.getenv("READONLY_PROXY_DNS","tasks.dsproxy_ro")
READONLY_PORT = int(os.getenv("READONLY_PROXY_PORT","2375"))
MANAGER_PROXY = os.getenv("MANAGER_PROXY_HOST","http://dsproxy_rw:2375").rstrip("/")
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL","15"))
DEFAULT_COOLDOWN = int(os.getenv("DEFAULT_COOLDOWN","120"))
LABEL_PREFIX = os.getenv("LABEL_PREFIX","autoscale")
DEFAULT_MIN = int(os.getenv("DEFAULT_MIN_REPLICAS","1"))
DEFAULT_MAX = int(os.getenv("DEFAULT_MAX_REPLICAS","50"))

SMTP_CONFIG_PATH = os.getenv("SMTP_CONFIG_PATH", "/config/smtp.yml")

# Stato runtime (globali del modulo)
last_scale_ts = {}     # svc_id -> timestamp ultimo scale
pending_down = {}      # svc_id -> asyncio.Task
smtp_conf = {}         # config SMTP caricata
notifier = None        # istanza EmailNotifier

# -----------------------
# Utilità HTTP/API
# -----------------------
def resolve_ro_proxies():
    ips = set()
    try:
        for res in socket.getaddrinfo(READONLY_DNS, READONLY_PORT, proto=socket.IPPROTO_TCP):
            ip = res[4][0]
            ips.add(ip)
    except Exception as e:
        log.warning(f"DNS resolution failed for {READONLY_DNS}: {e}")
    return [f"http://{ip}:{READONLY_PORT}" for ip in sorted(ips)]

async def http_get_json(session, base, path, params=None, timeout=15):
    url = f"{base}{path}"
    async with session.get(url, params=params, timeout=timeout) as r:
        text = await r.text()
        if r.status >= 400:
            raise RuntimeError(f"GET {url} -> {r.status} {text}")
        try:
            return json.loads(text)
        except:
            return text

async def http_post_json(session, base, path, params=None, json_body=None, timeout=30):
    url = f"{base}{path}"
    async with session.post(url, params=params, json=json_body, timeout=timeout) as r:
        text = await r.text()
        if r.status >= 400:
            raise RuntimeError(f"POST {url} -> {r.status} {text}")
        try:
            return json.loads(text)
        except:
            return text

async def build_nodeid_to_proxy(session, ro_bases):
    mapping = {}
    for base in ro_bases:
        try:
            info = await http_get_json(session, base, "/info")
            node_id = (info.get("Swarm") or {}).get("NodeID")
            if node_id:
                mapping[node_id] = base
                log.debug(f"Proxy {base} -> NodeID {node_id}")
        except Exception as e:
            log.warning(f"/info failed on {base}: {e}")
    return mapping

def read_label(labels, key, default=None, cast=str):
    val = labels.get(f"{LABEL_PREFIX}.{key}")
    if val is None:
        return default
    try:
        return cast(val)
    except Exception:
        return default

async def list_target_services(session):
    filters = {"label": [f"{LABEL_PREFIX}.enable=true"]}
    params = {"filters": json.dumps(filters)}
    return await http_get_json(session, MANAGER_PROXY, "/services", params=params)

async def list_running_tasks(session, service_id):
    filters = {"service": [service_id], "desired-state": ["running"]}
    params = {"filters": json.dumps(filters)}
    return await http_get_json(session, MANAGER_PROXY, "/tasks", params=params)

async def container_stats_once(session, base, cid):
    params = {"stream": "false"}  # niente one-shot: consente precpu_stats
    return await http_get_json(session, base, f"/containers/{cid}/stats", params=params)

async def container_inspect(session, base, cid):
    return await http_get_json(session, base, f"/containers/{cid}/json")

async def exec_create(session, base, cid, cmd):
    body = {
        "AttachStdin": False,
        "AttachStdout": True,
        "AttachStderr": True,
        "Tty": False,
        "Cmd": ["/bin/sh","-c", cmd],
    }
    return await http_post_json(session, base, f"/containers/{cid}/exec", json_body=body)

async def exec_start(session, base, exec_id):
    return await http_post_json(session, base, f"/exec/{exec_id}/start",
                                json_body={"Detach": False, "Tty": False})

async def exec_inspect(session, base, exec_id):
    return await http_get_json(session, base, f"/exec/{exec_id}/json")

async def container_stop(session, base, cid, timeout_sec=30):
    params = {"timeout": str(int(timeout_sec))}
    await http_post_json(session, base, f"/containers/{cid}/stop", params=params)

async def get_service_spec_and_version(session, service_id):
    svc = await http_get_json(session, MANAGER_PROXY, f"/services/{service_id}")
    spec = svc.get("Spec") or {}
    version = (svc.get("Version") or {}).get("Index")
    return spec, version

async def update_service_replicas(session, service_id, new_replicas, max_retries=3):
    for attempt in range(max_retries):
        spec, version = await get_service_spec_and_version(session, service_id)
        mode = spec.get("Mode") or {}
        if "Replicated" not in mode:
            log.warning(f"Service {service_id} not replicated; skipping")
            return
        mode["Replicated"]["Replicas"] = int(new_replicas)
        spec["Mode"] = mode
        try:
            await http_post_json(session, MANAGER_PROXY,
                                 f"/services/{service_id}/update",
                                 params={"version": version}, json_body=spec)
            log.info(f"Scaled {service_id} -> replicas={new_replicas}")
            return
        except Exception as e:
            msg = str(e)
            if "out of sequence" in msg and attempt < max_retries - 1:
                log.warning(f"Version conflict scaling {service_id}, retrying ({attempt+1})")
                await asyncio.sleep(0.5)
                continue
            raise

# -----------------------
# CPU limit helpers
# -----------------------
def service_limit_cpus_from_spec(spec):
    tt = (spec or {}).get("TaskTemplate") or {}
    res = (tt.get("Resources") or {}).get("Limits") or {}
    nano = res.get("NanoCPUs") or 0
    if nano and nano > 0:
        return float(nano) / 1e9
    return 0.0

def limit_cpus_from_inspect(ins):
    hc = (ins.get("HostConfig") or {})
    nano = hc.get("NanoCpus") or hc.get("NanoCPUs") or 0
    if nano and nano > 0:
        return float(nano) / 1e9
    quota = hc.get("CpuQuota") or 0
    period = hc.get("CpuPeriod") or 0
    if quota and period and period > 0:
        return float(quota) / float(period)
    cpuset = hc.get("CpusetCpus") or ""
    cnt = parse_cpuset(cpuset)
    if cnt > 0:
        return float(cnt)
    return 0.0

def online_cpus_from_stats(stats):
    cpu = stats.get("cpu_stats", {}) or {}
    oc = cpu.get("online_cpus")
    try:
        return float(oc) if oc else 0.0
    except:
        return 0.0

def normalize_cpu_percent(raw_pct: float, limit_cpus: float) -> float:
    if limit_cpus <= 0:
        return max(0.0, min(100.0, raw_pct))
    return max(0.0, min(100.0, raw_pct / limit_cpus))

# -----------------------
# Email notifier con batching
# -----------------------
def load_smtp_config():
    try:
        with open(SMTP_CONFIG_PATH, "r") as f:
            return yaml.safe_load(f) or {}
    except Exception as e:
        log.warning(f"SMTP config not loaded: {e}")
        return {}

class EmailNotifier:
    def __init__(self, conf: dict):
        self.enabled = bool(conf.get("enabled", False))
        self.conf = conf
        self.queue = []
        self.lock = asyncio.Lock()
        self.next_flush = time.time() + float(conf.get("batch_window_seconds", 300) or 0)
        self.max_batch = int(conf.get("max_batch_events", 100) or 100)
        self.running = False

    def _smtp_send_sync(self, subject: str, body: str, to_list: list):
        smtp = self.conf.get("smtp", {}) or {}
        host = smtp.get("host")
        port = int(smtp.get("port", 587))
        starttls = bool(smtp.get("starttls", True))
        user = smtp.get("username")
        pwd = smtp.get("password")
        from_addr = self.conf.get("from")
        if not (host and from_addr and to_list):
            return
        msg = MIMEText(body, "plain", "utf-8")
        prefix = self.conf.get("subject_prefix","[Swarm Autoscaler]")
        msg["Subject"] = f"{prefix} Autoscaling events"
        msg["From"] = from_addr
        msg["To"] = ", ".join(to_list)
        with smtplib.SMTP(host, port, timeout=20) as s:
            if starttls:
                s.starttls()
            if user and pwd:
                s.login(user, pwd)
            s.sendmail(from_addr, to_list, msg.as_string())

    async def send_email(self, subject: str, body: str, to_list: list):
        try:
            await asyncio.to_thread(self._smtp_send_sync, subject, body, to_list)
            log.info(f"email sent to {to_list}")
        except Exception as e:
            log.error(f"email send failed: {e}")

    async def flush_if_due(self, force=False):
        async with self.lock:
            now = time.time()
            if not self.queue:
                self.next_flush = now + float(self.conf.get("batch_window_seconds", 300) or 0)
                return
            if not force and now < self.next_flush and len(self.queue) < self.max_batch:
                return
            default_rcpts = self.conf.get("to_default") or []
            buckets = {}
            for ev in self.queue:
                rcpts = ev.get("to") or default_rcpts
                key = ",".join(sorted(rcpts)) if rcpts else "_none"
                buckets.setdefault(key, {"rcpts": rcpts, "items": []})
                buckets[key]["items"].append(ev)
            for key, b in buckets.items():
                if not b["rcpts"]:
                    continue
                lines = []
                for ev in b["items"]:
                    lines.append(
                        f"{ev['ts_iso']} | {ev['action']} | {ev['service']} ({ev['service_id']}) "
                        f"{ev['old']} -> {ev['new']} | cpu={ev['cpu']:.1f}% mem={ev['mem']:.1f}% | reason={ev['reason']}"
                    )
                body = "\n".join(lines)
                await self.send_email("Autoscaling events", body, b["rcpts"])
            self.queue.clear()
            self.next_flush = now + float(self.conf.get("batch_window_seconds", 300) or 0)

    async def run_flush_loop(self):
        self.running = True
        while self.running:
            try:
                await self.flush_if_due()
            except Exception as e:
                log.error(f"flush loop error: {e}")
            await asyncio.sleep(2)

    async def enqueue(self, ev: dict):
        if not self.enabled:
            return
        async with self.lock:
            self.queue.append(ev)
            if len(self.queue) >= self.max_batch:
                self.next_flush = 0  # trigger flush

def email_enabled_for_service(labels: dict, default=True):
    raw = labels.get(f"{LABEL_PREFIX}.notify.email.enable")
    if raw is None:
        return default
    return str(raw).lower() == "true"

def recipients_for_service(labels: dict, conf: dict):
    raw = labels.get(f"{LABEL_PREFIX}.notify.email.to")
    if raw:
        return [e.strip() for e in raw.split(",") if e.strip()]
    return conf.get("to_default") or []

def iso_now():
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())

# -----------------------
# Scale-down “graceful”
# -----------------------
async def graceful_scale_down(session, node_map, service_id, spec, name, labels, tasks,
                              pre_cmd, pre_timeout, stop_timeout):
    t = next((x for x in tasks), None)
    if not t:
        log.warning(f"{service_id} no running tasks to scale down")
        return
    nid = t.get("NodeID")
    base = node_map.get(nid)
    cid = ((t.get("Status") or {}).get("ContainerStatus") or {}).get("ContainerID")
    if not base or not cid:
        log.warning(f"{service_id} missing base/cid for task")
        return

    try:
        if pre_cmd:
            log.info(f"{name} pre-stop exec on {cid}: {pre_cmd}")
            ex = await exec_create(session, base, cid, pre_cmd)
            ex_id = ex.get("Id") or ex.get("ID")
            if not ex_id:
                raise RuntimeError("exec create failed: no id")
            await exec_start(session, base, ex_id)
            deadline = time.time() + pre_timeout
            while time.time() < deadline:
                info = await exec_inspect(session, base, ex_id)
                if info.get("Running") is False:
                    code = info.get("ExitCode", 0)
                    if code != 0:
                        raise RuntimeError(f"pre-stop command exit {code}")
                    break
                await asyncio.sleep(1.0)
            else:
                raise RuntimeError("pre-stop timeout")

        await container_stop(session, base, cid, timeout_sec=stop_timeout)

        cur = int(((spec.get("Mode") or {}).get("Replicated") or {}).get("Replicas", 1))
        new_repl = max(cur - 1, 0)
        await update_service_replicas(session, service_id, new_repl)

        # notifica email
        if notifier and email_enabled_for_service(labels, default=bool(smtp_conf.get("enabled", False))):
            to = recipients_for_service(labels, smtp_conf)
            ev = {
                "ts_iso": iso_now(),
                "service": name, "service_id": service_id,
                "action": "scale_down", "old": cur, "new": new_repl,
                "cpu": 0.0, "mem": 0.0,
                "reason": "graceful scale-down completed",
                "to": to
            }
            await notifier.enqueue(ev)

    except Exception as e:
        log.error(f"{service_id} graceful scale-down failed: {e}")
    finally:
        pending = pending_down.pop(service_id, None)
        if pending and not pending.cancelled():
            pass

# -----------------------
# Riconciliazione per servizio
# -----------------------
async def reconcile_service(session, node_map, svc):
    svc_id = svc.get("ID")
    spec = svc.get("Spec") or {}
    labels = spec.get("Labels") or {}
    name = spec.get("Name")

    cpu_max = read_label(labels, "cpu.max", 80, int)
    cpu_min = read_label(labels, "cpu.min", 20, int)
    mem_max = read_label(labels, "mem.max", 80, int)
    mem_min = read_label(labels, "mem.min", 20, int)
    min_rep = read_label(labels, "min", DEFAULT_MIN, int)
    max_rep = read_label(labels, "max", DEFAULT_MAX, int)
    cooldown = read_label(labels, "cooldown", DEFAULT_COOLDOWN, int)

    # Nuove label: controllo scale down e pre-stop
    scale_down_enabled = read_label(labels, "scale_down.enable", True, lambda v: str(v).lower() != "false")
    pre_cmd = read_label(labels, "pre_stop.cmd", "", str)
    pre_timeout = read_label(labels, "pre_stop.timeout", 600, int)
    stop_timeout = read_label(labels, "stop.timeout", 30, int)

    mode = (spec.get("Mode") or {}).get("Replicated") or {}
    desired = int(mode.get("Replicas", 1))

    svc_limit_cpus = service_limit_cpus_from_spec(spec)

    tasks = await list_running_tasks(session, svc_id)
    cpu_vals, mem_vals = [], []
    for t in tasks:
        st = t.get("Status") or {}
        cs = st.get("ContainerStatus") or {}
        cid = cs.get("ContainerID")
        nid = t.get("NodeID")
        base = node_map.get(nid)
        if not cid or not base:
            continue
        try:
            s = await container_stats_once(session, base, cid)
            raw_cpu = cpu_percent_v151(s)
            limit_cpus = svc_limit_cpus
            if limit_cpus <= 0:
                try:
                    ins = await container_inspect(session, base, cid)
                    limit_cpus = limit_cpus_from_inspect(ins)
                except Exception:
                    limit_cpus = 0.0
            if limit_cpus <= 0:
                oc = online_cpus_from_stats(s)
                if oc > 0:
                    limit_cpus = oc
            norm_cpu = normalize_cpu_percent(raw_cpu, limit_cpus)
            cpu_vals.append(norm_cpu)
            mem_vals.append(mem_percent(s))
        except Exception as e:
            log.debug(f"stats/inspect failed for {cid}@{base}: {e}")

    avg_cpu = avg(cpu_vals)
    avg_mem = avg(mem_vals)
    log.info(f"{name} cpu={avg_cpu:.1f}% mem={avg_mem:.1f}% desired={desired} running={len(tasks)}")

    now = time.time()
    last = last_scale_ts.get(svc_id, 0)
    can_scale = (now - last) >= cooldown and svc_id not in pending_down

    new_replicas = desired
    need_up = (avg_cpu > cpu_max) or (avg_mem > mem_max)
    need_down = (avg_cpu < cpu_min) and (avg_mem < mem_min)

    # Scale UP
    if can_scale and need_up and desired < max_rep:
        new_replicas = min(desired + 1, max_rep)
        if new_replicas != desired:
            await update_service_replicas(session, svc_id, new_replicas)
            last_scale_ts[svc_id] = now
            # email
            if notifier and email_enabled_for_service(labels, default=bool(smtp_conf.get("enabled", False))):
                to = recipients_for_service(labels, smtp_conf)
                ev = {
                    "ts_iso": iso_now(),
                    "service": name, "service_id": svc_id,
                    "action": "scale_up", "old": desired, "new": new_replicas,
                    "cpu": avg_cpu, "mem": avg_mem,
                    "reason": f"cpu>{cpu_max} or mem>{mem_max}",
                    "to": to
                }
                await notifier.enqueue(ev)
            return

    # Scale DOWN
    if can_scale and need_down and desired > min_rep:
        if not scale_down_enabled:
            log.info(f"{name} scale-down disabled by label")
            return
        if pre_cmd:
            log.info(f"{name} scheduling graceful scale-down")
            last_scale_ts[svc_id] = now  # blocca altre azioni durante il drain
            pending_down[svc_id] = asyncio.create_task(
                graceful_scale_down(session, node_map, svc_id, spec, name, labels, tasks,
                                    pre_cmd, pre_timeout, stop_timeout)
            )
            return
        else:
            new_replicas = max(desired - 1, min_rep)
            if new_replicas != desired:
                await update_service_replicas(session, svc_id, new_replicas)
                last_scale_ts[svc_id] = now
                # email
                if notifier and email_enabled_for_service(labels, default=bool(smtp_conf.get("enabled", False))):
                    to = recipients_for_service(labels, smtp_conf)
                    ev = {
                        "ts_iso": iso_now(),
                        "service": name, "service_id": svc_id,
                        "action": "scale_down", "old": desired, "new": new_replicas,
                        "cpu": avg_cpu, "mem": avg_mem,
                        "reason": f"cpu<{cpu_min} and mem<{mem_min}",
                        "to": to
                    }
                    await notifier.enqueue(ev)
                return

# -----------------------
# Main loop
# -----------------------
async def main_loop():
    global smtp_conf, notifier
    smtp_conf = load_smtp_config()
    notifier = EmailNotifier(smtp_conf)
    asyncio.create_task(notifier.run_flush_loop())

    async with aiohttp.ClientSession() as session:
        while True:
            try:
                ro_bases = resolve_ro_proxies()
                node_map = await build_nodeid_to_proxy(session, ro_bases)
                services = await list_target_services(session)
                tasks = [reconcile_service(session, node_map, s) for s in services]
                await asyncio.gather(*tasks)
                await notifier.flush_if_due()
            except Exception as e:
                log.error(f"reconcile error: {e}")
            await asyncio.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    asyncio.run(main_loop())
