
const cron = require("node-cron");
const axios = require("axios");
const { NodeSSH } = require('node-ssh');
const dayjs = require('dayjs');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const dns = require("dns").promises;
const appRoot = require('app-root-path').path;
const { execSync } = require('child_process');

const { DataBase } = require("./helpers/databaseOperation");
const { Mikrotik } = require("./helpers/mikrotikOperation");
const { MikrotikConnection } = require("./configs/mikrotikConfig");
const { Mailer } = require("./controllers/mailerController");
const { SMS } = require("./controllers/smsController");
const { MpesaController } = require("./controllers/mpesaController");
const { Mikrotikcontroller } = require("./controllers/mikrotikController");
const { Utils } = require("./utils/Functions");
const { socketManager } = require("./controllers/socketController");
const { ensureRadiusClient, getRadiusClientIp, isWireGuardMikrotikIp, updateClientIp } = require("./utils/radiusConfig");
const { WebdockService } = require("./services/webdockService");

class CronJob {
    constructor() {
        this.db = new DataBase();
        this.mikrotik = new Mikrotik();
        this.config = new MikrotikConnection();
        this.mailer = new Mailer();
        this.sms = new SMS();
        this.mpesa = new MpesaController();
        this.mikrotikController = new Mikrotikcontroller();
        this.webdock = new WebdockService();
        this.ssh = new NodeSSH();
        this.pullTransactionsRunning = false;
        this.pm2RestartRunning = false;
        this.mikrotikBackupRunning = false;
        this.webdockRunning = false;
        this.pppoeSmsIssueNotifications = new Map();

        this.mikrotikConnectionPool = new Map();
        this.routerLocks = new Map();
        this.routerConnectFailures = new Map();
        this.routerFailureCooldownMs = Number(process.env.CRON_ROUTER_RETRY_COOLDOWN_MS || 120000);

        setInterval(() => {
            const now = Date.now();
            for (const [key, conn] of this.mikrotikConnectionPool.entries()) {
                if (now - conn.createdAt > 2 * 60 * 1000) {
                    try {
                        conn.channel.close();
                    } catch { }
                    this.mikrotikConnectionPool.delete(key);
                }
            }
        }, 30 * 1000);
    }

    async findRadiusStationSharingClientIp(radiusClientIp, currentStationId = "") {
        const ip = String(radiusClientIp || "").trim();
        if (!ip || !this.db?.getAllStations) return null;
        try {
            const stations = await this.db.getAllStations();
            return (stations || []).find((station) =>
                String(station?.id || "") !== String(currentStationId || "") &&
                String(station?.radiusClientIp || "").trim() === ip &&
                String(station?.radiusClientSecret || "").trim()
            ) || null;
        } catch (_error) {
            return null;
        }
    }

