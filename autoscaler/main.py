import os, asyncio, aiohttp, logging, json, socket, time, smtplib, sys
import yaml
from email.mime.text import MIMEText
from aiohttp import web
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
ADMIN_API_PORT = int(os.getenv("ADMIN_API_PORT", "9090"))
STARTUP_PROXY_WAIT = int(os.getenv("STARTUP_PROXY_WAIT", "60"))  # secondi max di attesa proxy a startup

# Stato runtime
last_scale_ts = {}
pending_down = {}
smtp_conf = {}
notifier = None

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
    params = {"stream": "false"}  # consente precpu_stats
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
# Email notifier con batching + template error
# -----------------------
def load_smtp_config():
    try:
        with open(SMTP_CONFIG_PATH, "r") as f:
            return yaml.safe_load(f) or {}
    except Exception as e:
        log.warning(f"SMTP config not loaded: {e}")
        return {}

def log_smtp_config_debug(conf: dict):
    if not log.isEnabledFor(logging.DEBUG):
        return
    smtp = conf.get("smtp", {}) or {}
    pwd = smtp.get("password") or ""
    masked = f"<len:{len(pwd)}>"
    log.debug(
        "SMTP cfg host=%s port=%s starttls=%s user=%s from=%s to_default=%s password=%s",
        smtp.get("host"), smtp.get("port"), smtp.get("starttls"),
        smtp.get("username"), conf.get("from"), conf.get("to_default"),
        masked
    )

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
        msg["Subject"] = f"{prefix} {subject}"
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

    # Template per batch eventi (scale up/down)
    def _compose_events_body(self, items: list[dict]) -> str:
        lines = []
        for ev in items:
            lines.append(
                f"{ev['ts_iso']} | {ev['action']} | {ev['service']} ({ev['service_id']}) "
                f"{ev['old']} -> {ev['new']} | cpu={ev['cpu']:.1f}% mem={ev['mem']:.1f}% | reason={ev['reason']}"
            )
        return "\n".join(lines)

    # Template per errori (singoli, immediati)
    def _compose_error_body(self, err: dict) -> str:
        parts = [
            f"Time: {err.get('ts_iso')}",
            f"Service: {err.get('service')} ({err.get('service_id')})",
            f"Action: {err.get('action')}",
            f"Reason: {err.get('reason')}",
        ]
        det = err.get("details")
        if det:
            parts.append(f"Details:\n{det}")
        return "\n".join(parts)

    async def send_error_now(self, err: dict, to_list: list):
        subject = f"ERROR: {err.get('service')} - {err.get('action')}"
        body = self._compose_error_body(err)
        await self.send_email(subject, body, to_list)

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
                body = self._compose_events_body(b["items"])
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

    async def enqueue(self, ev: dict, urgent: bool = False):
        if not self.enabled:
            return
        async with self.lock:
            self.queue.append(ev)
            if urgent or len(self.queue) >= self.max_batch:
                self.next_flush = 0  # flush asap

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
# Admin API (test email)
# -----------------------
async def handle_test_email(request: web.Request):
    n: EmailNotifier = request.app["notifier"]
    if not n or not n.enabled:
        return web.json_response({"ok": False, "error": "email notifier disabled"}, status=400)
    try:
        if request.method == "POST":
            payload = await request.json()
        else:
            payload = dict(request.query)
        to_raw = payload.get("to")
        subject = payload.get("subject", "Test email from autoscaler")
        body = payload.get("body", "This is a test email.")
        to_list = [e.strip() for e in to_raw.split(",")] if to_raw else (n.conf.get("to_default") or [])
        if not to_list:
            return web.json_response({"ok": False, "error": "no recipients"}, status=400)
        await n.send_email(subject, body, to_list)
        return web.json_response({"ok": True, "to": to_list})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

