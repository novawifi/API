class SimpleCache {
    constructor() {
        this.store = new Map();
    }

    get(key) {
        if (!key) return null;
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.expiresAt && entry.expiresAt <= Date.now()) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    set(key, value, ttlMs = 0) {
        if (!key) return;
        const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : null;
        this.store.set(key, { value, expiresAt });
    }

    del(key) {
        if (!key) return;
        this.store.delete(key);
    }

    delPrefix(prefix) {
        if (!prefix) return;
        for (const key of this.store.keys()) {
            if (key.startsWith(prefix)) {
                this.store.delete(key);
            }
        }
    }
}

module.exports = new SimpleCache();
