const test = require("node:test");
const assert = require("node:assert/strict");

const {
    apiCounterKey,
    counterDelta,
    radiusCounterKey,
    readBytes,
    toBytes,
} = require("../utils/bandwidth");
const { DataBase } = require("../helpers/databaseOperation");

test("toBytes preserves counters beyond Number safe integer range", () => {
    assert.equal(toBytes("9007199254740993123"), 9007199254740993123n);
    assert.equal(toBytes("invalid"), 0n);
    assert.equal(toBytes(-10), 0n);
});

test("counterDelta handles normal increments and router counter resets", () => {
    assert.equal(counterDelta(1500n, 1000n), 500n);
    assert.equal(counterDelta(250n, 1000n), 250n);
});

test("bandwidth counters use stable API and RADIUS identities", () => {
    assert.equal(apiCounterKey("hotspot", { name: "voucher-1", ".id": "*1" }), "api:hotspot:voucher-1");
    assert.equal(apiCounterKey("pppoe", { name: "alice", "caller-id": "AA:BB", ".id": "*A" }), "api:pppoe:alice:AA:BB");
    assert.equal(radiusCounterKey({ acctuniqueid: "session-123" }), "radius:session-123");
});

test("readBytes supports RouterOS and RADIUS field names", () => {
    assert.equal(readBytes({ "bytes-in": "1048576", "bytes-out": "2097152" }, "rx"), 1048576n);
    assert.equal(readBytes({ "bytes-in": "1048576", "bytes-out": "2097152" }, "tx"), 2097152n);
    assert.equal(readBytes({ acctinputoctets: 3n, acctoutputoctets: 4n }, "rx"), 3n);
    assert.equal(readBytes({ acctinputoctets: 3n, acctoutputoctets: 4n }, "tx"), 4n);
});

test("network usage stats do not double-count daily and monthly rows", () => {
    const db = new DataBase();
    const now = new Date();
    const rows = [
        { service: "hotspot", period: "daily", date: now, rx: 100n, tx: 200n },
        { service: "hotspot", period: "monthly", date: new Date(now.getFullYear(), now.getMonth(), 1), rx: 1000n, tx: 2000n },
    ];
    const stats = db.buildNetworkUsageStats(rows);
    const daily = stats.find((row) => row.service === "hotspot" && row.period === "daily");
    const monthly = stats.find((row) => row.service === "hotspot" && row.period === "monthly");
    const overall = stats.find((row) => row.service === "hotspot" && row.period === "overall");

    assert.deepEqual(daily, { service: "hotspot", period: "daily", rx: 100, tx: 200, totalBandwidth: 300 });
    assert.deepEqual(monthly, { service: "hotspot", period: "monthly", rx: 1000, tx: 2000, totalBandwidth: 3000 });
    assert.deepEqual(overall, { service: "hotspot", period: "overall", rx: 100, tx: 200, totalBandwidth: 300 });
});
