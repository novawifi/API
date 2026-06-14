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

test("getHotspotWalledGardenHosts includes Google Fonts hosts", () => {
    const ctrl = new Mikrotikcontroller();
    const hosts = ctrl.getHotspotWalledGardenHosts();

    assert.ok(hosts.includes("fonts.googleapis.com"));
    assert.ok(hosts.includes("fonts.gstatic.com"));
});

test("getHotspotWalledGardenHosts includes captive portal check hosts", () => {
    const ctrl = new Mikrotikcontroller();
    const hosts = ctrl.getHotspotWalledGardenHosts();

    assert.ok(hosts.includes("connectivitycheck.gstatic.com"));
    assert.ok(hosts.includes("captive.apple.com"));
});

test("collectBandwidthSamples collects per-station API and RADIUS counters", async () => {
    const ctrl = new Mikrotikcontroller();
    const closed = [];
    ctrl.db = {
        getStations: async () => ([
            { id: "api-station", mikrotikHost: "10.10.10.2", systemBasis: "API" },
            { id: "radius-station", mikrotikHost: "10.10.10.3", radiusClientIp: "192.0.2.3", systemBasis: "RADIUS" },
        ]),
        getRadiusBandwidthCounters: async (ips) => {
            assert.deepEqual(ips, ["192.0.2.3", "10.10.10.3"]);
            return [{ acctuniqueid: "rad-1", framedprotocol: "PPP", acctinputoctets: 30n, acctoutputoctets: 40n }];
        },
    };
    ctrl.config = {
        createSingleMikrotikClient: async (_platformID, host) => ({
            channel: { host, close: async () => closed.push(host) },
        }),
    };
    ctrl.mikrotik = {
        listHotspotUsers: async () => [{ name: "voucher-1", "bytes-in": "10", "bytes-out": "20" }],
        listPPPActiveUsers: async () => [{ ".id": "*A", name: "alice", "caller-id": "AA:BB", "bytes-in": "50", "bytes-out": "60" }],
    };

    const samples = await ctrl.collectBandwidthSamples("plat-1");

    assert.equal(samples.length, 3);
    assert.deepEqual(samples.map((row) => ({
        station: row.station,
        service: row.service,
        counterKey: row.counterKey,
        rx: row.rx,
        tx: row.tx,
    })), [
        { station: "api-station", service: "hotspot", counterKey: "api:hotspot:voucher-1", rx: 10n, tx: 20n },
        { station: "api-station", service: "pppoe", counterKey: "api:pppoe:alice:AA:BB", rx: 50n, tx: 60n },
        { station: "radius-station", service: "pppoe", counterKey: "radius:rad-1", rx: 30n, tx: 40n },
    ]);
    assert.deepEqual(closed, ["10.10.10.2"]);
});

test("uploadHotspotLoginTemplate ensures walled garden for offline templates", async () => {
    const ctrl = new Mikrotikcontroller();
    const calls = [];
    const channel = { close: async () => calls.push("close") };

    ctrl.buildOfflineLoginTemplateHtml = async () => "<html>offline</html>";
    ctrl.config = {
        createSingleMikrotikClient: async () => ({ channel }),
    };
    ctrl.ensureHotspotWalledGarden = async (receivedChannel) => {
        assert.equal(receivedChannel, channel);
        calls.push("walled-garden");
    };
    ctrl.resolveHotspotLoginFilePath = async () => {
        calls.push("resolve-path");
        return "hotspot/login.html";
    };
    ctrl.fetchHotspotFontAsset = async () => {
        calls.push("fetch-font");
        return "hotspot/nunito-sans-latin.woff2";
    };
    ctrl.fetchHotspotLoginFile = async () => {
        calls.push("fetch-file");
        return "hotspot/login.html";
    };

    const result = await ctrl.uploadHotspotLoginTemplate("plat1", "10.0.0.1", { mode: "offline" });

    assert.equal(result.success, true);
    assert.equal(result.fontPath, "hotspot/nunito-sans-latin.woff2");
    assert.deepEqual(calls, ["walled-garden", "resolve-path", "fetch-font", "fetch-file", "close"]);
});

test("fetchHotspotFontAsset replaces the local Nunito Sans file", async () => {
    const ctrl = new Mikrotikcontroller();
    const calls = [];
    const channel = {
        write: async (command) => {
            calls.push(command);
            return [];
        },
    };
    ctrl.removeRouterFile = async (_channel, path) => calls.push(["remove", path]);

    const result = await ctrl.fetchHotspotFontAsset(channel, "flash/hotspot/login.html");

    assert.equal(result, "flash/hotspot/nunito-sans-latin.woff2");
    assert.deepEqual(calls[0], ["remove", "flash/hotspot/nunito-sans-latin.woff2"]);
    assert.equal(calls[1][0], "/tool/fetch");
    assert.ok(calls[1].includes("=url=https://api.novawifi.co.ke/mkt/hotspot/font/nunito-sans-latin.woff2"));
    assert.ok(calls[1].includes("=dst-path=flash/hotspot/nunito-sans-latin.woff2"));
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

test("autoRouterComplete acknowledges before station saving starts", async () => {
    const ctrl = new Mikrotikcontroller();
    const session = {
        platformID: "plat1",
        adminID: "admin1",
        systemBasis: "API",
        apiUser: "nova-test",
        apiPass: "secret",
        mikrotikHost: "10.10.10.13",
        name: "DEMO",
    };
    ctrl.routerAutoSessions.set("session-token", session);

    let queued = null;
    ctrl.queueAutoRouterCompletion = (receivedSession, payload) => {
        queued = { session: receivedSession, payload };
    };

    const req = {
        query: {
            token: "session-token",
            publicKey: "public+key=",
            ddns: "demo.sn.mynetname.net",
            publicIp: "203.0.113.10",
            user: "nova-test",
            pass: "secret",
            host: "10.10.10.13",
            name: "DEMO",
        },
    };
    const res = createRes();

    await ctrl.autoRouterComplete(req, res);

    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.body, { success: true, accepted: true });
    assert.equal(queued.session, session);
    assert.equal(queued.payload.mikrotikHost, "10.10.10.13");
    assert.equal(queued.payload.publicKey, "public+key=");
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
