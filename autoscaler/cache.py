import time

class Cache:
    def __init__(self, ttl=60):
        self.ttl = ttl
        self._cache = {}

    def get(self, key):
        item = self._cache.get(key)
        if not item:
            return None
        value, exp_time = item
        if time.time() > exp_time:
            del self._cache[key]
            return None
        return value

    def set(self, key, value, ttl=None):
        ttl = ttl or self.ttl
        exp_time = time.time() + ttl
        self._cache[key] = (value, exp_time)
        return value
