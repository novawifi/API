const test = require("node:test");
const assert = require("node:assert/strict");

const { buildMikrotikRescueScript, getMikrotikRescueConfig } = require("../utils/mikrotikRescue");

test("MikroTik SSTP rescue configuration is opt-in and deterministic", () => {
    const disabled = getMikrotikRescueConfig("10.10.10.42", {});
    assert.equal(disabled.enabled, false);

    const config = getMikrotikRescueConfig("10.10.10.42", {
        MIKROTIK_RESCUE_SSTP_ENABLED: "true",
        MIKROTIK_RESCUE_SSTP_SERVER: "rescue.example.com",
        MIKROTIK_RESCUE_SSTP_PASSWORD: "strong-password",
        MIKROTIK_RESCUE_ADDRESS_PREFIX: "10.250.0",
    });

    assert.equal(config.enabled, true);
    assert.equal(config.username, "nova-rescue-42");
    assert.equal(config.rescueAddress, "10.250.0.42");
    assert.equal(config.rescueSubnet, "10.250.0.0/24");
});

test("MikroTik SSTP rescue script does not modify WireGuard", () => {
    const config = getMikrotikRescueConfig("10.10.10.7", {
        MIKROTIK_RESCUE_SSTP_ENABLED: "true",
        MIKROTIK_RESCUE_SSTP_SERVER: "rescue.example.com",
        MIKROTIK_RESCUE_SSTP_PASSWORD: "strong-password",
    });
    const script = buildMikrotikRescueScript(config).join("\n");

    assert.match(script, /interface\/sstp-client add/);
    assert.match(script, /connect-to="rescue\.example\.com"/);
    assert.match(script, /verify-server-certificate=yes/);
    assert.match(script, /add-default-route=no/);
    assert.match(script, /on-event=":local rescue \[\/interface\/sstp-client\/find name=nova-rescue-sstp\]/);
    assert.doesNotMatch(script, /on-event="[^\n]*name="nova-rescue-sstp"/);
    assert.doesNotMatch(script, /on-event="[^\n]*name="nova-rescue-watchdog-bootstrap"/);
    assert.doesNotMatch(script, /interface\/wireguard/);
});