    async pingWithRetry(pingFn, retries = 3, waitMs = 2000) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const result = await pingFn();
                if (result === true) return true;
            } catch (e) { }

            if (attempt < retries) {
                continue;
            }
        }
        return false;
    }

    getRouterFailureKey(platformID, host, mode = "single") {
        return `${platformID}:${host}:${mode}`;
    }

    shouldSkipRouterConnection(platformID, host, mode = "single") {
        const key = this.getRouterFailureKey(platformID, host, mode);
        const until = this.routerConnectFailures.get(key);
        if (!until) return false;
        if (Date.now() >= until) {
            this.routerConnectFailures.delete(key);
            return false;
        }
        return true;
    }

    markRouterConnectionFailure(platformID, host, mode = "single") {
        const key = this.getRouterFailureKey(platformID, host, mode);
        this.routerConnectFailures.set(key, Date.now() + this.routerFailureCooldownMs);
    }

    clearRouterConnectionFailure(platformID, host, mode = "single") {
        const key = this.getRouterFailureKey(platformID, host, mode);
        this.routerConnectFailures.delete(key);
    }

    async pingRouter(channel, host) {
        try {
            const response = await channel.write('/ping', [`=address=${host}`, '=count=3']);
            if (Array.isArray(response) && response.length > 0) return true;
            return false;
        } catch {
            return false;
        }
    }

    async notifyPPPoESMSIssue(platformID, reason, details = {}) {
        if (!platformID || !reason) return;
        const key = `${platformID}:${reason}`;
        const now = Date.now();
        const throttleMs = 6 * 60 * 60 * 1000;
        if ((this.pppoeSmsIssueNotifications.get(key) || 0) + throttleMs > now) return;
        this.pppoeSmsIssueNotifications.set(key, now);

        const title = "PPPoE SMS reminders not sent";
        const message = `${reason}${details.phone ? ` Phone: ${details.phone}.` : ""}${details.serviceId ? ` PPPoE: ${details.serviceId}.` : ""}`;
        try {
            await this.db.upsertPlatformNotification(platformID, title, {
                message,
                level: "warning",
                type: "pppoe_sms",
                metadata: details,
            });
        } catch (error) {
            console.error("Failed to create PPPoE SMS notification:", error?.message || error);
        }
        socketManager.log(platformID, message, {
            context: "cron",
            level: "warn",
        });
    }

    async sendPPPoESMS({ service, platform, type, expiresAt }) {
        if (!service?.phone || !service?.platformID || !platform) return false;
        const platformID = service.platformID;
        const label = type === "expired" ? "expired notice" : "reminder";

        const platformConfig = await this.db.getPlatformConfig(platformID);
        if (platformConfig?.sms !== true) return false;

        const sms = await this.db.getPlatformSMS(platformID);
        if (!sms) {
            await this.notifyPPPoESMSIssue(platformID, `PPPoE ${label} SMS skipped: SMS configuration was not found.`, { serviceId: service.id, phone: service.phone });
            return false;
        }
        if (sms.sentPPPoE === false) {
            await this.notifyPPPoESMSIssue(platformID, `PPPoE ${label} SMS skipped: PPPoE SMS sending is disabled.`, { serviceId: service.id, phone: service.phone });
            return false;
        }

        const costPerSMS = Number(sms.costPerSMS || 0);
        const balance = Number(sms.balance || 0);
        const remainingSMS = Number(sms.remainingSMS || 0);
        if (sms.default === true && Number.isFinite(costPerSMS) && Number.isFinite(balance) && balance < costPerSMS) {
            await this.notifyPPPoESMSIssue(platformID, `PPPoE ${label} SMS skipped: insufficient SMS balance.`, { serviceId: service.id, phone: service.phone, balance, costPerSMS });
            return false;
        }
        if (sms.default === true && Number.isFinite(remainingSMS) && remainingSMS < 1) {
            await this.notifyPPPoESMSIssue(platformID, `PPPoE ${label} SMS skipped: no remaining SMS credits.`, { serviceId: service.id, phone: service.phone, remainingSMS });
            return false;
        }

        const template = type === "expired" ? sms.pppoeExpiredSMS : sms.pppoeReminderSMS;
        if (!template) {
            await this.notifyPPPoESMSIssue(platformID, `PPPoE ${label} SMS skipped: SMS template is empty.`, { serviceId: service.id, phone: service.phone });
            return false;
        }

        const smsMessage = Utils.formatMessage(template, {
            company: platform.name,
            username: service.clientname || service.name,
            period: service.period,
            expiry: expiresAt ? expiresAt.toDateString() : service.expiresAt || service.expireAt,
            package: service.profile,
            amount: service.amount,
            paymentLink: `https://${platform.url}/pppoe?info=${service.paymentLink}`,
            accountNumber: service.accountNumber || "",
        });

        const result = await this.sms.sendSMS(service.phone, smsMessage, sms);
        if (!result?.success) {
            await this.notifyPPPoESMSIssue(platformID, `PPPoE ${label} SMS failed to send: ${result?.message || "provider error"}`, { serviceId: service.id, phone: service.phone });
            return false;
        }

        if (sms.default === true) {
            await this.db.updatePlatformSMS(platformID, {
                balance: (balance - costPerSMS).toString(),
                remainingSMS: Math.max(Math.floor(remainingSMS) - 1, 0).toString()
            });
        }
        return true;
    }

    async getMikrotikChannel(platformID, host) {
        const key = `${platformID}:${host}`;
        const existing = this.mikrotikConnectionPool.get(key);

        if (existing?.channel && !existing.channel.closed) {
            return existing.channel;
        }

        if (this.shouldSkipRouterConnection(platformID, host, "single")) {
            return null;
        }

        const connection = await this.config.createSingleMikrotikClient(platformID, host);
        if (!connection?.channel) {
            this.markRouterConnectionFailure(platformID, host, "single");
            return null;
        }

        this.clearRouterConnectionFailure(platformID, host, "single");

        this.mikrotikConnectionPool.set(key, {
            channel: connection.channel,
            createdAt: Date.now()
        });

        return connection.channel;
    }

    async withRouterLock(key, fn) {
        const prev = this.routerLocks.get(key) || Promise.resolve();
        let release;
        const next = new Promise(res => (release = res));
        this.routerLocks.set(key, prev.then(() => next));

        await prev;
        try {
            return await fn();
        } finally {
            // @ts-ignore
            release();
            if (this.routerLocks.get(key) === next) {
                this.routerLocks.delete(key);
            }
        }
    }

    async withPlatforms(handler) {
        const platforms = await this.db.getAllPlatforms();

        for (const platform of platforms) {
            try {
                await handler(platform);
            } catch (err) {
                console.error(
                    `Platform handler failed [${platform.platformID}]`,
                    err
                );
                socketManager.log(platform.platformID, `Cron handler failed: ${err?.message || err}`, {
                    context: "cron",
                    level: "error",
                });
            }
        }
    }

    latestSamplingValue(sampling) {
        if (!sampling) return null;
        if (Array.isArray(sampling)) return sampling.length ? Number(sampling[sampling.length - 1]?.amount || 0) : null;
        return Number(sampling.amount || 0);
    }

    async syncWebdockActions() {
        if (!this.webdock.isConfigured()) return;
        const actions = await this.db.getPendingDedicatedServerActions();
        for (const action of actions) {
            try {
                const events = await this.webdock.getEvents(action.callbackId);
                const event = Array.isArray(events.data) ? events.data[0] : events.data;
                const status = String(event?.status || event?.state || "").toLowerCase();
                if (!event || !status) continue;
                if (["finished", "success", "complete", "completed", "done"].includes(status)) {
                    const update = { status: "completed", response: { ...(action.response || {}), event } };
                    await this.db.updateDedicatedServerAction(action.id, update);
                    if (action.serverSlug) {
                        try {
                            const server = await this.webdock.getServer(action.serverSlug);
                            const update = {
                                ...this.webdock.normalizeServer(server.data),
                                webdockStatus: action.type === "delete" ? "deleted" : (server.data?.status || "active"),
                                lastSyncedAt: new Date(),
                            };
                            if (action.type === "provision" && action.request?.userScriptId) {
                                update.sshStatus = "ready";
                                update.nginxStatus = "active";
                                update.providerData = {
                                    ...(update.providerData || server.data || {}),
                                    novaSetup: {
                                        status: "complete",
                                        scriptId: action.request.userScriptId,
                                        completedAt: new Date().toISOString(),
                                        healthCommand: "nova-dedicated-check",
                                    },
                                };
                            }
                            await this.db.upsertPlatformServer(action.platformID, update);
                        } catch (err) {
                            if (action.type === "delete") {
                                await this.db.upsertPlatformServer(action.platformID, {
                                    webdockStatus: "deleted",
                                    lastSyncedAt: new Date(),
                                });
                            }
                        }
                    }
                    await this.db.upsertPlatformNotification(action.platformID, `Dedicated server ${action.type} complete`, {
                        message: `Dedicated server ${action.type} completed successfully.`,
                        status: "success",
                        actionLabel: "View Server",
                        actionUrl: "/admin/server",
                    });
                } else if (["error", "failed", "failure"].includes(status)) {
                    await this.db.updateDedicatedServerAction(action.id, {
                        status: "failed",
                        error: event?.message || event?.error || "Webdock action failed",
                        response: { ...(action.response || {}), event },
                    });
                    await this.db.upsertPlatformNotification(action.platformID, `Dedicated server ${action.type} failed`, {
                        message: event?.message || `Dedicated server ${action.type} failed.`,
                        status: "error",
                        actionLabel: "View Server",
                        actionUrl: "/admin/server",
                    });
                } else {
                    await this.db.updateDedicatedServerAction(action.id, { status: "processing" });
                }
            } catch (error) {
                console.error("[cron] Webdock action sync failed", error?.message || error);
            }
        }
    }

    async syncWebdockServers() {
        if (!this.webdock.isConfigured()) return;
        const servers = await this.db.getPlatformServers({
            webdockSlug: { not: null },
            webdockStatus: { notIn: ["deleted", "deleting"] },
        });
        for (const server of servers) {
            try {
                const [webdockServer, instantMetrics, metrics] = await Promise.all([
                    this.webdock.getServer(server.webdockSlug),
                    this.webdock.getInstantMetrics(server.webdockSlug),
                    this.webdock.getMetrics(server.webdockSlug),
                ]);
                const normalized = this.webdock.normalizeServer(webdockServer.data);
                const providerHealth = this.webdock.normalizeInstantMetrics(instantMetrics.data, webdockServer.data);
                await this.db.upsertPlatformServer(server.platformID, {
                    ...normalized,
                    instantMetrics: providerHealth,
                    metrics: metrics.data,
                    lastSyncedAt: new Date(),
                });
                await this.createWebdockHealthNotifications(server.platformID, providerHealth);
            } catch (error) {
                console.error("[cron] Webdock server sync failed", error?.message || error);
                await this.db.upsertPlatformNotification(server.platformID, "Dedicated server health check failed", {
                    message: "Could not refresh dedicated server health from Webdock.",
                    status: "warning",
                    actionLabel: "View Server",
                    actionUrl: "/admin/server",
                });
            }
        }
    }

    async createWebdockHealthNotifications(platformID, health) {
        const ramLimit = Number(process.env.DEDICATED_SERVER_RAM_ALERT_PERCENT || 85);
        const diskLimit = Number(process.env.DEDICATED_SERVER_DISK_ALERT_PERCENT || 80);
        const bandwidthLimit = Number(process.env.DEDICATED_SERVER_BANDWIDTH_ALERT_PERCENT || 85);
        const cpuSecondsLimit = Number(process.env.DEDICATED_SERVER_CPU_SECONDS_ALERT || 1500);

        if (health?.memory?.usedPercent !== null && health.memory.usedPercent >= ramLimit) {
            await this.db.upsertPlatformNotification(platformID, "Dedicated server RAM overusage", {
                message: `RAM usage is ${health.memory.usedPercent}%.`,
                status: "warning",
                actionLabel: "Upgrade Resources",
                actionUrl: "/admin/server",
            });
        }
        if (health?.disk?.usedPercent !== null && health.disk.usedPercent >= diskLimit) {
            await this.db.upsertPlatformNotification(platformID, "Dedicated server storage filling", {
                message: `Storage usage is ${health.disk.usedPercent}%.`,
                status: "warning",
                actionLabel: "Upgrade Resources",
                actionUrl: "/admin/server",
            });
        }
        if (health?.cpu?.usedSeconds !== null && health.cpu.usedSeconds >= cpuSecondsLimit) {
            await this.db.upsertPlatformNotification(platformID, "Dedicated server CPU overusage", {
                message: `CPU usage is high in the latest Webdock sample.`,
                status: "warning",
                actionLabel: "Upgrade Resources",
                actionUrl: "/admin/server",
            });
        }
        const network = health?.network;
        if (network?.allowed && network?.total && Number(network.total) / Number(network.allowed) * 100 >= bandwidthLimit) {
            await this.db.upsertPlatformNotification(platformID, "Dedicated server bandwidth usage", {
                message: `Bandwidth usage is ${Number((Number(network.total) / Number(network.allowed) * 100).toFixed(1))}%.`,
                status: "warning",
                actionLabel: "View Server",
                actionUrl: "/admin/server",
            });
        }
    }

    async deleteOverdueDedicatedServers() {
        if (!this.webdock.isConfigured()) return;
        const platforms = await this.db.getAllPlatforms();
        const cutoffMs = 30 * 24 * 60 * 60 * 1000;
        for (const platform of platforms) {
            try {
                const server = await this.db.getPlatformServer(platform.platformID);
                if (!server?.webdockSlug || ["deleted", "deleting"].includes(String(server.webdockStatus || "").toLowerCase())) continue;
                const unpaid = await this.db.getUnpaidPlatformBilling(platform.platformID);
                const overdue = unpaid.some((bill) => Number(bill.amount || 0) > 0 && bill.dueDate && Date.now() - new Date(bill.dueDate).getTime() > cutoffMs);
                if (!overdue) continue;
                const response = await this.webdock.deleteServer(server.webdockSlug);
                await this.db.upsertPlatformServer(platform.platformID, {
                    webdockStatus: "deleting",
                    pendingDeletionAt: new Date(),
                });
                await this.db.createDedicatedServerAction({
                    platformID: platform.platformID,
                    serverSlug: server.webdockSlug,
                    type: "delete",
                    status: response.callbackId ? "pending" : "processing",
                    callbackId: response.callbackId,
                    response: { callbackSequence: response.callbackSequence },
                });
                await this.db.upsertPlatformNotification(platform.platformID, "Dedicated server deleted for unpaid bill", {
                    message: "Dedicated server deletion was queued because a bill has been unpaid for more than 30 days.",
                    status: "error",
                    actionLabel: "View Bills",
                    actionUrl: "/admin/bills",
                });
            } catch (error) {
                console.error("[cron] overdue Webdock deletion failed", error?.message || error);
            }
        }
    }

    async runWebdockCron() {
        if (this.webdockRunning) return;
        this.webdockRunning = true;
        try {
            await this.syncWebdockActions();
            await this.syncWebdockServers();
        } finally {
            this.webdockRunning = false;
        }
    }

    async pullSafaricomTransactionsForPlatform(platform, mode) {
        const platformID = platform.platformID;
        const isC2B = mode === "C2B";
        const shortCode = isC2B ? platform.mpesaC2BShortCode : platform.mpesaShortCode;
        if (!shortCode) return;

        let accessToken;
        try {
            accessToken = isC2B
                ? await this.mpesa.getC2BAccessToken(platformID)
                : await this.mpesa.getAccessToken(platform);
        } catch {
            return;
        }

        const state = await this.db.getMpesaPullState(platformID);
        if (!state?.pullRegistered) {
            try {
                const nominated = platform.mpesaPhone || platform.phone || "";
                await this.mpesa.registerPullShortCode({
                    accessToken,
                    shortCode,
                    nominatedNumber: nominated,
                });
                await this.db.upsertMpesaPullState(platformID, { pullRegistered: true });
            } catch {
                return;
            }
        }

        const now = dayjs();
        const lastPulledAt = state?.lastPulledAt ? dayjs(state.lastPulledAt) : null;
        const start = lastPulledAt ? lastPulledAt.subtract(5, "minute") : now.subtract(48, "hour");
        const startWindow = start.isBefore(now.subtract(48, "hour")) ? now.subtract(48, "hour") : start;

        const startDate = startWindow.format("YYYY-MM-DD HH:mm:ss");
        const endDate = now.format("YYYY-MM-DD HH:mm:ss");

        let response;
        try {
            response = await this.mpesa.queryPullTransactions({
                accessToken,
                shortCode,
                startDate,
                endDate,
                offset: "0",
            });
        } catch {
            return;
        }

        const transactions = this.mpesa.normalizePullTransactions(response);
        if (!transactions || transactions.length === 0) {
            await this.db.upsertMpesaPullState(platformID, { lastPulledAt: now.toDate() });
            return;
        }

        const rows = transactions.map((tx) => ({
            shortCode: String(shortCode),
            transactionId: String(tx.transactionId || tx.TransactionID || tx.TransactionId || ""),
            trxDate: tx.trxDate ? new Date(tx.trxDate) : null,
            msisdn: tx.msisdn ? String(tx.msisdn) : null,
            transactiontype: tx.transactiontype ? String(tx.transactiontype) : null,
            billreference: tx.billreference ? String(tx.billreference) : null,
            amount: tx.amount !== undefined && tx.amount !== null ? String(tx.amount) : null,
            organizationname: tx.organizationname ? String(tx.organizationname) : null,
            raw: tx,
        })).filter((row) => row.transactionId);

        if (rows.length > 0) {
            await this.db.addMpesaPullTransactions(platformID, rows);
        }

        await this.db.upsertMpesaPullState(platformID, { lastPulledAt: now.toDate() });
    }

    async runPullTransactions() {
        if (this.pullTransactionsRunning) return;
        this.pullTransactionsRunning = true;
        try {
            await this.withPlatforms(async (platform) => {
                if (platform.IsC2B) {
                    await this.pullSafaricomTransactionsForPlatform(platform, "C2B");
                }
                if (platform.IsAPI) {
                    await this.pullSafaricomTransactionsForPlatform(platform, "API");
                }
            });
        } finally {
            this.pullTransactionsRunning = false;
        }
    }

    async checkAndExpireUsersForPlatform(platform) {
        const now = new Date();
        const platformID = platform.platformID;

        const routers = await this.db.getStations(platformID);
        if (!routers || routers.length === 0) return;

        const expiredUsers = await this.db.getExpiredActivePlatformUsers(platformID, now);
        if (expiredUsers.length === 0) return;

        await this.db.expireActiveUsersByIds(expiredUsers.map((user) => user.id));
        socketManager.log(platformID, `Cron: marked ${expiredUsers.length} hotspot users expired in database`, {
            context: "cron",
            level: "info",
        });

        const stationByHost = new Map(
            routers
                .filter((r) => r?.mikrotikHost)
                .map((r) => [r.mikrotikHost, r])
        );
        const resolveUserHost = (user) => user?.package?.routerHost || user?.station || "";
        const isRadiusUser = (user) => {
            const host = resolveUserHost(user);
            if (!host) return false;
            const station = stationByHost.get(host);
            return String(station?.systemBasis || "").toUpperCase() === "RADIUS";
        };
        const radiusExpiredUsers = expiredUsers.filter(isRadiusUser);
        const apiExpiredUsers = expiredUsers.filter((user) => !isRadiusUser(user));

        if (radiusExpiredUsers.length > 0) {
            const identifiers = radiusExpiredUsers.flatMap((user) =>
                [user.username, user.code, user.mac]
                    .filter((value) => typeof value === "string" && value !== "null" && value.trim() !== "")
            );
            try {
                await this.db.deleteRadiusUsers(identifiers);
            } catch {
                // Ignore radius cleanup errors; DB status is already expired.
            }
        }

        for (const router of routers) {
            if (!router.mikrotikHost) continue;
            const isRadiusBasis = String(router.systemBasis || "").toUpperCase() === "RADIUS";
            if (isRadiusBasis) continue;
            const host = router.mikrotikHost;

            await this.withRouterLock(`${platformID}:${host}`, async () => {
                const channel = await this.getMikrotikChannel(platformID, host);
                if (!channel) return;

                let mikrotikUsers = [];
                let mikrotikActiveUsers = [];
                let cookies = [];

                try {
                    mikrotikUsers = await this.mikrotik.listHotspotUsers(channel);
                    mikrotikActiveUsers = await this.mikrotik.listHotspotActiveUsers(channel);
                    cookies = await channel.write("/ip/hotspot/cookie/print", []);
                } catch {
                    return;
                }

                const routerUsers = apiExpiredUsers.filter(
                    (user) => {
                        const userHost = resolveUserHost(user);
                        return !userHost || userHost === host;
                    }
                );

                for (const user of routerUsers) {
                    const identifiers = new Set(
                        [user.username, user.code, user.mac]
                            .filter((value) => typeof value === "string" && value !== "null" && value.trim() !== "")
                    );
                    if (identifiers.size === 0) continue;

                    try {
                        const mikrotikUser = mikrotikUsers.find(
                            u => identifiers.has(u.name)
                        );
                        const mikrotikActiveUser = mikrotikActiveUsers.find(
                            u => identifiers.has(u.name)
                        );
                        const targetCookies = cookies.filter(
                            c => identifiers.has(c.user)
                        );

                        for (const cookie of targetCookies) {
                            await this.mikrotik.deleteHotspotCookie(channel, cookie[".id"]);
                        }

                        if (mikrotikUser) {
                            await this.mikrotik.deleteHotspotUser(channel, mikrotikUser[".id"]);
                        }

                        if (mikrotikActiveUser) {
                            await this.mikrotik.deleteHotspotActiveUser(
                                channel,
                                mikrotikActiveUser[".id"]
                            );
                        }

                    } catch {
                        // Ignore per-user router errors
                    }
                }
            });
        }
    }

    async disablePPPSecret(platformID, userName, host) {
        const lockKey = `${platformID}:${host}`;

        try {
            const stations = await this.db.getStations(platformID);
            const stationRecord = stations?.find((s) => s.mikrotikHost === host);
            if (stationRecord?.systemBasis === "RADIUS") {
                await this.db.deleteRadiusUser(userName);
                return {
                    success: true,
                    message: `RADIUS user "${userName}" removed successfully`,
                };
            }

            return await this.withRouterLock(lockKey, async () => {
                const channel = await this.getMikrotikChannel(platformID, host);
                if (!channel) {
                    return {
                        success: false,
                        message: "No valid MikroTik connection",
                    };
                }

                const secrets = await this.mikrotik.listSecrets(channel);
                const secret = secrets.find(s => s.name === userName);

                if (!secret) {
                    return {
                        success: true,
                        message: `PPP secret "${userName}" not found`,
                    };
                }

                await this.mikrotik.updateSecret(channel, secret[".id"], {
                    disabled: "true",
                });

                return {
                    success: true,
                    message: `PPP secret "${userName}" disabled successfully`,
                };
            });
        } catch (error) {
            console.error(
                `Error disabling PPP secret for user ${userName} on host ${host}:`,
                error
            );

            return {
                success: false,
                message: error.message || "Failed to disable PPP secret",
            };
        }
    }

    async checkPPPoEExpirations() {
        try {
            const now = new Date();
            const activeServices = await this.db.getAllActivePPPoE();

            for (const service of activeServices) {
                try {
                    const expiresAt = new Date(service.expiresAt);
                    const reminderDate = new Date(expiresAt);
                    reminderDate.setDate(reminderDate.getDate() - 1);

                    const gracePeriodEnd = new Date(expiresAt);
                    gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 1);

                    const platform = await this.db.getPlatform(service.platformID);
                    const template = await this.db.getPlatformEmailTemplate(service.platformID);

                    if (now.toDateString() === reminderDate.toDateString() && service.status === "active" && !service.reminderSent) {
                        if (service.email) {
                            const subject = `Reminder: Your ${platform.name} PPPoE plan expires soon!`;
                            const message = template?.pppoeReminderTemplate
                                ? Utils.formatMessage(template.pppoeReminderTemplate, {
                                    name: service.clientname,
                                    password: service.clientpassword,
                                    email: service.email,
                                    company: platform.name,
                                    package: service.profile,
                                    price: service.price,
                                    amount: service.amount,
                                    expiry: expiresAt.toDateString(),
                                    paymentLink: `<a href="https://${platform.url}/pppoe?info=${service.paymentLink}">https://${platform.url}/pppoe?info=${service.paymentLink}</a>`,
                                    accountNumber: service.accountNumber || "",
                                })
                                : `
<p>Reminder: Your PPPoE plan with <strong>${platform.name}</strong> will expire in 1 day.<br />
Package: ${service.name}<br />
Price: KSH ${service.price}</p>
<p>To avoid service interruption, renew now at:<br />
<a href="https://${platform.url}/pppoe?info=${service.paymentLink}">https://${platform.url}/pppoe?info=${service.paymentLink}</a></p>
`;

                            await this.mailer.EmailTemplate({
                                name: service.email,
                                type: "accounts",
                                email: service.email,
                                subject,
                                message,
                                company: platform.name
                            });

                        }
                        if (service.phone) {
                            await this.sendPPPoESMS({ service, platform, type: "reminder", expiresAt });
                        }
                        await this.db.updatePPPoE(service.id, { reminderSent: true });
                    }

                    if (now > gracePeriodEnd && service.status === "active") {
                        await this.db.updatePPPoE(service.id, {
                            status: "inactive",
                            amount: (Number(service.amount) + Number(service.price)).toString()
                        });

                        await this.disablePPPSecret(service.platformID, service.clientname, service.station);

                        if (service.email) {
                            const subject = `Your ${platform.name} PPPoE Service has expired!`;
                            const message = template?.pppoeExpiredTemplate
                                ? Utils.formatMessage(template.pppoeExpiredTemplate, {
                                    name: service.clientname,
                                    password: service.clientpassword,
                                    email: service.email,
                                    company: platform.name,
                                    package: service.profile,
                                    price: service.price,
                                    amount: service.amount,
                                    expiry: expiresAt.toDateString(),
                                    paymentLink: `<a href="https://${platform.url}/pppoe?info=${service.paymentLink}">https://${platform.url}/pppoe?info=${service.paymentLink}</a>`,
                                    accountNumber: service.accountNumber || "",
                                })
                                : `
<p>Your WiFi PPPoE credentials have been disabled by <strong>${platform.name}</strong> due to late payments of KSH ${service.amount}.</p>
<p>To reactivate, please pay at:<br />
<a href="https://${platform.url}/pppoe?info=${service.paymentLink}">https://${platform.url}/pppoe?info=${service.paymentLink}</a></p>
`;
                            await this.mailer.EmailTemplate({
                                name: service.email,
                                type: "accounts",
                                email: service.email,
                                subject,
                                message,
                                company: platform.name
                            });
                        }

                        if (service.phone) {
                            await this.sendPPPoESMS({ service, platform, type: "expired", expiresAt });
                        }
                    }
                } catch (error) {
                    console.error(`Error processing PPPoE ${service.id}:`, error);
                }
            }
        } catch (error) {
            console.error("PPPoE expiration check failed:", error);
        }
    }

    async expireDataPlansForPlatform(platform) {
        const platformID = platform.platformID;

        const routers = await this.db.getStations(platformID);
        if (!routers || routers.length === 0) return;

        const users = await this.db.getActivePlatformUsers(platformID);
        const limitedUsers = users.filter(
            user => String(user.package?.category || "").toLowerCase() === "data" && user.username
        );
        if (limitedUsers.length === 0) return;

        const stationByHost = new Map(routers.map((r) => [r.mikrotikHost, r]));
        const parseUsageToBytes = (usage) => {
            const text = String(usage || "").trim();
            if (!text || /^unlimited$/i.test(text)) return 0;
            const match = text.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);
            if (!match) return 0;
            const unitMap = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
            const factor = unitMap[match[2].toUpperCase()];
            if (!factor) return 0;
            const num = Number(match[1]);
            if (!Number.isFinite(num) || num <= 0) return 0;
            return Math.round(num * factor);
        };

        const radiusUsers = limitedUsers.filter((user) => {
            const host = user.package?.routerHost;
            if (!host) return false;
            const station = stationByHost.get(host);
            return station?.systemBasis === "RADIUS";
        });
        const apiUsers = limitedUsers.filter((user) => {
            const host = user.package?.routerHost;
            if (!host) return true;
            const station = stationByHost.get(host);
            return station?.systemBasis !== "RADIUS";
        });

        if (radiusUsers.length > 0) {
            const usernames = Array.from(new Set(radiusUsers.map((u) => u.username).filter(Boolean)));
            const usageMap = await this.db.getRadiusUsageByUsernames(usernames);
            const depletedByHost = new Map();
            for (const user of radiusUsers) {
                const username = user.username;
                const limitBytes = parseUsageToBytes(user.package?.fupLimit) || parseUsageToBytes(user.package?.usage);
                if (!username || limitBytes <= 0) continue;
                const usedBytes = usageMap[username] || 0;
                if (Number(usedBytes) < limitBytes) continue;
                await this.db.updateUser(user.id, { status: "expired" });
                await this.db.deleteRadiusUser(username);
                const host = user.package?.routerHost;
                if (host) {
                    const depleted = depletedByHost.get(host) || [];
                    depleted.push(username);
                    depletedByHost.set(host, depleted);
                }
            }

            for (const [host, depletedUsernames] of depletedByHost.entries()) {
                await this.withRouterLock(`${platformID}:${host}`, async () => {
                    const channel = await this.getMikrotikChannel(platformID, host);
                    if (!channel) return;

                    try {
                        const activeUsers = await this.mikrotik.listHotspotActiveUsers(channel);
                        const depletedSet = new Set(depletedUsernames);
                        for (const active of activeUsers || []) {
                            const activeName = active?.user || active?.name;
                            if (!active?.[".id"] || !depletedSet.has(activeName)) continue;
                            await this.mikrotik.deleteHotspotActiveUser(channel, active[".id"]);
                        }
                    } catch {
                        // RADIUS credentials were already removed; router session cleanup is best-effort.
                    }
                });
            }
        }

        for (const router of routers) {
            if (!router.mikrotikHost) continue;
            if (router.systemBasis === "RADIUS") continue;
            const host = router.mikrotikHost;
            const routerUsers = apiUsers.filter(
                (user) => !user.package?.routerHost || user.package.routerHost === host
            );
            if (routerUsers.length === 0) continue;

            await this.withRouterLock(`${platformID}:${host}`, async () => {
                const channel = await this.getMikrotikChannel(platformID, host);
                if (!channel) return;

                let activeUsers = [];
                let cookies = [];

                try {
                    activeUsers = await this.mikrotik.listHotspotActiveUsers(channel);
                    cookies = await channel.write("/ip/hotspot/cookie/print", []);
                } catch {
                    return;
                }

                for (const user of routerUsers) {
                    const username = user.username;

                    try {
                        const mikrotikUser = await this.mikrotik.getHotspotUsersByName(channel, username);
                        if (!mikrotikUser || mikrotikUser.length === 0) continue;

                        const userRecord = Array.isArray(mikrotikUser)
                            ? mikrotikUser[0]
                            : mikrotikUser;

                        if (!userRecord[".id"]) {
                            await this.db.updateUser(user.id, { status: "expired" });
                            continue;
                        }

                        const usage = await this.getUserUsageFromMikroTik(channel, username);
                        const totalBytesUsed = usage.bytesIn + usage.bytesOut;

                        if (totalBytesUsed < usage.limitBytes) continue;

                        await this.db.updateUser(user.id, { status: "expired" });

                        for (const cookie of cookies.filter(c => c.user === username)) {
                            await this.mikrotik.deleteHotspotCookie(channel, cookie[".id"]);
                        }

                        await this.mikrotik.deleteHotspotUser(channel, userRecord[".id"]);

                        const active = activeUsers.find(u => u.name === username);
                        if (active?.[".id"]) {
                            await this.mikrotik.deleteHotspotActiveUser(channel, active[".id"]);
                        }

                    } catch {
                        // Per-user router errors ignored
                    }
                }
            });
        }
    }

    parseDataLimitBytes(value) {
        const text = String(value || "").trim();
        if (!text || /^unlimited$/i.test(text)) return 0;
        const match = text.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);
        if (!match) return 0;
        const unitMap = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
        const factor = unitMap[match[2].toUpperCase()];
        const amount = Number(match[1]);
        if (!factor || !Number.isFinite(amount) || amount <= 0) return 0;
        return Math.round(amount * factor);
    }

    async expireRadiusPPPoEFupForPlatform(platform) {
        const platformID = platform.platformID;
        const [stations, pppoeAccounts, plans] = await Promise.all([
            this.db.getStations(platformID),
            this.db.getPPPoE(platformID),
            this.db.getPPPoEPlans(platformID),
        ]);
        if (!Array.isArray(stations) || !Array.isArray(pppoeAccounts) || pppoeAccounts.length === 0) return;

        const radiusHosts = new Set(
            stations
                .filter((station) => String(station?.systemBasis || "API").toUpperCase() === "RADIUS")
                .map((station) => station.mikrotikHost)
                .filter(Boolean)
        );
        if (radiusHosts.size === 0) return;

        const planMap = new Map((Array.isArray(plans) ? plans : []).map((plan) => [plan.id, plan]));
        const activeRadiusAccounts = pppoeAccounts.filter((account) =>
            String(account?.status || "").toLowerCase() === "active" &&
            account?.clientname &&
            radiusHosts.has(account?.station)
        );

        for (const account of activeRadiusAccounts) {
            const plan = account.planId ? planMap.get(account.planId) : null;
            const limitBytes = this.parseDataLimitBytes(account.fupLimit) || this.parseDataLimitBytes(plan?.fupLimit);
            if (limitBytes <= 0) continue;

            const cycleStartedAt = account.updatedAt || account.createdAt || null;
            const usedBytes = await this.db.getRadiusUsageByUsernameSince(account.clientname, cycleStartedAt);
            if (Number(usedBytes) < limitBytes) continue;

            await this.db.updatePPPoE(account.id, { status: "expired" });
            await this.disablePPPSecret(platformID, account.clientname, account.station);
            socketManager.log(platformID, `Cron: PPPoE FUP depleted for ${account.clientname}`, {
                context: "cron",
                level: "warn",
            });
        }
    }

    async getUserUsageFromMikroTik(channel, username) {
        const users = await this.mikrotik.listHotspotUsers(channel);
        const user = users.find(u => u.name === username);

        const bytesIn = parseInt(user?.['bytes-in'] || '0');
        const bytesOut = parseInt(user?.['bytes-out'] || '0');
        const limitBytes = parseInt(user?.['limit-bytes-total'] || '0');

        return { bytesIn, bytesOut, limitBytes };
    }

    async handleShortCodeBalance(platformID) {
        const req = { body: { platformID } };
        const res = { status: () => ({ json: () => ({}) }) };
        return this.mpesa.handleShortCodeBalance(req, res);
    }

    async saveShortCodeBalances(platform) {
        try {
            const platformID = platform.platformID;
            await this.handleShortCodeBalance(platformID);
        } catch (err) {
            console.error('Failed to save short code balances:', err);
        }
    }

    async rebootRouters() {
        const platforms = await this.db.getPlatforms();

        for (const platform of platforms) {
            const platformID = platform.platformID;
            try {
                const routers = await this.db.getStations(platformID);
                if (!routers || routers.length === 0) continue;

                for (const router of routers) {
                    if (!router?.mikrotikHost) continue;
                    const host = router.mikrotikHost;

                    try {
                        const connection = await this.config.createSingleMikrotikClient(platformID, host);
                        if (!connection?.channel) continue;

                        const { channel } = connection;

                        console.log(`Rebooting router: ${host}`);
                        await this.mikrotik.reboot(channel);

                        console.log(`Router ${host} rebooted successfully`);
                    } catch { }
                }
            } catch { }
        }
    }

    async makeSureUsersInMikrotikAreActiveInDatabaseForPlatform(platform) {
        const platformID = platform.platformID;

        const routers = await this.db.getStations(platformID);
        if (!routers || routers.length === 0) return;

        const dbActiveUsers = await this.db.getActivePlatformUsers(platformID);
        const activeUsersByRouter = new Map();
        const globalActiveUsers = new Set();

        for (const user of dbActiveUsers || []) {
            const identifiers = [user.username, user.code, user.mac, user.phone]
                .filter((val) => typeof val === "string" && val !== "null" && val.trim() !== "")
                .map((val) => val.trim());
            if (identifiers.length === 0) continue;
            const routerHost = user.package?.routerHost;
            if (routerHost) {
                if (!activeUsersByRouter.has(routerHost)) {
                    activeUsersByRouter.set(routerHost, new Set());
                }
                const set = activeUsersByRouter.get(routerHost);
                for (const id of identifiers) set.add(id);
            } else {
                for (const id of identifiers) globalActiveUsers.add(id);
            }
        }

        for (const router of routers) {
            if (!router?.mikrotikHost) continue;
            const host = router.mikrotikHost;

            await this.withRouterLock(`${platformID}:${host}`, async () => {
                const channel = await this.getMikrotikChannel(platformID, host);
                if (!channel) return;

                let mikrotikUsers = [];
                let mikrotikActiveUsers = [];
                let cookies = [];

                try {
                    mikrotikUsers = await this.mikrotik.listHotspotUsers(channel);
                    mikrotikActiveUsers = await this.mikrotik.listHotspotActiveUsers(channel);
                    cookies = await channel.write("/ip/hotspot/cookie/print", []);
                } catch {
                    return;
                }

                const activeUsernames = new Set([
                    ...globalActiveUsers,
                    ...(activeUsersByRouter.get(host) || new Set()),
                ]);

                for (const mUser of mikrotikUsers) {
                    const username = typeof mUser.name === "string" ? mUser.name.trim() : "";
                    if (!username) continue;
                    if (username === "default-trial") continue;
                    if (activeUsernames.has(username)) continue;

                    try {
                        const targetCookies = cookies.filter(c => c.user === username);
                        for (const cookie of targetCookies) {
                            await this.mikrotik.deleteHotspotCookie(channel, cookie[".id"]);
                        }

                        await this.mikrotik.deleteHotspotUser(channel, mUser[".id"]);

                        const mActive = mikrotikActiveUsers.find(u => u.name === username);
                        if (mActive?.[".id"]) {
                            await this.mikrotik.deleteHotspotActiveUser(channel, mActive[".id"]);
                        }
                    } catch {
                        // Per-user router errors ignored
                    }
                }
            });
        }
    }

    async checkUsersViolatingSystemThroughPayments(platform) {
        try {
            const platformID = platform.platformID;
            const platformName = platform.name;

            const mpesaPayments = await this.db.getMpesaFailedByPlatform(platformID);

            if (!mpesaPayments || mpesaPayments.length === 0) return;

            const uniquePhones = new Set();
            for (const pay of mpesaPayments) {
                if (pay.phone) uniquePhones.add(pay.phone);
            }

            for (const phone of uniquePhones) {
                const payments = await this.db.getMpesaByPlatformAndPhone(platformID, phone, 60);
                if (!payments || payments.length === 0) continue;

                let consecutiveFails = 0;
                for (const p of payments) {
                    if (p.status === "FAILED") {
                        consecutiveFails++;
                    } else {
                        break;
                    }
                }

                if (consecutiveFails >= 50) {
                    const alreadyBlocked = await this.db.getBlockedUserByPhone(phone, platformID);
                    if (!alreadyBlocked) {
                        await this.db.createBlockedUser({
                            phone,
                            reason: "Payments violation — 50 consecutive failed transactions.",
                            platformID,
                            blockedBy: platformName,
                            status: "blocked"
                        });
                    }
                }
            }
        } catch (err) {
            console.error("Error checking users violating payment rules:", err);
        }
    }

    async sendStationDownSMS(stationName, stationHost, phone, platformID) {
        try {
            const platformConfig = await this.db.getPlatformConfig(platformID);
            if (platformConfig?.sms !== true) return;
            const sms = await this.db.getPlatformSMS(platformID);
            if (!sms) return;

            const message = `Router ${stationName} (${stationHost}) is offline.`;
            await this.sms.sendSMS(phone, message, sms);
        } catch { }
    }

    async monitorStationsForPlatform(platform) {
        const platformID = platform.platformID;

        const routers = await this.db.getStations(platformID);
        if (!routers || routers.length === 0) return;

        const admins = await this.db.getAdminsByID(platform.adminID);

        for (const router of routers) {
            if (!router.mikrotikHost) continue;

            try {
                await this.withRouterLock(`${platformID}:${router.mikrotikHost}`, async () => {
                    const channel = await this.getMikrotikChannel(platformID, router.mikrotikHost);
                    if (!channel) {
                        if (router.reminderSent === false) {
                            for (const admin of admins) {
                                if (admin.phone) {
                                    await this.sendStationDownSMS(
                                        router.name || "Unknown Station",
                                        router.mikrotikHost,
                                        admin.phone,
                                        platformID
                                    );
                                }
                            }
                        }
                        await this.db.updateStation(router.id, { reminderSent: true });
                        return;
                    }

                    const isAlive = await this.pingWithRetry(
                        () => this.pingRouter(channel, router.mikrotikHost),
                        3
                    );

                    if (!isAlive && router.reminderSent === false) {
                        for (const admin of admins) {
                            if (admin.phone) {
                                await this.sendStationDownSMS(
                                    router.name || "Unknown Station",
                                    router.mikrotikHost,
                                    admin.phone,
                                    platformID
                                );
                            }
                        }
                        await this.db.updateStation(router.id, { reminderSent: true });
                    }
                    if (isAlive && router.reminderSent !== false) {
                        await this.db.updateStation(router.id, { reminderSent: false });
                    }
                });
            } catch (err) {
                console.error("Station monitor error:", err);

                if (router.reminderSent === false) {
                    for (const admin of admins) {
                        if (admin.phone) {
                            await this.sendStationDownSMS(
                                router.name || "Unknown Station",
                                router.mikrotikHost,
                                admin.phone,
                                platformID
                            );
                        }
                    }
                    await this.db.updateStation(router.id, { reminderSent: true });
                }
            }
        }
    }

    async manageBillingForPlatform(platform) {
        const platformID = platform.platformID;
        const now = new Date();

        const serviceKey = "billing";
        const service = await this.db.getSystemServiceByKey(serviceKey);
        if (!service) return;

        let billing = await this.db.getPlatformBillingByName(service.name, platformID);

        if (String(platform.status || "").toLowerCase() === "premium") {
            const premiumBill = {
                period: service.period,
                platformID,
                name: service.name,
                price: String(service.price || "500"),
                amount: "0",
                currency: service.currency || "KES",
                dueDate: null,
                paidAt: billing?.paidAt || now,
                status: "Paid",
                description: service.description,
                meta: { serviceKey, plan: "basic", premium: true },
            };
            if (billing) {
                await this.db.updatePlatformBilling(billing.id, premiumBill);
            } else {
                await this.db.createPlatformBilling(premiumBill);
            }
            return;
        }

        const parsePeriod = (periodValue) => {
            const text = String(periodValue || "").trim().toLowerCase();
            const match = text.match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
            if (!match) return null;
            const value = Number(match[1]);
            const unit = match[2].toLowerCase();
            if (!Number.isFinite(value) || value <= 0) return null;
            return { value, unit };
        };
        const periodSpec = parsePeriod(billing?.period || service.period) || { value: 1, unit: "month" };
        const addServicePeriod = (dateValue) => Utils.addPeriod(dateValue, periodSpec.value, periodSpec.unit);

        if (!billing) {
            const createdAt = new Date(platform.createdAt);

            const dueDate = addServicePeriod(createdAt);

            billing = await this.db.createPlatformBilling({
                period: service.period,
                platformID,
                name: service.name,
                price: service.price,
                amount: String(service.price),
                currency: "KES",
                dueDate,
                status: "Unpaid",
                description: service.description
            });
        }

        const toValidDate = (value) => {
            const parsed = new Date(value);
            if (Number.isNaN(parsed.getTime())) return null;
            return parsed;
        };

        let baseDate = toValidDate(billing.paidAt) || toValidDate(platform.createdAt);

        // If a bill payment was made, mark as paid and re-enable the platform if needed.
        // Prefer payments referencing this exact bill. Fallback: match known bill amounts (485/500) for legacy records without referenceID.
        const referencedPayment = await this.db.getPlatformLastBillPaymentForBill(platformID, billing.id);
        const legacyAmountPayment = referencedPayment
            ? null
            : await this.db.getPlatformLastBillPaymentByAmounts(platformID, [485, 500]);
        const prevPayment = referencedPayment || legacyAmountPayment;
        const mpesaPaidAt = toValidDate(prevPayment?.createdAt);
        if (mpesaPaidAt) {
            const billingPaidAt = toValidDate(billing.paidAt);
            const paidAtChanged = !billingPaidAt || mpesaPaidAt > billingPaidAt;
            if (paidAtChanged) {
                const nextDueDate = addServicePeriod(new Date(mpesaPaidAt));
                await this.db.updatePlatformBilling(billing.id, {
                    status: "Paid",
                    amount: "0",
                    paidAt: mpesaPaidAt,
                    dueDate: nextDueDate,
                });
                billing.status = "Paid";
                billing.amount = "0";
                billing.paidAt = mpesaPaidAt;
                billing.dueDate = nextDueDate;
            }

            if (String(platform.status || "").toLowerCase() === "inactive") {
                await this.db.updatePlatform(platformID, { status: "active" });
                platform.status = "active";
            }

            if (!baseDate || mpesaPaidAt > baseDate) baseDate = mpesaPaidAt;
        }

        if (!baseDate) return;

        const firstDueDate = addServicePeriod(baseDate);
        const disableOn = new Date(firstDueDate);
        disableOn.setDate(disableOn.getDate() + 3);

        // Keep a dueDate on the bill, but never use a "pushed-ahead" dueDate to decide disabling.
        let effectiveDueDate = billing.dueDate ? new Date(billing.dueDate) : firstDueDate;
        if (Number.isNaN(effectiveDueDate.getTime()) || effectiveDueDate <= baseDate) {
            effectiveDueDate = firstDueDate;
        }
        if (!billing.dueDate || new Date(billing.dueDate).getTime() !== effectiveDueDate.getTime()) {
            await this.db.updatePlatformBilling(billing.id, { dueDate: effectiveDueDate });
        }

        // If overdue, accrue per missed billing cycle(s) using the real service period.
        if (now >= effectiveDueDate) {
            const price = Number(billing.price || service.price || 0);
            let amount = Number(billing.amount || 0);
            let nextDue = addServicePeriod(new Date(effectiveDueDate));
            let cycles = 0;
            while (now >= nextDue && cycles < 120) {
                amount += price;
                nextDue = addServicePeriod(nextDue);
                cycles += 1;
            }
            await this.db.updatePlatformBilling(billing.id, {
                amount: String(amount),
                status: "Unpaid",
                dueDate: nextDue,
            });
        }

        // Disable after 3 days past due since last payment (or platform creation if never paid).
        if (now >= disableOn) {
            if (platform.status !== "Inactive") {
                await this.db.updatePlatform(platformID, { status: "Inactive" });
            }
        }
    }

    getPaystackSecretKey() {
        return process.env.PAYSTACK_SECRET_KEY || "";
    }

    buildPaystackRetryReference(platformID, billID) {
        return `ncr.${platformID}.${String(billID || "").replace(/-/g, "")}.${Date.now()}`;
    }

    getBillCardAutopay(bill) {
        const meta = bill?.meta && typeof bill.meta === "object" ? bill.meta : {};
        return meta.cardAutopay && typeof meta.cardAutopay === "object" ? meta.cardAutopay : null;
    }

    async updateBillCardAutopay(bill, cardAutopay) {
        const meta = bill?.meta && typeof bill.meta === "object" ? { ...bill.meta } : {};
        const cleanCardAutopay = Object.fromEntries(
            Object.entries(cardAutopay || {}).filter(([, value]) => value !== undefined)
        );
        meta.cardAutopay = {
            ...(meta.cardAutopay || {}),
            ...cleanCardAutopay,
            updatedAt: new Date().toISOString(),
        };
        return this.db.updatePlatformBilling(bill.id, { meta });
    }

    getPaystackRetryState(cardAutopay, invoiceKey) {
        const retries = cardAutopay?.retries && typeof cardAutopay.retries === "object" ? cardAutopay.retries : {};
        const current = retries[invoiceKey] && typeof retries[invoiceKey] === "object" ? retries[invoiceKey] : {};
        return { retries, current };
    }

    canRunPaystackRetry(cardAutopay, invoiceKey, now) {
        const maxAttempts = Math.max(1, Number(process.env.PAYSTACK_CARD_RETRY_MAX_DAILY_ATTEMPTS || 3));
        const minHoursBetweenAttempts = Math.max(1, Number(process.env.PAYSTACK_CARD_RETRY_INTERVAL_HOURS || 8));
        const { current } = this.getPaystackRetryState(cardAutopay, invoiceKey);
        const today = now.toISOString().slice(0, 10);
        const lastDate = current.lastAttemptAt ? new Date(current.lastAttemptAt).toISOString().slice(0, 10) : null;
        const attemptsToday = lastDate === today ? Number(current.attemptsToday || 0) : 0;
        if (attemptsToday >= maxAttempts) return { allowed: false, reason: "daily_attempt_limit" };
        if (current.lastAttemptAt) {
            const lastAttemptAt = new Date(current.lastAttemptAt);
            if (!Number.isNaN(lastAttemptAt.getTime())) {
                const elapsedHours = (now.getTime() - lastAttemptAt.getTime()) / 36e5;
                if (elapsedHours < minHoursBetweenAttempts) return { allowed: false, reason: "retry_interval" };
            }
        }
        return { allowed: true, attemptsToday, maxAttempts };
    }

    async chargePaystackAuthorization({ email, amount, authorizationCode, currency, reference }) {
        const secretKey = this.getPaystackSecretKey();
        if (!secretKey) throw new Error("Paystack secret key is not configured.");
        const response = await axios.post(
            "https://api.paystack.co/transaction/charge_authorization",
            {
                email,
                amount: String(Math.round(Number(amount) * 100)),
                authorization_code: authorizationCode,
                reference,
                currency: currency || "KES",
            },
            {
                timeout: 20000,
                headers: {
                    accept: "application/json",
                    "content-type": "application/json",
                    Authorization: `Bearer ${secretKey}`,
                },
            }
        );
        return response.data;
    }

    mapPaystackTransactionStatus(status) {
        const normalized = String(status || "").toLowerCase();
        if (normalized === "success") return "COMPLETE";
        if (["failed", "reversed", "abandoned"].includes(normalized)) return "FAILED";
        return "PENDING";
    }

    async recordPaystackRetryResult(platformID, bill, reference, transaction, fallback) {
        const status = this.mapPaystackTransactionStatus(transaction?.status || fallback?.status);
        const amount = Number(transaction?.amount || 0) / 100 || Number(fallback?.amount || bill.amount || bill.price || 0);
        const fees = Number(transaction?.fees || 0) / 100;
        const customer = transaction?.customer || {};
        const authorization = transaction?.authorization || {};
        const existing = await this.db.getMpesaCode(reference);
        let payment = existing;
        const data = {
            platformID,
            amount: String(amount),
            code: reference,
            reqcode: reference,
            phone: customer.email || fallback?.email || "card",
            status,
            service: "bill",
            paymentMethod: "PAYSTACK-CARD-RETRY",
            reason: null,
            referenceID: bill.id,
            type: "deposit",
            charges: fees ? fees.toFixed(2) : "0.00",
            failed_reason: transaction?.gateway_response || transaction?.message || fallback?.message || "null",
            FirstName: customer.first_name || "N/A",
            LastName: customer.last_name || "N/A",
            verified: status === "COMPLETE",
        };

        if (!payment) {
            payment = await this.db.addMpesaCode(data);
        } else {
            payment = await this.db.updateMpesaCodeByID(payment.id, {
                status,
                charges: data.charges,
                failed_reason: data.failed_reason,
                verified: data.verified,
            });
        }

        await this.updateBillCardAutopay(bill, {
            provider: "paystack",
            status,
            reference,
            setupUrl: null,
            paymentMethod: "PAYSTACK-CARD-RETRY",
            cardMask: authorization.last4 ? `${authorization.card_type || authorization.brand || "Card"} **** ${authorization.last4}` : undefined,
            cardType: authorization.card_type || authorization.brand,
            cardExpiry: authorization.exp_month && authorization.exp_year ? `${authorization.exp_month}/${authorization.exp_year}` : undefined,
            authorizationCode: authorization.authorization_code,
            authorizationReusable: authorization.reusable,
            customerEmail: customer.email || fallback?.email,
            amount: String(amount),
            currency: transaction?.currency || fallback?.currency || bill.currency || "KES",
            paidAt: status === "COMPLETE" ? new Date().toISOString() : undefined,
            paystackTransactionID: transaction?.id,
        });

        if (status === "COMPLETE" && payment) {
            await this.mpesa.completePaymentForService(payment);
        }

        return { status, payment };
    }

    async retryPaystackCardBillingForPlatform(platform) {
        const platformID = platform.platformID;
        if (!this.getPaystackSecretKey()) return;

        const bills = await this.db.getUnpaidPlatformBilling(platformID);
        if (!Array.isArray(bills) || bills.length === 0) return;

        const now = new Date();
        for (const bill of bills) {
            const amount = Number(bill.amount || 0);
            if (!Number.isFinite(amount) || amount <= 0) continue;

            const cardAutopay = this.getBillCardAutopay(bill);
            if (cardAutopay?.provider !== "paystack") continue;
            if (!cardAutopay.authorizationCode || !cardAutopay.customerEmail) continue;
            if (cardAutopay.authorizationReusable === false) continue;

            const invoiceKey = `${bill.id}:${bill.dueDate ? new Date(bill.dueDate).toISOString().slice(0, 10) : "open"}:${amount}`;
            const retryGate = this.canRunPaystackRetry(cardAutopay, invoiceKey, now);
            if (!retryGate.allowed) continue;

            const { retries, current } = this.getPaystackRetryState(cardAutopay, invoiceKey);
            const today = now.toISOString().slice(0, 10);
            const lastDate = current.lastAttemptAt ? new Date(current.lastAttemptAt).toISOString().slice(0, 10) : null;
            const attemptsToday = lastDate === today ? Number(current.attemptsToday || 0) : 0;
            const reference = this.buildPaystackRetryReference(platformID, bill.id);

            retries[invoiceKey] = {
                ...current,
                attempts: Number(current.attempts || 0) + 1,
                attemptsToday: attemptsToday + 1,
                lastAttemptAt: now.toISOString(),
                lastReference: reference,
                lastStatus: "PROCESSING",
            };

            await this.updateBillCardAutopay(bill, {
                retries,
                lastRetryReference: reference,
                lastRetryAt: now.toISOString(),
                status: "PROCESSING",
            });

            try {
                const response = await this.chargePaystackAuthorization({
                    email: cardAutopay.customerEmail,
                    amount,
                    authorizationCode: cardAutopay.authorizationCode,
                    currency: bill.currency || cardAutopay.currency || "KES",
                    reference,
                });
                const transaction = response?.data || {};
                const result = await this.recordPaystackRetryResult(platformID, bill, reference, transaction, {
                    amount,
                    email: cardAutopay.customerEmail,
                    currency: bill.currency || cardAutopay.currency || "KES",
                    message: response?.message,
                });
                retries[invoiceKey] = {
                    ...retries[invoiceKey],
                    lastStatus: result.status,
                    lastMessage: response?.message || transaction?.gateway_response || result.status,
                };
                await this.updateBillCardAutopay(bill, { retries });
                socketManager.log(platformID, `Paystack card retry ${result.status} for ${bill.name || "bill"} (ref ${reference})`, {
                    context: "payments",
                    level: result.status === "COMPLETE" ? "success" : "warn",
                });
            } catch (error) {
                const message = error?.response?.data?.message || error?.message || "Paystack retry failed";
                retries[invoiceKey] = {
                    ...retries[invoiceKey],
                    lastStatus: "FAILED",
                    lastMessage: message,
                };
                await this.updateBillCardAutopay(bill, {
                    retries,
                    status: "FAILED",
                    failedReason: message,
                });
                await this.recordPaystackRetryResult(platformID, bill, reference, null, {
                    amount,
                    email: cardAutopay.customerEmail,
                    currency: bill.currency || cardAutopay.currency || "KES",
                    status: "failed",
                    message,
                });
                socketManager.log(platformID, `Paystack card retry failed for ${bill.name || "bill"}: ${message}`, {
                    context: "payments",
                    level: "warn",
                });
            }
        }
    }

    async managePluginBillsForPlatform(platform) {
        const platformID = platform.platformID;
        const bills = await this.db.getPlatformBilling(platformID);
        if (!bills || bills.length === 0) return;

        const pluginBills = bills.filter((bill) => bill?.meta?.isPlugin === true);
        if (pluginBills.length === 0) return;

        const plugins = await this.db.getPlatformPlugins(platformID);
        if (!plugins || plugins.length === 0) return;

        const pluginMap = new Map(plugins.map((plugin) => [plugin.serviceKey, plugin]));
        const now = new Date();

        for (const bill of pluginBills) {
            const serviceKey = bill?.meta?.serviceKey;
            if (!serviceKey) continue;

            const plugin = pluginMap.get(serviceKey);
            if (!plugin) continue;

            const billStatus = String(bill.status || "").toLowerCase();
            const dueDate = bill.dueDate ? new Date(bill.dueDate) : null;
            const isOverdue = dueDate ? now >= dueDate : false;

            if (billStatus !== "paid" && isOverdue) {
                if (plugin.status !== "disabled") {
                    await this.db.updatePlatformPlugin(platformID, serviceKey, { status: "disabled" });
                }
                const meta = bill.meta || {};
                if (!meta.disableOn) {
                    await this.db.updatePlatformBilling(bill.id, {
                        meta: {
                            ...meta,
                            disableOn: now.toISOString(),
                            disableReason: "payment_overdue",
                        },
                    });
                }
                continue;
            }

            if (billStatus === "paid" && plugin.status === "disabled" && bill?.meta?.disableOn) {
                await this.db.updatePlatformPlugin(platformID, serviceKey, { status: "active" });
                const meta = { ...(bill.meta || {}) };
                delete meta.disableOn;
                delete meta.disableReason;
                await this.db.updatePlatformBilling(bill.id, { meta });
            }
        }
    }

    async createMikrotikBackUpForPlatform(platform) {
        const now = dayjs();
        const platformID = platform.platformID;

        const routers = await this.db.getStations(platformID);
        if (!routers || routers.length === 0) return;

        for (const router of routers) {
            if (!router?.mikrotikHost) continue;
            const host = router.mikrotikHost;
            if (this.shouldSkipRouterConnection(platformID, host, "apiraw")) {
                continue;
            }

            try {
                socketManager.log(platformID, `Backup started for router ${host}`, {
                    context: "backup",
                    level: "info",
                });
                // @ts-ignore
                const apiConnection = await this.config.createSingleMikrotikClientAPI(platformID, host);
                if (!apiConnection?.api) {
                    this.markRouterConnectionFailure(platformID, host, "apiraw");
                    socketManager.log(platformID, `Backup failed for router ${host}: missing API connection`, {
                        context: "backup",
                        level: "error",
                    });
                    continue;
                }
                let channel = null;
                const timestamp = now.format("YYYY-MM-DD_HH-mm-ss");
                const backupBase = `backup_${timestamp}`;
                const backupName = `${backupBase}.backup`;
                const folderPath = path.join(appRoot, "backups", "remote-hosts", host);
                const relativePath = path.join("backups", "remote-hosts", host, backupName);

                try {
                    await apiConnection.api.connect();
                    this.clearRouterConnectionFailure(platformID, host, "apiraw");
                    const rawApi = apiConnection.api.api().rosApi;
                    channel = await rawApi.openChannel();
                    if (!channel?.write) {
                        throw new Error("Failed to open MikroTik API channel");
                    }

                    if (fs.existsSync(folderPath)) {
                        for (const file of fs.readdirSync(folderPath)) {
                            if (file.startsWith("backup_") && file.endsWith(".backup")) {
                                fs.unlinkSync(path.join(folderPath, file));
                            }
                        }
                    } else {
                        const backupUser = process.env.BACKUP_SUDO_USER;
                        execSync(`sudo -u ${backupUser} mkdir -p "${folderPath}"`);
                    }

                    try {
                        const files = await channel.write(["/file/print"]);
                        const backupFiles = (files || []).filter(
                            (f) => f?.name?.startsWith("backup_") && f?.name?.endsWith(".backup")
                        );
                        for (const file of backupFiles) {
                            await channel.write(["/file/remove", `=.id=${file[".id"]}`]);
                        }
                    } catch { }

                    await channel.write(["/system/backup/save", `=name=${backupBase}`]);

                    const { FTP_USER, FTP_PASSWORD, SERVER_IP } = process.env;
                    if (FTP_USER && FTP_PASSWORD && SERVER_IP) {
                        try {
                            await channel.write([
                                "/tool/fetch",
                                `=url=ftp://${FTP_USER}:${FTP_PASSWORD}@${SERVER_IP}/backups/remote-hosts/${host}/${backupName}`,
                                "=mode=ftp",
                                "=upload=yes",
                                `=src-path=${backupName}`,
                            ]);
                        } catch { }
                    }

                    try {
                        const files = await this.mikrotik.listFiles(channel);
                        const created = files.find(f => f.name === backupName);
                        if (created) {
                            await channel.write(["/file/remove", `=.id=${created[".id"]}`]);
                        }
                    } catch { }

                    const data = {
                        status: "updated",
                        path: relativePath,
                        platformID,
                        host,
                        filename: backupName,
                    };

                    const existing = await this.db.getPlatformMikrotikBackUpByHost(platformID, host);
                    existing
                        ? await this.db.updatePlatformMikrotikBackUp(existing.id, data)
                        : await this.db.createPlatformMikrotikBackUp(data);

                    socketManager.log(platformID, `Backup completed for router ${host} (${backupName})`, {
                        context: "backup",
                        level: "success",
                    });
                } finally {
                    try { await channel?.close(); } catch { }
                    try { await apiConnection.api.close?.(); } catch { }
                }
            } catch (err) {
                this.markRouterConnectionFailure(platformID, host, "apiraw");
                console.error(`Backup failed for ${host}`, err);
                socketManager.log(platformID, `Backup failed for router ${host}: ${err?.message || err}`, {
                    context: "backup",
                    level: "error",
                });
                try { await channel?.close(); } catch { }
            }
        }
    }

    async saveBandwidthUsageForPlatform(platform) {
        const stations = await this.db.getStations(platform.platformID);
        if (!stations || stations.length === 0) return;
        const samples = await this.mikrotikController.collectBandwidthSamples(platform.platformID);
        await this.db.applyBandwidthSamples(samples, new Date());
        console.log(`Bandwidth usage saved for ${platform.platformID}: ${samples.length} counters`);
    }

    async processScheduledBulkSms(platform) {
        const platformID = platform.platformID;
        const due = await this.db.getDueScheduledSms(platformID, new Date());
        if (!due || due.length === 0) return;

        const smsConfig = await this.db.getPlatformConfig(platformID);
        if (!smsConfig || !smsConfig.sms) {
            for (const item of due) {
                await this.db.updateScheduledSms(item.id, {
                    status: "failed",
                    sentAt: new Date(),
                    summary: { total: 0, sent: 0, failed: 0 },
                    failedNumbers: [],
                    error: "SMS service is not enabled for this platform.",
                });
            }
            return;
        }

        const sms = await this.db.getPlatformSMS(platformID);
        if (!sms) {
            for (const item of due) {
                await this.db.updateScheduledSms(item.id, {
                    status: "failed",
                    sentAt: new Date(),
                    summary: { total: 0, sent: 0, failed: 0 },
                    failedNumbers: [],
                    error: "SMS configuration not found for this platform.",
                });
            }
            return;
        }

        for (const item of due) {
            const numbers = Array.isArray(item.phoneNumbers)
                ? item.phoneNumbers
                : String(item.phoneNumbers || "")
                    .split(",")
                    .map((n) => n.trim())
                    .filter(Boolean);

            if (numbers.length === 0) {
                await this.db.updateScheduledSms(item.id, {
                    status: "failed",
                    sentAt: new Date(),
                    summary: { total: 0, sent: 0, failed: 0 },
                    failedNumbers: [],
                    error: "No valid phone numbers provided.",
                });
                continue;
            }

            if (sms.default === true) {
                const costPerSMS = Number(sms.costPerSMS);
                const totalCost = costPerSMS * numbers.length;
                const balance = Number(sms.balance);
                const remaining = Number(sms.remainingSMS);

                if (Number.isFinite(balance) && balance < totalCost) {
                    await this.db.updateScheduledSms(item.id, {
                        status: "failed",
                        sentAt: new Date(),
                        summary: { total: numbers.length, sent: 0, failed: numbers.length },
                        failedNumbers: numbers.map((phone) => ({
                            phone,
                            reason: "Insufficient SMS balance.",
                        })),
                        error: "Insufficient SMS balance.",
                    });
                    continue;
                }
                if (Number.isFinite(remaining) && remaining > 0 && remaining < numbers.length) {
                    await this.db.updateScheduledSms(item.id, {
                        status: "failed",
                        sentAt: new Date(),
                        summary: { total: numbers.length, sent: 0, failed: numbers.length },
                        failedNumbers: numbers.map((phone) => ({
                            phone,
                            reason: "Insufficient SMS credits.",
                        })),
                        error: "Insufficient SMS credits.",
                    });
                    continue;
                }
            }

            const success = [];
            const failed = [];

            for (const phone of numbers) {
                const valid = Utils.validatePhoneNumber(phone);
                if (!valid.valid) {
                    failed.push({ phone, reason: "Invalid phone number format." });
                    continue;
                }
                const result = await this.sms.sendSMS(phone, item.message, sms);
                if (result?.success) {
                    success.push(phone);
                    if (sms.default === true) {
                        const newBalance = Number(sms.balance) - Number(sms.costPerSMS);
                        const newRemaining = Math.floor(Number(sms.remainingSMS)) - 1;
                        sms.balance = newBalance.toString();
                        sms.remainingSMS = newRemaining.toString();
                        await this.db.updatePlatformSMS(platformID, {
                            balance: sms.balance,
                            remainingSMS: sms.remainingSMS,
                        });
                    }
                } else {
                    failed.push({ phone, reason: result?.message || "Failed to send" });
                }
            }

            await this.db.updateScheduledSms(item.id, {
                status: failed.length > 0 ? "completed_with_errors" : "sent",
                sentAt: new Date(),
                summary: {
                    total: numbers.length,
                    sent: success.length,
                    failed: failed.length,
                },
                sentNumbers: success,
                failedNumbers: failed,
            });
        }
    }

    async processScheduledInternalSms() {
        const due = await this.db.getDueScheduledInternalSms(new Date());
        if (!due || due.length === 0) return;

        for (const item of due) {
            const numbers = Array.isArray(item.phoneNumbers)
                ? item.phoneNumbers
                : (item.phoneNumbers || []);

            const success = [];
            const failed = [];

            for (const phone of numbers) {
                const valid = Utils.validatePhoneNumber(phone);
                if (!valid.valid) {
                    failed.push({ phone, reason: "Invalid phone number format." });
                    continue;
                }
                const result = await this.sms.sendInternalSMS(phone, item.message);
                if (result?.success) {
                    success.push(phone);
                } else {
                    failed.push({ phone, reason: result?.message || "Failed to send" });
                }
            }

            await this.db.updateScheduledInternalSms(item.id, {
                status: failed.length > 0 ? "completed_with_errors" : "sent",
                sentAt: new Date(),
                summary: {
                    total: numbers.length,
                    sent: success.length,
                    failed: failed.length
                },
                failedNumbers: failed
            });
        }
    }

    async processScheduledInternalEmail() {
        const due = await this.db.getDueScheduledInternalEmail(new Date());
        if (!due || due.length === 0) return;

        for (const item of due) {
            const recipients = Array.isArray(item.emails)
                ? item.emails
                : (item.emails || []);

            const success = [];
            const failed = [];

            for (const email of recipients) {
                if (!String(email).includes("@")) {
                    failed.push({ email, reason: "Invalid email address." });
                    continue;
                }
                const result = await this.mailer.sendInternalEmail({
                    to: email,
                    subject: item.subject,
                    message: item.message,
                    name: email,
                });
                if (result?.success) {
                    success.push(email);
                } else {
                    failed.push({ email, reason: result?.message || "Failed to send" });
                }
            }

            await this.db.updateScheduledInternalEmail(item.id, {
                status: failed.length > 0 ? "completed_with_errors" : "sent",
                sentAt: new Date(),
                summary: {
                    total: recipients.length,
                    sent: success.length,
                    failed: failed.length
                },
                failedEmails: failed
            });
        }
    }

    async reconcilePendingPayments(platform) {
        const platformID = platform.platformID;
        const cutoff = new Date(Date.now() - 2 * 60 * 1000);
        const pending = await this.db.getMpesaByStatuses(platformID, ["PENDING", "PROCESSING"], cutoff);
        if (!pending || pending.length === 0) return;

        for (const payment of pending) {
            try {
                const invoiceId = payment.reqcode || payment.code;
                const statusInfo = await this.mpesa.fetchIntaSendStatus(invoiceId);
                if (!statusInfo?.state) continue;

                const nextStatus = this.mpesa.normalizeIntaSendStatus(statusInfo.state);
                if (nextStatus !== payment.status) {
                    await this.db.updateMpesaCode(payment.code, {
                        status: nextStatus,
                        failed_reason: statusInfo.failed_reason || payment.failed_reason,
                        charges: statusInfo.charges || payment.charges,
                        account: statusInfo.account || payment.account,
                    });
                }

                if (nextStatus === "COMPLETE") {
                    await this.mpesa.completePaymentForService(payment);
                }
            } catch (error) {
                socketManager.log(platformID, `Pending payment reconcile failed for ${payment.code}`, {
                    context: "cron",
                    level: "error",
                });
            }
        }
    }

    async reconcileDashboardStatsForPlatform(platform) {
        const platformID = platform.platformID;
        try {
            await this.db.reconcileDashboardRevenueStats(platformID);
        } catch (error) {
            socketManager.log(platformID, "Cron: dashboard stats reconcile failed", {
                context: "cron",
                level: "error",
            });
        }
    }

    async saveOnlineCountsForPlatform(platformID, hotspotCount, pppoeCount) {
        const existing = await this.db.getDashboardStats(platformID);
        if (!existing) {
            await this.db.rebuildDashboardStats(platformID, {
                onlineHotspotUsers: hotspotCount,
                onlinePPPoEUsers: pppoeCount,
            });
            return;
        }
        const stats = { ...(existing.stats || {}) };
        stats.totalUsersOnline = hotspotCount;
        stats.totalPPPoEUsersOnline = pppoeCount;
        await this.db.upsertDashboardStats(platformID, {
            stats,
            funds: existing.funds || {},
            networkUsage: existing.networkUsage || [],
            isB2B: existing.isB2B || false,
        });
    }

    async saveOnlineCountsForStation(platformID, stationId, hotspotCount, pppoeCount) {
        const existing = await this.db.getStationDashboardStats(platformID, stationId);
        if (!existing) {
            await this.db.rebuildStationDashboardStats(platformID, stationId, {
                onlineHotspotUsers: hotspotCount,
                onlinePPPoEUsers: pppoeCount,
            });
            return;
        }
        const stats = { ...(existing.stats || {}) };
        stats.totalUsersOnline = hotspotCount;
        stats.totalPPPoEUsersOnline = pppoeCount;
        await this.db.upsertStationDashboardStats(platformID, stationId, {
            stats,
            funds: existing.funds || {},
            networkUsage: existing.networkUsage || [],
            isB2B: existing.isB2B || false,
        });
    }

    async updateOnlineCountsForPlatform(platform) {
        const platformID = platform.platformID;
        const stations = await this.db.getStations(platformID);
        if (!stations || stations.length === 0) return;

        let totalHotspot = 0;
        let totalPPPoE = 0;

        for (const station of stations) {
            if (!station?.mikrotikHost) continue;
            const host = station.mikrotikHost;

            await this.withRouterLock(`${platformID}:${host}:online`, async () => {
                const channel = await this.getMikrotikChannel(platformID, host);
                if (!channel) return;

                let hotspotCount = 0;
                let pppoeCount = 0;

                try {
                    const activeHotspot = await this.mikrotik.listHotspotActiveUsers(channel);
                    hotspotCount = Array.isArray(activeHotspot) ? activeHotspot.length : 0;
                } catch { }

                try {
                    const activePPPoE = await this.mikrotik.listPPPActiveUsers(channel);
                    pppoeCount = Array.isArray(activePPPoE) ? activePPPoE.length : 0;
                } catch { }

                totalHotspot += hotspotCount;
                totalPPPoE += pppoeCount;

                try {
                    await this.saveOnlineCountsForStation(platformID, station.id, hotspotCount, pppoeCount);
                } catch { }
            });
        }

        await this.saveOnlineCountsForPlatform(platformID, totalHotspot, totalPPPoE);
    }

    async syncRadiusClientIpsForPlatform(platform) {
        const platformID = platform.platformID;
        const stations = await this.db.getStations(platformID);
        if (!stations || stations.length === 0) return;

        for (const station of stations) {
            try {
                if (station.systemBasis !== "RADIUS") continue;
                const internalClientIp = getRadiusClientIp(station, station.radiusClientIp || "");
                if (isWireGuardMikrotikIp(internalClientIp)) {
                    if (station.radiusClientIp !== internalClientIp) {
                        const updateResult = await updateClientIp({
                            name: station.radiusClientName,
                            ip: internalClientIp,
                        });
                        if (updateResult?.updated) {
                            await this.db.updateStation(station.id, { radiusClientIp: internalClientIp });
                        }
                    }
                    continue;
                }
                const publicHost = station.mikrotikPublicHost || station.mikrotikDDNS || "";
                if (!publicHost) continue;
                if (Utils.isValidIP && Utils.isValidIP(publicHost)) continue;
                if (!station.radiusClientName) continue;

                const resolved = await dns.resolve4(publicHost);
                const publicIp = Array.isArray(resolved) && resolved.length > 0 ? resolved[0] : null;
                if (!publicIp) continue;

                const sharedRadiusStation = await this.findRadiusStationSharingClientIp(publicIp, station.id);
                const radiusSecret = sharedRadiusStation?.radiusClientSecret || station.radiusClientSecret;
                let updateResult;
                if (sharedRadiusStation?.radiusClientSecret && sharedRadiusStation.radiusClientSecret !== station.radiusClientSecret) {
                    updateResult = await ensureRadiusClient({
                        name: station.radiusClientName,
                        ip: publicIp,
                        secret: sharedRadiusStation.radiusClientSecret,
                        shortname: station.name || station.mikrotikHost,
                        server: station.radiusServerIp || "",
                        description: `Nova RADIUS client for ${station.name || station.mikrotikHost}`,
                    });
                    updateResult.updated = Boolean(updateResult?.success);
                } else {
                    updateResult = await updateClientIp({
                        name: station.radiusClientName,
                        ip: publicIp,
                    });
                }

                if (updateResult?.updated) {
                    await this.db.updateStation(station.id, {
                        radiusClientIp: publicIp,
                        ...(radiusSecret ? { radiusClientSecret: radiusSecret } : {}),
                    });
                    socketManager.log(platformID, `RADIUS client IP updated for ${station.name}`, {
                        context: "cron",
                        level: "info",
                    });
                }
            } catch (error) {
                socketManager.log(platformID, `RADIUS IP sync failed for ${station?.name || station?.id}`, {
                    context: "cron",
                    level: "error",
                });
            }
        }
    }

    async purgeOldPublicLiveChats() {
        try {
            const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const threads = await this.db.getSupportThreadsWithMessagesBefore({
                type: "live",
                channel: "public",
                olderThan: cutoff,
            });

            const uploadsDir = path.join(appRoot, "public", "support-uploads");
            const filesToDelete = new Set();

            for (const thread of threads) {
                for (const message of thread.messages || []) {
                    const attachments = message.attachments || [];
                    if (Array.isArray(attachments)) {
                        for (const attachment of attachments) {
                            const url = attachment?.url || "";
                            const id = attachment?.id || "";
                            const filename =
                                String(url).startsWith("/support-uploads/")
                                    ? String(url).replace("/support-uploads/", "")
                                    : String(id);
                            if (filename) {
                                filesToDelete.add(filename);
                            }
                        }
                    }
                }
            }

            const tasks = [];
            for (const filename of filesToDelete) {
                const filePath = path.join(uploadsDir, filename);
                tasks.push(fsp.unlink(filePath).catch(() => null));
            }
            await Promise.all(tasks);

            const deleted = await this.db.deleteOldSupportThreads({
                type: "live",
                channel: "public",
                olderThan: cutoff,
            });
            if (deleted > 0) {
                console.log(`Deleted ${deleted} public live chats older than 7 days`);
            }
        } catch (error) {
            console.error("Error purging old public live chats:", error);
        }
    }

    async markAllExpiredUserCodesInDB() {
        const now = new Date();
        const result = await this.db?.updateActiveDBUsersByTime(now);

        if (result?.count > 0) {
            console.log(`Cron: marked ${result.count} expired active users in database`);
            socketManager.log("system", `Cron: marked ${result.count} expired active users in database`, {
                context: "cron",
                level: "info",
            });
        }
    }

    async purgeDuplicateUserCodes(platform) {
        try {
            const platformID = platform.platformID;
            const duplicateCodes = await this.db.getDuplicateActiveUserCodes(platformID);
            if (!Array.isArray(duplicateCodes) || duplicateCodes.length === 0) return;

            const users = await this.db.getActiveUsersByCodes(platformID, duplicateCodes);
            if (!Array.isArray(users) || users.length === 0) return;

            const byCode = new Map();
            for (const user of users) {
                const code = String(user.code || "").trim();
                if (!code || code === "null") continue;
                if (!byCode.has(code)) byCode.set(code, []);
                byCode.get(code).push(user);
            }

            let removed = 0;
            for (const [code, entries] of byCode.entries()) {
                if (!Array.isArray(entries) || entries.length <= 1) continue;
                entries.sort((a, b) => {
                    const aActive = a.status === "active" ? 1 : 0;
                    const bActive = b.status === "active" ? 1 : 0;
                    if (aActive !== bActive) return bActive - aActive;
                    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
                    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
                    return bTime - aTime;
                });

                const [keep, ...dupes] = entries;
                for (const dup of dupes) {
                    if (!dup?.id) continue;
                    await this.db.deleteUser(dup.id);
                    removed += 1;
                }

                if (dupes.length > 0) {
                    socketManager.log(platformID, `Removed ${dupes.length} duplicate users for code ${code} (kept ${keep?.id})`, {
                        context: "cron",
                        level: "warn",
                    });
                }
            }

            if (removed > 0) {
                console.log(`Removed ${removed} duplicate users for platform ${platformID}`);
            }
        } catch (error) {
            console.error("Error purging duplicate user codes:", error);
        }
    }

    async registerURL(platform) {
        try {
            await this.mpesa.registerURL(platform);
        } catch (error) {
            console.error("Error registering MPesa URLs:", error);
        }
    }

    withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Timeout")), ms)
            ),
        ]);
    }

    async runCombinedCronsForPlatform(platform) {
        socketManager.log(platform.platformID, "Cron: tasks started", {
            context: "cron",
            level: "info",
        });

        const tasks = [
            () => this.checkPPPoEExpirations(),
            () => this.saveBandwidthUsageForPlatform(platform),
            () => this.checkAndExpireUsersForPlatform(platform),
            () => this.expireDataPlansForPlatform(platform),
            () => this.expireRadiusPPPoEFupForPlatform(platform),
            () => this.updateOnlineCountsForPlatform(platform),
            () => this.makeSureUsersInMikrotikAreActiveInDatabaseForPlatform(platform),
            () => this.reconcileDashboardStatsForPlatform(platform),
            () => this.checkUsersViolatingSystemThroughPayments(platform),
            () => this.manageBillingForPlatform(platform),
            () => this.retryPaystackCardBillingForPlatform(platform),
            () => this.managePluginBillsForPlatform(platform),
        ];

        for (const task of tasks) {
            try {
                await this.withTimeout(task(), 60_000 * 2);
            } catch (err) {
                socketManager.log(platform.platformID, `[cron][${platform.platformID}] Task failed`, {
                    context: "cron",
                    level: "error",
                });

                console.error(
                    `[cron][${platform.platformID}] Task failed`,
                    err
                );
            }
        }

        socketManager.log(platform.platformID, "Cron: tasks completed", {
            context: "cron",
            level: "success",
        });
    }

    start() {
        this.fiveMinuteRunning = false;
        this.hourlyRunning = false;
        this.pullTxnRunning = false;
        this.rebootRunning = false;
        this.mikrotikBackupRunning = false;
        this.minuteDbExpiryRunning = false;

        const withTimeout = (promise, ms, label = "task") =>
            Promise.race([
                promise,
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error(`[timeout] ${label} exceeded ${ms}ms`)),
                        ms
                    )
                ),
            ]);

        const runEveryFiveMinutes = async () => {
            if (this.fiveMinuteRunning) {
                console.warn("[cron] 5-minute job still running, skipping");
                return;
            }

            this.fiveMinuteRunning = true;
            console.log(`[cron] 5-minute tick ${new Date().toISOString()}`);

            try {
                const platforms = await withTimeout(
                    this.db.getAllPlatforms(),
                    30_000,
                    "fetch platforms"
                );

                for (const platform of platforms) {
                    try {
                        await withTimeout(
                            this.runCombinedCronsForPlatform(platform),
                            5 * 60 * 1000,
                            `platform ${platform.platformID}`
                        );
                    } catch (err) {
                        console.error(
                            `[cron][platform ${platform.platformID}] failed`,
                            err
                        );
                    }
                }

                await withTimeout(
                    this.processScheduledInternalSms(),
                    60_000,
                    "internal sms"
                );

                await withTimeout(
                    this.processScheduledInternalEmail(),
                    60_000,
                    "internal email"
                );

                await withTimeout(
                    this.runWebdockCron(),
                    90_000,
                    "webdock sync"
                );
            } catch (err) {
                console.error("[cron] 5-minute fatal error", err);
            } finally {
                this.fiveMinuteRunning = false;
            }
        };

        const runDbExpiryEveryMinute = async () => {
            if (this.minuteDbExpiryRunning) {
                console.warn("[cron] DB expiry job still running, skipping");
                return;
            }

            this.minuteDbExpiryRunning = true;
            try {
                await withTimeout(
                    this.markAllExpiredUserCodesInDB(),
                    60_000,
                    "db user expiry"
                );
            } catch (err) {
                console.error("[cron] DB expiry job failed", err);
            } finally {
                this.minuteDbExpiryRunning = false;
            }
        };

        setTimeout(runDbExpiryEveryMinute, 5_000);
        this.minuteDbExpiryInterval = setInterval(runDbExpiryEveryMinute, 60_000);
        console.log("[cron] DB expiry interval registered at 60 seconds");

        setTimeout(() => {
            this.fiveMinuteTask = cron.schedule(
                "*/5 * * * *",
                runEveryFiveMinutes,
                {
                    scheduled: true,
                    timezone: "Africa/Nairobi",
                }
            );

            console.log(
                `[cron] 5-minute schedule registered at ${new Date().toISOString()}`
            );
        }, 30_000);

        cron.schedule(
            "0 * * * *",
            async () => {
                if (this.hourlyRunning) return;
                this.hourlyRunning = true;

                console.log("[cron] Running hourly cleanup...");
                try {
                    await withTimeout(
                        this.deleteOverdueDedicatedServers(),
                        120_000,
                        "webdock overdue deletion"
                    );

                    await withTimeout(
                        this.purgeOldPublicLiveChats(),
                        10 * 60 * 1000,
                        "hourly cleanup"
                    );

                    socketManager.log("system", "Cron: hourly cleanup completed", {
                        context: "cron",
                        level: "success",
                    });
                } catch (err) {
                    console.error("[cron] hourly cleanup failed", err);
                } finally {
                    this.hourlyRunning = false;
                }
            },
            { timezone: "Africa/Nairobi" }
        );

        cron.schedule(
            "*/30 * * * *",
            async () => {
                if (this.pullTxnRunning) {
                    console.warn("[cron] pull transactions still running, skipping");
                    return;
                }

                this.pullTxnRunning = true;
                console.log("[cron] Running pull transactions...");

                try {
                    await withTimeout(
                        this.runPullTransactions(),
                        10 * 60 * 1000,
                        "pull transactions"
                    );

                    const platforms = await withTimeout(
                        this.db.getAllPlatforms(),
                        30_000,
                        "fetch platforms"
                    );

                    for (const platform of platforms) {

                        const tasks = [
                            () => this.monitorStationsForPlatform(platform),
                            () => this.processScheduledBulkSms(platform),
                            () => this.reconcilePendingPayments(platform),
                            () => this.purgeDuplicateUserCodes(platform),
                            () => this.syncRadiusClientIpsForPlatform(platform),
                            () => this.saveShortCodeBalances(platform),
                            () => this.registerURL(platform),
                        ];

                        for (const task of tasks) {
                            try {
                                await this.withTimeout(task(), 60_000 * 2);
                            } catch (err) {
                                socketManager.log(platform.platformID, `[cron][${platform.platformID}] Task failed`, {
                                    context: "cron",
                                    level: "error",
                                });

                                console.error(
                                    `[cron][${platform.platformID}] Task failed`,
                                    err
                                );
                            }
                        }
                    }

                    socketManager.log("system", "Cron: pull transactions completed", {
                        context: "cron",
                        level: "success",
                    });
                } catch (err) {
                    console.error("[cron] pull transactions failed", err);
                } finally {
                    this.pullTxnRunning = false;
                }
            },
            { timezone: "Africa/Nairobi" }
        );

        cron.schedule(
            "*/30 * * * *",
            async () => {
                if (this.mikrotikBackupRunning) {
                    console.warn("[cron] mikrotik backup still running, skipping");
                    return;
                }

                this.mikrotikBackupRunning = true;
                console.log("[cron] Running MikroTik backups...");

                try {
                    const platforms = await withTimeout(
                        this.db.getAllPlatforms(),
                        30_000,
                        "fetch platforms for backup"
                    );

                    for (const platform of platforms) {
                        try {
                            await withTimeout(
                                this.createMikrotikBackUpForPlatform(platform),
                                20 * 60 * 1000,
                                `mikrotik backup ${platform.platformID}`
                            );
                        } catch (err) {
                            console.error(
                                `[cron][${platform.platformID}] mikrotik backup failed`,
                                err
                            );
                        }
                    }

                    socketManager.log("system", "Cron: MikroTik backups completed", {
                        context: "backup",
                        level: "success",
                    });
                } catch (err) {
                    console.error("[cron] mikrotik backup run failed", err);
                    socketManager.log("system", `Cron: MikroTik backups failed - ${err?.message || err}`, {
                        context: "backup",
                        level: "error",
                    });
                } finally {
                    this.mikrotikBackupRunning = false;
                }
            },
            { timezone: "Africa/Nairobi" }
        );

        cron.schedule(
            "0 0 * * *",
            async () => {
                if (this.pm2RestartRunning) return;
                this.pm2RestartRunning = true;

                console.log("[cron] Running midnight PM2 restart...");
                try {
                    execSync("pm2 restart nova-server", { stdio: "pipe" });
                    socketManager.log("system", "Cron: midnight PM2 restart completed", {
                        context: "cron",
                        level: "success",
                    });
                } catch (err) {
                    console.error("[cron] midnight PM2 restart failed", err);
                    socketManager.log("system", `Cron: midnight PM2 restart failed - ${err?.message || err}`, {
                        context: "cron",
                        level: "error",
                    });
                } finally {
                    this.pm2RestartRunning = false;
                }
            },
            { timezone: "Africa/Nairobi" }
        );

        cron.schedule(
            "0 3 * * *",
            async () => {
                if (this.rebootRunning) return;
                this.rebootRunning = true;

                console.log("[cron] Running router reboot (3AM)...");
                try {
                    await withTimeout(
                        this.rebootRouters(),
                        30 * 60 * 1000,
                        "router reboot"
                    );

                    socketManager.log("system", "Cron: router reboot completed", {
                        context: "cron",
                        level: "success",
                    });
                } catch (err) {
                    console.error("[cron] router reboot failed", err);
                } finally {
                    this.rebootRunning = false;
                }
            },
            { timezone: "Africa/Nairobi" }
        );
    }
}

module.exports = { CronJob };
