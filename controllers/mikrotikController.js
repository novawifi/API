// @ts-check

const crypto = require("crypto");
const axios = require("axios");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const appRoot = require("app-root-path").path;
const dns = require("dns").promises;
const { exec, execFile } = require("child_process");
const { socketManager } = require("./socketController");

const { DataBase } = require("../helpers/databaseOperation");
const { Mikrotik } = require("../helpers/mikrotikOperation");
const { MikrotikConnection } = require("../configs/mikrotikConfig");
const { Utils } = require("../utils/Functions");
const net = require("net");
const { Mailer } = require("./mailerController");
const { SMS } = require("./smsController");
const { Auth } = require("./authController");
const cache = require("../utils/cache");
const { ensureRadiusClient } = require("../utils/radiusConfig");

class Mikrotikcontroller {
    constructor() {
        this.db = new DataBase();
        this.mikrotik = new Mikrotik();
        this.config = new MikrotikConnection();
        this.mailer = new Mailer();
        this.sms = new SMS();
        this.auth = new Auth();
        this.cache = cache;
        this.routerAutoSessions = new Map();
    }

    logPlatform(platformID, message, meta = {}) {
        socketManager.log(platformID, message, {
            context: meta.context || "mikrotik",
            level: meta.level || "info",
            ...meta,
        });
    }

    async pushDashboardStats(platformID) {
        if (!platformID) return;
        try {
            const payload = await this.db.rebuildDashboardStats(platformID);
            if (!payload) return;
            socketManager.emitToRoom(`platform-${platformID}`, "stats", {
                success: true,
                message: "Dashboard stats fetched",
                stats: payload.stats,
                funds: payload.funds,
                networkusage: payload.networkusage,
                IsB2B: payload.IsB2B,
            });
        } catch (error) {
            // ignore dashboard refresh errors
        }
    }

    async safeCloseChannel(channel) {
        if (!channel) return;
        try {
            await channel.close();
        } catch (error) { }
    }

    async ensureHotspotMacCookie(channel, sessionTimeout) {
        try {
            const loginBy = "http-chap,http-pap,mac-cookie";
            const profiles = await this.mikrotik.getHotspotProfiles(channel);
            if (!profiles || profiles.length === 0) return;
            for (const profile of profiles) {
                const updates = {
                    "login-by": loginBy,
                    "mac-cookie": "yes",
                };
                if (sessionTimeout) {
                    updates["mac-cookie-timeout"] = sessionTimeout;
                }
                await this.mikrotik.updateHotspotServerProfile(channel, profile[".id"], updates);
            }
        } catch (error) { }
    }

