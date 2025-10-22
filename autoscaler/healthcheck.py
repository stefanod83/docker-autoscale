# /app/healthcheck.py
import os, sys, socket, urllib.request

def manager_ping():
    base = os.getenv("MANAGER_PROXY_HOST", "http://dsproxy_rw:2375").rstrip("/")
    url = f"{base}/_ping"
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            body = r.read().decode(errors="ignore").strip().upper()
            return body == "OK"
    except Exception:
        return False

def ro_dns_resolves():
    name = os.getenv("READONLY_PROXY_DNS", "tasks.dsproxy_ro")
    port = int(os.getenv("READONLY_PROXY_PORT", "2375"))
    try:
        infos = socket.getaddrinfo(name, port, proto=socket.IPPROTO_TCP)
        return len(infos) > 0
    except Exception:
        return False

ok = manager_ping() and ro_dns_resolves()
sys.exit(0 if ok else 1)
