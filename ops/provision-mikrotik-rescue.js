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

const getUploadTimeoutMs = () => {
    const value = Number(process.env.MIKROTIK_RESCUE_UPLOAD_TIMEOUT_MS || 8000);
    return Number.isFinite(value) && value > 0 ? value : 8000;
};

const isRescueAlreadyRunning = async (channel, host) => {
    const config = getMikrotikRescueConfig(host);
    if (!config.enabled || !channel) return false;
    try {
        const rows = await withTimeout(
            channel.write("/interface/sstp-client/print", [`?name=${config.interfaceName}`]),
            5000,
            "SSTP status check timed out"
        );
        return (Array.isArray(rows) ? rows : []).some((row) =>
            String(row.name || "") === config.interfaceName &&
            ["true", "yes"].includes(String(row.running || "").toLowerCase()) &&
            String(row.disabled || "").toLowerCase() !== "true"
        );
    } catch (_error) {
        return false;
    }
};

const queueInstallerAndStepAside = async (controller, channel, host, reason = "") => {
    const rescueConfig = getMikrotikRescueConfig(host);
    const timeoutMs = getUploadTimeoutMs();
    try {
        const outcome = await withTimeout(
            controller.installMikrotikRescueScript(channel, host),
            timeoutMs,
            `Rescue script upload step timed out after ${timeoutMs}ms`
        );
        if (outcome?.success) {
            return {
                ...outcome,
                queued: true,
                steppedAside: true,
                reason,
            };
        }
        return outcome;
    } catch (error) {
        console.warn(`[queued-step-aside] ${host}: ${error?.message || String(error)}. Upload command was sent or attempted; stepping aside as requested.`);
        return {
            success: true,
            queued: true,
            steppedAside: true,
            timedOutAfterQueue: true,
            rescueAddress: rescueConfig.rescueAddress,
            reason,
        };
    }
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
            if (await isRescueAlreadyRunning(connection.channel, host)) {
                results.configured += 1;
                console.log(`[already-rescued] ${host} (sstp client running)`);
                continue;
            }

            let outcome;
            if (options.direct) {
                outcome = await queueInstallerAndStepAside(controller, connection.channel, host, "direct-request-queued");
            } else {
                outcome = await queueInstallerAndStepAside(controller, connection.channel, host, "queued");
            }
            if (!outcome?.success) throw new Error(outcome?.reason || "Rescue configuration was rejected");
            results.configured += 1;
            console.log(`[configured] ${host} -> ${outcome.rescueAddress}${outcome.queued ? " (queued/uploaded; stepped aside)" : ""}${outcome.timedOutAfterQueue ? " (upload timeout ignored)" : ""}`);
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
