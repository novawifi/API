//@ts-check

const cron = require("node-cron");
const { NodeSSH } = require('node-ssh');
const dayjs = require('dayjs');
const fs = require('fs');
const path = require('path');
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

        this.mikrotikConnectionPool = new Map();
        this.routerLocks = new Map();

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

    delay(ms) {
        return new Promise(res => setTimeout(res, ms));
    }

    async pingWithRetry(pingFn, retries = 3, waitMs = 2000) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const result = await pingFn();
                if (result === true) return true;
            } catch (e) { }

            if (attempt < retries) {
                await this.delay(waitMs);
            }
        }
        return false;
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

        const connection = await this.config.createSingleMikrotikClient(platformID, host);
        if (!connection?.channel) return null;

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
            }
        }
    }

    async checkAndExpireUsersForPlatform(platform) {
        const now = new Date();
        const platformID = platform.platformID;

        const routers = await this.db.getStations(platformID);
        if (!routers || routers.length === 0) return;

        const users = await this.db.getActivePlatformUsers(platformID);
        if (!users || users.length === 0) return;

        for (const router of routers) {
            if (!router.mikrotikHost) continue;
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

                for (const user of users) {
                    if (!user.username || !user.expireAt) continue;
                    if (user.package?.category === "Data") continue;

                    const expireAt = new Date(user.expireAt);
                    if (expireAt > now) continue;

                    await this.db.updateUser(user.id, { status: "expired" });

                    try {
                        const mikrotikUser = mikrotikUsers.find(
                            u => u.name === user.username
                        );
                        const mikrotikActiveUser = mikrotikActiveUsers.find(
                            u => u.name === user.username
                        );
                        const targetCookies = cookies.filter(
                            c => c.user === user.username
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
                                    paymentLink: `<a href="https://${platform.url}/pppoe?info=${service.paymentLink}">https://${platform.url}/pppoe?info=${service.paymentLink}</a>`
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
                                    paymentLink: `<a href="https://${platform.url}/pppoe?info=${service.paymentLink}">https://${platform.url}/pppoe?info=${service.paymentLink}</a>`
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

        for (const router of routers) {
            if (!router.mikrotikHost) continue;
            const host = router.mikrotikHost;

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

                for (const user of limitedUsers) {
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

    async saveShortCodeBalances() {
        try {
            const platforms = await this.db.getPlatforms();

            for (const platform of platforms) {
                const platformID = platform.platformID;
                await this.handleShortCodeBalance(platformID);
            }
        } catch (err) {
            console.error('Failed to check and expire users:', err);
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
        const activeUsernames = new Set(dbActiveUsers.map(u => u.username));

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

                for (const mUser of mikrotikUsers) {
                    const username = mUser.name;
                    const comment = mUser.comment;

                    if (username === "default-trial") continue;
                    if (comment === "manual") continue;
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

    async checkUsersViolatingSystemThroughPayments() {
        try {
            const platforms = await this.db.getPlatforms();

            for (const platform of platforms) {
                const platformID = platform.platformID;
                const platformName = platform.name;

                const mpesaPayments = await this.db.getMpesaByPlatform(platformID);

                if (!mpesaPayments || mpesaPayments.length === 0) continue;

                const paymentMap = {};
                for (const pay of mpesaPayments) {
                    const phone = pay.phone;
                    if (!phone) continue;

                    if (!paymentMap[phone]) paymentMap[phone] = [];
                    paymentMap[phone].push(pay);
                }

                for (const [phone, payments] of Object.entries(paymentMap)) {
                    payments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

                    let consecutiveFails = 0;
                    for (const p of payments) {
                        if (p.status === "FAILED") {
                            consecutiveFails++;
                        } else {
                            break;
                        }
                    }

                    if (consecutiveFails >= 50) {
                        const alreadyBlocked = await this.db.getBlockedUserByPhone(phone);
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
            }
        } catch (err) {
            console.error("Error checking users violating payment rules:", err);
        }
    }

    async addMissingHotspotUsers() {
        try {
            const platforms = await this.db.getPlatforms();

            for (const platform of platforms) {
                const platformID = platform.platformID;
                const [payments, usersData] = await Promise.all([
                    this.db.getMpesaPayments(platformID),
                    this.db.getUserByPlatform(platformID),
                ]);

                const users = Array.isArray(usersData) ? usersData : [];
                const userCodes = new Map(
                    users.map(u => [String(u.code || u.username || u.password), u.status])
                );

                const missingPayments = payments.filter(p =>
                    p.status === "COMPLETE" &&
                    p.service === "hotspot" &&
                    !userCodes.has(String(p.code))
                );

                for (const payment of missingPayments) {
                    const pkg = await this.db.getPackagesByID(payment.packageID);
                    if (!pkg) continue;

                    const hostdata = await this.db.getStations(platformID);
                    if (!hostdata || hostdata.length === 0) continue;

                    const isTwoDevices = pkg.devices && Number(pkg.devices) > 1;

                    const host = pkg.routerHost;
                    const code = payment.code;
                    const mac = payment.mac || code;
                    const loginIdentifier = isTwoDevices ? code : mac;

                    const mikrotikData = {
                        platformID,
                        action: "add",
                        profileName: pkg.name,
                        host,
                        code,
                        username: loginIdentifier,
                        password: loginIdentifier
                    };

                    const addUserToMikrotik = await this.mikrotikController.manageMikrotikUser(mikrotikData);
                    if (!addUserToMikrotik?.success) continue;

                    let expireAt = null;
                    if (pkg?.period) {
                        const now = new Date();
                        const period = pkg.period.toLowerCase();
                        const match = period.match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
                        if (match) {
                            const value = parseInt(match[1]);
                            const unit = match[2].toLowerCase();
                            if (unit === 'minute') expireAt = new Date(now.getTime() + value * 60000);
                            if (unit === 'hour') expireAt = new Date(now.getTime() + value * 3600000);
                            if (unit === 'day') expireAt = new Date(now.getTime() + value * 86400000);
                            if (unit === 'month') expireAt = new Date(now.setMonth(now.getMonth() + value));
                            if (unit === 'year') expireAt = new Date(now.setFullYear(now.getFullYear() + value));
                        }
                    }

                    await this.db.createUser({
                        status: "active",
                        platformID,
                        phone: payment.phone,
                        username: loginIdentifier,
                        password: loginIdentifier,
                        expireAt,
                        packageID: pkg.id,
                        devices: isTwoDevices ? 2 : 1
                    });
                }
            }
        } catch (err) {
            console.error("Error in cronAddMissingHotspotUsers:", err);
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
                    if (!channel) throw new Error("No channel");

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
                    await this.db.updateStation(router.id, { reminderSent: false });
                });
            } catch (err) {
                console.error("Station monitor error:", err);

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

    async manageBillingForPlatform(platform) {
        const platformID = platform.platformID;
        const now = new Date();

        const serviceKey = "billing";
        const service = await this.db.getSystemServiceByKey(serviceKey);
        if (!service) return;

        let billing = await this.db.getPlatformBillingByName(service.name, platformID);

        if (!billing) {
            const createdAt = new Date(platform.createdAt);

            const match = service.period
                .toLowerCase()
                .match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);

            let dueDate = createdAt;
            if (match) {
                dueDate = Utils.addPeriod(createdAt, +match[1], match[2]);
            }

            billing = await this.db.createPlatformBilling({
                period: service.period,
                platformID,
                name: service.name,
                price: service.price,
                amount: platform.status === "Premium" ? "0" : String(service.price),
                currency: "KES",
                dueDate: platform.status === "Premium" ? null : dueDate,
                status: "Unpaid",
                description: service.description
            });
        }

        if (platform.status === "Premium") {
            await this.db.updatePlatformBilling(billing.id, {
                amount: "0",
                dueDate: null,
                paidAt: null
            });
            return;
        }

        if (!billing.dueDate) return;

        const overdueDate = new Date(billing.dueDate);
        const newAmount = Number(billing.amount) + Number(billing.price);
        if (now >= overdueDate) {
            await this.db.updatePlatformBilling(billing.id, {
                amount: String(newAmount),
                status: "Unpaid",
                dueDate: Utils.addPeriod(billing.dueDate, 1, "month")
            });
        }

        overdueDate.setDate(overdueDate.getDate() + 3);

        if (now >= overdueDate) {
            if (platform.status !== "Inactive") {
                await this.db.updatePlatform(platformID, { status: "Inactive" });
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

            try {
                // @ts-ignore
                const { api } = await this.config.createSingleMikrotikClientAPI(platformID, host);
                if (!api) continue;
                const rawApi = api.api().rosApi;
                const channel = await rawApi.openChannel();

                const timestamp = now.format("YYYY-MM-DD_HH-mm-ss");
                const backupName = `backup_${timestamp}.backup`;
                const folderPath = path.join(appRoot, "backups", "remote-hosts", host);
                const relativePath = path.join("backups", "remote-hosts", host, backupName);

                if (fs.existsSync(folderPath)) {
                    for (const file of fs.readdirSync(folderPath)) {
                        fs.unlinkSync(path.join(folderPath, file));
                    }
                } else {
                    execSync(`sudo -u novawifi-api-v1 mkdir -p "${folderPath}"`);
                }

                try {
                    const files = await channel.write(["/file/print"]);
                    for (const file of files.filter(
                        f => f.name?.startsWith("backup_") && f.name?.endsWith(".backup")
                    )) {
                        await channel.write(["/file/remove", `=.id=${file[".id"]}`]);
                    }
                } catch { }

                await channel.write(["/system/backup/save", `=name=${backupName}`]);

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
                    const files = await channel.write(["/file/print"]);
                    const created = files.find(f => f.name === backupName);
                    if (created) {
                        await channel.write(["/file/remove", `=.id=${created[".id"]}`]);
                    }
                } catch { }

                await channel.close();

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

            } catch (err) {
                console.error(`Backup failed for ${host}`, err);
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

    async runOneMinuteCrons() {
        await this.withPlatforms(async (platform) => {
            await Promise.all([
                this.checkAndExpireUsersForPlatform(platform),
                this.expireDataPlansForPlatform(platform)
            ]);
        });
    }

    async runFiveMinuteCrons() {
        await this.withPlatforms(async (platform) => {
            await Promise.all([
                // this.monitorStationsForPlatform(platform),
                this.manageBillingForPlatform(platform),
                this.saveBandwidthUsageForPlatform(platform),
                this.createMikrotikBackUpForPlatform(platform),
                this.makeSureUsersInMikrotikAreActiveInDatabaseForPlatform(platform)
            ]);
        });
    }

    start() {
        this.saveShortCodeBalances();

        cron.schedule("*/1 * * * *", async () => {
            console.log("Running scheduled 1 minute cronjob...");
            await Promise.all([
                this.saveShortCodeBalances(),
                this.runOneMinuteCrons(),
                this.checkPPPoEExpirations(),
                // this.registerURL()
            ]);
        });

        cron.schedule("*/5 * * * *", async () => {
            console.log("Running scheduled 5 minutes cronjob...");
            await Promise.all([
                this.runFiveMinuteCrons(),
                // this.checkUsersViolatingSystemThroughPayments(),
            ]);
        });

        cron.schedule("0 3 * * *", async () => {
            console.log("Running router reboot cronjob (3AM)...");
            await this.rebootRouters();
        });
    }
}

module.exports = { CronJob };
