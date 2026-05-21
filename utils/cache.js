class SimpleCache {
    constructor() {
        this.store = new Map();
        this.scheduleDailyDashboardCacheReset();
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

    clearDashboardCaches() {
        this.delPrefix("main:dashboard:");
        this.del("main:super:dashboard");
    }

    scheduleDailyDashboardCacheReset() {
        const scheduleNext = () => {
            const now = new Date();
            const nextMidnight = new Date(now);
            nextMidnight.setHours(24, 0, 0, 0);
            const delay = Math.max(1000, nextMidnight.getTime() - now.getTime());

            const timer = setTimeout(() => {
                this.clearDashboardCaches();
                scheduleNext();
            }, delay);
            if (typeof timer.unref === "function") {
                timer.unref();
            }
        };

        scheduleNext();
    }
}

module.exports = new SimpleCache();
