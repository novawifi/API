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

const createRes = () => ({
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

test("autoConfigurePPPoE returns 400 when RADIUS station is missing credentials", async () => {
    const ctrl = new Mikrotikcontroller();
    ctrl.auth = {
        AuthenticateRequest: async () => ({
            success: true,
            admin: { role: "superuser", platformID: "plat1" },
        }),
    };
    ctrl.db = {
        getStations: async () => ([
            { mikrotikHost: "10.0.0.1", systemBasis: "RADIUS" },
        ]),
    };
    ctrl.config = {
        createSingleMikrotikClient: async () => ({ channel: { close: async () => { } } }),
    };

    const req = { body: { token: "t", station: "10.0.0.1" } };
    const res = createRes();

    await ctrl.autoConfigurePPPoE(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /Missing RADIUS/);
});

test("autoConfigurePPPoE configures RADIUS and reuses existing PPPoE server", async () => {
    const ctrl = new Mikrotikcontroller();

    ctrl.auth = {
        AuthenticateRequest: async () => ({
            success: true,
            admin: { role: "superuser", platformID: "plat1" },
        }),
    };
    ctrl.db = {
        getStations: async () => ([
            {
                mikrotikHost: "10.0.0.1",
                systemBasis: "RADIUS",
                radiusServerIp: "192.168.0.10",
                radiusClientSecret: "newsecret",
            },
        ]),
    };

    const channelCalls = [];
    const channel = {
        write: async (path, args) => {
            channelCalls.push({ path, args });
            if (path === "/radius/print") {
                return [
                    {
                        ".id": "*1",
                        address: "192.168.0.10",
                        secret: "oldsecret",
                        service: "ppp",
                    },
                ];
            }
            return [];
        },
        close: async () => { },
    };

    ctrl.config = {
        createSingleMikrotikClient: async () => ({ channel }),
    };

    let profileListCalls = 0;
    const createdProfiles = [5, 8, 10, 15, 20].map((speed) => ({
        ".id": `*p${speed}`,
        name: `${speed}MBPS`,
    }));

    ctrl.mikrotik = {
        listInterfaces: async () => ([{ type: "bridge", name: "bridge1" }]),
        listPPPProfiles: async () => {
            profileListCalls += 1;
            return profileListCalls === 1 ? [] : createdProfiles;
        },
        addPPPProfile: async () => { },
        updatePPPProfile: async () => { },
        listPPPServers: async () => ([
            {
                ".id": "*s1",
                "service-name": "PPPoE_Server",
                interface: "bridge1",
                authentication: "chap",
                disabled: "yes",
            },
        ]),
        updatePPPServer: async () => { },
        addPPPServer: async () => { },
        addFirewallNatRule: async () => { },
        addIPAddress: async () => { },
        addPool: async () => { },
        listPools: async () => ([]),
    };

    const req = { body: { token: "t", station: "10.0.0.1" } };
    const res = createRes();

    await ctrl.autoConfigurePPPoE(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.server, "PPPoE_Server");

    const radiusSet = channelCalls.find((c) => c.path === "/radius/set");
    assert.ok(radiusSet, "Expected /radius/set to update secret");

    const radiusAdd = channelCalls.find((c) => c.path === "/radius/add");
    assert.equal(radiusAdd, undefined);
});
