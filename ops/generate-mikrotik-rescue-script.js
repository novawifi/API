require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { buildMikrotikRescueScript, getMikrotikRescueConfig } = require("../utils/mikrotikRescue");

const routerHost = String(process.argv[2] || "").trim();
if (!routerHost) {
    console.error("Usage: node ops/generate-mikrotik-rescue-script.js 10.10.10.X [output.rsc]");
    process.exit(1);
}

const config = getMikrotikRescueConfig(routerHost);
if (!config.enabled) {
    console.error(`Cannot generate rescue script: ${config.reason}`);
    process.exit(1);
}

const outputPath = path.resolve(
    process.argv[3] || `mikrotik-rescue-${routerHost.replace(/\./g, "-")}.rsc`
);
const apiAccessScript = [
    `:local apiId [/ip/service/find name="api"]`,
    `:if ([:len $apiId] > 0) do={`,
    `:local apiAddresses [/ip/service/get $apiId address]`,
    `:if ([:find $apiAddresses "${config.rescueSubnet}"] = nil) do={`,
    `:if ([:len $apiAddresses] = 0) do={ :set apiAddresses "${config.rescueSubnet}" } else={ :set apiAddresses ($apiAddresses . ",${config.rescueSubnet}") }`,
    `/ip/service/set $apiId address=$apiAddresses disabled=no`,
    `}`,
    `}`,
];
const script = [
    `# Nova emergency SSTP rescue for ${routerHost}`,
    `# Rescue address: ${config.rescueAddress}`,
    ...apiAccessScript,
    ...buildMikrotikRescueScript(config),
    `:log info "Nova SSTP rescue configuration installed"`,
    "",
].join("\n");

fs.writeFileSync(outputPath, script, { encoding: "utf8", mode: 0o600 });
console.log(`Generated ${outputPath}`);
