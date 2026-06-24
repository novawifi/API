require("dotenv").config();

const { DataBase } = require("../helpers/databaseOperation");
const { MikrotikConnection } = require("../configs/mikrotikConfig");
const { Mikrotikcontroller } = require("../controllers/mikrotikController");
const { getMikrotikRescueConfig } = require("../utils/mikrotikRescue");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = (promise, timeoutMs, message) => {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
};

const closeConnection = async (controller, connection) => {
    await controller.safeCloseChannel(connection?.channel);
};

const parseArgs = () => {
    const args = process.argv.slice(2);
    const readValue = (name) => {
        const prefix = `${name}=`;
        const inline = args.find((arg) => arg.startsWith(prefix));
        if (inline) return inline.slice(prefix.length).trim();
        const index = args.indexOf(name);
        if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) {
            return args[index + 1].trim();
        }
        return "";
    };

    return {
        apply: args.includes("--apply"),
        direct: args.includes("--direct"),
        platform: readValue("--platform"),
        station: readValue("--station"),
        stationId: readValue("--stationId") || readValue("--station-id"),
    };
};

async function run() {
    const options = parseArgs();
    const apply = options.apply;
    const db = new DataBase();
    const connectionManager = new MikrotikConnection();
    const controller = new Mikrotikcontroller();
    const stations = await db.getAllStations();
    const targets = [];
    const seen = new Set();

    for (const station of Array.isArray(stations) ? stations : []) {
        const host = String(station?.mikrotikHost || "").trim();
        const key = `${station?.platformID || ""}:${host}`;
        if (!host || seen.has(key)) continue;
        if (options.platform && String(station?.platformID || "").trim() !== options.platform) continue;
        if (options.station && host !== options.station) continue;
        if (options.stationId && String(station?.id || "").trim() !== options.stationId) continue;
        seen.add(key);
        if (!getMikrotikRescueConfig(host).enabled) continue;
        targets.push(station);
    }

    console.log("SSTP rescue rollout filter:", {
        platform: options.platform || "all",
        station: options.station || "all",
        stationId: options.stationId || "all",
    });
    console.log(`SSTP rescue rollout targets: ${targets.length}${apply ? "" : " (dry run; pass --apply to configure)"}`);
    if (!apply) return;

    const results = { configured: 0, unreachable: 0, failed: 0 };
    for (const station of targets) {
        const host = station.mikrotikHost;
        let connection;
        try {
            connection = await connectionManager.createSingleMikrotikClient(station.platformID, host);
            if (!connection?.channel) {
                results.unreachable += 1;
                console.log(`[unreachable] ${host}`);
                continue;
            }
            if (connection.transport === "sstp-rescue") {
                results.configured += 1;
                console.log(`[already-rescued] ${host}`);
                continue;
            }

            let outcome;
            if (options.direct) {
                try {
                    outcome = await withTimeout(
                        controller.ensureMikrotikRescue(connection.channel, host),
                        60000,
                        "Rescue configuration timed out"
                    );
                } catch (directError) {
                    console.warn(`[direct-slow] ${host}: ${directError?.message || String(directError)}. Queueing installer script instead.`);
                    await closeConnection(controller, connection);
                    connection = await connectionManager.createSingleMikrotikClient(station.platformID, host);
                    if (!connection?.channel) {
                        throw new Error("Direct configure timed out and reconnect for queued installer failed");
                    }
                    outcome = await withTimeout(
                        controller.installMikrotikRescueScript(connection.channel, host),
                        45000,
                        "Rescue script upload timed out after direct fallback"
                    );
                    if (outcome?.success) {
                        outcome.fallbackQueued = true;
                    }
                }
            } else {
                outcome = await withTimeout(
                    controller.installMikrotikRescueScript(connection.channel, host),
                    45000,
                    "Rescue script upload timed out"
                );
            }
            if (!outcome?.success) throw new Error(outcome?.reason || "Rescue configuration was rejected");
            results.configured += 1;
            console.log(`[configured] ${host} -> ${outcome.rescueAddress}${outcome.queued ? " (queued on router)" : ""}${outcome.fallbackQueued ? " (direct fallback)" : ""}`);
        } catch (error) {
            results.failed += 1;
            console.error(`[failed] ${host}: ${error?.message || String(error)}`);
        } finally {
            await closeConnection(controller, connection);
            await sleep(500);
        }
    }

    console.log("SSTP rescue rollout complete:", results);
}

run()
    .catch((error) => {
        console.error("SSTP rescue rollout aborted:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        const prisma = require("../prisma");
        await prisma.$disconnect();
        process.exit(process.exitCode || 0);
    });
