// In-memory cache with TTL (replaces Redis/File dual-backend cache)
const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expires && entry.expires < Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlSeconds = 300) {
  store.set(key, { value, expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
}

function del(key) {
  store.delete(key);
}

function clear() {
  store.clear();
}

module.exports = { get, set, delete: del, del, clear };
