// @ts-check

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { Mikrotikcontroller } = require("../controllers/mikrotikController");

test("getNextAutoRouterIp returns first available in 10.10.10.0/24", async () => {
    const ctrl = new Mikrotikcontroller();
    const used = ["10.10.10.2", "10.10.10.3", "10.10.10.5"];
    const ip = ctrl.getNextAutoRouterIp(used);
    assert.equal(ip, "10.10.10.4");
});

test("sanitizeDomain filters invalid values", async () => {
    const ctrl = new Mikrotikcontroller();
    assert.equal(ctrl.sanitizeDomain(""), null);
    assert.equal(ctrl.sanitizeDomain("bad/host"), null);
    assert.equal(ctrl.sanitizeDomain("good.example.com"), "good.example.com");
});

test("buildNginxConfig includes server_name and proxy_pass", async () => {
    const ctrl = new Mikrotikcontroller();
    const cfg = ctrl.buildNginxConfig("example.com", "http://localhost:3000");
    assert.ok(cfg.includes("server_name example.com;"));
    assert.ok(cfg.includes("proxy_pass http://localhost:3000;"));
});
