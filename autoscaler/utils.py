# utils.py

import math

def cpu_percent_v151(stats: dict) -> float:
    """
    Calcola la CPU% come fa docker stats:
    (cpu_delta / system_delta) * online_cpus * 100
    usando cpu_stats e precpu_stats dallo snapshot API.
    """
    cpu = stats.get("cpu_stats", {}) or {}
    precpu = stats.get("precpu_stats", {}) or {}
    total = (cpu.get("cpu_usage", {}) or {}).get("total_usage", 0) or 0
    pre_total = (precpu.get("cpu_usage", {}) or {}).get("total_usage", 0) or 0
    sys = cpu.get("system_cpu_usage", 0) or 0
    pre_sys = precpu.get("system_cpu_usage", 0) or 0
    online = cpu.get("online_cpus")
    if not online:
        online = len((cpu.get("cpu_usage", {}) or {}).get("percpu_usage", []) or []) or 1
    cpu_delta = float(total - pre_total)
    sys_delta = float(sys - pre_sys)
    if cpu_delta > 0.0 and sys_delta > 0.0:
        return (cpu_delta / sys_delta) * float(online) * 100.0
    return 0.0

def mem_percent(stats: dict) -> float:
    """
    Calcola la MEM% come usage/limit*100 così come esposto dall'API.
    """
    mem = stats.get("memory_stats", {}) or {}
    usage = float(mem.get("usage", 0) or 0)
    limit = float(mem.get("limit", 1) or 1)
    return (usage / limit) * 100.0

def avg(values):
    vals = [v for v in values if v is not None]
    return (sum(vals) / len(vals)) if vals else 0.0

def parse_cpuset(cpuset: str) -> int:
    """
    Interpreta una stringa cpuset tipo '0-2,4' restituendo il numero di CPU
    vincolate al container, utile per normalizzare la CPU% per replica.
    """
    if not cpuset:
        return 0
    parts = str(cpuset).split(",")
    cpus = set()
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if "-" in p:
            a, b = p.split("-", 1)
            try:
                a, b = int(a), int(b)
                lo, hi = (a, b) if a <= b else (b, a)
                for x in range(lo, hi + 1):
                    cpus.add(x)
            except Exception:
                # ignora segmenti malformati
                continue
        else:
            try:
                cpus.add(int(p))
            except Exception:
                continue
    return len(cpus)
