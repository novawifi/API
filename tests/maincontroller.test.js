// @ts-check

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const test = require("node:test");
const assert = require("node:assert/strict");

const { Controller } = require("../controllers/maincontroller");
const { socketManager } = require("../controllers/socketController");

const createJsonResponse = () => ({
    statusCode: 200,
    body: null,
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(payload) {
        this.body = payload;
        return this;
    },
});

test("getCode restores a completed hotspot payment found by transaction code", async () => {
    const controller = new Controller();
    const payment = {
        code: "TST1234567",
        reqcode: "checkout-1",
        phone: "254700000000",
        reason: "pkg-1",
        platformID: "plat-1",
        status: "COMPLETE",
        service: "hotspot",
    };
    let lookup = null;
    let recovery = null;
    controller.db = {
        getCodesByPhone: async () => [],
        getCodesByMpesa: async () => [],
        getCompletedHotspotPaymentsByLookup: async (platformID, value, phones) => {
            lookup = { platformID, value, phones };
            return [payment];
        },
        getUserByCodeAndPlatform: async () => null,
        getPackagesByID: async () => ({ id: "pkg-1", routerHost: "10.10.10.2" }),
    };
    controller.mikrotik = {
        addManualCode: async (data) => {
            recovery = data;
            return {
                success: true,
                code: {
                    id: "user-1",
                    username: payment.code,
                    password: payment.code,
                    status: "active",
                    createdAt: new Date(),
                    expireAt: new Date(Date.now() + 60 * 60 * 1000),
                },
            };
        },
    };

    const res = createJsonResponse();
    await controller.getCode({ body: { phone: "tst1234567", platformID: "plat-1" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.type, "success");
    assert.equal(res.body.foundcodes[0].username, payment.code);
    assert.equal(lookup.value, "TST1234567");
    assert.equal(recovery.code, payment.code);
});

test("getCode finds completed hotspot payments using normalized phone variants", async () => {
    const controller = new Controller();
    let capturedPhones = [];
    controller.db = {
        getCodesByPhone: async () => [],
        getCodesByMpesa: async () => [],
        getCompletedHotspotPaymentsByLookup: async (_platformID, _value, phones) => {
            capturedPhones = phones;
            return [];
        },
    };

    const res = createJsonResponse();
    await controller.getCode({ body: { phone: "0712 345 678", platformID: "plat-1" } }, res);

    assert.ok(capturedPhones.includes("0712 345 678"));
    assert.ok(capturedPhones.includes("0712345678"));
    assert.ok(capturedPhones.includes("254712345678"));
    assert.equal(res.body.type, "error");
});

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

test("getStationTemplateSelection keeps station template modes independent", () => {
    const controller = new Controller();
    const config = { template: "Default" };

    const online = controller.getStationTemplateSelection(config, {
        hotspotTemplateMode: "online",
        hotspotTemplateName: "Nexus",
    });
    const offline = controller.getStationTemplateSelection(config, {
        hotspotTemplateMode: "offline",
        hotspotTemplateName: null,
    });

    assert.equal(online.templateMode, "online");
    assert.equal(online.defaulttemplate, "Nexus");
    assert.equal(offline.templateMode, "offline");
    assert.equal(offline.defaulttemplate, "");
});

test("getStationTemplateSelection supports legacy platform defaults", () => {
    const controller = new Controller();
    const selection = controller.getStationTemplateSelection(
        { template: "OfflineBox" },
        {}
    );

    assert.equal(selection.templateMode, "offline");
    assert.equal(selection.defaulttemplate, "");
});

test("ensureStationWebfigSite repairs the selected station mapping", async () => {
    const controller = new Controller();
    const calls = [];
    controller.addReverseProxySite = async (domain, target) => {
        calls.push({ type: "provision", domain, target });
        return { success: true };
    };
    controller.verifyNginxSite = async (domain, target) => {
        calls.push({ type: "verify", domain, target });
        return { success: true, httpCode: "502" };
    };

    const result = await controller.ensureStationWebfigSite({
        id: "station-1",
        name: "Office",
        mikrotikHost: "10.10.10.42",
        mikrotikWebfigHost: "office-webfig.novawifi.co.ke",
    });

    assert.equal(result.success, true);
    assert.equal(result.target, "http://10.10.10.42");
    assert.deepEqual(calls, [
        { type: "provision", domain: "office-webfig.novawifi.co.ke", target: "http://10.10.10.42" },
        { type: "verify", domain: "office-webfig.novawifi.co.ke", target: "http://10.10.10.42" },
    ]);
});

test("ensureStationWebfigSite creates and stores a missing hostname", async () => {
    const controller = new Controller();
    const updates = [];
    controller.generateMikrotikWebfigHost = () => "generated-webfig.novawifi.co.ke";
    controller.db = {
        updateStation: async (id, data) => updates.push({ id, data }),
    };
    controller.addReverseProxySite = async () => ({ success: true });
    controller.verifyNginxSite = async () => ({ success: true, httpCode: "200" });

    const station = { id: "station-2", name: "Branch", mikrotikHost: "10.10.10.43" };
    const result = await controller.ensureStationWebfigSite(station);

    assert.equal(result.success, true);
    assert.equal(station.mikrotikWebfigHost, "generated-webfig.novawifi.co.ke");
    assert.deepEqual(updates, [{
        id: "station-2",
        data: { mikrotikWebfigHost: "generated-webfig.novawifi.co.ke" },
    }]);
});