    getNextAutoRouterIp(usedHosts) {
        const used = new Set(
            (usedHosts || [])
                .filter((host) => typeof host === "string" && host.startsWith("10.10.10."))
                .map((host) => host.trim())
        );
        for (let i = 2; i <= 254; i += 1) {
            const candidate = `10.10.10.${i}`;
            if (!used.has(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    async manageMikrotikUser(data) {
        const { platformID, action, profileName, host, code, password, username } = data;
        if (!platformID || !action) {
            return { success: false, message: "platformID and action are required parameters" };
        }
        this.logPlatform(platformID, `User action '${action}' on router ${host || "unknown"}`, {
            context: "mikrotik",
            level: "info",
        });
        try {
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return { success: false, message: `No valid MikroTik connection` };
            const { channel } = connection;
            try {
                if (action === "add") {
                    if (!profileName) return { success: false, message: `Profile name is required when adding users` };
                    const profiles = await this.mikrotik.listHotspotProfiles(channel);
                    const existingProfiles = profiles.filter(p => p.name === profileName);
                    if (existingProfiles.length === 0) return { success: false, message: `Profile '${profileName}' not found` };
                    const packages = await this.db.getPackagesByPlatformID(platformID);
                    if (!packages || packages.length === 0) return { success: false, message: `No packages found for platform ${platformID}` };
                    const pkg = packages.find(pkg => pkg.name === profileName);
                    if (!pkg) return { success: false, message: `Package for profile '${profileName}' not found` };
                    const users = await this.mikrotik.listHotspotUsers(channel);
                    const existingUser = users.find(u => u.name === (code || username));
                    if (existingUser) {
                        this.logPlatform(platformID, `Hotspot user already exists (${code || username})`, {
                            context: "mikrotik",
                            level: "info",
                        });
                        return {
                            success: true,
                            message: `User '${code || username}' already exists`,
                            username: code || username,
                            password: code || username,
                            profile: profileName,
                            limits: {
                                uptime: pkg.uptime,
                                data: pkg.usage,
                                speed: pkg.speed ? `${pkg.speed} Mbps` : 'Unlimited'
                            }
                        };
                    }
                    let uptimeLimit = '';
                    if (pkg.period && pkg.period.trim().toLowerCase() !== 'noexpiry') uptimeLimit = this.formatUptime(pkg.period);
                    let bytesTotal = '';
                    if (pkg.usage && pkg.usage !== 'Unlimited') {
                        const [value, unit] = pkg.usage.split(' ');
                        bytesTotal = this.convertToBytes(parseFloat(value), unit).toString();
                    }
                    let finalUsername = "";
                    let finalPassword = "";
                    if (code && code.trim()) { finalUsername = code; finalPassword = code; }
                    else if (username && username.trim() && password && password.trim()) { finalUsername = username; finalPassword = password; }
                    else {
                        const cred = this.generateCode();
                        finalUsername = cred;
                        finalPassword = cred;
                    }
                    await this.mikrotik.addHotspotUser(channel, {
                        name: finalUsername,
                        password: finalPassword,
                        profile: profileName,
                        limitUptime: uptimeLimit,
                        limitBytesTotal: bytesTotal ? bytesTotal : 0
                    });
                    return {
                        success: true,
                        message: "User added successfully",
                        username: finalUsername,
                        password: finalPassword,
                        profile: profileName,
                        limits: {
                            uptime: pkg.uptime,
                            data: pkg.usage,
                            speed: pkg.speed ? `${pkg.speed} Mbps` : 'Unlimited'
                        }
                    };
                } else if (action === "remove") {
                    if (!username) return { success: true, message: `username is required for removal` };
                    const profiles = await this.mikrotik.listHotspotUsers(channel);
                    const existingUser = profiles.find(p => p.name === username);
                    const mikrotikActiveUsers = await this.mikrotik.listHotspotActiveUsers(channel);
                    const mikrotikActiveUser = mikrotikActiveUsers.find(u => u.name === username);
                    const cookies = await this.mikrotik.listHotspotCookies(channel);
                    const targetCookies = cookies.filter(c => c.user === username);
                    if (!existingUser) return { success: true, message: `User '${username}' not found` };
                    if (Array.isArray(targetCookies) && targetCookies.length > 0) {
                        for (const cookie of targetCookies) await this.mikrotik.deleteHotspotCookie(channel, cookie['.id']);
                    }
                    await this.mikrotik.deleteHotspotUser(channel, existingUser['.id']);
                    if (mikrotikActiveUser && mikrotikActiveUser['.id']) await this.mikrotik.deleteHotspotActiveUser(channel, mikrotikActiveUser['.id']);
                    return { success: true, message: "User removed successfully" };
                } else {
                    return { success: false, message: "Invalid action. Use 'add' or 'remove'" };
                }
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            this.logPlatform(platformID, `Mikrotik user action failed: ${error.message || error}`, {
                context: "mikrotik",
                level: "error",
            });
            return { success: false, message: error.message, errorDetails: error.stack, action: action, profileName: profileName, username: username };
        }
    }

    async manageMikrotikPPPoE(data) {
        const { platformID, user, host } = data;
        if (!platformID || !user || !host) return { success: false, message: "platformID, user, host, and action are required parameters" };
        try {
            const stations = await this.db.getStations(platformID);
            const stationRecord = stations?.find((s) => s.mikrotikHost === host);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            if (isRadius) {
                const pppoes = await this.db.getPPPoE(platformID);
                const record = (pppoes || []).find((p) => p.clientname === user && p.station === host);
                if (!record) return { success: false, message: `PPPoE user "${user}" not found.` };
                const plan = record.planId ? await this.db.getPPPoEPlanById(record.planId) : null;
                const speedSource = plan?.profile || record.profile || plan?.name || record.name || "";
                const speedVal = String(speedSource).replace(/[^0-9.]/g, "");
                const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
                await this.db.upsertRadiusUser({
                    username: record.clientname,
                    password: record.clientpassword || record.clientname,
                    groupname: plan?.name || record.name,
                    rateLimit,
                });
                return { success: true, message: `RADIUS PPPoE user "${user}" re-enabled.` };
            }
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return { success: false, message: `No valid MikroTik connection` };
            const { channel } = connection;
            try {
                const response = await this.mikrotik.listSecrets(channel);
                const secret = response.find(s => s.name === user);
                if (!secret) return { success: false, message: `PPP secret (user) "${user}" does not exist.` };
                await this.mikrotik.updateSecret(channel, secret['.id'], { disabled: false });
                return { success: true, message: `PPP secret (user) "${user}" has been enabled.` };
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            return { success: false, message: error.message || "An unexpected error occurred.", error: error.stack };
        }
    }

    async createMikrotikProfile(platformID, profileName, rateLimit, pool, host, sharedUsers, uptimeLimit, category) {
        try {
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return { success: false, message: `No valid MikroTik connection` };
            const { channel } = connection;
            try {
                const profiles = await this.mikrotik.listHotspotProfiles(channel);
                const existingProfile = profiles.find(p => p.name === profileName);
                if (existingProfile) {
                    this.logPlatform(platformID, `Profile already exists: ${profileName}`, {
                        context: "mikrotik",
                        level: "warn",
                    });
                    return { success: false, message: "Profile name already exists" };
                }
                let sharedUsersValue = sharedUsers;
                if (sharedUsers !== undefined && sharedUsers !== null) {
                    if (String(sharedUsers).toLowerCase() === "unlimited") sharedUsersValue = "unlimited";
                    else {
                        const numUsers = Number(sharedUsers);
                        if (isNaN(numUsers) || numUsers < 1) return { success: false, message: "Invalid shared users value. Use a positive number or 'Unlimited'" };
                        sharedUsersValue = numUsers.toString();
                    }
                }
                let time = '';
                if (uptimeLimit && uptimeLimit.trim() !== "NoExpiry") {
                    time = this.formatUptime(uptimeLimit);
                    if (!this.isValidMikrotikTime(time)) return { success: false, message: `Invalid session-timeout format: ${time}. Use format like "1h30m" or "1d"` };
                }
                const isDataPackage = String(category || '').toLowerCase() === 'data';
                const addMacCookie = isDataPackage ? "no" : "yes";
                const macCookieTimeout = !isDataPackage && time ? time : undefined;
                await this.mikrotik.addHotspotProfile(channel, {
                    name: profileName,
                    rateLimit: rateLimit,
                    sharedUsers: sharedUsersValue || 0,
                    pool: pool,
                    time,
                    addMacCookie,
                    macCookieTimeout,
                });
                await this.ensureHotspotMacCookie(channel, time);
                this.logPlatform(platformID, `Profile created: ${profileName} on ${host}`, {
                    context: "mikrotik",
                    level: "success",
                });
                return { success: true, message: "Profile created successfully" };
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            this.logPlatform(platformID, `Profile creation failed for ${profileName}: ${error.message || error}`, {
                context: "mikrotik",
                level: "error",
            });
            return { success: false, message: error.message, errorDetails: error.stack };
        }
    }

    async verifyMikrotikUser(data) {
        const { platformID, code, host } = data;
        if (!platformID || !code || !host) return { success: false, message: "Missing credentials are required parameters" };
        try {
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return { success: false, message: `No valid MikroTik connection` };
            const { channel } = connection;
            try {
                const profiles = await this.mikrotik.listHotspotUsers(channel);
                const existingUser = profiles.find(p => p.name === code);
                if (!existingUser) return { success: true, message: `User '${code}' not found` };
                return { success: true, message: "User found" };
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    formatUptime(input) {
        const timeMap = { minutes: 'm', hours: 'h', days: 'd' };
        const [value, unit] = input.split(' ');
        if (!timeMap[unit]) throw new Error(`Invalid time unit: ${unit}. Use minutes/hours/days`);
        return `${value}${timeMap[unit]}`;
    }

    isValidMikrotikTime(time) {
        return /^(\d+d)?(\d+h)?(\d+m)?$/.test(time);
    }

    convertToBytes(value, unit) {
        const unitMap = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
        if (!unitMap[unit]) throw new Error(`Unsupported unit: ${unit}`);
        return Math.round(value * unitMap[unit]);
    }

    async updateMikrotikProfile(platformID, currentProfileName, newProfileName, rateLimit, pool, host, sharedUsers, uptimeLimit) {
        try {
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return { success: false, message: `No valid MikroTik connection` };
            const { channel } = connection;
            try {
                const profiles = await this.mikrotik.listHotspotProfiles(channel);
                const existingProfile = profiles.find(p => p.name === currentProfileName);
                if (!existingProfile) return { success: false, message: "Profile not found" };
                const currentProfile = existingProfile;
                const profileData = {};
                if (newProfileName && newProfileName !== currentProfileName) {
                    const nameCheck = profiles.find(p => p.name === newProfileName);
                    if (nameCheck) return { success: false, message: "New profile name already exists" };
                    profileData.name = newProfileName;
                }
                if (rateLimit !== undefined && rateLimit !== currentProfile['rate-limit']) profileData['rate-limit'] = rateLimit;
                if (pool !== undefined && pool !== currentProfile['address-pool']) profileData['address-pool'] = pool;
                if (sharedUsers !== undefined) {
                    if (String(sharedUsers).toLowerCase() === 'unlimited') profileData['shared-users'] = 'unlimited';
                    else {
                        const numUsers = Number(sharedUsers);
                        if (isNaN(numUsers)) throw new Error("Invalid shared users value. Use a number or 'unlimited'");
                        profileData['shared-users'] = numUsers.toString();
                    }
                }
                if (uptimeLimit && uptimeLimit.trim() !== "Unlimited" && uptimeLimit.trim() !== "NoExpiry") {
                    const time = this.formatUptime(uptimeLimit);
                    if (!this.isValidMikrotikTime(time)) throw new Error(`Invalid session-timeout: ${time}. Use format like '1h30m' or '1d'`);
                    profileData['session-timeout'] = time;
                }
                if (Object.keys(profileData).length === 0) return { success: false, message: "No valid changes provided" };
                await this.mikrotik.updateHotspotProfile(channel, currentProfile['.id'], profileData);
                if (profileData["session-timeout"]) {
                    await this.ensureHotspotMacCookie(channel, profileData["session-timeout"]);
                }
                return { success: true, message: "Profile updated successfully" };
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            return { success: false, message: error.message, errorDetails: error.stack };
        }
    }

    async deleteMikrotikProfile(platformID, profileName, host) {
        try {
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return { success: false, message: `No valid MikroTik connection` };
            const { channel } = connection;
            try {
                const profiles = await this.mikrotik.listHotspotProfiles(channel);
                const existingProfile = profiles.find(p => p.name === profileName);
                if (!existingProfile) {
                    this.logPlatform(platformID, `Profile not found: ${profileName}`, {
                        context: "mikrotik",
                        level: "warn",
                    });
                    return { success: true, message: "Profile not found" };
                }
                await this.mikrotik.deleteHotspotProfile(channel, existingProfile['.id']);
                this.logPlatform(platformID, `Profile deleted: ${profileName} on ${host}`, {
                    context: "mikrotik",
                    level: "success",
                });
                return { success: true, message: "Profile deleted successfully" };
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            this.logPlatform(platformID, `Profile delete failed for ${profileName}: ${error.message || error}`, {
                context: "mikrotik",
                level: "error",
            });
            return { success: false, message: error.message, errorDetails: error.stack };
        }
    }

    async handlePackageLifecycle(platformID, packageData, action) {
        const { speed } = packageData;
        try {
            if (action === 'create') return await this.createMikrotikProfile(platformID, speed, speed);
            if (action === 'delete') return await this.deleteMikrotikProfile(platformID, speed);
        } catch (error) {
            return { success: false, message: `Failed to ${action} package profile: ${error.message}` };
        }
    }

    async fetchAddressPoolsFromConnections(req, res) {
        const { token } = req.body;
        if (!token) return res.json({ success: false, message: "Missing credentials required!" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID." });
            const stations = await this.db.getStations(platformID);
            const results = [];
            await Promise.all(stations.map(async (station) => {
                try {
                    const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
                    if (!connection?.channel) {
                        results.push({ id: station.id, host: station.mikrotikHost, username: station.mikrotikUser, status: "error", data: { pools: [] }, message: "Failed to connect to router" });
                        return;
                    }
                    const { channel } = connection;
                    try {
                        const pools = await this.mikrotik.listPools(channel);
                        results.push({ id: station.id, host: station.mikrotikHost, username: station.mikrotikUser, status: "success", data: { pools: pools.map((p) => ({ name: p.name, ranges: p.ranges, comment: p.comment || "" })) } });
                    } finally {
                        await this.safeCloseChannel(channel);
                    }
                } catch (error) {
                    results.push({ id: station.id, host: station.mikrotikHost, username: station.mikrotikUser, status: "error", data: { pools: [] }, message: error.message || "Error fetching pools" });
                }
            }));
            return res.status(200).json({ success: true, message: "Address pools fetched successfully", pools: results });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Error fetching address pools." });
        }
    }

    async fetchMikrotikProfiles(req, res) {
        const { token } = req.body;
        if (!token) return res.json({ success: false, message: "Missing credentials required!" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID." });
            const results = [];
            const stations = await this.db.getStations(platformID);
            for (const station of stations) {
                const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
                if (!connection?.channel) return res.json({ success: false, message: `No valid MikroTik connection` });
                const { channel } = connection;
                try {
                    const response = await this.mikrotik.listHotspotProfiles(channel);
                    const profiles = response.map(item => ({
                        id: item['.id'] || '',
                        name: item['name'] || '',
                        rateLimit: item['rate-limit'] || '',
                        sharedUsers: item['shared-users'] || '',
                        idleTimeout: item['idle-timeout'] || '',
                        keepaliveTimeout: item['keepalive-timeout'] || '',
                        sessionTimeout: item['session-timeout'] || '',
                        statusAutorefresh: item['status-autorefresh'] || '',
                        addMacCookie: item['add-mac-cookie'] || '',
                        macCookieTimeout: item['mac-cookie-timeout'] || '',
                        addressPool: item['address-pool'] || '',
                        addressList: item['address-list'] || '',
                        transparentProxy: item['transparent-proxy'] || '',
                    }));
                    results.push({ id: station.id, username: station.mikrotikUser, host: station.mikrotikHost, status: 'success', data: { profiles } });
                } finally {
                    await this.safeCloseChannel(channel);
                }
            }
            return res.status(200).json({ success: true, message: "Hotspot user profiles fetched successfully", profiles: results });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Error fetching hotspot user profiles." });
        }
    }

    async fetchStations(req, res) {
        const { token } = req.body;
        if (!token) return res.json({ success: false, message: "Missing credentials required!" });
        const auth = await this.auth.AuthenticateRequest(token);
        if (!auth.success) return res.json({ success: false, message: auth.message });
        if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
        const platformID = auth.admin.platformID;
        if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID." });
        try {
            const stations = await this.db.getMikrotikPlatformConfig(platformID);
            const sanitizedStations = stations.map(station => {
                const { mikrotikPassword, ...sanitizedStation } = station;
                return sanitizedStation;
            });
            return res.status(200).json({ success: true, message: "Stations fetched successfully", stations: sanitizedStations });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Error fetching stations." });
        }
    }

    async fetchAdminStations(req, res) {
        const { token } = req.body;
        if (!token) return res.status(400).json({ success: false, message: "Missing credentials required!" });
        const auth = await this.auth.AuthenticateRequest(token);
        if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
        if (!auth.superuser && auth.admin?.role !== "superuser") {
            return res.status(403).json({ success: false, message: "Unauthorised!" });
        }
        try {
            const stations = await this.db.getAdminStations();
            if (!stations || stations.length === 0) return res.status(200).json({ success: true, message: "No stations found for this platform.", stations: [] });
            const stationsWithStatus = await Promise.all(stations.map(async (station) => {
                const connection = await this.config.createMikrotikConnection(station);
                return { ...station, connectionStatus: connection?.status, connectionMessage: connection?.message };
            }));
            return res.status(200).json({ success: true, message: "Stations fetched successfully", stations: stationsWithStatus });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Error fetching stations." });
        }
    }

    async fetchInterfaces(req, res) {
        const { token } = req.body;
        if (!token) return res.json({ success: false, message: "Missing credentials required!" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID." });
            const results = [];
            const stations = await this.db.getStations(platformID);
            for (const station of stations) {
                const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
                if (!connection?.channel) return res.json({ success: false, message: `No valid MikroTik connection` });
                const { channel } = connection;
                try {
                    const response = await this.mikrotik.listInterfaces(channel);
                    const interfaces = response.map(item => ({ name: item?.name || '', type: item?.type || '', disabled: item?.disabled || '', macAddress: item['mac-address'] || '', mtu: item.mtu || '' }));
                    results.push({ id: station.id, station: station.mikrotikHost, host: station.mikrotikHost, status: 'success', data: { interfaces } });
                } finally {
                    await this.safeCloseChannel(channel);
                }
            }
            return res.status(200).json({ success: true, message: "Interfaces fetched successfully", profiles: results });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Error fetching interfaces." });
        }
    }

    async fetchPPPSecret(req, res) {
        const { token } = req.body;
        if (!token) return res.json({ success: false, message: "Missing credentials required!" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.json({ success: false, message: auth.message });
            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID." });
            const connections = await this.config.createMikrotikClient(token);
            if (!connections || connections.length === 0) return res.status(400).json({ success: false, message: "No valid router connections." });
            const validConnections = connections.filter(conn => conn.status === "Connected" && conn.channel);
            const results = [];
            for (const conn of validConnections) {
                const { id, host, username, channel } = conn;
                try {
                    const response = await this.mikrotik.listInterfaces(channel);
                    const interfaces = response.map(item => ({ name: item?.name || '' }));
                    results.push({ id, host, username, status: 'success', data: { interfaces } });
                } finally {
                    await this.safeCloseChannel(channel);
                }
            }
            return res.status(200).json({ success: true, message: "Interfaces fetched successfully", profiles: results });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Error fetching interfaces." });
        }
    }

    async fetchPPPprofile(req, res) {
        const { token } = req.body;
        if (!token) return res.json({ success: false, message: "Missing credentials required!" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID." });
            const results = [];
            const stations = await this.db.getStations(platformID);
            for (const station of stations) {
                const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
                if (!connection?.channel) return res.json({ success: false, message: `No valid MikroTik connection` });
                const { channel } = connection;
                try {
                    const response = await this.mikrotik.listPPPProfiles(channel);
                    const profiles = response.map(item => ({ name: item?.name || '', localAddress: item['local-address'] || '', remoteAddress: item['remote-address'] || '', rateLimit: item['rate-limit'] || '', dnsServer: item['dns-server'] || '' }));
                    results.push({ id: station.id, station: station.name || station.mikrotikHost, host: station.mikrotikHost, status: 'success', data: { profiles } });
                } finally {
                    await this.safeCloseChannel(channel);
                }
            }
            return res.status(200).json({ success: true, message: "PPP profiles fetched successfully", profiles: results });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Error fetching PPP profiles." });
        }
    }

    async fetchPPPoEServers(req, res) {
        const { token } = req.body;
        if (!token) return res.json({ success: false, message: "Missing credentials required!" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID." });
            const results = [];
            const stations = await this.db.getStations(platformID);
            for (const station of stations) {
                const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
                if (!connection?.channel) return res.json({ success: false, message: `No valid MikroTik connection` });
                const { channel } = connection;
                try {
                    const response = await this.mikrotik.listPPPServers(channel);
                    const servers = response.map(item => ({ serviceName: item['service-name'] || '', interface: item['interface'] || '', authentication: item['authentication'] || '', maxSessions: item['max-sessions'] || '', defaultProfile: item['default-profile'] || '', disabled: item['disabled'] || 'no', id: item['.id'] || '' }));
                    results.push({ id: station.id, station: station.name || station.mikrotikHost, host: station.mikrotikHost, status: 'success', data: { servers } });
                } finally {
                    await this.safeCloseChannel(channel);
                }
            }
            return res.status(200).json({ success: true, message: "PPPoE servers fetched successfully", servers: results });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Error fetching PPPoE servers." });
        }
    }

    async fetchStationSummary(req, res) {
        const { token, stationId, host } = req.body;
        if (!token) return res.json({ success: false, message: "Missing credentials required!" });
        if (!stationId && !host) {
            return res.status(400).json({ success: false, message: "Missing stationId or host." });
        }
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID." });

            const station = stationId
                ? await this.db.getStation(stationId)
                : (await this.db.getStations(platformID))?.find((s) => s.mikrotikHost === host);
            if (!station) {
                return res.status(404).json({ success: false, message: "Station not found." });
            }

            const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
            if (!connection?.channel) {
                return res.status(200).json({
                    success: false,
                    message: "Mikrotik failed to connect",
                    data: { pools: [], interfaces: [], hotspotProfiles: [], pppProfiles: [], pppServers: [] },
                });
            }

            const { channel } = connection;
            try {
                const [pools, interfaces, hotspotProfiles, pppProfiles, pppServers, systemResource] = await Promise.all([
                    this.mikrotik.listPools(channel),
                    this.mikrotik.listInterfaces(channel),
                    this.mikrotik.listHotspotProfiles(channel),
                    this.mikrotik.listPPPProfiles(channel),
                    this.mikrotik.listPPPServers(channel),
                    this.mikrotik.listSystemResource(channel),
                ]);
                const resource = Array.isArray(systemResource) ? systemResource[0] : null;

                return res.status(200).json({
                    success: true,
                    message: "Station summary fetched successfully",
                    data: {
                        router: {
                            name: station.name || station.mikrotikHost || "Router",
                            host: station.mikrotikHost || "",
                            version: resource?.version || "",
                            boardName: resource?.["board-name"] || "",
                            uptime: resource?.uptime || "",
                        },
                        pools: pools.map((p) => ({ name: p.name, ranges: p.ranges, comment: p.comment || "" })),
                        interfaces: interfaces.map((item) => ({
                            name: item?.name || "",
                            type: item?.type || "",
                            disabled: item?.disabled || "",
                            macAddress: item["mac-address"] || "",
                            mtu: item.mtu || "",
                        })),
                        hotspotProfiles: hotspotProfiles.map((item) => ({
                            id: item[".id"] || "",
                            name: item["name"] || "",
                            rateLimit: item["rate-limit"] || "",
                            sharedUsers: item["shared-users"] || "",
                            idleTimeout: item["idle-timeout"] || "",
                            keepaliveTimeout: item["keepalive-timeout"] || "",
                            sessionTimeout: item["session-timeout"] || "",
                            statusAutorefresh: item["status-autorefresh"] || "",
                            addMacCookie: item["add-mac-cookie"] || "",
                            macCookieTimeout: item["mac-cookie-timeout"] || "",
                            addressPool: item["address-pool"] || "",
                            addressList: item["address-list"] || "",
                            transparentProxy: item["transparent-proxy"] || "",
                        })),
                        pppProfiles: pppProfiles.map((item) => ({
                            name: item?.name || "",
                            localAddress: item["local-address"] || "",
                            remoteAddress: item["remote-address"] || "",
                            rateLimit: item["rate-limit"] || "",
                            dnsServer: item["dns-server"] || "",
                        })),
                        pppServers: pppServers.map((item) => ({
                            serviceName: item["service-name"] || "",
                            interface: item["interface"] || "",
                            authentication: item["authentication"] || "",
                            maxSessions: item["max-sessions"] || "",
                            defaultProfile: item["default-profile"] || "",
                            disabled: item["disabled"] || "no",
                            id: item[".id"] || "",
                        })),
                    },
                });
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Error fetching station summary." });
        }
    }

    async updateAddressPool(req, res) {
        try {
            const { token, poolData } = req.body;
            if (!token || !poolData?.newName || !poolData?.ranges || !poolData?.station) return res.status(400).json({ success: false, message: "Missing required parameters" });
            const cidrRegex = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/([0-9]|[1-2]\d|3[0-2])$/;
            const rangeRegex = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})-(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
            const trimmedRange = poolData.ranges.trim();
            const ipToNumber = (ip) => ip.split('.').reduce((acc, oct) => acc * 256 + Number(oct), 0);
            if (cidrRegex.test(trimmedRange)) { }
            else if (rangeRegex.test(trimmedRange)) {
                const [startIP, endIP] = trimmedRange.split('-');
                const startParts = startIP.split('.').map(Number);
                const endParts = endIP.split('.').map(Number);
                if (startParts[3] < 2 || endParts[3] > 254 || ipToNumber(startIP) > ipToNumber(endIP)) {
                    return res.status(400).json({ success: false, message: "Invalid range. Start ≥ 2, end ≤ 254, and start ≤ end" });
                }
            } else {
                return res.status(400).json({ success: false, message: "Invalid format. Use CIDR (e.g. 10.10.20.0/24) or range (e.g. 10.10.20.2-10.10.22.254)" });
            }
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            if (!auth.admin.platformID) return res.status(400).json({ success: false, message: "Missing platformID" });
            const connection = await this.config.createSingleMikrotikClient(auth.admin.platformID, poolData.station);
            if (!connection) return res.status(400).json({ success: false, message: "Failed to create MikroTik client" });
            const { channel } = connection;
            try {
                const existingPools = await this.mikrotik.listPools(channel);
                const newBounds = Utils.getRangeBounds(poolData.ranges);
                if (!newBounds) return res.status(400).json({ success: false, message: "Invalid IP range format" });
                for (const pool of existingPools) {
                    if (poolData.name && pool.name === poolData.name) continue;
                    if (pool.ranges) {
                        const poolBounds = Utils.getRangeBounds(pool.ranges);
                        if (poolBounds && Utils.rangesOverlap(newBounds, poolBounds)) {
                            return res.status(400).json({ success: false, message: `Range ${poolData.ranges} overlaps with pool '${pool.name}' (${pool.ranges})` });
                        }
                    }
                }
                if (poolData.name) {
                    const existingPool = existingPools.find(p => p.name === poolData.name);
                    if (!existingPool) return res.status(404).json({ success: false, message: `Pool '${poolData.name}' not found.` });
                    const duplicateNewName = existingPools.find(p => p.name === poolData.newName);
                    if (duplicateNewName && duplicateNewName['.id'] !== existingPool['.id']) return res.status(400).json({ success: false, message: `Pool name '${poolData.newName}' already exists.` });
                    await this.mikrotik.updatePool(channel, existingPool['.id'], { name: poolData.newName, ranges: poolData.ranges, comment: poolData.comment || '' });
                    return res.status(200).json({ success: true, message: `Pool '${poolData.name}' updated successfully${poolData.name !== poolData.newName ? ` to '${poolData.newName}'` : ''}.` });
                }
                const duplicateNewName = existingPools.find(p => p.name === poolData.newName);
                if (duplicateNewName) return res.status(400).json({ success: false, message: `Pool '${poolData.newName}' already exists.` });
                await this.mikrotik.addPool(channel, { name: poolData.newName, ranges: poolData.ranges, comment: poolData.comment || '' });
                const resolveBase16 = (rangeOrCidr) => {
                    if (!rangeOrCidr) return null;
                    let ip = "";
                    if (rangeRegex.test(rangeOrCidr)) {
                        ip = rangeOrCidr.split("-")[0];
                    } else if (cidrRegex.test(rangeOrCidr)) {
                        ip = rangeOrCidr.split("/")[0];
                    }
                    const parts = ip.split(".").map((part) => Number(part));
                    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
                    const base = `${parts[0]}.${parts[1]}.0.0`;
                    return {
                        address: `${parts[0]}.${parts[1]}.0.1/16`,
                        network: base,
                    };
                };
                const base16 = resolveBase16(poolData.ranges);
                if (base16) {
                    const interfaces = await this.mikrotik.listInterfaces(channel);
                    let bridgeInterface = interfaces.find((i) => i.type === "bridge")?.name;
                    if (!bridgeInterface && interfaces.length > 0) bridgeInterface = interfaces[0].name;
                    if (bridgeInterface) {
                        const existingAddresses = await this.mikrotik.listIPAddresses(channel);
                        const exists = existingAddresses.find((addr) => {
                            const address = String(addr.address || "");
                            const network = String(addr.network || "");
                            return address.split("/")[0] === base16.address.split("/")[0] || network === base16.network;
                        });
                        if (!exists) {
                            await this.mikrotik.addIPAddress(channel, {
                                address: base16.address,
                                network: base16.network,
                                intf: bridgeInterface,
                                comment: `Pool Gateway - ${poolData.newName}`,
                            });
                        }
                    }
                }
                return res.status(200).json({ success: true, message: `Pool '${poolData.newName}' added successfully` });
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Internal server error", error: error.message });
        }
    }

    async deleteAddressPool(req, res) {
        try {
            const { token, poolData } = req.body;
            if (!token || !poolData) return res.status(400).json({ success: false, message: "Missing required parameters are required" });
            const poolName = poolData.name;
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            if (!auth.admin.platformID) return res.status(400).json({ success: false, message: "Missing platformID in authentication data" });
            const connection = await this.config.createSingleMikrotikClient(auth.admin.platformID, poolData.station);
            if (!connection) return res.status(400).json({ success: false, message: "Failed to create MikroTik client" });
            const channel = connection.channel;
            try {
                const existingPools = await this.mikrotik.listPools(channel);
                const existingPool = existingPools.find(pool => pool.name === poolData.name);
                if (!existingPool) return { success: true, message: `Pool '${poolName}' not found` };
                await this.mikrotik.deletePool(channel, existingPool['.id']);
                return res.status(200).json({ success: true, message: `Pool '${poolName}' deleted successfully` });
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Internal server error", error: error.message });
        }
    }

    async createPPPProfile(req, res) {
        const { token, station, name, pool, localaddress, DNSserver, speed } = req.body;
        if (!token || !station || !name || !DNSserver || !speed) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            const stations = await this.db.getStations(platformID);
            const stationRecord = stations.find((s) => s.mikrotikHost === station);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            if (!pool || !localaddress) {
                return res.status(400).json({ success: false, message: "Pool and local address are required for PPP profiles" });
            }
            const connection = await this.config.createSingleMikrotikClient(platformID, station);
            if (!connection?.channel) return res.json({ success: false, message: "No valid MikroTik connection" });
            const { channel } = connection;
            const rateLimit = speed ? `${speed}M/${speed}M` : "";
            try {
                const profiles = await this.mikrotik.listPPPProfiles(channel);
                const exists = profiles.find(p => p.name === name);
                if (exists) {
                    return res.json({ success: false, message: "PPP profile already exists" });
                }
                await this.mikrotik.addPPPProfile(channel, {
                    name,
                    localAddress: localaddress,
                    remoteAddress: pool,
                    dnsServer: DNSserver,
                    rateLimit: rateLimit
                });
                if (isRadius) {
                    const refreshedProfiles = await this.mikrotik.listPPPProfiles(channel);
                    const created = refreshedProfiles.find(p => p.name === name);
                    if (created?.[".id"]) {
                        await this.mikrotik.updatePPPProfile(channel, created[".id"], { "use-radius": "yes" });
                    }
                }
                return res.json({ success: true, message: "PPP profile created successfully" });
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to create PPP profile" });
        }
    }

    async createPPPoEServer(req, res) {
        const { token, station, servicename, interface: interfaceName, maxsessions } = req.body;
        if (!token || !station || !servicename || !interfaceName || !maxsessions) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            const connection = await this.config.createSingleMikrotikClient(platformID, station);
            if (!connection?.channel) return res.json({ success: false, message: "No valid MikroTik connection" });
            const { channel } = connection;
            try {
                const servers = await this.mikrotik.listPPPServers(channel);
                const exists = servers.find(s => s['service-name'] === servicename);
                if (exists) {
                    return res.json({ success: false, message: "PPPoE server already exists" });
                }
                const serverData = {
                    "service-name": servicename,
                    "interface": interfaceName,
                    "authentication": "pap,chap,mschap1,mschap2",
                    "max-sessions": maxsessions,
                    "disabled": "no"
                };
                await this.mikrotik.addPPPServer(channel, serverData);
                return res.json({ success: true, message: "PPPoE server created successfully" });
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to create PPPoE server" });
        }
    }

    async createPPPoEPlan(req, res) {
        const { token, station, name, profile, servicename, pool, price, period, status } = req.body;
        if (!token || !station || !name || !profile || !servicename || !price || !period) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            const stations = await this.db.getStations(platformID);
            const stationRecord = stations.find((s) => s.mikrotikHost === station);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            if (!isRadius && !pool) {
                return res.status(400).json({ success: false, message: "Pool is required for API PPPoE plans" });
            }
            const created = await this.db.createPPPoEPlan({
                platformID,
                station,
                name,
                profile,
                servicename,
                pool: isRadius ? "" : pool,
                price,
                period,
                status: status || "active",
            });
            if (!created) return res.status(500).json({ success: false, message: "Failed to create plan" });
            return res.json({ success: true, message: "PPPoE plan created successfully", plan: created });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to create plan" });
        }
    }

    async fetchPPPoEPlans(req, res) {
        const { token } = req.body;
        if (!token) return res.status(400).json({ success: false, message: "Missing token" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            const plans = await this.db.getPPPoEPlans(platformID);
            return res.json({ success: true, plans: plans || [] });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to fetch plans" });
        }
    }

    async createPPPoEUser(req, res) {
        const { token, station, planId, clientname, clientpassword, status, email, phone, customFields } = req.body;
        if (!token || !station || !planId || !clientname || !clientpassword) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }
        try {
            const allowedStatuses = new Set(["active", "inactive", "expired"]);
            const normalizedStatus = status ? String(status).toLowerCase() : "active";
            if (!allowedStatuses.has(normalizedStatus)) {
                return res.status(400).json({ success: false, message: "Invalid PPPoE status" });
            }
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            const plan = await this.db.getPPPoEPlanById(planId);
            if (!plan || plan.platformID !== platformID) {
                return res.status(404).json({ success: false, message: "PPPoE plan not found" });
            }
            const stations = await this.db.getStations(platformID);
            const stationRecord = stations.find((s) => s.mikrotikHost === station);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            if (!isRadius) {
                const connection = await this.config.createSingleMikrotikClient(platformID, station);
                if (!connection?.channel) return res.json({ success: false, message: "No valid MikroTik connection" });
                const { channel } = connection;
                const isdisabled = normalizedStatus === "active" ? "no" : "yes";
                try {
                    const existingSecrets = await this.mikrotik.listSecrets(channel);
                    const existingSecret = existingSecrets.find(s => s.name === clientname);
                    if (existingSecret) {
                        return res.status(500).json({ success: false, message: "PPPoE user already exists, create a new one!" });
                    }
                    await this.mikrotik.addSecret(channel, {
                        name: clientname,
                        password: clientpassword,
                        service: "pppoe",
                        profile: plan.profile,
                        disabled: isdisabled
                    });
                } finally {
                    await this.safeCloseChannel(channel);
                }
            } else {
                const speedSource = plan.profile || plan.name || "";
                const speedVal = String(speedSource).replace(/[^0-9.]/g, "");
                const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
                await this.db.upsertRadiusUser({
                    username: clientname,
                    password: clientpassword,
                    groupname: plan.name,
                    rateLimit,
                });
            }

            let expireAt = null;
            if (plan.period) {
                const match = plan.period.toLowerCase().match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
                if (match && normalizedStatus === "active") {
                    const value = parseInt(match[1]);
                    const unit = match[2].toLowerCase();
                    expireAt = Utils.addPeriod(new Date(), value, unit);
                }
            }
            if (normalizedStatus === "expired") {
                expireAt = new Date();
            }
            const amount = normalizedStatus === "active" ? "0" : String(plan.price || "0");

            let accountNumber = "";
            const config = await this.db.getPlatformConfig(platformID);
            if (config?.mpesaShortCodeType?.toLowerCase() === "paybill") {
                const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
                accountNumber = Array.from({ length: 3 }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join("");
            }
            const paymentLink = Math.random().toString(36).substring(2, 15);
            const pppoeData = {
                name: plan.name,
                profile: plan.profile,
                servicename: plan.servicename,
                station: plan.station,
                pool: plan.pool,
                platformID,
                devices: "100",
                price: plan.price,
                period: plan.period,
                clientname,
                clientpassword,
                interface: "",
                maxsessions: "",
                status: normalizedStatus,
                amount,
                paymentLink,
                email,
                expiresAt: expireAt ? expireAt : null,
                phone,
                accountNumber,
                customFields: customFields ? customFields : {},
                planId: plan.id,
            };
            const result = await this.db.createPPPoE(pppoeData);
            const platform = await this.db.getPlatform(platformID);
            if (email) {
                const template = await this.db.getPlatformEmailTemplate(platformID);
                let message = '';
                const subject = `PPPoE Credentials from ${platform.name}!`;
                if (normalizedStatus === "active") {
                    message = template?.pppoeRegisterTemplate
                        ? Utils.formatMessage(template.pppoeRegisterTemplate, {
                            name: clientname,
                            password: clientpassword,
                            email,
                            company: platform.name,
                            package: plan.name,
                            price: plan.price,
                            amount: amount,
                            expiry: expireAt ? expireAt : null,
                            paymentLink: `<a href="https://${platform.url}/pppoe?info=${paymentLink}">https://${platform.url}/pppoe?info=${paymentLink}</a>`,
                        })
                        : `<p>Your PPPoE credentials have been created by <strong>${platform.name}</strong>.</p><p><strong>-- PPPoE Credentials --</strong><br />Name: ${clientname}<br />Password: ${clientpassword}</p><p>For more status and information about this service, visit:<br /><a href="https://${platform.url}/pppoe?info=${paymentLink}">https://${platform.url}/pppoe?info=${paymentLink}</a></p>`;
                } else {
                    message = template?.pppoeInactiveTemplate
                        ? Utils.formatMessage(template.pppoeInactiveTemplate, {
                            name: clientname,
                            password: clientpassword,
                            email,
                            company: platform.name,
                            package: plan.name,
                            price: plan.price,
                            amount: amount,
                            expiry: expireAt ? expireAt : null,
                            paymentLink: `<a href="https://${platform.url}/pppoe?info=${paymentLink}">https://${platform.url}/pppoe?info=${paymentLink}</a>`,
                        })
                        : `<p>Your PPPoE account is currently inactive.</p><p><strong>-- PPPoE Credentials --</strong><br />Name: ${clientname}<br />Password: ${clientpassword}</p><p>To activate your credentials, please pay KSH ${amount} for your ${plan.name} plan.<br />Visit <a href="https://${platform.url}/pppoe?info=${paymentLink}">https://${platform.url}/pppoe?info=${paymentLink}</a> to complete payment.</p>`;
                }
                await this.mailer.EmailTemplate({ name: email, type: "accounts", email, subject, message, company: platform.name });
            }
            if (phone) {
                const platformConfig = await this.db.getPlatformConfig(platformID);
                if (platformConfig?.sms === true) {
                    const sms = await this.db.getPlatformSMS(platformID);
                    if (sms && sms.sentPPPoE !== false && Number(sms.balance) >= Number(sms.costPerSMS)) {
                        let sms_message = ``;
                        if (normalizedStatus === "active") {
                            sms_message = Utils.formatMessage(sms.pppoeRegisterSMS, {
                                company: platform.name,
                                username: plan.name,
                                period: plan.period,
                                amount: amount,
                                package: plan.profile,
                                expiry: expireAt,
                                paymentLink: `https://${platform.url}/pppoe?info=${paymentLink}`,
                            });
                        } else {
                            sms_message = Utils.formatMessage(sms.pppoeInactiveSMS, {
                                company: platform.name,
                                username: plan.name,
                                period: plan.period,
                                amount: amount,
                                package: plan.profile,
                                expiry: expireAt,
                                paymentLink: `https://${platform.url}/pppoe?info=${paymentLink}`,
                            });
                        }
                        const is_send = await this.sms.sendSMS(phone, sms_message, sms);
                        if (is_send.success && sms?.default === true) {
                            const newSMSBalance = Number(sms.balance) - Number(sms.costPerSMS);
                            const newSMS = Math.floor(Number(sms.remainingSMS)) - 1;
                            await this.db.updatePlatformSMS(platformID, { balance: newSMSBalance.toString(), remainingSMS: newSMS.toString() });
                        }
                    }
                }
            }
            await this.pushDashboardStats(platformID);
            return res.json({ success: true, message: "PPPoE created successfully", pppoe: result });
        } catch (error) {
            return res.status(500).json({ success: false, message: "An error occured, try again!" });
        }
    }

    async updatePPPoEUser(req, res) {
        const { token, id, planId, clientname, clientpassword, status, email, phone, customFields } = req.body;
        if (!token || !id || !clientname || !clientpassword) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }
        try {
            const allowedStatuses = new Set(["active", "inactive", "expired"]);
            const normalizedStatus = status ? String(status).toLowerCase() : null;
            if (normalizedStatus && !allowedStatuses.has(normalizedStatus)) {
                return res.status(400).json({ success: false, message: "Invalid PPPoE status" });
            }
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            const client = await this.db.getPPPoEById(id);
            if (!client) return res.status(404).json({ success: false, message: "PPPoE client not found" });
            const plan = planId ? await this.db.getPPPoEPlanById(planId) : null;
            if (planId && (!plan || plan.platformID !== platformID)) {
                return res.status(404).json({ success: false, message: "PPPoE plan not found" });
            }

            const stations = await this.db.getStations(platformID);
            const stationRecord = stations.find((s) => s.mikrotikHost === client.station);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            const effectiveStatus = normalizedStatus || String(client.status || "active").toLowerCase();
            if (!isRadius) {
                const connection = await this.config.createSingleMikrotikClient(platformID, client.station);
                if (!connection?.channel) return res.json({ success: false, message: "No valid MikroTik connection" });
                const { channel } = connection;
                const isdisabled = effectiveStatus === "active" ? "no" : "yes";
                try {
                    const existingSecrets = await this.mikrotik.listSecrets(channel);
                    const existingSecret = existingSecrets.find(s => s.name === client.clientname) || existingSecrets.find(s => s.name === clientname);
                    if (!existingSecret) {
                        return res.status(404).json({ success: false, message: "PPPoE user not found on router" });
                    }
                    const updates = {
                        name: clientname,
                        password: clientpassword,
                        service: "pppoe",
                        profile: plan ? plan.profile : client.profile,
                        disabled: isdisabled
                    };
                    await this.mikrotik.updateSecret(channel, existingSecret['.id'], updates);
                } finally {
                    await this.safeCloseChannel(channel);
                }
            } else {
                if (client.clientname && client.clientname !== clientname) {
                    await this.db.deleteRadiusUser(client.clientname);
                }
                const speedSource = (plan ? plan.profile : client.profile) || plan?.name || client.name || "";
                const speedVal = String(speedSource).replace(/[^0-9.]/g, "");
                const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
                await this.db.upsertRadiusUser({
                    username: clientname,
                    password: clientpassword,
                    groupname: plan ? plan.name : client.name,
                    rateLimit,
                });
            }

            let expireAt = client.expiresAt ? new Date(client.expiresAt) : null;
            if (plan?.period) {
                const match = plan.period.toLowerCase().match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
                if (match && effectiveStatus === "active") {
                    const value = parseInt(match[1]);
                    const unit = match[2].toLowerCase();
                    expireAt = Utils.addPeriod(new Date(), value, unit);
                }
            }
            if (effectiveStatus === "expired") {
                expireAt = new Date();
            } else if (effectiveStatus === "inactive") {
                expireAt = null;
            }
            const price = plan ? plan.price : client.price;
            const amount = effectiveStatus === "active" ? "0" : String(price || "0");

            const pppoeData = {
                name: plan ? plan.name : client.name,
                profile: plan ? plan.profile : client.profile,
                servicename: plan ? plan.servicename : client.servicename,
                pool: plan ? plan.pool : client.pool,
                price: price,
                period: plan ? plan.period : client.period,
                clientname,
                clientpassword,
                status: effectiveStatus,
                amount,
                email,
                phone,
                expiresAt: expireAt ? expireAt : null,
                customFields: customFields ? customFields : client.customFields,
                planId: plan ? plan.id : client.planId,
            };
            const result = await this.db.updatePPPoE(id, pppoeData);
            await this.pushDashboardStats(platformID);
            return res.json({ success: true, message: "PPPoE updated successfully", pppoe: result });
        } catch (error) {
            return res.status(500).json({ success: false, message: "An error occured, try again!" });
        }
    }

    async togglePPPoEStatus(req, res) {
        const { token, id } = req.body;
        if (!token || !id) return res.status(400).json({ success: false, message: "Missing required parameters" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platform ID" });
            const client = await this.db.getPPPoEById(id);
            if (!client) return res.status(404).json({ success: false, message: "PPPoE not found" });
            const stations = await this.db.getStations(platformID);
            const stationRecord = stations.find((s) => s.mikrotikHost === client.station);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            const newStatus = client.status === "active" ? "inactive" : "active";
            if (!isRadius) {
                const connection = await this.config.createSingleMikrotikClient(platformID, client.station);
                if (!connection?.channel) return res.json({ success: false, message: `No valid MikroTik connection` });
                const { channel } = connection;
                try {
                    const secrets = await this.mikrotik.listSecrets(channel);
                    const secret = secrets.find((s) => s.name === client.clientname);
                    if (secret) {
                        await this.mikrotik.updateSecret(channel, secret[".id"], {
                            disabled: newStatus === "active" ? "no" : "yes",
                        });
                    }
                } finally {
                    await this.safeCloseChannel(channel);
                }
            }
            await this.db.updatePPPoE(id, { status: newStatus });
            return res.status(200).json({ success: true, message: `PPPoE ${newStatus} successfully` });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Internal server error", error: error.message });
        }
    }

    async updateMikrotikPPPoE(req, res) {
        const {
            station,
            clientname,
            clientpassword,
            profile,
            interface: interfaceName,
            name,
            pool,
            price,
            maxsessions,
            servicename,
            period,
            id,
            token,
            localaddress,
            DNSserver,
            speed,
            email,
            status,
            paymentLink,
            phone,
            customFields
        } = req.body;
        if (!token) return res.status(400).json({ success: false, message: "Missing authentication token" });
        if (!station || !clientname || !clientpassword || !servicename || !name) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }
        try {
            const allowedStatuses = new Set(["active", "inactive", "expired"]);
            const normalizedStatus = status ? String(status).toLowerCase() : null;
            if (normalizedStatus && !allowedStatuses.has(normalizedStatus)) {
                return res.status(400).json({ success: false, message: "Invalid PPPoE status" });
            }
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platform ID" });
            const client = id ? await this.db.getPPPoEById(id) : null;
            if (id && !client) {
                return res.status(404).json({ success: false, message: "PPPoE client not found" });
            }
            const stations = await this.db.getStations(platformID);
            const stationRecord = stations.find((s) => s.mikrotikHost === station);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            const effectiveStatus = normalizedStatus || String(client?.status || "active").toLowerCase();
            const connection = await this.config.createSingleMikrotikClient(platformID, station);
            if (!isRadius && !connection?.channel) return res.json({ success: false, message: `No valid MikroTik connection` });
            const { channel } = connection || {};
            const rateLimit = speed ? `${speed}M/${speed}M` : '';
            let pppoe_link = "";
            if (!paymentLink) pppoe_link = Math.random().toString(36).substring(2, 15);
            let thisprofile = profile && profile.trim() ? profile.trim() : name.trim();
            if (!isRadius) {
                try {
                    const matchedProfile = (await this.mikrotik.listPPPProfiles(channel)).find(p => p.name === thisprofile);
                    if (matchedProfile && id) {
                        const updates = { name: thisprofile };
                        if (localaddress) updates["local-address"] = localaddress;
                        if (pool) updates["remote-address"] = pool;
                        if (DNSserver) updates["dns-server"] = DNSserver;
                        if (rateLimit) updates["rate-limit"] = rateLimit;
                        await this.mikrotik.updatePPPProfile(channel, matchedProfile[".id"], updates);
                    } else if (!matchedProfile) {
                        await this.mikrotik.addPPPProfile(channel, { name: thisprofile, localAddress: localaddress, remoteAddress: pool, dnsServer: DNSserver, rateLimit: rateLimit });
                    }
                    const existingServers = await this.mikrotik.listPPPServers(channel);
                    const existingServer = existingServers.find(s => s['service-name'] === servicename);
                    let servername = servicename;
                    if (!existingServer) {
                        const newServer = { "service-name": servername, "interface": interfaceName, "authentication": "pap,chap,mschap1,mschap2", "max-sessions": maxsessions, "disabled": "no" };
                        await this.mikrotik.addPPPServer(channel, newServer);
                    } else {
                        if (id) {
                            const updates = {};
                            if (existingServer['service-name'] !== servername) updates['service-name'] = servername;
                            if (existingServer['interface'] !== interfaceName) updates['interface'] = interfaceName;
                            if (existingServer['disabled'] !== 'no') updates['disabled'] = 'no';
                            if (Object.keys(updates).length > 0) await this.mikrotik.updatePPPServer(channel, existingServer['.id'], updates);
                        }
                    }
                    const existingSecrets = await this.mikrotik.listSecrets(channel);
                    const lookupName = client?.clientname || clientname;
                    const existingSecret = existingSecrets.find(s => s.name === lookupName) || existingSecrets.find(s => s.name === clientname);
                    const isdisabled = effectiveStatus === "active" ? "no" : "yes";
                    if (existingSecret) {
                        if (!id) {
                            return res.status(500).json({ success: false, message: "PPPoE user already exists, create a new one!" });
                        } else {
                            const updates = { name: clientname, password: clientpassword, service: 'pppoe', profile: thisprofile, disabled: isdisabled };
                            await this.mikrotik.updateSecret(channel, existingSecret['.id'], updates);
                        }
                    } else {
                        const newSecret = { name: clientname, password: clientpassword, service: 'pppoe', profile: thisprofile, disabled: isdisabled };
                        await this.mikrotik.addSecret(channel, newSecret);
                    }
                } finally {
                    await this.safeCloseChannel(channel);
                }
            } else {
                if (client?.clientname && client.clientname !== clientname) {
                    await this.db.deleteRadiusUser(client.clientname);
                }
                const speedSource = thisprofile || name || "";
                const speedVal = String(speedSource).replace(/[^0-9.]/g, "");
                const rate = speedVal ? `${speedVal}M/${speedVal}M` : "";
                await this.db.upsertRadiusUser({
                    username: clientname,
                    password: clientpassword,
                    groupname: name,
                    rateLimit: rate,
                });
            }
            let expireAt = null;
            if (period) {
                const match = period.toLowerCase().match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
                if (match) {
                    const value = parseInt(match[1]);
                    const unit = match[2].toLowerCase();
                    const now = new Date();
                    if (!id) {
                        if (effectiveStatus === "active") {
                            expireAt = Utils.addPeriod(now, value, unit);
                        }
                    } else if (client) {
                        const wasActive = client.status === "active";
                        const isActive = effectiveStatus === "active";
                        if (!wasActive && isActive) {
                            expireAt = Utils.addPeriod(now, value, unit);
                        } else if (client.expiresAt) {
                            expireAt = new Date(client.expiresAt);
                        } else {
                            expireAt = null;
                        }
                    }
                }
            } else if (client?.expiresAt) {
                expireAt = new Date(client.expiresAt);
            }
            if (effectiveStatus === "expired") {
                expireAt = new Date();
            } else if (effectiveStatus === "inactive") {
                expireAt = null;
            }
            let newamount = "0";
            if (!id) {
                if (effectiveStatus === "active") newamount = "0";
                else newamount = Number(price).toString();
            } else {
                const existing = client.amount ? Number(client.amount) : 0;
                const oldPrice = client.price ? Number(client.price) : 0;
                const newPrice = Number(price);
                if (effectiveStatus === "active") newamount = "0";
                else {
                    if (existing === 0) newamount = newPrice.toString();
                    else {
                        if (newPrice !== oldPrice) {
                            const diff = newPrice - oldPrice;
                            const adjusted = existing + diff;
                            newamount = adjusted > 0 ? adjusted.toString() : "0";
                        } else {
                            newamount = existing.toString();
                        }
                    }
                }
            }
            let accountNumber = "";
            const config = await this.db.getPlatformConfig(platformID);
            if (config) {
                if (config.mpesaShortCodeType && (config.mpesaShortCodeType).toLowerCase() === "paybill") {
                    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                    accountNumber = Array.from({ length: 3 }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join('');
                }
            }
            const pppoeData = {
                name,
                profile: thisprofile,
                servicename,
                station: station,
                pool,
                platformID,
                devices: "100",
                price,
                period,
                clientname,
                clientpassword,
                interface: interfaceName,
                maxsessions,
                status: effectiveStatus,
                amount: newamount,
                paymentLink: paymentLink ? paymentLink : client?.paymentLink || pppoe_link,
                email,
                expiresAt: expireAt ? expireAt : null,
                phone,
                accountNumber,
                customFields: customFields ? customFields : {},
            };
            const dbOperation = id ? this.db.updatePPPoE(id, pppoeData) : this.db.createPPPoE(pppoeData);
            const result = await dbOperation;
            const platform = await this.db.getPlatform(platformID);
            const actualPaymentLink = paymentLink ? paymentLink : pppoe_link;
            if (email && !id) {
                const template = await this.db.getPlatformEmailTemplate(platformID);
                let message = '';
                const subject = `PPPoE Credentials from ${platform.name}!`;
                if (effectiveStatus === "active") {
                    template?.pppoeRegisterTemplate ? message = Utils.formatMessage(template?.pppoeRegisterTemplate, {
                        name: clientname,
                        password: clientpassword,
                        email: email,
                        company: platform.name,
                        package: name,
                        price: price,
                        amount: newamount,
                        expiry: expireAt ? expireAt : null,
                        paymentLink: `<a href="https://${platform.url}/pppoe?info=${actualPaymentLink}">https://${platform.url}/pppoe?info=${actualPaymentLink}</a>`,
                    }) : message = `<p>Your PPPoE credentials have been created by <strong>${platform.name}</strong>.</p><p><strong>-- PPPoE Credentials --</strong><br />Name: ${clientname}<br />Password: ${clientpassword}</p><p>For more status and information about this service, visit:<br /><a href="https://${platform.url}/pppoe?info=${actualPaymentLink}">https://${platform.url}/pppoe?info=${actualPaymentLink}</a></p>`;
                } else {
                    template?.pppoeInactiveTemplate ? message = Utils.formatMessage(template?.pppoeInactiveTemplate, {
                        name: clientname,
                        password: clientpassword,
                        email: email,
                        company: platform.name,
                        package: name,
                        price: price,
                        amount: newamount,
                        expiry: expireAt ? expireAt : null,
                        paymentLink: `<a href="https://${platform.url}/pppoe?info=${actualPaymentLink}">https://${platform.url}/pppoe?info=${actualPaymentLink}</a>`,
                    }) : message = `<p>Your PPPoE account is currently inactive.</p><p><strong>-- PPPoE Credentials --</strong><br />Name: ${clientname}<br />Password: ${clientpassword}</p><p>To activate your credentials, please pay KSH ${newamount} for your ${name} plan.<br />Visit <a href="https://${platform.url}/pppoe?info=${actualPaymentLink}">https://${platform.url}/pppoe?info=${actualPaymentLink}</a> to complete payment.</p>`;
                }
                const data = { name: email, type: "accounts", email: email, subject: subject, message: message, company: platform.name };
                const sendpppoeemail = await this.mailer.EmailTemplate(data);
                if (!sendpppoeemail.success) {
                    return res.status(200).json({ success: true, message: `PPPoE created successfully. ${sendpppoeemail.message}`, pppoe: result });
                }
            }
            if (phone && !id) {
                const platformConfig = await this.db.getPlatformConfig(platformID);
                if (platformConfig?.sms === true) {
                    const sms = await this.db.getPlatformSMS(platformID);
                    if (!sms) return { success: false, message: "SMS not found!" };
                    if (sms && sms.sentPPPoE === false) return { success: false, message: "PPPoE SMS sending is disabled!" };
                    if (Number(sms.balance) < Number(sms.costPerSMS)) return { success: false, message: "Insufficient SMS Balance!" };
                    const platform = await this.db.getPlatform(platformID);
                    if (!platform) return { success: false, message: "Platform not found!" };
                    let sms_message = ``;
                    if (effectiveStatus === "active") {
                        sms_message = Utils.formatMessage(sms.pppoeRegisterSMS, {
                            company: platform.name,
                            username: name,
                            period: period,
                            amount: newamount,
                            package: profile,
                            expiry: expireAt,
                            paymentLink: `https://${platform.url}/pppoe?info=${actualPaymentLink}`,
                        });
                    } else {
                        sms_message = Utils.formatMessage(sms.pppoeInactiveSMS, {
                            company: platform.name,
                            username: name,
                            period: period,
                            amount: newamount,
                            package: profile,
                            expiry: expireAt,
                            paymentLink: `https://${platform.url}/pppoe?info=${actualPaymentLink}`,
                        });
                    }
                    const is_send = await this.sms.sendSMS(phone, sms_message, sms);
                    if (is_send.success && sms?.default === true) {
                        const newSMSBalance = Number(sms.balance) - Number(sms.costPerSMS);
                        const newSMS = Math.floor(Number(sms.remainingSMS)) - 1;
                        await this.db.updatePlatformSMS(platformID, { balance: newSMSBalance.toString(), remainingSMS: newSMS.toString() });
                    }
                }
            }
            await this.pushDashboardStats(platformID);
            return res.json({ success: true, message: id ? "PPPoE updated successfully" : "PPPoE created successfully", pppoe: result });
        } catch (error) {
            return res.status(500).json({ success: false, message: "An error occured, try again!" });
        }
    }

    async deletePppoE(req, res) {
        const { id, token } = req.body;
        if (!token || !id) return res.status(400).json({ success: false, message: "Missing authentication token" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platform ID" });
            const platform = await this.db.getPlatform(platformID);
            if (!platform) return res.status(400).json({ success: false, message: "Platform does not exist!" });
            const client = await this.db.getPPPoEById(id);
            if (!client) return res.status(400).json({ success: false, message: "PPPoE does not exist!" });
            await this.db.deletePPPoE(id);
            this.cache.delPrefix(`main:pppoe:${platformID}:`);
            this.cache.delPrefix(`main:search:${platformID}:pppoe`);
            const stations = await this.db.getStations(platformID);
            const stationRecord = stations.find((s) => s.mikrotikHost === client.station);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            const clientname = client.clientname;
            if (!isRadius) {
                const connection = await this.config.createSingleMikrotikClient(platformID, client.station);
                if (!connection?.channel) return res.json({ success: false, message: `No valid MikroTik connection` });
                const { channel } = connection;
                try {
                    const secrets = await this.mikrotik.listSecrets(channel);
                    const secret = secrets.find(s => s.name === clientname);
                    if (secret) await this.mikrotik.deleteSecret(channel, secret['.id']);
                } finally {
                    await this.safeCloseChannel(channel);
                }
            } else {
                await this.db.deleteRadiusUser(clientname);
            }
            const email = client.email;
            const subject = `PPPoE Credentials deleted from ${platform.name}!`;
            const message = `<p>Your PPPoE credentials have been deleted by <strong>${platform.name}</strong>.</p><p><strong>-- PPPoE Credentials --</strong><br />Name: ${clientname}<br />Password: ${client.clientpassword}</p><p>For more status and information about this service, visit:<br /><a href="https://${platform.url}/pppoe?info=${client.paymentLink}">https://${platform.url}/pppoe?info=${client.paymentLink}</a></p>`;
            const data = { name: email, type: "accounts", email: email, subject: subject, message: message, company: platform.name };
            const sendpppoeemail = await this.mailer.EmailTemplate(data);
            await this.pushDashboardStats(platformID);
            return res.status(200).json({ success: true, message: `PPPoE deleted successfully${sendpppoeemail.success ? "" : `. ${sendpppoeemail.message}`}` });
        } catch (error) {
            return res.status(500).json({ success: false, message: "An error occurred, try again!" });
        }
    }

    async getHotspotDNSName(platformID, host) {
        try {
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return { success: false, message: "No valid MikroTik connection" };
            const { channel } = connection;
            try {
                const servers = await this.mikrotik.listHotspotServers(channel);
                if (!servers || servers.length === 0) return { success: false, message: "No hotspot servers found in your router!" };
                const profiles = await this.mikrotik.getHotspotProfiles(channel);
                if (!profiles || profiles.length === 0) return { success: false, message: "No hotspot profiles found in your router!" };
                let selectedProfileName;
                if (servers.length === 1) selectedProfileName = servers[0].profile;
                else {
                    const bridgeServer = servers.find(s => s.interface && s.interface.toLowerCase().includes("bridge"));
                    if (!bridgeServer) return { success: false, message: "No hotspot servers with bridge interface found in your router!" };
                    selectedProfileName = bridgeServer.profile;
                }
                const matchedProfile = profiles.find(p => p.name === selectedProfileName);
                if (!matchedProfile) return { success: false, message: "Profile not found for the hotspot server!" };
                return { success: true, message: "DNS name found", dns_name: matchedProfile["dns-name"] || null };
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (err) {
            return { success: false, message: "An error occurred, try again!" };
        }
    }

    formatMikrotikTime(mikrotikTime) {
        return mikrotikTime.replace(/d/, " days ").replace(/h/, " hours ").replace(/m/, " minutes ").replace(/s/, " seconds ");
    }

    generateCode(length = 6) {
        return crypto.randomBytes(length).toString("hex").slice(0, length).toUpperCase();
    }

    async mikrotikConnections(req, res) {
        const { token } = req.body;
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            const result = await this.config.createMikrotikClient(token);
            return res.json({ success: true, message: "Connections found!", result });
        } catch (error) {
            return res.json({ success: false, message: "Failed to connect to MikroTik routers!" });
        }
    }

    async debugMikrotikConnections(req, res) {
        const { token, stationId } = req.body || {};
        if (!token) {
            return res.status(400).json({ success: false, message: "Missing token" });
        }
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            const stations = await this.db.getMikrotikPlatformConfig(platformID);
            const targetStations = stationId
                ? stations.filter((s) => s.id === stationId)
                : stations;

            const hostCounts = new Map();
            targetStations.forEach((s) => {
                if (!s.mikrotikHost) return;
                hostCounts.set(s.mikrotikHost, (hostCounts.get(s.mikrotikHost) || 0) + 1);
            });

            const results = await Promise.all(
                targetStations.map(async (station) => {
                    const issues = [];
                    const fixes = [];
                    const warnings = [];
                    const { id, mikrotikHost, mikrotikUser, mikrotikPassword } = station;

                    if (!mikrotikHost || !mikrotikUser || !mikrotikPassword) {
                        issues.push("missing_credentials");
                        return { id, host: mikrotikHost, status: "Failed", message: "Missing credentials", issues, fixes, warnings };
                    }

                    if ((hostCounts.get(mikrotikHost) || 0) > 1) {
                        warnings.push("ip_conflict");
                    }

                    const connection = await this.config.createSingleMikrotikClient(platformID, mikrotikHost);
                    if (!connection?.channel) {
                        issues.push("connection_failed");
                        return { id, host: mikrotikHost, status: "Offline", message: "Link down or connection failed", issues, fixes, warnings };
                    }

                    const { channel } = connection;
                    try {
                        const ensureResult = await this.ensureRouterBasics(channel, mikrotikHost);
                        issues.push(...ensureResult.issues);
                        fixes.push(...ensureResult.fixes);

                        const pingOk = await this.pingInternal(channel);
                        if (!pingOk) {
                            issues.push("link_down");
                            return { id, host: mikrotikHost, status: "Offline", message: "Link down", issues, fixes, warnings };
                        }

                        return { id, host: mikrotikHost, status: "Connected", message: "OK", issues, fixes, warnings };
                    } catch (err) {
                        issues.push("debug_failed");
                        return { id, host: mikrotikHost, status: "Failed", message: err.message || "Debug failed", issues, fixes, warnings };
                    } finally {
                        await this.safeCloseChannel(channel);
                    }
                })
            );

            return res.json({ success: true, message: "Debug complete", result: results });
        } catch (error) {
            return res.json({ success: false, message: "Failed to debug routers" });
        }
    }

    async ensureRouterBasics(channel, mikrotikHost) {
        const issues = [];
        const fixes = [];
        try {
            const domain = process.env.DOMAIN || "novawifi.co.ke";
            const serverIp = (process.env.SERVER_IP || "77.37.97.244").toString().split(":")[0];
            const serverWgPublicKey = process.env.WIREGUARD_PUBLIC_KEY || "Pn1mfAY8NCdzkdxjZL8kMXAzMNOIbEuyHTPqqI1zdRA=";
            const wireguards = await channel.write("/interface/wireguard/print", []);
            let wg = wireguards.find((w) => w.name === "wireguard") || wireguards[0];
            if (!wg) {
                await channel.write("/interface/wireguard/add", [
                    "=listen-port=13231",
                    "=mtu=1420",
                    "=name=wireguard",
                ]);
                fixes.push("wireguard_added");
                const updated = await channel.write("/interface/wireguard/print", []);
                wg = updated.find((w) => w.name === "wireguard") || updated[0];
            }

            if (wg?.name) {
                const addresses = await channel.write("/ip/address/print", []);
                const hasAddress = addresses.some((a) => String(a.address || "").startsWith(`${mikrotikHost}/`));
                if (!hasAddress) {
                    await channel.write("/ip/address/add", [
                        `=address=${mikrotikHost}/24`,
                        `=interface=${wg.name}`,
                    ]);
                    fixes.push("wireguard_address_added");
                }

                const peers = await channel.write("/interface/wireguard/peers/print", []);
                const peerExists = peers.some(
                    (p) =>
                        p["endpoint-address"] === serverIp ||
                        p["public-key"] === serverWgPublicKey
                );
                if (!peerExists) {
                    await channel.write("/interface/wireguard/peers/add", [
                        `=interface=${wg.name}`,
                        `=name=novapeer`,
                        `=public-key=${serverWgPublicKey}`,
                        `=endpoint-address=${serverIp}`,
                        `=endpoint-port=51820`,
                        `=allowed-address=10.10.10.1/32`,
                        `=persistent-keepalive=10`,
                    ]);
                    fixes.push("wireguard_peer_added");
                }
            }

            const services = await channel.write("/ip/service/print", ["?name=api"]);
            const apiService = services?.[0];
            if (apiService) {
                const address = String(apiService.address || "");
                if (!address.includes("10.10.10.0/24")) {
                    await channel.write("/ip/service/set", [
                        `=.id=${apiService[".id"]}`,
                        "=address=10.10.10.0/24",
                    ]);
                    fixes.push("api_allowed");
                }
            }

            const firewall = await channel.write("/ip/firewall/filter/print", []);
            const hasApiRule = firewall.some(
                (r) =>
                    r.chain === "input" &&
                    r["src-address"] === "10.10.10.0/24" &&
                    r.protocol === "tcp" &&
                    String(r["dst-port"] || "").includes("8728")
            );
            if (!hasApiRule) {
                await channel.write("/ip/firewall/filter/add", [
                    "=chain=input",
                    "=src-address=10.10.10.0/24",
                    "=protocol=tcp",
                    "=dst-port=8728",
                    "=action=accept",
                    `=comment=Allow API from WireGuard`,
                ]);
                fixes.push("firewall_api_rule_added");
            }

            const hasUdpRule = firewall.some(
                (r) =>
                    r.chain === "input" &&
                    r.protocol === "udp" &&
                    String(r["dst-port"] || "").includes("13231")
            );
            if (!hasUdpRule) {
                await channel.write("/ip/firewall/filter/add", [
                    "=chain=input",
                    "=protocol=udp",
                    "=dst-port=13231",
                    "=action=accept",
                ]);
                fixes.push("firewall_udp_rule_added");
            }

            const hasSubnetRule = firewall.some(
                (r) => r.chain === "input" && r["src-address"] === "10.10.10.0/24"
            );
            if (!hasSubnetRule) {
                await channel.write("/ip/firewall/filter/add", [
                    "=chain=input",
                    "=src-address=10.10.10.0/24",
                    "=action=accept",
                ]);
                fixes.push("firewall_subnet_rule_added");
            }

            const wgGarden = await channel.write("/ip/hotspot/walled-garden/print", []);
            const hasNova = wgGarden.some((g) => g["dst-host"] === domain);
            const hasWildcard = wgGarden.some((g) => g["dst-host"] === `*.${domain}`);
            const hasIpify = wgGarden.some((g) => g["dst-host"] === "api64.ipify.org");
            if (!hasNova) {
                await channel.write("/ip/hotspot/walled-garden/add", [
                    `=dst-host=${domain}`,
                    "=action=allow",
                ]);
                fixes.push("walled_garden_nova_added");
            }
            if (!hasWildcard) {
                await channel.write("/ip/hotspot/walled-garden/add", [
                    `=dst-host=*.${domain}`,
                    "=action=allow",
                ]);
                fixes.push("walled_garden_wildcard_added");
            }
            if (!hasIpify) {
                await channel.write("/ip/hotspot/walled-garden/add", [
                    "=dst-host=api64.ipify.org",
                    "=action=allow",
                ]);
                fixes.push("walled_garden_ipify_added");
            }

            const dns = await channel.write("/ip/dns/print", []);
            const dnsRow = dns?.[0];
            if (dnsRow) {
                const servers = String(dnsRow.servers || "");
                if (!servers || servers.trim().length === 0) {
                    await channel.write("/ip/dns/set", [
                        `=.id=${dnsRow[".id"]}`,
                        "=servers=8.8.8.8,1.1.1.1",
                        "=allow-remote-requests=yes",
                    ]);
                    fixes.push("dns_servers_set");
                }
            }
        } catch (err) {
            issues.push("config_check_failed");
        }

        return { issues, fixes };
    }

    async pingInternal(channel) {
        try {
            const result = await channel.write("/ping", [
                "=address=10.10.10.1",
                "=count=2",
            ]);
            return Array.isArray(result) && result.length > 0;
        } catch {
            return false;
        }
    }

    async checkHotspotUserStatus(platformID, host) {
        try {
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return { success: false, message: "No valid MikroTik connection" };
            const { channel } = connection;
            try {
                const activeUsers = await this.mikrotik.listHotspotActiveUsers(channel);
                return { success: true, users: activeUsers || [] };
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (err) {
            return { success: false, reason: err.message, users: [] };
        }
    }

    async checkPPPUserStatus(platformID, host) {
        try {
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return { success: false, message: "No valid MikroTik connection" };
            const { channel } = connection;
            try {
                const activeUsers = await this.mikrotik.listPPPActiveUsers(channel);
                return { success: true, users: activeUsers || [] };
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (err) {
            return { success: false, reason: err.message, users: [] };
        }
    }

    async updateMikrotikUser(req, res) {
        const { token, userData } = req.body;
        const { id, new_username, username, phone, profile, packageID, status } = userData || {};
        if (!token || !userData || !id || !packageID || !profile) return res.json({ success: false, message: "Token, userData, ID, packageID, and profile are required" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            const pkg = await this.db.getPackage(packageID);
            const host = pkg.routerHost;
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return { success: false, message: "No valid MikroTik connection" };
            const { channel } = connection;
            try {
                const profiles = await this.mikrotik.listHotspotProfiles(channel);
                const existingProfiles = profiles.filter(p => p.name === profile);
                if (existingProfiles.length === 0) return res.json({ success: false, message: `Profile '${profile}' not found` });
                const users = await this.mikrotik.listHotspotUsers(channel);
                let existingUser = users.find(u => u.name === username);
                if (!existingUser && status?.toLowerCase() === "active") {
                    const newuser = { platformID, action: "add", profileName: profile, host, username, code: username };
                    const isadded = await this.manageMikrotikUser(newuser);
                    if (!isadded.success) return res.json({ success: false, message: isadded.message });
                } else {
                    await this.mikrotik.updateHotspotUser(channel, existingUser[".id"], { name: new_username || username, profile: profile });
                    const activeUsers = await this.mikrotik.listHotspotActiveUsers(channel);
                    const activeUser = activeUsers.find(u => u.name === username);
                    if (activeUser && activeUser[".id"]) await this.mikrotik.deleteHotspotActiveUser(channel, activeUser[".id"]);
                }
            } finally {
                await this.safeCloseChannel(channel);
            }
            const user = await this.db.getUserByUsername(username);
            if (!user) return res.json({ success: false, message: `User '${username}' not found in database` });
            await this.db.updateUser(user.id, { username: new_username, password: new_username, code: new_username, phone: phone, status });
            return res.json({ success: true, message: "User updated successfully" });
        } catch (error) {
            return res.json({ success: false, message: "An error occurred, try again!", error });
        }
    }

    async autoConfigurePPPoE(req, res) {
        const { station, token } = req.body;
        if (!token) return res.status(400).json({ success: false, message: "Missing authentication token" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success || auth.admin.role !== "superuser") return res.status(401).json({ success: false, message: "Unauthorized!" });
            const platformID = auth.admin.platformID;
            const stationRecord = await this.db.getStations(platformID).then((stations) =>
                stations.find((s) => s.mikrotikHost === station)
            );
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            if (isRadius) {
                const radiusServerIp = stationRecord?.radiusServerIp || (process.env.RADIUS_SERVER_IP || process.env.SERVER_IP || "").toString().split(":")[0];
                const radiusSecret = stationRecord?.radiusClientSecret;
                if (!radiusServerIp || !radiusSecret) {
                    return res.status(400).json({
                        success: false,
                        message: "Missing RADIUS server IP or client secret for this station."
                    });
                }
            }
            const connection = await this.config.createSingleMikrotikClient(platformID, station);
            if (!connection?.channel) return res.json({ success: false, message: "No valid MikroTik connection" });
            const { channel } = connection;
            try {
                const interfaces = await this.mikrotik.listInterfaces(channel);
                let bridgeInterface = interfaces.find(i => i.type === "bridge")?.name;
                if (!bridgeInterface && interfaces.length > 0) bridgeInterface = interfaces[0].name;
                const profiles = await this.mikrotik.listPPPProfiles(channel);
                const speeds = [5, 8, 10, 15, 20];
                for (let speed of speeds) {
                    const profileName = `${speed}MBPS`;
                    if (!profiles.find(p => p.name === profileName)) {
                        if (isRadius) {
                            await this.mikrotik.addPPPProfile(channel, {
                                name: profileName,
                                localAddress: "41.41.0.1",
                                remoteAddress: "PPPoE_Pool",
                                dnsServer: "1.1.1.1",
                                rateLimit: `${speed}M/${speed}M`
                            });
                        } else {
                            await this.mikrotik.addPPPProfile(channel, {
                                name: profileName,
                                localAddress: "41.41.0.1",
                                remoteAddress: "PPPoE_Pool",
                                dnsServer: "1.1.1.1",
                                rateLimit: `${speed}M/${speed}M`
                            });
                        }
                    }
                }
                let poolName = "";
                if (isRadius) {
                    const radiusServerIp = stationRecord?.radiusServerIp || (process.env.RADIUS_SERVER_IP || process.env.SERVER_IP || "").toString().split(":")[0];
                    const radiusSecret = stationRecord?.radiusClientSecret;
                    if (radiusServerIp && radiusSecret) {
                        const radiusEntries = await channel.write("/radius/print", []);
                        const matchingRadius = Array.isArray(radiusEntries)
                            ? radiusEntries.find((r) =>
                                String(r.address || "") === radiusServerIp &&
                                String(r.service || "").toLowerCase().includes("ppp")
                            )
                            : null;
                        if (matchingRadius) {
                            if (String(matchingRadius.secret || "") !== radiusSecret && matchingRadius[".id"]) {
                                await channel.write("/radius/set", [
                                    `=.id=${matchingRadius[".id"]}`,
                                    `=secret=${radiusSecret}`,
                                ]);
                            }
                        } else {
                            await channel.write("/radius/add", [
                                `=address=${radiusServerIp}`,
                                `=secret=${radiusSecret}`,
                                `=service=ppp`,
                                `=timeout=300ms`,
                            ]);
                        }
                        await channel.write("/radius/incoming/set", ["=accept=yes"]);
                        await channel.write("/ppp/aaa/set", ["=use-radius=yes"]);
                        const refreshedProfiles = await this.mikrotik.listPPPProfiles(channel);
                        for (const profile of refreshedProfiles) {
                            if (String(profile?.name || "").match(/^\d+MBPS$/) && profile[".id"]) {
                                await this.mikrotik.updatePPPProfile(channel, profile[".id"], { "use-radius": "yes" });
                            }
                        }
                    }
                } else {
                    poolName = "PPPoE_Pool";
                    const pools = await this.mikrotik.listPools(channel);
                    if (pools.find(p => p.name === poolName)) {
                        let i = 1;
                        while (pools.find(p => p.name === `${poolName}_${i}`)) i++;
                        poolName = `${poolName}_${i}`;
                    }
                    await this.mikrotik.addIPAddress(channel, { address: "41.41.0.1/16", network: "41.41.0.0", intf: bridgeInterface, comment: "PPPoE Auto Configuration Gateway" });
                    await this.mikrotik.addPool(channel, { name: poolName, ranges: "41.41.0.2-41.41.255.254", comment: "PPPoE Auto Configuration Pool" });
                    const refreshedProfiles = await this.mikrotik.listPPPProfiles(channel);
                    for (const profile of refreshedProfiles) {
                        if (String(profile?.name || "").match(/^\d+MBPS$/) && profile[".id"]) {
                            await this.mikrotik.updatePPPProfile(channel, profile[".id"], { "remote-address": poolName });
                        }
                    }
                }
                const existingServers = await this.mikrotik.listPPPServers(channel);
                let servername = "PPPoE_Server";
                const desiredAuth = "pap,chap,mschap1,mschap2";
                let matchedServer = existingServers.find(
                    (s) => s["service-name"] === servername && String(s.interface || "") === String(bridgeInterface || "")
                );
                if (!matchedServer) {
                    matchedServer = existingServers.find(
                        (s) =>
                            String(s["service-name"] || "").startsWith("PPPoE_Server") &&
                            String(s.interface || "") === String(bridgeInterface || "")
                    );
                }
                if (matchedServer?.["service-name"]) {
                    servername = matchedServer["service-name"];
                    if (matchedServer[".id"]) {
                        const updates = {};
                        if (String(matchedServer.authentication || "") !== desiredAuth) {
                            updates["authentication"] = desiredAuth;
                        }
                        if (String(matchedServer.disabled || "") === "yes") {
                            updates["disabled"] = "no";
                        }
                        if (Object.keys(updates).length > 0) {
                            await this.mikrotik.updatePPPServer(channel, matchedServer[".id"], updates);
                        }
                    }
                } else {
                    let counter = 1;
                    while (existingServers.find(s => s['service-name'] === servername)) {
                        servername = `${"PPPoE_Server"}_${counter}`;
                        counter++;
                    }
                    const newServer = { "service-name": servername, "interface": bridgeInterface, "authentication": desiredAuth, "disabled": "no" };
                    await this.mikrotik.addPPPServer(channel, newServer);
                }
                if (!isRadius) {
                    await this.mikrotik.addFirewallNatRule(channel, { chain: "srcnat", action: "masquerade", srcAddress: "41.41.0.0/16", comment: "Masquerade pppoe network", outInterface: "" });
                }
                const existingPlans = await this.db.getPPPoEPlans(platformID);
                const stationPlans = Array.isArray(existingPlans)
                    ? existingPlans.filter((plan) => plan.station === station)
                    : [];
                const createdPlans = [];

                for (const speed of speeds) {
                    const profileName = `${speed}MBPS`;
                    const exists = stationPlans.find((plan) => plan.name === profileName);
                    if (exists) continue;
                    const price = String(speed);
                    const created = await this.db.createPPPoEPlan({
                        platformID,
                        station,
                        name: profileName,
                        profile: profileName,
                        servicename: servername,
                        pool: isRadius ? "" : poolName,
                        price,
                        period: "30 days",
                        status: "active",
                    });
                    if (created) createdPlans.push(created);
                }

                return res.json({
                    success: true,
                    message: "PPPoE Auto Configuration completed successfully",
                    profiles: speeds.map(s => `${s}MBPS`),
                    server: servername,
                    plansCreated: createdPlans.length
                });
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "An error occurred during PPPoE auto configuration" });
        }
    }

    async isPPPoEAutoConfigured(req, res) {
        const { station, token } = req.body;
        if (!token) return res.status(400).json({ success: false, message: "Missing authentication token" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success || auth.admin.role !== "superuser") return res.status(401).json({ success: false, message: "Unauthorized!" });
            const platformID = auth.admin.platformID;
            const stationRecord = await this.db.getStations(platformID).then((stations) =>
                stations.find((s) => s.mikrotikHost === station)
            );
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            const connection = await this.config.createSingleMikrotikClient(platformID, station);
            if (!connection?.channel) return res.json({ success: false, message: "No valid MikroTik connection" });
            const { channel } = connection;
            try {
                let poolName = null;
                if (!isRadius) {
                    const pools = await this.mikrotik.listPools(channel);
                    const base = "PPPoE_Pool";
                    if (pools.find((p) => p.name === base)) {
                        poolName = base;
                    } else {
                        let i = 1;
                        while (pools.find((p) => p.name === `${base}_${i}`)) {
                            poolName = `${base}_${i}`;
                            i++;
                        }
                    }
                }

                const speeds = [5, 8, 10, 15, 20];
                const profiles = await this.mikrotik.listPPPProfiles(channel);
                for (let speed of speeds) {
                    const profileName = `${speed}MBPS`;
                    const profile = profiles.find(p => p.name === profileName);
                    if (!profile) return res.json({ autoconfigured: false, message: `Profile ${profileName} not found` });
                    if (!isRadius && poolName) {
                        if (profile["remote-address"] !== poolName) {
                            return res.json({ autoconfigured: false, message: `Profile ${profileName} not linked to ${poolName}` });
                        }
                    }
                }
                const servers = await this.mikrotik.listPPPServers(channel);
                let serverName = null;
                if (servers.find(s => s["service-name"] === "PPPoE_Server")) serverName = "PPPoE_Server";
                else {
                    let i = 1;
                    while (servers.find(s => s["service-name"] === `PPPoE_Server_${i}`)) {
                        serverName = `PPPoE_Server_${i}`;
                        i++;
                    }
                }
                if (!serverName) return res.json({ autoconfigured: false, message: "No PPPoE Server found" });
                const matchedServer = servers.find(s => s["service-name"] === serverName);
                if (!matchedServer) return res.json({ autoconfigured: false, message: "PPPoE Server configuration mismatch" });
                if (isRadius) {
                    const radiusServerIp = stationRecord?.radiusServerIp || (process.env.RADIUS_SERVER_IP || process.env.SERVER_IP || "").toString().split(":")[0];
                    const radiusSecret = stationRecord?.radiusClientSecret;
                    if (!radiusServerIp || !radiusSecret) {
                        return res.json({ autoconfigured: false, message: "Missing RADIUS credentials for this station." });
                    }
                    const radiusEntries = await channel.write("/radius/print", []);
                    const matchingRadius = Array.isArray(radiusEntries)
                        ? radiusEntries.find((r) =>
                            String(r.address || "") === radiusServerIp &&
                            String(r.secret || "") === radiusSecret &&
                            String(r.service || "").toLowerCase().includes("ppp")
                        )
                        : null;
                    if (!matchingRadius) {
                        return res.json({ autoconfigured: false, message: "RADIUS entry not configured for PPPoE." });
                    }
                    const incoming = await channel.write("/radius/incoming/print", []);
                    const incomingAccept = Array.isArray(incoming)
                        ? incoming.find((i) => String(i.accept || "").toLowerCase() === "yes")
                        : null;
                    if (!incomingAccept) {
                        return res.json({ autoconfigured: false, message: "RADIUS incoming requests are not enabled." });
                    }
                    const aaa = await channel.write("/ppp/aaa/print", []);
                    const useRadius = Array.isArray(aaa)
                        ? aaa.find((a) => String(a["use-radius"] || "").toLowerCase() === "yes")
                        : null;
                    if (!useRadius) {
                        return res.json({ autoconfigured: false, message: "PPPoE AAA is not set to use RADIUS." });
                    }
                } else {
                    if (!poolName) {
                        return res.json({ autoconfigured: false, message: "No valid PPPoE Pool found" });
                    }
                    const pools = await this.mikrotik.listPools(channel);
                    const pool = pools.find((p) => p.name === poolName);
                    if (pool && pool["ranges"] !== "41.41.0.2-41.41.255.254") {
                        return res.json({ autoconfigured: false, message: "Pool address configuration mismatch" });
                    }
                }
                return res.json({ autoconfigured: true, message: "PPPoE auto configuration verified successfully", server: serverName, profiles: speeds.map(s => `${s}MBPS`) });
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (err) {
            return res.json({ autoconfigured: false, message: "Error checking PPPoE auto configuration" });
        }
    }

    async autoConfigureHotspot(req, res) {
        const { station, token } = req.body;
        if (!token) return res.status(400).json({ success: false, message: "Missing authentication token" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success || auth.admin.role !== "superuser") return res.status(401).json({ success: false, message: "Unauthorized!" });
            const platformID = auth.admin.platformID;
            const connection = await this.config.createSingleMikrotikClient(platformID, station);
            if (!connection?.channel) return res.json({ success: false, message: "No valid MikroTik connection" });
            const { channel } = connection;
            try {
                const sessionTimeout = "1d";
                const loginBy = "http-chap,http-pap,mac-cookie";
                const stationRecord = await this.db.getStations(platformID).then((stations) =>
                    stations.find((s) => s.mikrotikHost === station)
                );
                const isRadius = stationRecord?.systemBasis === "RADIUS";
                const poolName = "Hotspot_Pool";
                const dhcpName = "hotspot_dhcp";
                const hotspotAddress = "41.42.0.1/16";
                const hotspotNetwork = "41.42.0.0/16";
                const hotspotRange = "41.42.0.2-41.42.255.254";

                const interfaces = await this.mikrotik.listInterfaces(channel);
                let bridgeInterface = interfaces.find(i => i.type === "bridge")?.name;
                if (!bridgeInterface) {
                    bridgeInterface = "bridge-hotspot";
                    await channel.write("/interface/bridge/add", [`=name=${bridgeInterface}`]);
                }

                for (const intf of interfaces) {
                    const name = String(intf.name || "");
                    const type = String(intf.type || "").toLowerCase();
                    if (!name) continue;
                    if (!(type === "wlan" || type === "wifi" || name.startsWith("wlan"))) continue;
                    try {
                        await channel.write("/interface/wireless/set", [
                            `=.id=${name}`,
                            "=disabled=no",
                            "=mode=ap-bridge",
                        ]);
                    } catch {
                        // Ignore if wireless package not present or interface is not a wireless type
                    }
                }

                const existingBridgePorts = await channel.write("/interface/bridge/port/print", []);
                const existingPortNames = new Set(
                    (Array.isArray(existingBridgePorts) ? existingBridgePorts : [])
                        .map((p) => String(p.interface || "").trim())
                        .filter(Boolean)
                );

                const candidatePorts = interfaces.filter((i) => {
                    const name = String(i.name || "").trim();
                    const type = String(i.type || "").toLowerCase();
                    if (!name) return false;
                    if (name.toLowerCase() === "ether1") return false;
                    if (type === "bridge") return false;
                    // Prefer physical ports + WLAN for hotspot
                    if (type && !["ether", "wlan", "wifi"].includes(type)) return false;
                    return true;
                });

                for (const port of candidatePorts) {
                    if (existingPortNames.has(port.name)) continue;
                    await channel.write("/interface/bridge/port/add", [
                        `=bridge=${bridgeInterface}`,
                        `=interface=${port.name}`,
                    ]);
                }

                // Remove duplicates before adding new config
                const existingPools = await channel.write("/ip/pool/print", [`?name=${poolName}`]);
                if (Array.isArray(existingPools) && existingPools.length > 0) {
                    for (const pool of existingPools) {
                        if (pool[".id"]) {
                            await channel.write("/ip/pool/remove", [`=.id=${pool[".id"]}`]);
                        }
                    }
                }
                const existingAddresses = await channel.write("/ip/address/print", [`?address=${hotspotAddress}`]);
                if (Array.isArray(existingAddresses) && existingAddresses.length > 0) {
                    for (const addr of existingAddresses) {
                        if (addr[".id"]) {
                            await channel.write("/ip/address/remove", [`=.id=${addr[".id"]}`]);
                        }
                    }
                }
                const existingDhcp = await channel.write("/ip/dhcp-server/print", [`?name=${dhcpName}`]);
                if (Array.isArray(existingDhcp) && existingDhcp.length > 0) {
                    for (const srv of existingDhcp) {
                        if (srv[".id"]) {
                            await channel.write("/ip/dhcp-server/remove", [`=.id=${srv[".id"]}`]);
                        }
                    }
                }
                const existingNetworks = await channel.write("/ip/dhcp-server/network/print", [`?address=${hotspotNetwork}`]);
                if (Array.isArray(existingNetworks) && existingNetworks.length > 0) {
                    for (const net of existingNetworks) {
                        if (net[".id"]) {
                            await channel.write("/ip/dhcp-server/network/remove", [`=.id=${net[".id"]}`]);
                        }
                    }
                }

                await this.mikrotik.addPool(channel, { name: poolName, ranges: hotspotRange, comment: "Hotspot Auto Configuration Pool" });
                await this.mikrotik.addIPAddress(channel, { address: hotspotAddress, network: "41.42.0.0", comment: "Hotspot Network", intf: bridgeInterface });
                await channel.write("/ip/dhcp-server/add", [
                    `=name=${dhcpName}`,
                    `=interface=${bridgeInterface}`,
                    `=address-pool=${poolName}`,
                    `=disabled=no`,
                ]);
                await channel.write("/ip/dhcp-server/network/add", [
                    `=address=${hotspotNetwork}`,
                    `=gateway=41.42.0.1`,
                    `=dns-server=8.8.8.8,1.1.1.1`,
                ]);
                await this.mikrotik.addFirewallNatRule(channel, { chain: "srcnat", action: "masquerade", srcAddress: "41.42.0.0/16", comment: "Masquerade Hotspot network", outInterface: "" });
                const profiles = await this.mikrotik.getHotspotProfiles(channel);
                let profileName = "hotspotprofile1";
                const existingProfile = profiles.find(p => p.name === profileName);
                if (!existingProfile) {
                    try {
                        await this.mikrotik.addHotspotServerProfile(channel, {
                            name: profileName,
                            hotspotAddress: "41.42.0.1",
                            dnsName: "local.wifi",
                            smtpServer: "0.0.0.0",
                            folder: "hotspot",
                            loginBy,
                        });
                    } catch (profileErr) {
                        if (String(profileErr?.message || "").toLowerCase().includes("mac-cookie")) {
                            await this.mikrotik.addHotspotServerProfile(channel, {
                                name: profileName,
                                hotspotAddress: "41.42.0.1",
                                dnsName: "local.wifi",
                                smtpServer: "0.0.0.0",
                                folder: "hotspot",
                                loginBy,
                            });
                        } else {
                            throw profileErr;
                        }
                    }
                } else {
                    try {
                        await this.mikrotik.updateHotspotServerProfile(channel, existingProfile[".id"], {
                            "login-by": loginBy,
                            "mac-cookie-timeout": sessionTimeout,
                            "mac-cookie": "yes",
                        });
                    } catch (profileErr) {
                        if (String(profileErr?.message || "").toLowerCase().includes("mac-cookie")) {
                            await this.mikrotik.updateHotspotServerProfile(channel, existingProfile[".id"], {
                                "login-by": loginBy,
                                "mac-cookie-timeout": sessionTimeout,
                            });
                        } else {
                            throw profileErr;
                        }
                    }
                }
                const servers = await this.mikrotik.listHotspotServers(channel);
                let serverName = "Hotspot_Server";
                let counter = 1;
                while (servers.find(s => s.name === serverName)) {
                    serverName = `Hotspot_Server_${counter}`;
                    counter++;
                }
                await this.mikrotik.addHotspotServer(channel, { name: serverName, intf: bridgeInterface, profile: profileName, addressPool: poolName });

                if (isRadius && stationRecord?.radiusClientSecret) {
                    const radiusServerIp = stationRecord.radiusServerIp || (process.env.RADIUS_SERVER_IP || process.env.SERVER_IP || "").toString().split(":")[0];
                    if (radiusServerIp) {
                        const radiusEntries = await channel.write("/radius/print", []);
                        const hasRadius = Array.isArray(radiusEntries)
                            ? radiusEntries.find((r) =>
                                String(r.address || "") === radiusServerIp &&
                                String(r.secret || "") === stationRecord.radiusClientSecret &&
                                String(r.service || "").toLowerCase().includes("hotspot")
                            )
                            : null;
                        if (!hasRadius) {
                            await channel.write("/radius/add", [
                                `=address=${radiusServerIp}`,
                                `=secret=${stationRecord.radiusClientSecret}`,
                                `=service=hotspot`,
                                `=timeout=300ms`,
                            ]);
                        }
                        await channel.write("/radius/incoming/set", ["=accept=yes"]);
                        const refreshedProfiles = await this.mikrotik.getHotspotProfiles(channel);
                        const targetProfile = refreshedProfiles.find((p) => p.name === profileName);
                        if (targetProfile && targetProfile[".id"]) {
                            await this.mikrotik.updateHotspotServerProfile(channel, targetProfile[".id"], {
                                "use-radius": "yes",
                            });
                        }
                    }
                }

                let uploadError = null;
                try {
                    const platform = await this.db.getPlatform(platformID);
                    const domain = process.env.DOMAIN || "novawifi.co.ke";
                    const platformUrl = platform?.url ? `https://${platform.url}` : `https://${domain}`;
                    let hotspotHash = "";
                    try {
                        const host = stationRecord?.mikrotikHost || "";
                        if (Utils.isValidIP(host) && host.startsWith("10.10.10.")) {
                            hotspotHash = Utils.hashInternalIP(host);
                        }
                    } catch (err) {
                        hotspotHash = "";
                    }
                    const hashParam = hotspotHash ? encodeURIComponent(hotspotHash) : "";
                    const loginRedirect = hotspotHash
                        ? `${platformUrl}/login?hash=${hashParam}&mac=$(mac)`
                        : `${platformUrl}/login?mac=$(mac)`;
                    const loginHtml = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
   "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta http-equiv="pragma" content="no-cache" />
<meta http-equiv="expires" content="-1" />
<meta name="viewport" content="width=device-width; initial-scale=1.0; maximum-scale=1.0;"/>
<title>Logging in...</title>
</head>

<body onload="autoLogin()">
<script type="text/javascript" src="/md5.js"></script>
<script type="text/javascript">
    function autoLogin() {
        const urlParams = new URLSearchParams(window.location.search);
        const username = urlParams.get('username');
        const password = urlParams.get('password');

        if (username && password) {
            const form = document.createElement('form');
            form.action = "$(link-login-only)";
            form.method = 'post';

            const inputUsername = document.createElement('input');
            inputUsername.type = 'hidden';
            inputUsername.name = 'username';
            inputUsername.value = username;
            form.appendChild(inputUsername);

            const inputPassword = document.createElement('input');
            inputPassword.type = 'hidden';
            inputPassword.name = 'password';
            inputPassword.value = hexMD5('$(chap-id)' + password + '$(chap-challenge)');
            form.appendChild(inputPassword);

            const inputDst = document.createElement('input');
            inputDst.type = 'hidden';
            inputDst.name = 'dst';
            inputDst.value = "$(link-orig)";
            form.appendChild(inputDst);

            const inputPopup = document.createElement('input');
            inputPopup.type = 'hidden';
            inputPopup.name = 'popup';
            inputPopup.value = 'true';
            form.appendChild(inputPopup);

            document.body.appendChild(form);
            form.submit();
        } else {
            window.location.href = "${loginRedirect}";
        }
    }
</script>

</body>
</html>
                    `;
                    const apiConnection = await this.config.createSingleMikrotikClientAPI(platformID, station);
                    if (!apiConnection?.api) {
                        uploadError = "Failed to open low-level API connection";
                    } else {
                        let rawChannel = null;
                        try {
                            await apiConnection.api.connect();
                            const rawApi = apiConnection.api.api().rosApi;
                            rawChannel = await rawApi.openChannel();
                            const existingFiles = await rawChannel.write(["/file/print", `?name=hotspot/login.html`]);
                            if (Array.isArray(existingFiles) && existingFiles.length > 0) {
                                await rawChannel.write([
                                    "/file/set",
                                    `=.id=${existingFiles[0][".id"]}`,
                                    `=contents=${loginHtml}`,
                                ]);
                            } else {
                                await rawChannel.write([
                                    "/file/add",
                                    "=name=hotspot/login.html",
                                    `=contents=${loginHtml}`,
                                ]);
                            }
                        } finally {
                            try { await rawChannel?.close(); } catch (err) { }
                            try { await apiConnection.api.close(); } catch (err) { }
                        }
                    }
                } catch (error) {
                    uploadError = error?.message || "Failed to upload login.html";
                }

                return res.json({
                    success: true,
                    message: uploadError
                        ? `Hotspot Auto Configuration completed, but login.html upload failed: ${uploadError}`
                        : "Hotspot Auto Configuration completed successfully.",
                    pool: poolName,
                    profile: profileName,
                    server: serverName
                });
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            console.error("[Hotspot Auto Config] error:", error);
            return res.status(500).json({ success: false, message: "An error occurred during Hotspot auto configuration" });
        }
    }

    async isHotspotAutoConfigured(req, res) {
        const { station, token } = req.body;
        if (!token) return res.status(400).json({ isConfigured: false, message: "Missing authentication token" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success || auth.admin.role !== "superuser") return res.status(401).json({ isConfigured: false, message: "Unauthorized!" });
            const platformID = auth.admin.platformID;
            const stationRecord = await this.db.getStations(platformID).then((stations) =>
                stations.find((s) => s.mikrotikHost === station)
            );
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            const connection = await this.config.createSingleMikrotikClient(platformID, station);
            if (!connection?.channel) return res.json({ success: false, message: "No valid MikroTik connection" });
            const { channel } = connection;
            try {
                const servers = await this.mikrotik.listHotspotServers(channel);
                const hasServers = servers.length > 0;
                if (!hasServers) {
                    return res.json({ isConfigured: false, message: "No hotspot servers configured." });
                }

                if (!isRadius) {
                    return res.json({ isConfigured: true, servers: servers.map(s => s.name) });
                }

                const profiles = await this.mikrotik.getHotspotProfiles(channel);
                const normalizeBool = (val) => String(val ?? "").toLowerCase();
                const useRadiusProfile = profiles.find((p) =>
                    ["yes", "true", "1"].includes(normalizeBool(p["use-radius"]))
                );
                if (!useRadiusProfile) {
                    return res.json({ isConfigured: false, message: "Hotspot profile not set to use RADIUS." });
                }

                const radiusServerIp = stationRecord?.radiusServerIp || (process.env.RADIUS_SERVER_IP || process.env.SERVER_IP || "").toString().split(":")[0];
                const radiusSecret = stationRecord?.radiusClientSecret;
                if (!radiusServerIp || !radiusSecret) {
                    return res.json({ isConfigured: false, message: "Missing RADIUS credentials for this station." });
                }

                const radiusEntries = await channel.write("/radius/print", []);
                const matchingRadius = Array.isArray(radiusEntries)
                    ? radiusEntries.find((r) => {
                        const address = String(r.address || "");
                        const secret = String(r.secret || "");
                        const service = String(r.service || "").toLowerCase();
                        return address === radiusServerIp &&
                            secret === radiusSecret &&
                            (service.includes("hotspot") || service.includes("all"));
                    })
                    : null;

                if (!matchingRadius) {
                    return res.json({ isConfigured: false, message: "RADIUS entry not configured for hotspot." });
                }

                const incoming = await channel.write("/radius/incoming/print", []);
                const incomingAccept = Array.isArray(incoming)
                    ? incoming.find((i) => ["yes", "true", "1"].includes(normalizeBool(i.accept)))
                    : null;
                if (!incomingAccept) {
                    return res.json({ isConfigured: false, message: "RADIUS incoming requests are not enabled." });
                }

                return res.json({ isConfigured: true, servers: servers.map(s => s.name), profile: useRadiusProfile?.name || null });
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "An error occurred while checking Hotspot configuration" });
        }
    }

    async repairRouter(req, res) {
        const { token, station } = req.body;
        if (!token || !station) {
            return res.status(400).json({ success: false, message: "Missing token or station" });
        }
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID" });

            const stations = await this.db.getStations(platformID);
            const stationRecord = stations?.find((s) => s.mikrotikHost === station);
            if (!stationRecord) {
                return res.status(404).json({ success: false, message: "Station not found" });
            }

            const tcpResult = await new Promise((resolve) => {
                const socket = new net.Socket();
                let resolved = false;
                const finish = (ok, error) => {
                    if (resolved) return;
                    resolved = true;
                    try { socket.destroy(); } catch (e) { }
                    resolve({ ok, error });
                };
                socket.setTimeout(3000);
                socket.once("connect", () => finish(true, null));
                socket.once("timeout", () => finish(false, "Connection timeout"));
                socket.once("error", (err) => finish(false, err?.message || "Connection error"));
                socket.connect(8728, station);
            });

            if (!tcpResult.ok) {
                return res.json({
                    success: false,
                    status: "unreachable",
                    diagnosis: "Router offline or network unreachable (or wrong host).",
                    message: "Unable to reach router API port.",
                    details: { error: tcpResult.error },
                });
            }

            const connection = await this.config.createSingleMikrotikClient(platformID, station);
            if (!connection?.channel) {
                return res.json({
                    success: false,
                    status: "auth_failed",
                    diagnosis: "Router reachable but login failed (bad credentials or API disabled).",
                    message: "Router reachable but login failed.",
                });
            }

            let hotspotConfigured = false;
            let hotspotServers = [];
            try {
                const servers = await this.mikrotik.listHotspotServers(connection.channel);
                hotspotServers = servers.map((s) => s.name).filter(Boolean);
                hotspotConfigured = servers.length > 0;
            } finally {
                await this.safeCloseChannel(connection.channel);
            }

            if (!hotspotConfigured) {
                const autoConfigResult = await new Promise((resolve) => {
                    const fakeRes = {
                        status: () => fakeRes,
                        json: (payload) => resolve(payload),
                    };
                    this.autoConfigureHotspot({ body: { token, station } }, fakeRes);
                });

                if (autoConfigResult?.success) {
                    return res.json({
                        success: true,
                        status: "repaired",
                        diagnosis: "Hotspot was not configured. Auto-configuration applied.",
                        message: autoConfigResult.message || "Auto configuration applied.",
                        details: autoConfigResult,
                    });
                }

                return res.json({
                    success: false,
                    status: "repair_failed",
                    diagnosis: "Router reachable but hotspot configuration failed.",
                    message: autoConfigResult?.message || "Failed to auto configure hotspot.",
                    details: autoConfigResult,
                });
            }

            return res.json({
                success: true,
                status: "configured",
                diagnosis: "Router reachable and hotspot configuration looks OK.",
                message: "Router OK.",
                details: { hotspotServers },
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to diagnose router", error: error?.message });
        }
    }

    async startAutoRouter(req, res) {
        const { token, name, systemBasis } = req.body || {};
        if (!token) return res.status(400).json({ success: false, message: "Missing token" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.status(403).json({ success: false, message: "Unauthorised!" });
            const sessionToken = crypto.randomBytes(16).toString("hex");
            this.routerAutoSessions.set(sessionToken, {
                platformID: auth.admin.platformID,
                adminID: auth.admin.adminID,
                name: typeof name === "string" ? name.trim() : "",
                systemBasis: typeof systemBasis === "string" ? systemBasis : "API",
                createdAt: Date.now(),
            });
            return res.json({ success: true, token: sessionToken });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to start auto router session" });
        }
    }

    async getAutoRouterScript(req, res) {
        const token = req.query.token;
        const serverUrl = (req.query.server || "").toString().replace(/\/+$/, "");
        const requestedName = (req.query.name || "").toString();
        const requestedBasis = (req.query.systemBasis || "").toString();
        if (!token) return res.status(400).send("Missing token");
        const session = this.routerAutoSessions.get(token);
        if (!session) return res.status(404).send("Invalid session");
        const platformID = session.platformID;

        try {
            if (requestedName.trim()) {
                const sanitizedName = requestedName
                    .trim()
                    .replace(/\s+/g, "-")
                    .replace(/[^a-zA-Z0-9._-]/g, "")
                    .replace(/-+/g, "-")
                    .replace(/^[-.]+|[-.]+$/g, "");
                session.name = sanitizedName;
                this.routerAutoSessions.set(token, session);
            }
            if (requestedBasis) {
                session.systemBasis = requestedBasis;
                this.routerAutoSessions.set(token, session);
            }
            const stations = await this.db.getStations(platformID);
            const usedHosts = (stations || []).map((s) => s.mikrotikHost);
            const internalIp = this.getNextAutoRouterIp(usedHosts);
            if (!internalIp) {
                return res.status(400).send("No available IPs in 10.10.10.0/24");
            }

            const apiUser = session.apiUser || `nova-${crypto.randomBytes(3).toString("hex")}`;
            const apiPass = session.apiPass || crypto.randomBytes(6).toString("hex");
            session.apiUser = apiUser;
            session.apiPass = apiPass;
            session.mikrotikHost = internalIp;
            this.routerAutoSessions.set(token, session);

            const baseUrl = serverUrl || `${req.protocol}://${req.get("host")}`;
            const routerosBaseUrl = process.env.ROUTEROS_BASE_URL || `${baseUrl}/routeros`;
            const logBase = `${baseUrl}/mkt/auto-router/log?token=${token}&msg=`;
            const completeUrl = `${baseUrl}/mkt/auto-router/complete?token=${token}`;
            const routerName = (session.name || "")
                .toString()
                .replace(/"/g, "")
                .replace(/\s+/g, "-");
            const scriptUrl = `${baseUrl}/mkt/auto-router/script?token=${token}&server=${encodeURIComponent(baseUrl)}&name=${encodeURIComponent(routerName)}&systemBasis=${encodeURIComponent(session.systemBasis || "API")}`;
            const endpointAddress = (process.env.SERVER_IP || "77.37.97.244").toString().split(":")[0];
            const endpointPort = (process.env.SERVER_WIREGUARD_PORT || "51820").toString();
            const serverWgPublicKey = process.env.WIREGUARD_PUBLIC_KEY || "Pn1mfAY8NCdzkdxjZL8kMXAzMNOIbEuyHTPqqI1zdRA=";
            const radiusServerIp = (process.env.RADIUS_SERVER_IP || process.env.SERVER_IP || "").toString().split(":")[0];
            const domain = (process.env.DOMAIN || process.env.NEXT_PUBLIC_DOMAIN || "novawifi.co.ke").toString();
            if (session.systemBasis === "RADIUS") {
                const stations = await this.db.getStations(platformID);
                const existingNames = new Set(stations.map(s => s.radiusClientName).filter(Boolean));
                const generateName = () => {
                    const base = `rad-${platformID.slice(0, 6)}`;
                    const suffix = crypto.randomBytes(3).toString("hex");
                    return `${base}-${suffix}`;
                };
                let clientName = session.radiusClientName || generateName();
                while (existingNames.has(clientName)) {
                    clientName = generateName();
                }
                session.radiusClientName = clientName;
                session.radiusClientSecret = session.radiusClientSecret || crypto.randomBytes(12).toString("hex");
                session.radiusServerIp = radiusServerIp;
                this.routerAutoSessions.set(token, session);
            }

            const radiusScript =
                session.systemBasis === "RADIUS" && session.radiusClientSecret && radiusServerIp
                    ? [
                        `/tool fetch url=($logBase . "radius-config-start") keep-result=no`,
                        `/radius add address=${radiusServerIp} secret=${session.radiusClientSecret} service=ppp,hotspot timeout=300ms`,
                        `/radius incoming set accept=yes`,
                        `/ppp aaa set use-radius=yes accounting=yes interim-update=1m`,
                        `/tool fetch url=($logBase . "radius-config-done") keep-result=no`,
                    ]
                    : [];

            const script = [
                `:local token "${token}"`,
                `:local logBase "${logBase}"`,
                `:local completeUrl "${completeUrl}"`,
                `:local scriptUrl "${scriptUrl}"`,
                `:local routerosBase "${routerosBaseUrl}"`,
                `:local routerName "${routerName}"`,
                `:local internalIp "${internalIp}"`,
                `:local apiUser "${apiUser}"`,
                `:local apiPass "${apiPass}"`,
                `:local safeFetch do={ :local u $1; :do { /tool fetch url=$u keep-result=no } on-error={} }`,
                `:local ensureReconnect do={`,
                `:local schedId [/system/scheduler/find name="nova-reconnect"]`,
                `:if ([:len $schedId] = 0) do={`,
                `/system/scheduler add name="nova-reconnect" start-time=startup on-event=":delay 5s; :do { /tool fetch url=($logBase . \\\"router-rebooted\\\") keep-result=no } on-error={}; :do { /tool fetch url=($scriptUrl) dst-path=\\\"nova-auto.rsc\\\" keep-result=no } on-error={}; /import file-name=\\\"nova-auto.rsc\\\"; /file/remove nova-auto.rsc; /system/scheduler remove [find name=\\\"nova-reconnect\\\"]"`,
                `}`,
                `}`,
                `:do {`,
                `:local mode [/system/device-mode/get mode]`,
                `:if ($mode != "advanced") do={`,
                `$safeFetch ($logBase . "device-mode-updating")`,
                `/system/device-mode/update mode=advanced`,
                `$ensureReconnect`,
                `$safeFetch ($logBase . "device-mode-reboot")`,
                `/system/reboot`,
                `}`,
                `} on-error={ $safeFetch ($logBase . "device-mode-check-failed") }`,
                `:local rosVer [/system/resource/get version]`,
                `:local arch [/system/resource/get architecture-name]`,
                `:if ([:pick $rosVer 0 2] = "6.") do={`,
                `$safeFetch ($logBase . "routeros-v6-detected")`,
                `:local pkgBase ($routerosBase . "/" . $arch)`,
                `/tool fetch url=($pkgBase . "/routeros.npk") dst-path="routeros.npk" keep-result=yes`,
                `/tool fetch url=($pkgBase . "/wireless.npk") dst-path="wireless.npk" keep-result=yes`,
                `:do { /tool fetch url=($pkgBase . "/hotspot.npk") dst-path="hotspot.npk" keep-result=yes } on-error={ $safeFetch ($logBase . "hotspot-package-missing") }`,
                `$safeFetch ($logBase . "routeros-packages-downloaded")`,
                `$ensureReconnect`,
                `$safeFetch ($logBase . "rebooting-for-upgrade")`,
                `/system/reboot`,
                `}`,
                `:local conflictAddr [/ip/address/find where address~"10.10.10."]`,
                `:local conflictPool [/ip/pool/find where ranges~"10.10.10."]`,
                `:local ipInUse [/ip/address/find where address=($internalIp . "/24")]`,
                `:if (([:len $conflictAddr] > 0) || ([:len $conflictPool] > 0) || ([:len $ipInUse] > 0)) do={`,
                `$safeFetch ($logBase . "ip-conflict")`,
                `/ip/address remove $conflictAddr`,
                `/ip/pool remove $conflictPool`,
                `:delay 1s`,
                `:set conflictAddr [/ip/address/find where address~"10.10.10."]`,
                `:set conflictPool [/ip/pool/find where ranges~"10.10.10."]`,
                `:set ipInUse [/ip/address/find where address=($internalIp . "/24")]`,
                `:if (([:len $conflictAddr] > 0) || ([:len $conflictPool] > 0) || ([:len $ipInUse] > 0)) do={`,
                `:error "10.10.10.0/24 already in use"`,
                `}`,
                `}`,
                `:local bridgeName ""`,
                `:local bridgeIds [/interface/bridge/find]`,
                `:if ([:len $bridgeIds] > 0) do={ :set bridgeName [/interface/bridge/get ([:pick $bridgeIds 0]) name] }`,
                `:if ([:len $bridgeName] = 0) do={ /interface/bridge add name=bridge; :set bridgeName "bridge" }`,
                `:if ([:len [/interface/list/find name="LAN"]] = 0) do={ /interface/list add name="LAN" }`,
                `$safeFetch ($logBase . "start")`,
                `/interface wireguard remove [find name="wireguard"]`,
                `/ip address remove [find where interface=wireguard and address~"10.10.10."]`,
                `/interface wireguard peers remove [find where name="novapeer"]`,
                `/interface list member remove [find list="LAN" interface=wireguard]`,
                `/ip firewall filter remove [find comment="Allow API from WireGuard"]`,
                `/ip firewall filter remove [find where dst-port="13231" and protocol="udp"]`,
                `/ip firewall filter remove [find where src-address="10.10.10.0/24"]`,
                `/interface wireguard add listen-port=13231 mtu=1420 name=wireguard`,
                `$safeFetch ($logBase . "wireguard-interface-added")`,
                `/ip address add address=($internalIp . "/24") interface=wireguard`,
                `$safeFetch ($logBase . "wireguard-ip-assigned")`,
                `/interface wireguard peers add interface=wireguard name=novapeer public-key="${serverWgPublicKey}" endpoint-address=${endpointAddress} endpoint-port=${endpointPort} allowed-address=10.10.10.1/32 persistent-keepalive=10`,
                `$safeFetch ($logBase . "wireguard-peer-added")`,
                `:delay 10s`,
                `:do {`,
                `:local pingOk [/ping 10.10.10.1 count=3]`,
                `:if ([:len $pingOk] > 0) do={ $safeFetch ($logBase . "ping-server-ok") } else={ $safeFetch ($logBase . "ping-server-failed") }`,
                `} on-error={ $safeFetch ($logBase . "ping-server-error") }`,
                `/ip service set api address=10.10.10.0/24`,
                `/ip service set www-ssl disabled=no`,
                `/ip service set api disabled=no`,
                `/ip service set ftp disabled=no`,
                `$safeFetch ($logBase . "api-access-enabled")`,
                `/ip firewall filter add chain=input src-address=10.10.10.0/24 protocol=tcp dst-port=8728 action=accept comment="Allow API from WireGuard"`,
                `/interface list member add list=LAN interface=wireguard`,
                `/ip firewall filter add action=accept chain=input dst-port=13231 protocol=udp`,
                `/ip firewall filter add action=accept chain=input src-address=10.10.10.0/24`,
                `/ip dns set servers=8.8.8.8,1.1.1.1 allow-remote-requests=yes`,
                `:if ([:len [/ip/hotspot/walled-garden/find dst-host="${domain}"]] = 0) do={ /ip/hotspot/walled-garden/add dst-host="${domain}" action=allow }`,
                `:if ([:len [/ip/hotspot/walled-garden/find dst-host="*.${domain}"]] = 0) do={ /ip/hotspot/walled-garden/add dst-host="*.${domain}" action=allow }`,
                `:if ([:len [/ip/hotspot/walled-garden/find dst-host="api64.ipify.org"]] = 0) do={ /ip/hotspot/walled-garden/add dst-host="api64.ipify.org" action=allow }`,
                `/ip firewall mangle add chain=postrouting out-interface=$bridgeName action=change-ttl new-ttl=set:1`,
                `$safeFetch ($logBase . "firewall-rules-set")`,
                `:local userId [/user/find name=$apiUser]`,
                `:if ([:len $userId] = 0) do={ /user/add name=$apiUser password=$apiPass group=full } else={ /user/set $userId password=$apiPass }`,
                `$safeFetch ($logBase . "api-user-ready")`,
                ...radiusScript,
                `/ip cloud set ddns-enabled=yes`,
                `:delay 5s`,
                `:local ddns [/ip/cloud/get dns-name]`,
                `:local publicIp [/ip/cloud/get public-address]`,
                `:if ([:len $publicIp] = 0) do={`,
                `:local ipify [/tool fetch url="https://api64.ipify.org" as-value output=user]`,
                `:if ([:typeof ($ipify->"data")] = "str") do={ :set publicIp ($ipify->"data") }`,
                `}`,
                `:if ([:len $ddns] = 0) do={ :set ddns $publicIp }`,
                `:local pubkey [/interface wireguard/get [find name=wireguard] public-key]`,
                `$safeFetch ($completeUrl . "&publicKey=" . $pubkey . "&ddns=" . $ddns . "&publicIp=" . $publicIp . "&user=" . $apiUser . "&pass=" . $apiPass . "&host=" . $internalIp . "&name=" . $routerName)`,
            ].join("\n");

            res.setHeader("Content-Type", "text/plain");
            return res.status(200).send(script);
        } catch (error) {
            return res.status(500).send("Failed to generate script");
        }
    }

    async autoRouterLog(req, res) {
        const token = req.query.token;
        const message = (req.query.msg || "").toString();
        if (!token) return res.status(400).json({ success: false, message: "Missing token" });
        if (!this.routerAutoSessions.has(token)) {
            return res.status(404).json({ success: false, message: "Invalid session" });
        }
        socketManager.emitToRoom(`router-auto-${token}`, "router-auto:log", {
            token,
            message,
            timestamp: Date.now(),
        });
        return res.json({ success: true });
    }

    async autoRouterComplete(req, res) {
        const token = req.query.token;
        if (!token) return res.status(400).json({ success: false, message: "Missing token" });
        const session = this.routerAutoSessions.get(token);
        if (!session) return res.status(404).json({ success: false, message: "Invalid session" });

        const normalize = (value) => (value ? value.toString().replace(/ /g, "+") : "");
        const sanitizeRouterName = (value) =>
            String(value || "")
                .trim()
                .replace(/\s+/g, "-")
                .replace(/[^a-zA-Z0-9._-]/g, "")
                .replace(/-+/g, "-")
                .replace(/^[-.]+|[-.]+$/g, "");

        const payload = {
            token,
            publicKey: normalize(req.query.publicKey),
            ddns: normalize(req.query.ddns),
            publicIp: normalize(req.query.publicIp),
            mikrotikUser: normalize(req.query.user) || session.apiUser || "",
            mikrotikPassword: normalize(req.query.pass) || session.apiPass || "",
            mikrotikHost: normalize(req.query.host) || session.mikrotikHost || "",
            name: sanitizeRouterName(normalize(req.query.name) || session.name || ""),
            timestamp: Date.now(),
        };
        console.log("[AutoRouter] complete payload", {
            token,
            publicKey: payload.publicKey,
            ddns: payload.ddns,
            publicIp: payload.publicIp,
            mikrotikUser: payload.mikrotikUser,
            mikrotikHost: payload.mikrotikHost,
            name: payload.name,
            systemBasis: session.systemBasis,
        });
        const saveResult = await this.saveAutoStation(session, payload);
        const finalPayload = {
            ...payload,
            saved: saveResult.success,
            station: saveResult.station || null,
            saveMessage: saveResult.message || "",
        };

        socketManager.emitToRoom(`router-auto-${token}`, "router-auto:complete", finalPayload);
        if (saveResult.station) {
            socketManager.emitToRoom(`router-auto-${token}`, "router-auto:saved", {
                station: saveResult.station,
                message: saveResult.message || "Station saved",
            });
        }
        if (saveResult.success && payload.mikrotikHost) {
            execFile("ping", ["-c", "3", "-W", "2", payload.mikrotikHost], (err) => {
                const message = err ? "ping-failed" : "ping-ok";
                socketManager.emitToRoom(`router-auto-${token}`, "router-auto:log", {
                    token,
                    message,
                    timestamp: Date.now(),
                });
            });
        }
        return res.json({ success: true, saved: saveResult.success, message: saveResult.message });
    }

    sanitizeDomain(domain) {
        if (!domain || typeof domain !== "string") return null;
        const safe = domain.trim().toLowerCase();
        if (!safe || safe.includes("..") || safe.includes("/") || safe.includes(" ")) return null;
        return safe;
    }

    buildNginxConfig(domain, targetUrl) {
        return [
            "server {",
            "    listen 80;",
            `    server_name ${domain};`,
            "",
            "    location / {",
            `        proxy_pass ${targetUrl};`,
            "        proxy_http_version 1.1;",
            "",
            "        proxy_set_header Host $host;",
            "        proxy_set_header X-Real-IP $remote_addr;",
            "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
            "        proxy_set_header X-Forwarded-Proto $scheme;",
            "",
            "        proxy_set_header Upgrade $http_upgrade;",
            "        proxy_set_header Connection \"upgrade\";",
            "    }",
            "}",
            "",
        ].join("\n");
    }

    async addReverseProxySite(domain, targetUrl) {
        const safeDomain = this.sanitizeDomain(domain);
        if (!safeDomain) {
            return { success: false, message: "Invalid domain provided." };
        }

        const config = this.buildNginxConfig(safeDomain, targetUrl);
        const tmpPath = `/tmp/nginx-${safeDomain}.conf`;
        const availablePath = `/etc/nginx/sites-available/${safeDomain}`;
        const enabledPath = `/etc/nginx/sites-enabled/${safeDomain}`;

        try {
            await fsp.writeFile(tmpPath, config, "utf8");
        } catch (err) {
            return { success: false, message: "Failed to write nginx config", error: err.message };
        }

        const run = (cmd, args = []) =>
            new Promise((resolve, reject) => {
                execFile(cmd, args, (err, stdout, stderr) => {
                    if (err) return reject(stderr || err.message);
                    resolve(stdout);
                });
            });

        try {
            await run("sudo", ["-n", "mv", tmpPath, availablePath]);
            await run("sudo", ["-n", "ln", "-sf", availablePath, enabledPath]);
            await run("sudo", ["-n", "/usr/sbin/nginx", "-t"]);
            await run("sudo", ["-n", "/usr/bin/systemctl", "reload", "nginx"]);

            return {
                success: true,
                message: `Nginx reverse proxy configured for ${safeDomain}`,
            };
        } catch (error) {
            return {
                success: false,
                message: `Failed to configure nginx for ${safeDomain}`,
                error,
            };
        }
    }

    async installLetsEncryptCert(domain) {
        const safeDomain = this.sanitizeDomain(domain);
        if (!safeDomain) {
            return { success: false, message: "Invalid domain provided." };
        }
        const baseDomain = process.env.DOMAIN || "novawifi.co.ke";
        const adminEmail = `admin@${baseDomain}`;

        return new Promise((resolve) => {
            execFile(
                "sudo",
                ["-n", "certbot", "--nginx", "-d", safeDomain, "--non-interactive", "--agree-tos", "-m", adminEmail],
                (err, stdout, stderr) => {
                    if (err) {
                        return resolve({
                            success: false,
                            message: `SSL installation failed for ${safeDomain}`,
                            error: stderr || err.message,
                        });
                    }

                    resolve({
                        success: true,
                        message: `SSL installed for ${safeDomain}`,
                        output: stdout?.trim(),
                    });
                }
            );
        });
    }

    async resolveMikrotikHost(mikrotikPublicHost) {
        const endpointHost = mikrotikPublicHost;
        if (!endpointHost) return { success: false, message: 'Public router host is required.' };
        if (Utils.isValidIP && Utils.isValidIP(endpointHost)) return { success: true, host: endpointHost, addresses: [endpointHost] };
        if (Utils.validateDdnsHost && Utils.validateDdnsHost(endpointHost)) {
            try {
                const addresses = await dns.resolve4(endpointHost);
                return { success: true, host: endpointHost, addresses };
            } catch (err) {
                return { success: false, message: `Failed to resolve '${endpointHost}'. Make sure it points to a valid Public IP Address` };
            }
        }
        return { success: false, message: 'Invalid host: must be a valid IP or hostname.' };
    }

    async updateWireguardConfig({ mikrotikHost, mikrotikPublicKey, endpointHost }) {
        if (!mikrotikHost || !mikrotikPublicKey || !endpointHost) {
            return { success: false, message: "Missing WireGuard peer data." };
        }

        const wgName = "wg0";
        const wgConfPath = `/etc/wireguard/${wgName}.conf`;
        console.log("[WireGuard] update requested", {
            mikrotikHost,
            endpointHost,
            mikrotikPublicKey,
            wgConfPath,
        });

        const peerBlock = [
            "[Peer]",
            `PublicKey = ${mikrotikPublicKey}`,
            `Endpoint = ${endpointHost}:13231`,
            `AllowedIPs = ${mikrotikHost}/32`,
            "PersistentKeepalive = 10",
        ].join("\n");

        const runSudo = (args = []) =>
            new Promise((resolve, reject) => {
                execFile("sudo", ["-n", ...args], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                    if (err) return reject((stderr || err.message || "").toString().trim());
                    resolve(stdout.toString());
                });
            });

        const parseConfig = (text) => {
            const lines = text.replace(/\r\n/g, "\n").split("\n");
            let i = 0;

            while (i < lines.length && lines[i].trim() !== "[Interface]") i++;
            if (i === lines.length) return { interfaceBlock: "", peerBlocks: [] };

            const ifaceStart = i;
            i++;

            while (i < lines.length && lines[i].trim() !== "[Peer]") i++;
            const interfaceBlock = lines.slice(ifaceStart, i).join("\n").trim();

            const peerBlocks = [];
            while (i < lines.length) {
                if (lines[i].trim() !== "[Peer]") {
                    i++;
                    continue;
                }
                const start = i;
                i++;
                while (i < lines.length && lines[i].trim() !== "[Peer]") i++;
                const block = lines.slice(start, i).join("\n").trim();
                if (block) peerBlocks.push(block);
            }

            return { interfaceBlock, peerBlocks };
        };

        const getField = (block, key) => {
            const m = block.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`, "mi"));
            return m ? m[1].trim() : null;
        };

        try {
            const fileData = await runSudo(["/bin/cat", wgConfPath]);

            const backupPath = `${wgConfPath}.bak-${Date.now()}`;
            await runSudo(["/bin/cp", "-a", wgConfPath, backupPath]);

            const { interfaceBlock, peerBlocks } = parseConfig(fileData);

            if (!interfaceBlock) {
                return { success: false, message: "wg0.conf missing [Interface] block." };
            }

            const seenIPs = new Set();
            const seenKeys = new Set();
            const cleanedPeers = [];

            for (const block of peerBlocks) {
                const allowed = getField(block, "AllowedIPs");
                const pubKey = getField(block, "PublicKey");
                const allowedNorm = allowed ? allowed.split(",").map((s) => s.trim()).join(", ") : null;

                if (allowedNorm && seenIPs.has(allowedNorm)) continue;
                if (pubKey && seenKeys.has(pubKey)) continue;

                if (allowedNorm) seenIPs.add(allowedNorm);
                if (pubKey) seenKeys.add(pubKey);

                cleanedPeers.push(block.trim());
            }

            const newAllowed = `${mikrotikHost}/32`;
            const finalPeers = cleanedPeers.filter((b) => {
                const allowed = getField(b, "AllowedIPs");
                const pubKey = getField(b, "PublicKey");
                return pubKey !== mikrotikPublicKey && allowed !== newAllowed;
            });

            finalPeers.push(peerBlock);

            const newConfig =
                [interfaceBlock.trim(), ...finalPeers.map((b) => b.trim())]
                    .filter(Boolean)
                    .join("\n\n")
                    .replace(/\n{3,}/g, "\n\n")
                    .trim() + "\n";

            console.log("[WireGuard] new config preview", newConfig.replace(/PrivateKey\\s*=\\s*.+/i, "PrivateKey = (redacted)"));

            const tmpPath = `/tmp/${wgName}-${Date.now()}.conf`;
            await fsp.writeFile(tmpPath, newConfig, "utf8");
            await runSudo(["/usr/bin/install", "-o", "root", "-g", "root", "-m", "600", tmpPath, wgConfPath]);
            await fsp.unlink(tmpPath).catch(() => { });

            await runSudo(["/bin/systemctl", "restart", `wg-quick@${wgName}`]);

            return { success: true, message: "WireGuard updated and restarted." };
        } catch (error) {
            console.error("[WireGuard] update failed", error?.toString?.() || error);
            return { success: false, message: `WireGuard update failed: ${String(error)}` };
        }
    }

    async saveAutoStation(session, payload) {
        try {
            const platformID = session.platformID;
            const adminID = session.adminID;
            const platform = await this.db.getPlatform(platformID);
            if (!platform) return { success: false, message: "Platform doesn't exist." };

            const stations = await this.db.getStations(platformID);
            const randomSuffix = Math.floor(Math.random() * 999) + 1;
            const sanitizeRouterName = (value) =>
                String(value || "")
                    .trim()
                    .replace(/\s+/g, "-")
                    .replace(/[^a-zA-Z0-9._-]/g, "")
                    .replace(/-+/g, "-")
                    .replace(/^[-.]+|[-.]+$/g, "");
            const name = sanitizeRouterName(payload.name) || `Mikrotik-${randomSuffix}`;
            const endpointHost = payload.ddns || payload.publicIp;
            if (!endpointHost) return { success: false, message: "Public router host is required." };

            const existingHost = stations.find(s => s.mikrotikHost?.trim() === payload.mikrotikHost?.trim());
            const existingKey = stations.find(s => s.mikrotikPublicKey?.trim() === payload.publicKey?.trim());
            const existing = existingHost || existingKey;

            if (!existing) {
                if (payload.ddns) {
                    const existingDnsName = stations.find(s => s.mikrotikDDNS?.trim() === payload.ddns?.trim());
                    if (existingDnsName) {
                        return { success: false, message: "DDNS name is already being used by another router." };
                    }
                }
            }

            // const resolveResult = await this.resolveMikrotikHost(endpointHost);
            // if (!resolveResult.success) {
            //     return { success: false, message: resolveResult.message };
            // }

            const rawPassword = payload.mikrotikPassword || "";
            const isEncryptedPassword =
                typeof rawPassword === "string" &&
                rawPassword.includes(":") &&
                rawPassword.split(":")[0]?.length === 32;
            const encryptedPassword = rawPassword && !isEncryptedPassword
                ? Utils.encryptPassword(rawPassword)
                : rawPassword;

            let stationResult;
            const warnings = [];
            const systemBasis = session.systemBasis || "API";
            if (!existing) {
                const sanitizeSubdomain = (value) => {
                    const lettersOnly = String(value || "")
                        .toLowerCase()
                        .replace(/[^a-z]/g, "");
                    const trimmed = lettersOnly.slice(0, 12);
                    return trimmed || "router";
                };
                const randomness = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 4) || "site";
                const domain = process.env.DOMAIN || "novawifi.co.ke";
                const mikrotikWebfigHost = `${sanitizeSubdomain(name)}${randomness}.${domain}`;

                stationResult = await this.db.createStation({
                    name,
                    mikrotikHost: payload.mikrotikHost,
                    mikrotikPublicKey: payload.publicKey,
                    mikrotikUser: payload.mikrotikUser,
                    mikrotikPassword: encryptedPassword,
                    mikrotikDDNS: payload.ddns || "",
                    mikrotikPublicHost: payload.ddns ? "" : payload.publicIp,
                    mikrotikWebfigHost,
                    platformID,
                    adminID,
                    systemBasis,
                    radiusClientName: session.radiusClientName || null,
                    radiusClientSecret: session.radiusClientSecret || null,
                    radiusClientIp: systemBasis === "RADIUS" ? (payload.publicIp || "") : null,
                    radiusServerIp: systemBasis === "RADIUS" ? (session.radiusServerIp || "") : null,
                });

                const proxy = await this.addReverseProxySite(mikrotikWebfigHost, `http://${payload.mikrotikHost}`);
                if (!proxy.success) {
                    warnings.push(proxy.message || "Failed to create reverse proxy site");
                }
                // SSL handled via wildcard certificate; skip per-host install.
            } else {
                stationResult = await this.db.updateStation(existing.id, {
                    name,
                    mikrotikHost: payload.mikrotikHost,
                    mikrotikPublicKey: payload.publicKey,
                    mikrotikUser: payload.mikrotikUser,
                    mikrotikPassword: encryptedPassword,
                    mikrotikDDNS: payload.ddns || "",
                    mikrotikPublicHost: payload.ddns ? "" : payload.publicIp,
                    systemBasis,
                    radiusClientName: session.radiusClientName || existing.radiusClientName || null,
                    radiusClientSecret: session.radiusClientSecret || existing.radiusClientSecret || null,
                    radiusClientIp: systemBasis === "RADIUS" ? (payload.publicIp || existing.radiusClientIp || "") : existing.radiusClientIp || null,
                    radiusServerIp: systemBasis === "RADIUS" ? (session.radiusServerIp || existing.radiusServerIp || "") : existing.radiusServerIp || null,
                });
            }

            if (systemBasis === "RADIUS" && session.radiusClientName && session.radiusClientSecret) {
                if (!payload.publicIp) {
                    warnings.push("RADIUS client not added: missing public IP/DDNS");
                } else {
                    const addResult = await ensureRadiusClient({
                        name: session.radiusClientName,
                        ip: payload.publicIp,
                        secret: session.radiusClientSecret,
                        shortname: name,
                        server: session.radiusServerIp || "",
                        description: `Nova RADIUS client for ${name}`,
                    });
                    if (!addResult?.success) {
                        warnings.push(`RADIUS client add failed: ${addResult?.message || "unknown error"}`);
                        console.warn("[RADIUS] ensureRadiusClient failed", addResult?.message || addResult);
                    }
                }
            }

            const wgResult = await this.updateWireguardConfig({
                mikrotikHost: payload.mikrotikHost,
                mikrotikPublicKey: payload.publicKey,
                endpointHost,
            });
            if (!wgResult.success) {
                return { success: false, message: wgResult.message, station: stationResult };
            }

            const warningMessage = warnings.length > 0 ? ` Warnings: ${warnings.join(" | ")}` : "";
            return { success: true, message: `Station saved.${warningMessage}`, station: stationResult };
        } catch (error) {
            return { success: false, message: "Failed to save station" };
        }
    }

    async fetchActivePPPoEConnections(platformID) {
        try {
            const stations = await this.db.getStations(platformID);
            let totalActive = 0;
            for (const station of stations) {
                const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
                if (!connection?.channel) continue;
                const { channel } = connection;
                try {
                    const active = await this.mikrotik.listPPPActiveUsers(channel);
                    totalActive += (active && active.length) ? active.length : 0;
                } finally {
                    await this.safeCloseChannel(channel);
                }
            }
            return totalActive;
        } catch (error) {
            throw error;
        }
    }

    async fetchActiveHotspotConnections(platformID) {
        try {
            const stations = await this.db.getStations(platformID);
            let totalActive = 0;
            for (const station of stations) {
                const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
                if (!connection?.channel) continue;
                const { channel } = connection;
                try {
                    const active = await this.mikrotik.listHotspotActiveUsers(channel);
                    totalActive += (active && active.length) ? active.length : 0;
                } finally {
                    await this.safeCloseChannel(channel);
                }
            }
            return totalActive;
        } catch (error) {
            throw error;
        }
    }

    async calculateBandwidthUsage(platformID) {
        const stations = await this.db.getStations(platformID);
        const results = [];
        for (const station of stations) {
            try {
                const isRadius = station?.systemBasis === "RADIUS";
                const ipCandidates = [
                    station?.radiusClientIp,
                    station?.mikrotikPublicHost,
                    station?.mikrotikHost,
                ].filter(Boolean).map((val) => String(val).trim());
                const ipRegex = /^(?:\d{1,3}\.){3}\d{1,3}$/;
                const nasIps = Array.from(new Set(ipCandidates.filter((val) => ipRegex.test(val))));

                if (isRadius) {
                    const radiusUsage = await this.db.getRadiusUsageByNasIps(nasIps);
                    const totalTx = radiusUsage.hotspot.tx + radiusUsage.pppoe.tx;
                    const totalRx = radiusUsage.hotspot.rx + radiusUsage.pppoe.rx;
                    if (totalTx > 0 || totalRx > 0) {
                        results.push(
                            { id: station.id, service: "hotspot", tx: radiusUsage.hotspot.tx, rx: radiusUsage.hotspot.rx },
                            { id: station.id, service: "pppoe", tx: radiusUsage.pppoe.tx, rx: radiusUsage.pppoe.rx }
                        );
                        continue;
                    }
                }

                const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
                if (!connection?.channel) continue;
                const { channel } = connection;
                try {
                    let hotspotTx = 0, hotspotRx = 0;
                    const hotspotUsers = await this.mikrotik.listHotspotActiveUsers(channel);
                    for (const user of hotspotUsers) { hotspotTx += Number(user["bytes-out"] || 0); hotspotRx += Number(user["bytes-in"] || 0); }
                    let pppoeTx = 0, pppoeRx = 0;
                    const pppoeUsers = await this.mikrotik.listPPPActiveUsers(channel);
                    for (const user of pppoeUsers) { pppoeTx += Number(user["bytes-out"] || 0); pppoeRx += Number(user["bytes-in"] || 0); }
                    results.push({ id: station.id, service: "hotspot", tx: hotspotTx, rx: hotspotRx }, { id: station.id, service: "pppoe", tx: pppoeTx, rx: pppoeRx });
                } finally {
                    await this.safeCloseChannel(channel);
                }
            } catch (err) { }
        }
        return results;
    }

    async fetchPPPoEInfo(req, res) {
        const { token } = req.body;
        if (!token) return res.json({ success: false, message: "Missing credentials required!" });
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID." });
            const stations = await this.db.getStations(platformID);
            const results = [];
            for (const station of stations) {
                const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
                if (!connection?.channel) {
                    results.push({ id: station.id, station: station.name || station.mikrotikHost, host: station.mikrotikHost, status: "error", message: "Failed to connect to router", data: null });
                    continue;
                }
                const { channel } = connection;
                try {
                    const poolsRes = await this.mikrotik.listPools(channel);
                    const pools = poolsRes.map(p => ({ name: p.name, ranges: p.ranges, comment: p.comment || "" }));
                    const profilesRes = await this.mikrotik.listPPPProfiles(channel);
                    const profiles = profilesRes.map(p => ({ name: p?.name || "", localAddress: p["local-address"] || "", remoteAddress: p["remote-address"] || "", rateLimit: p["rate-limit"] || "", dnsServer: p["dns-server"] || "" }));
                    const serversRes = await this.mikrotik.listPPPServers(channel);
                    const servers = serversRes.map(s => ({ serviceName: s["service-name"] || "", interface: s["interface"] || "", authentication: s["authentication"] || "", maxSessions: s["max-sessions"] || "", defaultProfile: s["default-profile"] || "", disabled: s["disabled"] || "no", id: s[".id"] || "" }));
                    results.push({ id: station.id, station: station.name || station.mikrotikHost, host: station.mikrotikHost, status: "success", data: { pools, profiles, servers } });
                } catch (error) {
                    results.push({ id: station.id, station: station.name || station.mikrotikHost, host: station.mikrotikHost, status: "error", message: error.message, data: null });
                } finally {
                    await channel.close();
                }
            }
            return res.status(200).json({ success: true, message: "PPPoE info fetched successfully", results });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Error fetching PPPoE info." });
        }
    }

    async addMikrotikManualCode(data) {
        if (!data) return { success: false, message: "Missing credentials required!" };
        const { phone, packageID, platformID, username, password } = data;
        try {
            const pkg = await this.db.getPackagesByID(packageID);
            if (!pkg) return { success: false, message: "Failed to add user to MikroTik, Package not found!" };
            const profileName = pkg.name;
            const hostdata = await this.db.getStations(platformID);
            if (!hostdata) return { success: false, message: "Failed to add user to MikroTik, Router not found!" };
            const stationRecord = hostdata.find((s) => s.mikrotikHost === pkg.routerHost);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            let expireAt = null;
            if (pkg?.period) {
                const now = new Date();
                const period = pkg.period.toLowerCase();
                const match = period.match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
                if (match) {
                    const value = parseInt(match[1]);
                    const unit = match[2].toLowerCase();
                    switch (unit) {
                        case 'minute': expireAt = new Date(now.getTime() + value * 60000); break;
                        case 'hour': expireAt = new Date(now.getTime() + value * 3600000); break;
                        case 'day': expireAt = new Date(now.getTime() + value * 86400000); break;
                        case 'month': expireAt = new Date(now.setMonth(now.getMonth() + value)); break;
                        case 'year': expireAt = new Date(now.setFullYear(now.getFullYear() + value)); break;
                    }
                }
            }
            if (isRadius) {
                const speedVal = String(pkg.speed || "").replace(/[^0-9.]/g, "");
                const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
                let dataLimitBytes = null;
                if (String(pkg.category || "").toLowerCase() === "data" && pkg.usage && pkg.usage !== "Unlimited") {
                    const [value, unit] = String(pkg.usage).split(" ");
                    if (value && unit) {
                        try {
                            dataLimitBytes = this.convertToBytes(parseFloat(value), unit.toUpperCase());
                        } catch (error) {
                            dataLimitBytes = null;
                        }
                    }
                }
                await this.db.upsertRadiusUser({
                    username,
                    password,
                    groupname: pkg.name,
                    rateLimit,
                    dataLimitBytes,
                });
            }
            const addedcode = await this.db.createUser({ status: "active", code: username, platformID: platformID, phone: phone, username: username, password: password, packageID: packageID, expireAt: expireAt });
            return { success: true, message: "Code added successfully", code: addedcode };
        } catch (error) {
            return { success: false, message: "An error occurred while adding the user" };
        }
    }

    async importUsers(req, res) {
        try {
            const { token, host } = req.body;
            if (!token || !host) return res.status(400).json({ success: false, message: "Missing token or host" });
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const platformID = auth.admin.platformID;
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return res.status(500).json({ success: false, message: "Failed to connect to MikroTik" });
            const { channel } = connection;
            try {
                const mikrotikUsers = await this.mikrotik.listHotspotUsers(channel);
                if (!mikrotikUsers || mikrotikUsers.length === 0) return res.status(404).json({ success: false, message: "No users found in MikroTik" });
                const packages = await this.db.getPackagesByPlatformID(platformID);
                if (!packages || packages.length === 0) return res.status(404).json({ success: false, message: "No packages found for platform" });
                const createdUsers = [];
                for (const mUser of mikrotikUsers) {
                    const username = mUser.name;
                    const password = mUser.password;
                    const profile = mUser.profile;
                    if (!username || username === "default-trial") continue;
                    const pkg = packages.find((p) => p.name.toLowerCase().trim() === profile.toLowerCase().trim());
                    if (!pkg) continue;
                    const existingUser = await this.db.getUserByUsername(username);
                    if (existingUser) continue;
                    const data = { phone: "null", packageID: pkg.id, platformID: platformID, username: username, password: password };
                    const addcodetorouter = await this.addMikrotikManualCode(data);
                    if (!addcodetorouter.success) return res.status(400).json({ success: false, message: `An error occured: ${addcodetorouter.message}` });
                    createdUsers.push({ ...addcodetorouter.code, active: "Offline" });
                }
                return res.status(200).json({ success: true, message: `Imported ${createdUsers.length} users successfully`, users: createdUsers });
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (err) {
            return res.status(500).json({ success: false, message: "Failed to import users" });
        }
    }

    async rebootRouter(req, res) {
        try {
            const { token, id } = req.body;
            if (!token || !id) return res.status(400).json({ success: false, message: "Missing token or id" });
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });
            const station = await this.db.getStation(id);
            if (!station) return res.status(404).json({ success: false, message: "Station not found" });
            const connection = await this.config.createSingleMikrotikClient(station.platformID, station.mikrotikHost);
            if (!connection?.channel) return res.status(500).json({ success: false, message: "Failed to connect to MikroTik" });
            const { channel } = connection;
            try {
                await this.mikrotik.reboot(channel);
                return res.status(200).json({ success: true, message: "Router rebooted successfully" });
            } finally {
                await this.safeCloseChannel(channel);
            }
        } catch (err) {
            return res.status(500).json({ success: false, message: "Failed to reboot mikrotik router" });
        }
    }

    async addManualCode(data) {
        if (!data) {
            return {
                success: false,
                message: "Missing credentials required!",
            }
        }

        const { phone, packageID, platformID, code, mac, token } = data;

        try {
            if (code && platformID) {
                const existing = await this.db.getUserByCodeAndPlatform(code, platformID);
                if (existing) {
                    return {
                        success: true,
                        message: "Code already exists",
                        code: existing,
                    };
                }
            }

            const pkg = await this.db.getPackagesByID(packageID);
            if (!pkg) {
                return {
                    success: false,
                    message: "Failed to add user to MikroTik, Package not found!",
                };
            }
            const profileName = pkg.name;
            const hostdata = await this.db.getStations(platformID);
            if (!hostdata) {
                return {
                    success: false,
                    message: "Failed to add user to MikroTik, Router not found!",
                };
            }
            const host = pkg.routerHost;
            const stationRecord = hostdata.find((s) => s.mikrotikHost === host);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            const isMoreThanOneDevice = Number(pkg.devices) > 1;
            const isData = pkg.category === "Data";
            const baseCode = code;
            const loginIdentifier =
                isMoreThanOneDevice || isData
                    ? baseCode
                    : (mac && mac !== "null"
                        ? mac
                        : baseCode);
            let addUserToMikrotik = { success: true, username: loginIdentifier, password: loginIdentifier };
            if (!isRadius) {
                const mikrotikData = {
                    platformID,
                    action: "add",
                    profileName,
                    host,
                    code: loginIdentifier
                };
                addUserToMikrotik = await this.manageMikrotikUser(mikrotikData)
                if (!addUserToMikrotik) {
                    return {
                        success: false,
                        message: "Failed to add user to MikroTik",
                    };
                }
            } else {
                const speedVal = String(pkg.speed || "").replace(/[^0-9.]/g, "");
                const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
                let dataLimitBytes = null;
                if (isData && pkg.usage && pkg.usage !== "Unlimited") {
                    const [value, unit] = String(pkg.usage).split(" ");
                    if (value && unit) {
                        try {
                            dataLimitBytes = this.convertToBytes(parseFloat(value), unit.toUpperCase());
                        } catch (error) {
                            dataLimitBytes = null;
                        }
                    }
                }
                await this.db.upsertRadiusUser({
                    username: loginIdentifier,
                    password: loginIdentifier,
                    groupname: pkg.name,
                    rateLimit,
                    dataLimitBytes,
                });
            }

            if (addUserToMikrotik.success) {
                let expireAt = null;
                if (pkg?.period) {
                    const now = new Date();
                    const period = pkg.period.toLowerCase();

                    const match = period.match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);

                    if (match) {
                        const value = parseInt(match[1]);
                        const unit = match[2].toLowerCase();

                        switch (unit) {
                            case 'minute':
                                expireAt = new Date(now.getTime() + value * 60000);
                                break;
                            case 'hour':
                                expireAt = new Date(now.getTime() + value * 3600000);
                                break;
                            case 'day':
                                expireAt = new Date(now.getTime() + value * 86400000);
                                break;
                            case 'month':
                                expireAt = new Date(now.setMonth(now.getMonth() + value));
                                break;
                            case 'year':
                                expireAt = new Date(now.setFullYear(now.getFullYear() + value));
                                break;
                        }
                    }
                }

                const addedcode = await this.db.createUser({
                    status: "active",
                    code: code,
                    platformID: platformID,
                    phone: phone,
                    username: addUserToMikrotik.username || loginIdentifier,
                    password: addUserToMikrotik.password || loginIdentifier,
                    packageID: packageID,
                    expireAt: expireAt,
                    token: token,
                    mac: mac
                });

                return {
                    success: true,
                    message: "Code added successfully",
                    code: addedcode,
                };
            } else {
                return {
                    success: false,
                    message: `Failed to add user to MikroTik, ${addUserToMikrotik.message}`,
                };
            }

        } catch (error) {
            console.log("An error occurred", error);
            return {
                success: false,
                message: "An error occurred while adding the user",
            };
        }
    }
}

module.exports = { Mikrotikcontroller };
