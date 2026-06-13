//@ts-check

const { RouterOSClient } = require('routeros-client');
const { RouterOSAPI } = require('@fibercom/routeros-api');
const { Utils } = require("../utils/Functions");
const { DataBase } = require("../helpers/databaseOperation");
const { Auth } = require('../controllers/authController');
const { getMikrotikRescueConfig } = require('../utils/mikrotikRescue');

class MikrotikConnection {
    constructor() {
        this.db = new DataBase();
        this.auth = new Auth();
    }

    withTimeout = (promise, ms, onTimeout) => {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(onTimeout || `Timeout after ${ms}ms`)), ms)
            )
        ]);
    };

    async connectRouterApi(host, user, password, timeout = 3000) {
        const api = new RouterOSAPI({ host, user, password, port: 8728, timeout });
        return this.withTimeout(api.connect(), timeout, `Connection timeout (${host})`);
    }

    async connectRouterApiWithFallback(primaryHost, user, password) {
        try {
            const channel = await this.connectRouterApi(primaryHost, user, password);
            return { channel, host: primaryHost, transport: "wireguard" };
        } catch (primaryError) {
            const rescue = getMikrotikRescueConfig(primaryHost);
            if (!rescue.enabled) throw primaryError;

            try {
                const channel = await this.connectRouterApi(rescue.rescueAddress, user, password, 5000);
                return { channel, host: rescue.rescueAddress, transport: "sstp-rescue" };
            } catch (rescueError) {
                throw new Error(
                    `Primary connection failed (${primaryError.message}); SSTP rescue failed (${rescueError.message})`
                );
            }
        }
    }

    async createMikrotikClient(token) {
        if (!token) return null;

        const auth = await this.auth.AuthenticateRequest(token);
        if (!auth.success) return null;

        const platformID = auth.admin.platformID;
        const platform = await this.db.getPlatformByplatformID(platformID);
        if (!platform) {
            return {
                id: null,
                host: null,
                username: null,
                status: "Failed",
                message: "Platform not found",
            };
        };
        const stations = await this.db.getMikrotikPlatformConfig(platformID);
        const connectionResults = await Promise.all(
            stations.map(async (station) => {
                const { id, mikrotikHost, mikrotikUser, mikrotikPassword } = station;

                if (!mikrotikHost || !mikrotikUser || !mikrotikPassword) {
                    return { id, host: mikrotikHost, status: "Failed", message: "Missing Credentials" };
                }

                if (platform.status === "Inactive") {
                    return {
                        id,
                        host: mikrotikHost,
                        username: mikrotikUser,
                        status: "Failed",
                        message: "Platform status is Inactive",
                    };
                }

                const decryptedPassword = Utils.decryptPasswordSafe(mikrotikPassword);
                try {
                    const connection = await this.connectRouterApiWithFallback(
                        mikrotikHost,
                        mikrotikUser,
                        decryptedPassword
                    );
                    return {
                        id,
                        host: mikrotikHost,
                        username: mikrotikUser,
                        channel: connection.channel,
                        connectedHost: connection.host,
                        transport: connection.transport,
                        status: "Connected",
                        message: "Connected successfully",
                    };
                } catch (err) {
                    return {
                        id,
                        host: mikrotikHost,
                        username: mikrotikUser,
                        status: "Failed",
                        message: err.message || "Connection error",
                    };
                }
            })
        );

        return connectionResults;
    };

    async createSingleMikrotikClient(platformID, host) {
        const platform = await this.db.getPlatformByplatformID(platformID);
        if (!platform) {
            return { channel: null };
        };
        if (platform.status === "Inactive") {
            return { channel: null };
        }

        const stations = await this.db.getMikrotikPlatformConfig(platformID);
        const station = stations.find((s) => s.mikrotikHost === host);

        if (!station) {
            console.log("No station found with host:", host);
            return null;
        }

        const { mikrotikUser, mikrotikPassword, mikrotikHost } = station;
        if (!mikrotikHost || !mikrotikUser || !mikrotikPassword) {
            return { channel: null };
        }
        console.log("Connecting to MikroTik (Single):", mikrotikHost);

        const decryptedPassword = Utils.decryptPasswordSafe(mikrotikPassword);
        try {
            const connection = await this.connectRouterApiWithFallback(
                mikrotikHost,
                mikrotikUser,
                decryptedPassword
            );
            console.log(`Connected to ${mikrotikHost} single via ${connection.transport}`);
            return connection;

        } catch (err) {
            console.error(`Failed to connect to ${mikrotikHost}:`, err.message);
            return { channel: null };
        }
    };

    // Low level raw api connection
    async createSingleMikrotikClientAPI(platformID, host) {
        const stations = await this.db.getMikrotikPlatformConfig(platformID);
        const station = stations.find((s) => s.mikrotikHost === host);

        if (!station) {
            console.log("No station found with host:", host);
            return null;
        }

        const { mikrotikUser, mikrotikPassword, mikrotikHost } = station;
        if (!mikrotikHost || !mikrotikUser || !mikrotikPassword) {
            return { api: null };
        }
        console.log("Connecting to MikroTik (Single) api:", mikrotikHost);

        const decryptedPassword = Utils.decryptPasswordSafe(mikrotikPassword);
        const api = new RouterOSClient({
            host: mikrotikHost,
            user: mikrotikUser,
            password: decryptedPassword,
            port: 8728,
            timeout: 3000,
        });

        return { api };
    };

    async createMikrotikConnection(station) {
        if (!station) return null;

        const { mikrotikHost, mikrotikUser, mikrotikPassword } = station;
        if (!mikrotikHost || !mikrotikUser || !mikrotikPassword) {
            return { success: false, status: "Failed", message: "Missing Credentials" };
        }

        const decryptedPassword = Utils.decryptPasswordSafe(mikrotikPassword);
        try {
            const connection = await this.connectRouterApiWithFallback(
                mikrotikHost,
                mikrotikUser,
                decryptedPassword
            );
            if (connection.channel) {
                connection.channel.close?.();
            }
            return {
                success: true,
                status: "Connected",
                transport: connection.transport,
                message: connection.transport === "sstp-rescue"
                    ? "Connected through SSTP rescue"
                    : "Connected successfully",
            };
        } catch (err) {
            return {
                success: false,
                status: "Failed",
                message: err.message || "Connection error",
            };
        }
    }

}

module.exports = { MikrotikConnection };
