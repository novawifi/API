// @ts-check

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const { MpesaController } = require("../controllers/mpesaController");

const withEnv = async (env, fn) => {
    const previous = {};
    for (const key of Object.keys(env)) {
        previous[key] = process.env[key];
        process.env[key] = env[key];
    }
    try {
        await fn();
    } finally {
        for (const key of Object.keys(env)) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    }
};

test("getC2BEnvConfig reads env and defaults shortCodeType", async () => {
    await withEnv(
        {
            MPESA_C2B_CONSUMER_KEY: "ck",
            MPESA_C2B_CONSUMER_SECRET: "cs",
            MPESA_C2B_SHORT_CODE: "1234",
            MPESA_C2B_SHORT_CODE_TYPE: "",
            MPESA_C2B_PASS_KEY: "pk",
            MPESA_C2B_INITIATOR_NAME: "init",
            MPESA_C2B_INITIATOR_PASSWORD: "pass",
        },
        async () => {
            const controller = new MpesaController();
            const cfg = controller.getC2BEnvConfig();
            assert.equal(cfg.consumerKey, "ck");
            assert.equal(cfg.consumerSecret, "cs");
            assert.equal(cfg.shortCode, "1234");
            assert.equal(cfg.shortCodeType, "Paybill");
            assert.equal(cfg.passKey, "pk");
            assert.equal(cfg.initiatorName, "init");
            assert.equal(cfg.initiatorPassword, "pass");
        }
    );
});

test("computeExpiryFromPackage uses fallback when period invalid", async () => {
    const controller = new MpesaController();
    const before = Date.now();
    const result = controller.computeExpiryFromPackage({ period: "0" });
    const after = Date.now();
    assert.equal(result.expiresIn, "1440m");
    const expiresAt = Date.parse(result.expiresAtISO);
    assert.ok(expiresAt >= before + 1439 * 60 * 1000);
    assert.ok(expiresAt <= after + 1441 * 60 * 1000);
});

test("computeExpiryFromPackage respects numeric period", async () => {
    const controller = new MpesaController();
    const before = Date.now();
    const result = controller.computeExpiryFromPackage({ period: "90" });
    const after = Date.now();
    assert.equal(result.expiresIn, "90m");
    const expiresAt = Date.parse(result.expiresAtISO);
    assert.ok(expiresAt >= before + 89 * 60 * 1000);
    assert.ok(expiresAt <= after + 91 * 60 * 1000);
});

test("createHotspotToken signs JWT with payload", async () => {
    await withEnv({ JWT_SECRET: "test-secret" }, async () => {
        const controller = new MpesaController();
        const token = await controller.createHotspotToken({ user: "alice" }, "10m");
        const payload = jwt.verify(token, "test-secret");
        assert.equal(payload.user, "alice");
    });
});

test("getC2BAccessToken calls MPESA auth with env credentials", async () => {
    const controller = new MpesaController();
    const original = axios.get;
    try {
        await withEnv(
            {
                MPESA_C2B_CONSUMER_KEY: "ckey",
                MPESA_C2B_CONSUMER_SECRET: "csecret",
            },
            async () => {
                axios.get = async (_url, options) => {
                    assert.ok(options);
                    assert.equal(options.auth.username, "ckey");
                    assert.equal(options.auth.password, "csecret");
                    return { data: { access_token: "tok123" } };
                };
                const token = await controller.getC2BAccessToken();
                assert.equal(token, "tok123");
            }
        );
    } finally {
        axios.get = original;
    }
});

test("isMaintenanceHappening reads settings", async () => {
    const controller = new MpesaController();
    controller.db = {
        getSettings: async () => ({
            underMaintenance: true,
            maintenanceReason: "Maintenance",
        }),
    };
    const result = await controller.isMaintenanceHappening();
    assert.equal(result.ismaintenance, true);
    assert.equal(result.reason, "Maintenance");
});

test("isBlocked returns blocked user or null", async () => {
    const controller = new MpesaController();
    controller.db = {
        getBlockedUserByPhone: async (phone) =>
            phone === "254700000000"
                ? { phone, status: "blocked", blockedBy: "admin" }
                : null,
    };
    const blocked = await controller.isBlocked("254700000000");
    const ok = await controller.isBlocked("254711111111");
    assert.ok(blocked);
    assert.equal(blocked.status, "blocked");
    assert.equal(ok, null);
});
