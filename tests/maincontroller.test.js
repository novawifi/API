// @ts-check

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const test = require("node:test");
const assert = require("node:assert/strict");

const { Controller } = require("../controllers/maincontroller");
const { socketManager } = require("../controllers/socketController");

test("buildDashboardResponse limits stats for admin role", async () => {
    const controller = new Controller();
    const payload = {
        stats: {
            totalUsers: 10,
            totalUsersOnline: 3,
            totalPPPoEUsers: 2,
            totalPPPoEUsersOnline: 1,
            revenue: 999,
        },
        funds: { balance: 1000 },
        networkusage: [1, 2, 3],
        IsB2B: true,
    };
    const response = controller.buildDashboardResponse(payload, "admin");
    assert.equal(response.success, true);
    assert.equal(response.stats.totalUsers, 10);
    assert.equal(response.stats.revenue, undefined);
    assert.deepEqual(response.funds, {});
    assert.deepEqual(response.networkusage, []);
});

test("buildDashboardResponse returns full payload for superuser", async () => {
    const controller = new Controller();
    const payload = {
        stats: { totalUsers: 10 },
        funds: { balance: 1000 },
        networkusage: [1, 2, 3],
        IsB2B: true,
    };
    const response = controller.buildDashboardResponse(payload, "superuser");
    assert.equal(response.success, true);
    assert.equal(response.stats.totalUsers, 10);
    assert.equal(response.funds.balance, 1000);
    assert.equal(response.networkusage.length, 3);
    assert.equal(response.IsB2B, true);
});

test("refreshDashboardStats returns null without platformID", async () => {
    const controller = new Controller();
    const result = await controller.refreshDashboardStats(null);
    assert.equal(result, null);
});

test("refreshDashboardStats caches and emits when payload exists", async () => {
    const controller = new Controller();
    const emitted = [];
    const originalEmit = socketManager.emitToRoom;
    try {
        socketManager.emitToRoom = (room, event, payload) => {
            emitted.push({ room, event, payload });
        };
        controller.cache = {
            set: (key, value) => {
                controller.__cacheKey = key;
                controller.__cacheValue = value;
            },
        };
        controller.db = {
            rebuildDashboardStats: async () => ({
                stats: { totalUsers: 5 },
                funds: { balance: 20 },
                networkusage: [],
                IsB2B: false,
            }),
        };
        const result = await controller.refreshDashboardStats("plat-1", { role: "superuser" });
        assert.ok(result);
        assert.equal(controller.__cacheKey, "main:dashboard:plat-1");
        assert.equal(emitted.length, 1);
        assert.equal(emitted[0].room, "platform-plat-1");
        assert.equal(emitted[0].event, "stats");
    } finally {
        socketManager.emitToRoom = originalEmit;
    }
});

test("sanitizeDomain returns normalized or null", async () => {
    const controller = new Controller();
    assert.equal(controller.sanitizeDomain("Example.COM"), "example.com");
    assert.equal(controller.sanitizeDomain(".bad"), null);
    assert.equal(controller.sanitizeDomain("bad/host"), null);
});

test("buildNginxConfig contains server_name and proxy_pass", async () => {
    const controller = new Controller();
    const config = controller.buildNginxConfig("example.com", "http://localhost:3000");
    assert.ok(config.includes("server_name example.com;"));
    assert.ok(config.includes("proxy_pass http://localhost:3000;"));
});
