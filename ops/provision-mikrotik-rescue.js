require("dotenv").config();

const { DataBase } = require("../helpers/databaseOperation");
const { MikrotikConnection } = require("../configs/mikrotikConfig");
const { Mikrotikcontroller } = require("../controllers/mikrotikController");
const { getMikrotikRescueConfig } = require("../utils/mikrotikRescue");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
    const dryRun = process.argv.includes("--dry-run");
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
        seen.add(key);
        if (!getMikrotikRescueConfig(host).enabled) continue;
        targets.push(station);
    }

    console.log(`SSTP rescue rollout targets: ${targets.length}${dryRun ? " (dry run)" : ""}`);
    if (dryRun) return;

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

            const outcome = await controller.ensureMikrotikRescue(connection.channel, host);
            if (!outcome?.success) throw new Error(outcome?.reason || "Rescue configuration was rejected");
            results.configured += 1;
            console.log(`[configured] ${host} -> ${outcome.rescueAddress}`);
        } catch (error) {
            results.failed += 1;
            console.error(`[failed] ${host}: ${error?.message || String(error)}`);
        } finally {
            await controller.safeCloseChannel(connection?.channel);
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
    });