async def start_admin_api(app_notifier: EmailNotifier, port: int):
    app = web.Application()
    app["notifier"] = app_notifier
    app.router.add_get("/api/test-email", handle_test_email)
    app.router.add_post("/api/test-email", handle_test_email)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    log.info(f"Admin API listening on :{port}")
    # mantieni vivo
    while True:
        await asyncio.sleep(3600)

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
        # invia email immediata in caso di errore (se possibile)
        if notifier and email_enabled_for_service(labels, default=bool(smtp_conf.get("enabled", False))):
            to = recipients_for_service(labels, smtp_conf)
            err = {
                "ts_iso": iso_now(),
                "service": name, "service_id": service_id,
                "action": "graceful_scale_down",
                "reason": "Failure during graceful downscale",
                "details": str(e),
            }
            await notifier.send_error_now(err, to)
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
    # Passato a DEBUG
    log.debug(f"{name} cpu={avg_cpu:.1f}% mem={avg_mem:.1f}% desired={desired} running={len(tasks)}")

    running = len(tasks)
    now = time.time()
    below_min = (running < min_rep) or (desired < min_rep)
    if below_min:
        last_alert = below_min_last_ts.get(svc_id, 0)
        if (now - last_alert) >= BELOW_MIN_ALERT_COOLDOWN:
            log.error(f"{name} replicas below min: running={running}, desired={desired}, min={min_rep}")
            if notifier and email_enabled_for_service(labels, default=bool(smtp_conf.get("enabled", False))):
                to = recipients_for_service(labels, smtp_conf)
                err = {
                    "ts_iso": iso_now(),
                    "service": name, "service_id": svc_id,
                    "action": "replicas_below_min",
                    "reason": "Running or desired replicas are below the minimum threshold",
                    "details": f"running={running}, desired={desired}, min={min_rep}, cpu_avg={avg_cpu:.1f}%, mem_avg={avg_mem:.1f}%",
                }
                await notifier.send_error_now(err, to)
            below_min_last_ts[svc_id] = now

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
            try:
                await update_service_replicas(session, svc_id, new_replicas)
                last_scale_ts[svc_id] = now
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
            except Exception as e:
                log.error(f"{name} scale up failed: {e}")
                if notifier and email_enabled_for_service(labels, default=bool(smtp_conf.get("enabled", False))):
                    to = recipients_for_service(labels, smtp_conf)
                    err = {
                        "ts_iso": iso_now(),
                        "service": name, "service_id": svc_id,
                        "action": "scale_up",
                        "reason": "Failure during upscaling",
                        "details": str(e),
                    }
                    await notifier.send_error_now(err, to)
            return

    # Scale DOWN
    if can_scale and need_down and desired > min_rep:
        if not scale_down_enabled:
            log.info(f"{name} scale-down disabled by label")
            return
        if pre_cmd:
            log.info(f"{name} scheduling graceful scale-down")
            last_scale_ts[svc_id] = now
            pending_down[svc_id] = asyncio.create_task(
                graceful_scale_down(session, node_map, svc_id, spec, name, labels, tasks,
                                    pre_cmd, pre_timeout, stop_timeout)
            )
            return
        else:
            new_replicas = max(desired - 1, min_rep)
            if new_replicas != desired:
                try:
                    await update_service_replicas(session, svc_id, new_replicas)
                    last_scale_ts[svc_id] = now
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
                except Exception as e:
                    log.error(f"{name} scale down failed: {e}")
                    if notifier and email_enabled_for_service(labels, default=bool(smtp_conf.get("enabled", False))):
                        to = recipients_for_service(labels, smtp_conf)
                        err = {
                            "ts_iso": iso_now(),
                            "service": name, "service_id": svc_id,
                            "action": "scale_down",
                            "reason": "Failure during downscaling",
                            "details": str(e),
                        }
                        await notifier.send_error_now(err, to)
                return

# -----------------------
# Startup: attesa proxy pronti
# -----------------------
async def wait_proxies_ready(session, max_wait_seconds: int) -> bool:
    deadline = time.time() + max_wait_seconds
    while time.time() < deadline:
        ok_mgr = False
        ok_ro = False
        # manager /_ping
        try:
            pong = await http_get_json(session, MANAGER_PROXY, "/_ping", params=None, timeout=3)
            if (isinstance(pong, str) and pong.strip().upper() == "OK") or pong:
                ok_mgr = True
        except Exception:
            ok_mgr = False
        # almeno un RO /info mappato
        try:
            ro_bases = resolve_ro_proxies()
            node_map = await build_nodeid_to_proxy(session, ro_bases)
            ok_ro = len(node_map) > 0
        except Exception:
            ok_ro = False
        if ok_mgr and ok_ro:
            log.info("Proxies ready: manager and read-only endpoints reachable")
            return True
        await asyncio.sleep(2)
    return False

# -----------------------
# Main loop
# -----------------------
async def main_loop():
    global smtp_conf, notifier
    smtp_conf = load_smtp_config()
    log_smtp_config_debug(smtp_conf)
    notifier = EmailNotifier(smtp_conf)
    asyncio.create_task(notifier.run_flush_loop())
    asyncio.create_task(start_admin_api(notifier, ADMIN_API_PORT))

    async with aiohttp.ClientSession() as session:
        # Attesa iniziale dei proxy (per evitare falsi errori a bootstrap)
        ready = await wait_proxies_ready(session, STARTUP_PROXY_WAIT)
        if not ready:
            msg = f"Startup failed: proxies not reachable within {STARTUP_PROXY_WAIT}s"
            log.error(msg)
            # Email d'errore dedicata (immediata)
            if smtp_conf.get("enabled"):
                to = smtp_conf.get("to_default") or []
                if to:
                    err = {
                        "ts_iso": iso_now(),
                        "service": "autoscaler", "service_id": "autoscaler",
                        "action": "startup",
                        "reason": "Proxies not reachable on startup",
                        "details": msg,
                    }
                    await notifier.send_error_now(err, to)
            # termina con errore
            sys.exit(1)

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
                if smtp_conf.get("enabled"):
                    to = smtp_conf.get("to_default") or []
                    if to:
                        err = {
                            "ts_iso": iso_now(),
                            "service": "autoscaler", "service_id": "autoscaler",
                            "action": "reconcile",
                            "reason": "Unhandled error during reconcile loop",
                            "details": str(e),
                        }
                        await notifier.send_error_now(err, to)
            await asyncio.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    asyncio.run(main_loop())
