//@ts-check

const cron = require("node-cron");
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
const { updateClientIp } = require("./utils/radiusConfig");

class CronJob {
    constructor() {
        this.db = new DataBase();
        this.mikrotik = new Mikrotik();
        this.config = new MikrotikConnection();
        this.mailer = new Mailer();
        this.sms = new SMS();
        this.mpesa = new MpesaController();
        this.mikrotikController = new Mikrotikcontroller();
        this.ssh = new NodeSSH();
        this.pullTransactionsRunning = false;
        this.pm2RestartRunning = false;
        this.mikrotikBackupRunning = false;

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

        const users = await this.db.getActivePlatformUsers(platformID);
        if (!users || users.length === 0) return;

        const expiredUsers = users.filter((user) => {
            if (!user.expireAt) return false;
            if (user.package?.category === "Data") return false;
            const expireAt = new Date(user.expireAt);
            return expireAt <= now;
        });
        if (expiredUsers.length === 0) return;

        await Promise.all(
            expiredUsers.map((user) => this.db.updateUser(user.id, { status: "expired" }))
        );

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
            for (const user of radiusExpiredUsers) {
                const identifiers = Array.from(
                    new Set(
                        [user.username, user.code, user.mac]
                            .filter((value) => typeof value === "string" && value !== "null" && value.trim() !== "")
                    )
                );
                for (const username of identifiers) {
                    try {
                        await this.db.deleteRadiusUser(username);
                    } catch {
                        // Ignore per-user radius cleanup errors
                    }
                }
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

                            await this.db.updatePPPoE(service.id, { reminderSent: true });
                        }
                        if (service.phone) {
                            const platformConfig = await this.db.getPlatformConfig(service.platformID);
                            if (platformConfig?.sms === true) {
                                const sms = await this.db.getPlatformSMS(service.platformID);
                                if (!sms) return { success: false, message: "SMS not found!" };
                                if (sms && sms.sentPPPoE === false) return { success: false, message: "PPPoE SMS sending is disabled!" };
                                if (Number(sms.balance) < Number(sms.costPerSMS)) return { success: false, message: "Insufficient SMS Balance!" };

                                const platform = await this.db.getPlatform(service.platformID);
                                if (!platform) return { success: false, message: "Platform not found!" };

                                const sms_message = Utils.formatMessage(sms.pppoeReminderSMS, {
                                    company: platform.name,
                                    username: service.name,
                                    period: service.period,
                                    expiry: service.expireAt,
                                    package: service.profile,
                                    amount: service.amount,
                                    paymentLink: `https://${platform.url}/pppoe?info=${service.paymentLink}`,
                                    accountNumber: service.accountNumber || "",
                                });

                                const is_send = await this.sms.sendSMS(service.phone, sms_message, sms);
                                if (is_send.success && sms?.default === true) {
                                    const newSMSBalance = Number(sms.balance) - Number(sms.costPerSMS);
                                    const newSMS = Math.floor(Number(sms.remainingSMS)) - 1;

                                    await this.db.updatePlatformSMS(service.platformID, {
                                        balance: newSMSBalance.toString(),
                                        remainingSMS: newSMS.toString()
                                    });
                                }
                            }
                        }
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
                            const platformConfig = await this.db.getPlatformConfig(service.platformID);
                            if (platformConfig?.sms === true) {
                                const sms = await this.db.getPlatformSMS(service.platformID);
                                if (!sms) return { success: false, message: "SMS not found!" };
                                if (sms && sms.sentPPPoE === false) return { success: false, message: "PPPoE SMS sending is disabled!" };
                                if (Number(sms.balance) < Number(sms.costPerSMS)) return { success: false, message: "Insufficient SMS Balance!" };

                                const platform = await this.db.getPlatform(service.platformID);
                                if (!platform) return { success: false, message: "Platform not found!" };

                                const sms_message = Utils.formatMessage(sms.pppoeExpiredSMS, {
                                    company: platform.name,
                                    username: service.name,
                                    period: service.period,
                                    expiry: service.expireAt,
                                    package: service.profile,
                                    amount: service.amount,
                                    paymentLink: `https://${platform.url}/pppoe?info=${service.paymentLink}`,
                                    accountNumber: service.accountNumber || "",
                                });

                                const is_send = await this.sms.sendSMS(service.phone, sms_message, sms);
                                if (is_send.success && sms?.default === true) {
                                    const newSMSBalance = Number(sms.balance) - Number(sms.costPerSMS);
                                    const newSMS = Math.floor(Number(sms.remainingSMS)) - 1;

                                    await this.db.updatePlatformSMS(service.platformID, {
                                        balance: newSMSBalance.toString(),
                                        remainingSMS: newSMS.toString()
                                    });
                                }
                            }
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
            user => user.package?.category === "Data" && user.username
        );
        if (limitedUsers.length === 0) return;

        const stationByHost = new Map(routers.map((r) => [r.mikrotikHost, r]));
        const parseUsageToKilobytes = (usage) => {
            if (!usage) return 0;
            if (String(usage).toLowerCase() === "unlimited") return 0;
            const [value, unit] = String(usage).split(" ");
            if (!value || !unit) return 0;
            const unitMap = { B: 1 / 1024, KB: 1, MB: 1024, GB: 1024 ** 2, TB: 1024 ** 3 };
            const factor = unitMap[unit.toUpperCase()];
            if (!factor) return 0;
            const num = parseFloat(value);
            if (Number.isNaN(num)) return 0;
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
            for (const user of radiusUsers) {
                const username = user.username;
                const limitKb = parseUsageToKilobytes(user.package?.usage);
                if (!username || limitKb <= 0) continue;
                const usedBytes = usageMap[username] || 0;
                const usedKb = Math.floor(Number(usedBytes) / 1024);
                if (usedKb < limitKb) continue;
                await this.db.updateUser(user.id, { status: "expired" });
                await this.db.deleteRadiusUser(username);
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
            if (billing) {
                await this.db.deletePlatformBilling(billing.id);
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

        const today = new Date();
        const dateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

        for (const station of stations) {
            try {
                const usages = await this.mikrotikController.calculateBandwidthUsage(station.platformID);

                for (const usage of usages) {
                    const daily = await this.db.getNetworkUsageByStation(
                        usage.id,
                        usage.service,
                        "daily",
                        dateOnly
                    );

                    if (daily) {
                        const tx = Number(daily.tx);
                        const rx = Number(daily.rx);

                        await this.db.updateNetworkUsage(daily.id, {
                            tx: BigInt(usage.tx < tx ? tx + usage.tx : usage.tx),
                            rx: BigInt(usage.rx < rx ? rx + usage.rx : usage.rx),
                        });
                    } else {
                        await this.db.createNetworkUsage({
                            platformID: station.platformID,
                            station: usage.id,
                            service: usage.service,
                            tx: BigInt(usage.tx),
                            rx: BigInt(usage.rx),
                            period: "daily",
                            date: dateOnly,
                        });
                    }

                    const monthly = await this.db.getNetworkUsageByStation(
                        usage.id,
                        usage.service,
                        "monthly",
                        monthStart
                    );

                    if (monthly) {
                        const tx = Number(monthly.tx);
                        const rx = Number(monthly.rx);

                        await this.db.updateNetworkUsage(monthly.id, {
                            tx: BigInt(usage.tx < tx ? tx + usage.tx : usage.tx),
                            rx: BigInt(usage.rx < rx ? rx + usage.rx : usage.rx),
                        });
                    } else {
                        await this.db.createNetworkUsage({
                            platformID: station.platformID,
                            station: usage.id,
                            service: usage.service,
                            tx: BigInt(usage.tx),
                            rx: BigInt(usage.rx),
                            period: "monthly",
                            date: monthStart,
                        });
                    }
                }

                console.log(`✅ Usage saved: ${station.name}`);
            } catch (err) {
                console.error(`❌ Usage failed: ${station.name}`, err);
            }
        }
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
                if (!station.mikrotikDDNS) continue;
                if (Utils.isValidIP && Utils.isValidIP(station.mikrotikDDNS)) continue;
                if (!station.radiusClientName) continue;

                const resolved = await dns.resolve4(station.mikrotikDDNS);
                const publicIp = Array.isArray(resolved) && resolved.length > 0 ? resolved[0] : null;
                if (!publicIp) continue;

                const updateResult = await updateClientIp({
                    name: station.radiusClientName,
                    ip: publicIp,
                });

                if (updateResult?.updated) {
                    await this.db.updateStation(station.id, { radiusClientIp: publicIp });
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
            () => this.checkAndExpireUsersForPlatform(platform),
            () => this.expireDataPlansForPlatform(platform),
            () => this.updateOnlineCountsForPlatform(platform),
            () => this.makeSureUsersInMikrotikAreActiveInDatabaseForPlatform(platform),
            () => this.reconcileDashboardStatsForPlatform(platform),
            () => this.checkUsersViolatingSystemThroughPayments(platform),
            () => this.manageBillingForPlatform(platform),
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
            } catch (err) {
                console.error("[cron] 5-minute fatal error", err);
            } finally {
                this.fiveMinuteRunning = false;
            }
        };

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
