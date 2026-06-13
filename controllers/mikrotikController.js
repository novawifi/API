
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
const { getHotspotHash, renderOfflineBoxLoginTemplate, resolveApiBaseUrl } = require("../utils/hotspotTemplate");
const { buildMikrotikRescueScript, getMikrotikRescueConfig } = require("../utils/mikrotikRescue");
const net = require("net");
const { Mailer } = require("./mailerController");
const { SMS } = require("./smsController");
const { Auth } = require("./authController");
const cache = require("../utils/cache");
const { ensureRadiusClient, getRadiusClientIp, getRadiusServerIp } = require("../utils/radiusConfig");

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
            await Promise.race([
                channel.close(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Channel close timeout")), 3000)),
            ]);
        } catch (error) { }
    }

    getHotspotWalledGardenHosts() {
        const domain = (process.env.DOMAIN || process.env.NEXT_PUBLIC_DOMAIN || "novawifi.co.ke").toString();
        const hosts = [
            domain,
            `*.${domain}`,
            "api64.ipify.org",
            "fonts.googleapis.com",
            "fonts.gstatic.com",
            "connectivitycheck.gstatic.com",
            "captive.apple.com",
        ];
        try {
            const apiHost = new URL(resolveApiBaseUrl()).hostname;
            if (apiHost) {
                hosts.push(apiHost);
                hosts.push(`*.${apiHost}`);
            }
        } catch (error) { }
        return [...new Set(hosts.filter(Boolean))];
    }

    async ensureHotspotWalledGarden(channel) {
        const existing = await channel.write("/ip/hotspot/walled-garden/print", []);
        const existingHosts = new Set(
            (Array.isArray(existing) ? existing : [])
                .map((entry) => String(entry["dst-host"] || "").trim())
                .filter(Boolean)
        );
        for (const host of this.getHotspotWalledGardenHosts()) {
            if (existingHosts.has(host)) continue;
            await channel.write("/ip/hotspot/walled-garden/add", [
                `=dst-host=${host}`,
                "=action=allow",
            ]);
            existingHosts.add(host);
        }
    }

    async ensureMikrotikRescue(channel, routerHost) {
        const config = getMikrotikRescueConfig(routerHost);
        if (!config.enabled) {
            return { success: false, configured: false, reason: config.reason };
        }

        const fixes = [];
        const interfaces = await channel.write("/interface/sstp-client/print", []);
        const existing = (Array.isArray(interfaces) ? interfaces : [])
            .find((entry) => entry.name === config.interfaceName);
        const interfaceArgs = [
            `=connect-to=${config.server}`,
            `=port=${config.port}`,
            `=user=${config.username}`,
            `=password=${config.password}`,
            "=authentication=mschap2",
            "=profile=default-encryption",
            "=add-default-route=no",
            "=dial-on-demand=no",
            "=keepalive-timeout=30",
            "=tls-version=only-1.2",
            "=verify-server-certificate=yes",
            "=verify-server-address-from-certificate=yes",
            "=disabled=no",
            "=comment=Nova emergency rescue tunnel",
        ];

        if (existing?.[".id"]) {
            await channel.write("/interface/sstp-client/set", [
                `=.id=${existing[".id"]}`,
                ...interfaceArgs,
            ]);
            fixes.push("sstp_rescue_updated");
        } else {
            await channel.write("/interface/sstp-client/add", [
                `=name=${config.interfaceName}`,
                ...interfaceArgs,
            ]);
            fixes.push("sstp_rescue_added");
        }

        const services = await channel.write("/ip/service/print", ["?name=api"]);
        const apiService = Array.isArray(services) ? services[0] : null;
        if (apiService?.[".id"]) {
            const allowed = new Set(
                String(apiService.address || "")
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter(Boolean)
            );
            allowed.add("10.10.10.0/24");
            allowed.add(config.rescueSubnet);
            await channel.write("/ip/service/set", [
                `=.id=${apiService[".id"]}`,
                `=address=${[...allowed].join(",")}`,
                "=disabled=no",
            ]);
            fixes.push("sstp_rescue_api_allowed");
        }

        const firewall = await channel.write("/ip/firewall/filter/print", []);
        const rescueRule = (Array.isArray(firewall) ? firewall : [])
            .find((entry) => entry.comment === "Nova rescue management");
        const firewallArgs = [
            "=chain=input",
            `=in-interface=${config.interfaceName}`,
            `=src-address=${config.rescueSubnet}`,
            "=protocol=tcp",
            `=dst-port=${config.managementPorts}`,
            "=action=accept",
            "=comment=Nova rescue management",
            "=disabled=no",
        ];
        if (rescueRule?.[".id"]) {
            await channel.write("/ip/firewall/filter/set", [
                `=.id=${rescueRule[".id"]}`,
                ...firewallArgs,
            ]);
        } else {
            await channel.write("/ip/firewall/filter/add", [
                ...firewallArgs,
                "=place-before=0",
            ]);
        }
        fixes.push("sstp_rescue_firewall_allowed");

        const watchdogEvent = [
            `:local rescue [/interface/sstp-client/find name=\"${config.interfaceName}\"]`,
            ":if ([:len $rescue] > 0) do={",
            ":local restart false",
            ":if ([/interface/sstp-client/get $rescue running] = false) do={ :set restart true }",
            `:if (!$restart) do={ :if ([/ping address=${config.rescueGateway} interface=${config.interfaceName} count=3 interval=1s] = 0) do={ :set restart true } }`,
            ":if ($restart) do={ /interface/sstp-client disable $rescue; :delay 5s; /interface/sstp-client enable $rescue }",
            "}",
        ].join("; ");
        const schedulers = await channel.write("/system/scheduler/print", []);
        const watchdog = (Array.isArray(schedulers) ? schedulers : [])
            .find((entry) => entry.name === config.watchdogName);
        const schedulerArgs = [
            "=interval=2m",
            "=start-time=startup",
            `=on-event=${watchdogEvent}`,
            "=policy=read,write,test",
            "=disabled=no",
        ];
        if (watchdog?.[".id"]) {
            await channel.write("/system/scheduler/set", [
                `=.id=${watchdog[".id"]}`,
                ...schedulerArgs,
            ]);
        } else {
            await channel.write("/system/scheduler/add", [
                `=name=${config.watchdogName}`,
                ...schedulerArgs,
            ]);
        }
        fixes.push("sstp_rescue_watchdog_ready");

        return {
            success: true,
            configured: true,
            rescueAddress: config.rescueAddress,
            fixes,
        };
    }

    async configureMikrotikRescue(req, res) {
        const auth = await this.authenticateStationRequest(req);
        if (!auth.success) {
            return res.status(auth.status || 400).json({ success: false, message: auth.message });
        }

        const config = getMikrotikRescueConfig(auth.host);
        if (!config.enabled) {
            return res.status(503).json({
                success: false,
                message: `SSTP rescue is not available: ${config.reason}`,
            });
        }

        const connection = await this.config.createSingleMikrotikClient(auth.platformID, auth.host);
        if (!connection?.channel) {
            return res.status(502).json({ success: false, message: "Unable to connect to the selected MikroTik" });
        }
        if (connection.transport === "sstp-rescue") {
            await this.safeCloseChannel(connection.channel);
            return res.status(409).json({
                success: false,
                message: "The router is currently reachable only through SSTP rescue; refusing to reconfigure the active rescue tunnel.",
            });
        }

        try {
            const result = await this.ensureMikrotikRescue(connection.channel, auth.host);
            return res.status(200).json({
                success: true,
                message: "SSTP rescue connection configured",
                ...result,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: error?.message || "Failed to configure SSTP rescue connection",
            });
        } finally {
            await this.safeCloseChannel(connection.channel);
        }
    }

    async buildOfflineLoginTemplateHtml(platformID, stationHost) {
        const platform = await this.db.getPlatform(platformID);
        const config = await this.db.getPlatformConfig(platformID);
        const host = String(stationHost || config?.mikrotikHost || "").trim();
        let packages = [];
        if (host) {
            packages = await this.db.getPackagesByHost(platformID, host);
        } else {
            packages = await this.db.getPackages(platformID);
        }
        return renderOfflineBoxLoginTemplate({
            platform,
            config,
            packages,
            platformID,
            host,
            hash: getHotspotHash(host),
        });
    }

    async buildOnlineLoginTemplateHtml(platformID, stationHost) {
        const platform = await this.db.getPlatform(platformID);
        const config = await this.db.getPlatformConfig(platformID);
        if (!platform || !config) {
            throw new Error("Platform data not found");
        }

        const host = String(stationHost || config?.mikrotikHost || "").trim();
        const hash = getHotspotHash(host);
        const portalBase = String(
            platform.domain ||
            platform.url ||
            process.env.NEXT_PUBLIC_DOMAIN ||
            process.env.DOMAIN ||
            ""
        ).trim();
        if (!portalBase) {
            throw new Error("Platform portal URL is not configured");
        }
        const portalUrl = /^https?:\/\//i.test(portalBase)
            ? portalBase.replace(/\/+$/, "")
            : `https://${portalBase.replace(/\/+$/, "")}`;
        const loginUrl = `${portalUrl}/login?hash=${encodeURIComponent(hash)}&mac=$(mac)`;

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="pragma" content="no-cache">
<meta http-equiv="expires" content="-1">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WiFi Login</title>
<script src="/md5.js"></script>
<script>
function autoLogin() {
  var params = new URLSearchParams(window.location.search);
  var username = params.get("username");
  var password = params.get("password");
  if (username && password) {
    var form = document.createElement("form");
    form.action = "$(link-login-only)";
    form.method = "post";
    var user = document.createElement("input");
    user.type = "hidden";
    user.name = "username";
    user.value = username;
    form.appendChild(user);
    var pass = document.createElement("input");
    pass.type = "hidden";
    pass.name = "password";
    pass.value = hexMD5("$(chap-id)" + password + "$(chap-challenge)");
    form.appendChild(pass);
    var dst = document.createElement("input");
    dst.type = "hidden";
    dst.name = "dst";
    dst.value = "$(link-orig)";
    form.appendChild(dst);
    var popup = document.createElement("input");
    popup.type = "hidden";
    popup.name = "popup";
    popup.value = "true";
    form.appendChild(popup);
    document.body.appendChild(form);
    form.submit();
    return;
  }
  window.location.replace("${loginUrl}");
}
</script>
</head>
<body onload="autoLogin()">
<noscript><a href="${loginUrl}">Open WiFi login</a></noscript>
</body>
</html>`;
    }

    normalizeHotspotHtmlDirectory(value) {
        const directory = String(value || "hotspot")
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\/+|\/+$/g, "")
            .replace(/\/+/g, "/");
        const withoutLoginFile = directory.replace(/\/?login\.html$/i, "").replace(/^\/+|\/+$/g, "");
        return withoutLoginFile || "hotspot";
    }

    async resolveHotspotLoginFilePath(channel) {
        const fallbackDirectory = "hotspot";
        let hotspotServers = [];
        let profiles = [];

        try {
            hotspotServers = await channel.write(["/ip/hotspot/print"]);
        } catch (error) {
            hotspotServers = [];
        }

        try {
            profiles = await channel.write(["/ip/hotspot/profile/print"]);
        } catch (error) {
            profiles = [];
        }

        const profileByNameOrId = new Map();
        for (const profile of Array.isArray(profiles) ? profiles : []) {
            if (profile?.name) profileByNameOrId.set(String(profile.name), profile);
            if (profile?.[".id"]) profileByNameOrId.set(String(profile[".id"]), profile);
        }

        const activeServer = (Array.isArray(hotspotServers) ? hotspotServers : [])
            .find((server) => String(server?.disabled || "").toLowerCase() !== "true" && server?.profile);
        const profileRef = activeServer?.profile ? String(activeServer.profile) : "";
        const selectedProfile = profileByNameOrId.get(profileRef) || (Array.isArray(profiles) ? profiles[0] : null);
        const htmlDirectoryOverride = String(selectedProfile?.["html-directory-override"] || "").trim();
        const profileDirectory = htmlDirectoryOverride && htmlDirectoryOverride.toLowerCase() !== "none"
            ? htmlDirectoryOverride
            : selectedProfile?.["html-directory"];
        const htmlDirectory = this.normalizeHotspotHtmlDirectory(profileDirectory || fallbackDirectory);

        return `${htmlDirectory}/login.html`;
    }

    async writeHotspotLoginFile(channel, path, contents) {
        const safePath = `${this.normalizeHotspotHtmlDirectory(path)}/login.html`;
        const existingFiles = await channel.write(["/file/print", `?name=${safePath}`]);
        if (Array.isArray(existingFiles) && existingFiles.length > 0) {
            for (const file of existingFiles) {
                if (!file?.[".id"]) continue;
                await channel.write([
                    "/file/remove",
                    `=.id=${file[".id"]}`,
                ]);
            }
        }

        await channel.write([
            "/file/add",
            `=name=${safePath}`,
            `=contents=${contents}`,
        ]);
        return safePath;
    }

    async removeHotspotLoginFile(channel, path) {
        const safePath = `${this.normalizeHotspotHtmlDirectory(path)}/login.html`;
        await this.removeRouterFile(channel, safePath);
        return safePath;
    }

    async removeRouterFile(channel, safePath) {
        const existingFiles = await channel.write(["/file/print", `?name=${safePath}`]);
        if (Array.isArray(existingFiles) && existingFiles.length > 0) {
            for (const file of existingFiles) {
                if (!file?.[".id"]) continue;
                await channel.write([
                    "/file/remove",
                    `=.id=${file[".id"]}`,
                ]);
            }
        }
    }

    createHotspotLoginDownload(loginHtml) {
        const token = crypto.randomBytes(24).toString("hex");
        this.cache.set(`mkt:hotspot-login:${token}`, loginHtml, 2 * 60 * 1000);
        return `${resolveApiBaseUrl()}/mkt/hotspot/login-template/${token}.html`;
    }

    async fetchHotspotLoginFile(channel, path, contents) {
        const safePath = await this.removeHotspotLoginFile(channel, path);
        const url = this.createHotspotLoginDownload(contents);
        await channel.write([
            "/tool/fetch",
            `=url=${url}`,
            `=dst-path=${safePath}`,
            "=keep-result=yes",
            "=check-certificate=no",
        ]);
        return safePath;
    }

    async fetchHotspotFontAsset(channel, loginFilePath) {
        const htmlDirectory = this.normalizeHotspotHtmlDirectory(loginFilePath);
        const fileName = "nunito-sans-latin.woff2";
        const safePath = `${htmlDirectory}/${fileName}`;
        const url = `${resolveApiBaseUrl()}/mkt/hotspot/font/${fileName}`;

        await this.removeRouterFile(channel, safePath);
        await channel.write([
            "/tool/fetch",
            `=url=${url}`,
            `=dst-path=${safePath}`,
            "=keep-result=yes",
            "=check-certificate=no",
        ]);
        return safePath;
    }

    async downloadHotspotFontAsset(req, res) {
        const fileName = String(req.params?.fileName || "");
        if (fileName !== "nunito-sans-latin.woff2") {
            return res.status(404).send("Font asset not found");
        }

        const fontPath = path.join(appRoot, "assets", "hotspot-fonts", fileName);
        res.setHeader("Content-Type", "font/woff2");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.sendFile(fontPath);
    }

    async uploadHotspotLoginTemplate(platformID, stationHost, options = {}) {
        const mode = String(options.mode || "offline").toLowerCase() === "online" ? "online" : "offline";
        const loginHtml = mode === "online"
            ? await this.buildOnlineLoginTemplateHtml(platformID, stationHost)
            : await this.buildOfflineLoginTemplateHtml(platformID, stationHost);
        const connection = await this.config.createSingleMikrotikClient(platformID, stationHost);
        if (!connection?.channel) {
            return { success: false, message: "Failed to open MikroTik API connection" };
        }

        const channel = connection.channel;
        try {
            if (mode === "offline") {
                await this.ensureHotspotWalledGarden(channel);
            }
            const loginFilePath = await this.resolveHotspotLoginFilePath(channel);
            const fontPath = mode === "offline"
                ? await this.fetchHotspotFontAsset(channel, loginFilePath)
                : null;
            const writtenPath = await this.fetchHotspotLoginFile(channel, loginFilePath, loginHtml);
            return {
                success: true,
                path: writtenPath,
                fontPath,
                message: fontPath
                    ? `Offline template and Nunito Sans fetched to ${writtenPath}`
                    : `login.html fetched to ${writtenPath}`,
            };
        } finally {
            try { await channel.close?.(); } catch (err) { }
        }
    }

    async downloadHotspotLoginTemplate(req, res) {
        const token = String(req.params?.token || "").replace(/\.html$/i, "");
        const html = this.cache.get(`mkt:hotspot-login:${token}`);
        if (!html) {
            return res.status(404).send("login.html expired");
        }

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).send(html);
    }

    sanitizeRouterFilePath(value) {
        const normalized = String(value || "")
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\/+/, "")
            .replace(/\/+/g, "/");
        if (!normalized || normalized.includes("..") || /[\x00-\x1f]/.test(normalized)) {
            return "";
        }
        return normalized;
    }

    async authenticateStationRequest(req) {
        const token = req.body?.token || req.query?.token;
        const stationId = req.body?.stationId || req.query?.stationId;
        const stationHost = req.body?.host || req.query?.host || req.body?.station || req.query?.station;
        if (!token) return { success: false, status: 401, message: "Missing token" };

        const auth = await this.auth.AuthenticateRequest(token);
        if (!auth.success) {
            return { success: false, status: 401, message: auth.message || "Unauthorised" };
        }
        if (auth.admin?.role !== "superuser") {
            return { success: false, status: 403, message: "Unauthorised" };
        }

        const platformID = auth.admin.platformID;
        let station = null;
        if (stationId) {
            station = await this.db.getStation(stationId);
            if (!station || station.platformID !== platformID) {
                return { success: false, status: 404, message: "Selected station not found" };
            }
        } else if (stationHost) {
            const stations = await this.db.getStations(platformID);
            station = (Array.isArray(stations) ? stations : []).find((item) => item.mikrotikHost === stationHost);
            if (!station) {
                return { success: false, status: 404, message: "Selected station not found" };
            }
        }

        if (!station?.mikrotikHost) {
            return { success: false, status: 400, message: "Please select a MikroTik station" };
        }

        return { success: true, platformID, station, host: station.mikrotikHost };
    }

    async withRouterFileChannel(platformID, host, callback) {
        const connection = await this.config.createSingleMikrotikClient(platformID, host);
        if (!connection?.channel) {
            return { success: false, message: "Failed to connect to MikroTik" };
        }

        const channel = connection.channel;
        try {
            return await callback(channel);
        } finally {
            try { await channel.close?.(); } catch (err) { }
        }
    }

    mapRouterFile(file) {
        const name = String(file?.name || "");
        const size = Number(file?.size || 0);
        const type = String(file?.type || "").toLowerCase();
        const isDirectory = type === "directory" || (!name.includes(".") && file?.contents === undefined && size === 0);
        return {
            id: file?.[".id"] || "",
            name,
            type: type || (isDirectory ? "directory" : "file"),
            size,
            creationTime: file?.["creation-time"] || "",
            lastModified: file?.["last-modified"] || file?.["creation-time"] || "",
            isDirectory,
        };
    }

    async writeRouterFile(channel, path, contents) {
        const safePath = this.sanitizeRouterFilePath(path);
        if (!safePath) throw new Error("Invalid file path");
        const existingFiles = await channel.write(["/file/print", `?name=${safePath}`]);
        if (Array.isArray(existingFiles) && existingFiles.length > 0) {
            await channel.write([
                "/file/set",
                `=.id=${existingFiles[0][".id"]}`,
                `=contents=${contents}`,
            ]);
            return safePath;
        }

        await channel.write([
            "/file/add",
            `=name=${safePath}`,
            `=contents=${contents}`,
        ]);
        return safePath;
    }

    async readRouterFileContents(channel, filePath, file = {}) {
        const size = Number(file?.size || 0);
        const details = await channel.write([
            "/file/print",
            `=.proplist=.id,name,type,size,contents,creation-time,last-modified`,
            `?.id=${file[".id"]}`,
        ]).catch(() => []);
        const record = Array.isArray(details) && details[0] ? details[0] : file;
        const printedContents = record?.contents;
        if (typeof printedContents === "string" && (printedContents.length > 0 || size === 0)) {
            return { record, content: printedContents };
        }

        const chunkSize = 32768;
        const maxBytes = 2 * 1024 * 1024;
        const targetBytes = size > 0 ? Math.min(size, maxBytes) : maxBytes;
        let offset = 0;
        let content = "";

        while (offset < targetBytes) {
            const response = await channel.write([
                "/file/read",
                `=file=${filePath}`,
                `=offset=${offset}`,
                `=chunk-size=${Math.min(chunkSize, targetBytes - offset)}`,
            ]);
            const chunkRecord = Array.isArray(response) ? response[0] : response;
            const data = String(chunkRecord?.data ?? chunkRecord?.contents ?? "");
            if (!data) break;
            content += data;
            offset += data.length;
            if (data.length < chunkSize) break;
        }

        return { record, content };
    }

    async listMikrotikFiles(req, res) {
        try {
            const auth = await this.authenticateStationRequest(req);
            if (!auth.success) return res.status(auth.status).json({ success: false, message: auth.message });

            const result = await this.withRouterFileChannel(auth.platformID, auth.host, async (channel) => {
                const files = await channel.write(["/file/print"]);
                const hotspotPath = await this.resolveHotspotLoginFilePath(channel).catch(() => "hotspot/login.html");
                return {
                    success: true,
                    files: (Array.isArray(files) ? files : []).map((file) => this.mapRouterFile(file)),
                    hotspotDirectory: hotspotPath.replace(/\/login\.html$/i, ""),
                };
            });
            return res.json(result);
        } catch (error) {
            console.error("List MikroTik files error:", error);
            return res.status(500).json({ success: false, message: error?.message || "Failed to list MikroTik files" });
        }
    }

    async readMikrotikFile(req, res) {
        try {
            const auth = await this.authenticateStationRequest(req);
            if (!auth.success) return res.status(auth.status).json({ success: false, message: auth.message });
            const filePath = this.sanitizeRouterFilePath(req.body?.path || req.query?.path);
            if (!filePath) return res.status(400).json({ success: false, message: "Invalid file path" });

            const result = await this.withRouterFileChannel(auth.platformID, auth.host, async (channel) => {
                const matches = await channel.write(["/file/print", `?name=${filePath}`]);
                const file = Array.isArray(matches) ? matches[0] : null;
                if (!file?.[".id"]) return { success: false, message: "File not found" };
                const { record, content } = await this.readRouterFileContents(channel, filePath, file);
                return {
                    success: true,
                    file: this.mapRouterFile(record),
                    content,
                };
            });
            return res.status(result.success ? 200 : 404).json(result);
        } catch (error) {
            console.error("Read MikroTik file error:", error);
            return res.status(500).json({ success: false, message: error?.message || "Failed to read MikroTik file" });
        }
    }

    async uploadMikrotikFile(req, res) {
        try {
            const auth = await this.authenticateStationRequest(req);
            if (!auth.success) return res.status(auth.status).json({ success: false, message: auth.message });
            const filePath = this.sanitizeRouterFilePath(req.body?.path);
            const content = req.body?.content ?? "";
            if (!filePath) return res.status(400).json({ success: false, message: "Invalid upload path" });
            if (String(content).length > 1024 * 1024) {
                return res.status(413).json({ success: false, message: "File is too large for MikroTik API upload" });
            }

            const result = await this.withRouterFileChannel(auth.platformID, auth.host, async (channel) => {
                const writtenPath = await this.writeRouterFile(channel, filePath, String(content));
                return { success: true, message: "File uploaded successfully", path: writtenPath };
            });
            return res.json(result);
        } catch (error) {
            console.error("Upload MikroTik file error:", error);
            return res.status(500).json({ success: false, message: error?.message || "Failed to upload MikroTik file" });
        }
    }

    async moveMikrotikFile(req, res) {
        try {
            const auth = await this.authenticateStationRequest(req);
            if (!auth.success) return res.status(auth.status).json({ success: false, message: auth.message });
            const from = this.sanitizeRouterFilePath(req.body?.from);
            const to = this.sanitizeRouterFilePath(req.body?.to);
            if (!from || !to) return res.status(400).json({ success: false, message: "Invalid source or destination path" });

            const result = await this.withRouterFileChannel(auth.platformID, auth.host, async (channel) => {
                const matches = await channel.write(["/file/print", `?name=${from}`]);
                const file = Array.isArray(matches) ? matches[0] : null;
                if (!file?.[".id"]) return { success: false, message: "File not found" };
                await channel.write(["/file/set", `=.id=${file[".id"]}`, `=name=${to}`]);
                return { success: true, message: "File moved successfully", path: to };
            });
            return res.status(result.success ? 200 : 404).json(result);
        } catch (error) {
            console.error("Move MikroTik file error:", error);
            return res.status(500).json({ success: false, message: error?.message || "Failed to move MikroTik file" });
        }
    }

    async deleteMikrotikFile(req, res) {
        try {
            const auth = await this.authenticateStationRequest(req);
            if (!auth.success) return res.status(auth.status).json({ success: false, message: auth.message });
            const filePath = this.sanitizeRouterFilePath(req.body?.path);
            if (!filePath) return res.status(400).json({ success: false, message: "Invalid file path" });

            const result = await this.withRouterFileChannel(auth.platformID, auth.host, async (channel) => {
                const matches = await channel.write(["/file/print", `?name=${filePath}`]);
                const file = Array.isArray(matches) ? matches[0] : null;
                if (!file?.[".id"]) return { success: false, message: "File not found" };
                await channel.write(["/file/remove", `=.id=${file[".id"]}`]);
                return { success: true, message: "File deleted successfully" };
            });
            return res.status(result.success ? 200 : 404).json(result);
        } catch (error) {
            console.error("Delete MikroTik file error:", error);
            return res.status(500).json({ success: false, message: error?.message || "Failed to delete MikroTik file" });
        }
    }

    async withAuthenticatedStationChannel(req, res, callback) {
        const auth = await this.authenticateStationRequest(req);
        if (!auth.success) {
            res.status(auth.status).json({ success: false, message: auth.message });
            return null;
        }

        const connection = await this.config.createSingleMikrotikClient(auth.platformID, auth.host);
        if (!connection?.channel) {
            res.status(500).json({ success: false, message: "Failed to connect to MikroTik" });
            return null;
        }

        try {
            return await callback(connection.channel, auth);
        } finally {
            await this.safeCloseChannel(connection.channel);
        }
    }

    normalizeRouterDisabled(value) {
        return String(value || "").toLowerCase() === "true" || String(value || "").toLowerCase() === "yes";
    }

    async setIpServiceDisabled(channel, serviceName, disabledValue) {
        const services = await channel.write("/ip/service/print", [`?name=${serviceName}`]).catch(() => []);
        const service = Array.isArray(services) ? services[0] : null;
        if (!service?.[".id"]) return false;
        await channel.write("/ip/service/set", [`=.id=${service[".id"]}`, `=disabled=${disabledValue}`]);
        return true;
    }

    async getRouterQuickSettings(req, res) {
        try {
            const result = await this.withAuthenticatedStationChannel(req, res, async (channel, auth) => {
                const hotspotServers = await channel.write("/ip/hotspot/print", []).catch(() => []);
                const pppoeServers = await channel.write("/interface/pppoe-server/server/print", []).catch(() => []);
                const ipServices = await channel.write("/ip/service/print", []).catch(() => []);
                const dnsSettings = await channel.write("/ip/dns/print", []).catch(() => []);
                const cloudSettings = await channel.write("/ip/cloud/print", []).catch(() => []);

                const serviceByName = new Map((Array.isArray(ipServices) ? ipServices : []).map((service) => [service.name, service]));
                const dns = Array.isArray(dnsSettings) ? dnsSettings[0] : null;
                const cloud = Array.isArray(cloudSettings) ? cloudSettings[0] : null;
                const allEnabled = (items) => Array.isArray(items) && items.length > 0 && items.some((item) => !this.normalizeRouterDisabled(item.disabled));
                const countEnabled = (items) => Array.isArray(items) ? items.filter((item) => !this.normalizeRouterDisabled(item.disabled)).length : 0;

                return {
                    success: true,
                    station: { id: auth.station.id, name: auth.station.name, host: auth.host },
                    settings: {
                        hotspot: {
                            enabled: allEnabled(hotspotServers),
                            total: Array.isArray(hotspotServers) ? hotspotServers.length : 0,
                            enabledCount: countEnabled(hotspotServers),
                        },
                        pppoe: {
                            enabled: allEnabled(pppoeServers),
                            total: Array.isArray(pppoeServers) ? pppoeServers.length : 0,
                            enabledCount: countEnabled(pppoeServers),
                        },
                        api: {
                            enabled: !this.normalizeRouterDisabled(serviceByName.get("api")?.disabled),
                            port: serviceByName.get("api")?.port || "",
                        },
                        webfig: {
                            enabled: ["www", "www-ssl"].some((name) => !this.normalizeRouterDisabled(serviceByName.get(name)?.disabled)),
                            httpEnabled: !this.normalizeRouterDisabled(serviceByName.get("www")?.disabled),
                            httpsEnabled: !this.normalizeRouterDisabled(serviceByName.get("www-ssl")?.disabled),
                        },
                        dnsRemote: {
                            enabled: String(dns?.["allow-remote-requests"] || "").toLowerCase() === "yes",
                        },
                        ipCloud: {
                            enabled: String(cloud?.["ddns-enabled"] || "").toLowerCase() === "yes",
                            dnsName: cloud?.["dns-name"] || "",
                        },
                    },
                };
            });
            if (result) return res.json(result);
        } catch (error) {
            console.error("Router quick settings fetch error:", error);
            return res.status(500).json({ success: false, message: error?.message || "Failed to fetch router settings" });
        }
    }

    async updateRouterQuickSetting(req, res) {
        try {
            const setting = String(req.body?.setting || "").trim();
            const enabled = req.body?.enabled === true || req.body?.enabled === "true";
            const allowed = new Set(["hotspot", "pppoe", "api", "webfig", "dnsRemote", "ipCloud"]);
            if (!allowed.has(setting)) {
                return res.status(400).json({ success: false, message: "Invalid router setting" });
            }

            const result = await this.withAuthenticatedStationChannel(req, res, async (channel) => {
                const disabledValue = enabled ? "no" : "yes";
                const boolValue = enabled ? "yes" : "no";
                let touched = 0;

                if (setting === "hotspot") {
                    const servers = await channel.write("/ip/hotspot/print", []);
                    for (const server of Array.isArray(servers) ? servers : []) {
                        if (!server[".id"]) continue;
                        await channel.write("/ip/hotspot/set", [`=.id=${server[".id"]}`, `=disabled=${disabledValue}`]);
                        touched += 1;
                    }
                }

                if (setting === "pppoe") {
                    const servers = await channel.write("/interface/pppoe-server/server/print", []);
                    for (const server of Array.isArray(servers) ? servers : []) {
                        if (!server[".id"]) continue;
                        await channel.write("/interface/pppoe-server/server/set", [`=.id=${server[".id"]}`, `=disabled=${disabledValue}`]);
                        touched += 1;
                    }
                }

                if (setting === "api") {
                    touched = await this.setIpServiceDisabled(channel, "api", disabledValue) ? 1 : 0;
                }

                if (setting === "webfig") {
                    const http = await this.setIpServiceDisabled(channel, "www", disabledValue);
                    const https = await this.setIpServiceDisabled(channel, "www-ssl", disabledValue);
                    touched = Number(http) + Number(https);
                }

                if (setting === "dnsRemote") {
                    await channel.write("/ip/dns/set", [`=allow-remote-requests=${boolValue}`]);
                    touched = 1;
                }

                if (setting === "ipCloud") {
                    await channel.write("/ip/cloud/set", [`=ddns-enabled=${boolValue}`]);
                    touched = 1;
                }

                return {
                    success: true,
                    message: `${setting} ${enabled ? "enabled" : "disabled"} successfully`,
                    touched,
                };
            });
            if (result) return res.json(result);
        } catch (error) {
            console.error("Router quick setting update error:", error);
            return res.status(500).json({ success: false, message: error?.message || "Failed to update router setting" });
        }
    }

    async writeWithTimeout(channel, command, args = [], timeoutMs = 12000) {
        return Promise.race([
            channel.write(command, args),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Router command timeout: ${command}`)), timeoutMs)
            ),
        ]);
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
                .map((host) => (typeof host === "string" ? host.trim() : ""))
                .filter((host) => /^10\.10\.10\.\d+$/.test(host))
        );
        for (let i = 2; i <= 254; i += 1) {
            const candidate = `10.10.10.${i}`;
            if (!used.has(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    getCleanupExpiredHotspotScriptSource() {
        return `:local nowTs [/system clock get time]
:local nowDate [/system clock get date]

:foreach u in=[/ip hotspot user find] do={
    :local name [/ip hotspot user get $u name]
    :local comment [/ip hotspot user get $u comment]
    :local idx [:find $comment "exp="]

    :if ($idx != nil) do={
        :local expStr [:pick $comment ($idx + 4) ($idx + 24)]

        :if ([:len $expStr] = 20) do={
            :do {
                :local expTs [:totime $expStr]
                :local curTs [:totime ($nowDate . " " . $nowTs)]

                :if (($expTs != nil) and ($curTs != nil) and ($curTs >= $expTs)) do={
                    :foreach c in=[/ip hotspot cookie find where user=$name] do={
                        /ip hotspot cookie remove $c
                    }

                    :foreach a in=[/ip hotspot active find where user=$name] do={
                        /ip hotspot active remove $a
                    }

                    /ip hotspot user remove $u
                }
            } on-error={}
        }
    }
}`;
    }

    getCleanupExpiredHotspotSeedRsc() {
        const scriptName = "cleanup-expired-hotspot";
        const schedulerName = "cleanup-expired-hotspot";
        const source = this.getCleanupExpiredHotspotScriptSource();

        return [
            `/system script remove [find where name="${scriptName}"]`,
            `/system script add name="${scriptName}" source={`,
            source,
            `}`,
            `/system scheduler remove [find where name="${schedulerName}"]`,
            `/system scheduler add name="${schedulerName}" interval=1m on-event="${scriptName}" start-time=startup`,
        ].join("\n");
    }

    async getCleanupExpiredHotspotSeedScript(req, res) {
        try {
            res.setHeader("Content-Type", "text/plain");
            return res.status(200).send(this.getCleanupExpiredHotspotSeedRsc());
        } catch (error) {
            return res.status(500).send("Failed to generate cleanup seed script");
        }
    }

    getRouterCallbackBaseUrl() {
        const baseUrl = process.env.BASE_URL;
        if (baseUrl) return String(baseUrl).replace(/\/+$/, "");
        return this.getRouterApiBaseUrl();
    }

    getRouterHotspotToken() {
        const token =
            process.env.ROUTER_HOTSPOT_TOKEN ||
            process.env.ROUTER_BACKUP_TOKEN ||
            process.env.API_TOKEN;
        return token ? String(token).trim() : "";
    }

    getCleanup3gbNoExpiryTimeoutScriptSource({ baseUrl, platformID, token }) {
        const safeBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
        const safePlatformId = String(platformID || "").trim();
        const safeToken = String(token || "").trim();
        const profileName = "3GB No Expiry";

        return `:local profileName "${profileName}"
:local baseUrl "${safeBaseUrl}"
:local platformID "${safePlatformId}"
:local token "${safeToken}"

:local profIds [/ip hotspot user profile find where name=$profileName]
:if ([:len $profIds] = 0) do={
    :log warning ("[nova] Hotspot profile not found: " . $profileName)
    :return
}

:local profId [:pick $profIds 0]
:local sessionTimeout [/ip hotspot user profile get $profId session-timeout]

:if (($sessionTimeout = "") || ($sessionTimeout = "0s")) do={
    :log warning ("[nova] No session-timeout set for profile: " . $profileName)
    :return
}

:local sessionTimeoutTs [:totime $sessionTimeout]

:foreach u in=[/ip hotspot user find where profile=$profileName] do={
    :local name [/ip hotspot user get $u name]
    :local uptime [/ip hotspot user get $u uptime]
    :local limitUptime [/ip hotspot user get $u limit-uptime]
    :local shouldExpire false

    :do {
        :local upTs [:totime $uptime]

        :if (($limitUptime != "") && ($limitUptime != "0s")) do={
            :local limTs [:totime $limitUptime]
            :if (($upTs != nil) and ($limTs != nil) and ($upTs >= $limTs)) do={
                :set shouldExpire true
            }
        } else={
            :if (($upTs != nil) and ($sessionTimeoutTs != nil) and ($upTs >= $sessionTimeoutTs)) do={
                :set shouldExpire true
            }
        }
    } on-error={
        :set shouldExpire false
    }

    :if ($shouldExpire) do={
        :foreach c in=[/ip hotspot cookie find where user=$name] do={
            /ip hotspot cookie remove $c
        }

        :foreach a in=[/ip hotspot active find where user=$name] do={
            /ip hotspot active remove $a
        }

        /ip hotspot user remove $u

        :if (($baseUrl != "") and ($platformID != "") and ($token != "")) do={
            :do {
                /tool fetch url=($baseUrl . "/mkt/hotspot/expire?platformID=" . $platformID . "&username=" . $name . "&token=" . $token) keep-result=no
            } on-error={}
        }
    }
}`;
    }

    getCleanup3gbNoExpiryTimeoutSeedRsc({ baseUrl, platformID, token }) {
        const scriptName = "cleanup-3gb-no-expiry-timeout";
        const schedulerName = "cleanup-3gb-no-expiry-timeout";
        const source = this.getCleanup3gbNoExpiryTimeoutScriptSource({ baseUrl, platformID, token });

        return [
            `/system script remove [find where name="${scriptName}"]`,
            `/system script add name="${scriptName}" source={`,
            source,
            `}`,
            `/system scheduler remove [find where name="${schedulerName}"]`,
            `/system scheduler add name="${schedulerName}" interval=1m on-event="${scriptName}" start-time=startup`,
        ].join("\n");
    }

    async getCleanup3gbNoExpiryTimeoutSeedScript(req, res) {
        try {
            const platformID = String(req.params?.platformID || "").trim();
            const token = String(req.params?.token || "").trim();
            if (!platformID) return res.status(400).send("Missing platformID");
            if (!token) return res.status(400).send("Missing token");

            const expected = this.getRouterHotspotToken();
            if (!expected || token !== expected) {
                return res.status(401).send("Unauthorised");
            }

            const baseUrl = this.getRouterCallbackBaseUrl();
            if (!baseUrl) {
                return res
                    .status(500)
                    .send("Missing BASE_URL (or ROUTER_PUBLIC_BASE_URL/NEXT_PUBLIC_SERVER_URL/SERVER_URL/ROUTEROS_BASE_URL/API_DOMAIN/DOMAIN)");
            }

            res.setHeader("Content-Type", "text/plain");
            return res.status(200).send(
                this.getCleanup3gbNoExpiryTimeoutSeedRsc({
                    baseUrl,
                    platformID,
                    token: expected,
                })
            );
        } catch (error) {
            return res.status(500).send("Failed to generate 3GB No Expiry cleanup seed script");
        }
    }

    getRouterApiBaseUrl() {
        const explicit =
            process.env.ROUTER_PUBLIC_BASE_URL ||
            process.env.NEXT_PUBLIC_SERVER_URL ||
            process.env.SERVER_URL;
        if (explicit) {
            return String(explicit).replace(/\/+$/, "");
        }

        if (process.env.ROUTEROS_BASE_URL) {
            try {
                const parsed = new URL(String(process.env.ROUTEROS_BASE_URL));
                return `${parsed.protocol}//${parsed.host}`;
            } catch { }
        }

        if (process.env.API_DOMAIN) {
            const value = String(process.env.API_DOMAIN).trim();
            return /^https?:\/\//i.test(value) ? value.replace(/\/+$/, "") : `https://${value}`;
        }

        if (process.env.DOMAIN) {
            const domain = String(process.env.DOMAIN).trim();
            if (/^https?:\/\//i.test(domain)) return domain.replace(/\/+$/, "");
            return `https://api.${domain}`;
        }

        return "";
    }

    async expireHotspotUserFromRouter(req, res) {
        try {
            const platformID = String(req.query?.platformID || "").trim();
            const username = String(req.query?.username || "").trim();
            const token = String(req.query?.token || "").trim();

            if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID" });
            if (!username) return res.status(400).json({ success: false, message: "Missing username" });
            if (!token) return res.status(400).json({ success: false, message: "Missing token" });

            const expected = this.getRouterHotspotToken();
            if (!expected || token !== expected) {
                return res.status(401).json({ success: false, message: "Unauthorised" });
            }

            const updated = await this.db.expireHotspotUserByUsername(platformID, username);
            if (!updated) {
                return res.status(404).json({ success: false, message: "User not found" });
            }

            return res.status(200).json({
                success: true,
                message: "User expired",
                user: {
                    id: updated.id,
                    platformID: updated.platformID,
                    username: updated.username,
                    phone: updated.phone,
                    status: updated.status,
                    expireAt: updated.expireAt,
                    packageID: updated.packageID,
                },
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: error?.message || "Failed to expire user" });
        }
    }

    async seedCleanupExpiredHotspotScriptForStation(platformID, station) {
        const scriptFileName = "cleanup-expired-hotspot.rsc";
        const baseUrl = this.getRouterApiBaseUrl();
        if (!baseUrl) {
            return { success: false, message: "Missing ROUTER_PUBLIC_BASE_URL/NEXT_PUBLIC_SERVER_URL/SERVER_URL/ROUTEROS_BASE_URL/API_DOMAIN/DOMAIN" };
        }
        const scriptUrl = `${String(baseUrl).replace(/\/+$/, "")}/mkt/seed/cleanup-expired-hotspot.rsc`;

        const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
        if (!connection?.channel) {
            return { success: false, message: "No valid MikroTik connection" };
        }

        const { channel } = connection;
        try {
            await this.writeWithTimeout(channel, "/tool/fetch", [
                `=url=${scriptUrl}`,
                `=dst-path=${scriptFileName}`,
                "=keep-result=yes",
            ], 45000);

            await this.writeWithTimeout(channel, "/import", [
                `=file-name=${scriptFileName}`,
            ], 60000);

            try {
                await this.writeWithTimeout(channel, "/file/remove", [
                    `=numbers=${scriptFileName}`,
                ], 15000);
            } catch { }

            return {
                success: true,
                message: "Cleanup script imported and scheduler seeded successfully",
            };
        } catch (error) {
            return { success: false, message: error?.message || "Failed to seed cleanup script" };
        } finally {
            await this.safeCloseChannel(channel);
        }
    }

    formatHotspotExpiryComment(expireAt) {
        if (!expireAt) return "";
        const date = new Date(expireAt);
        if (Number.isNaN(date.getTime())) return "";
        const pad = (value) => String(value).padStart(2, "0");
        const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
        const mon = months[date.getMonth()];
        const dd = pad(date.getDate());
        const yyyy = date.getFullYear();
        const hh = pad(date.getHours());
        const mi = pad(date.getMinutes());
        const ss = pad(date.getSeconds());

        // RouterOS-friendly timestamp: mon/DD/YYYY HH:MM:SS
        return `exp=${mon}/${dd}/${yyyy} ${hh}:${mi}:${ss}`;
    }

    async manageMikrotikUser(data) {
        const { platformID, action, profileName, host, code, password, username, expireAt } = data;
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

                    const parseRetryNumber = (value, fallback) => {
                        const parsed = parseInt(String(value ?? ""), 10);
                        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
                    };
                    const maxAttempts = Math.max(
                        1,
                        parseRetryNumber(
                            data?.retryAttempts ?? process.env.MIKROTIK_ADD_CODE_RETRY_ATTEMPTS,
                            5
                        )
                    );

                    let lastAddError = null;
                    let attemptsUsed = 0;
                    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                        attemptsUsed = attempt;
                        try {
                            await this.mikrotik.addHotspotUser(channel, {
                                name: finalUsername,
                                password: finalPassword,
                                profile: profileName,
                                limitUptime: uptimeLimit,
                                limitBytesTotal: bytesTotal ? bytesTotal : 0,
                                comment: this.formatHotspotExpiryComment(expireAt),
                            });
                            lastAddError = null;
                            break;
                        } catch (err) {
                            lastAddError = err;
                            try {
                                const existingByName = await this.mikrotik.getHotspotUsersByName(channel, finalUsername);
                                if (Array.isArray(existingByName) && existingByName.length > 0) {
                                    lastAddError = null;
                                    break;
                                }
                            } catch { }
                        }
                    }
                    if (lastAddError) {
                        const msg = lastAddError?.message || String(lastAddError);
                        throw new Error(`Failed to add user after ${attemptsUsed} attempts: ${msg}`);
                    }
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
                        },
                        retryAttemptsUsed: attemptsUsed,
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
	                    dataLimitBytes: null,
	                    expireAt: record.expiresAt || null,
	                    period: plan?.period || record.period || null,
	                    sessionTimeoutSeconds: null,
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

    async updateMikrotikProfile(platformID, currentProfileName, newProfileName, rateLimit, pool, host, sharedUsers, uptimeLimit, category) {
        try {
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) return { success: false, message: `No valid MikroTik connection` };
            const { channel } = connection;
            try {
                const profiles = await this.mikrotik.listHotspotProfiles(channel);
                const existingProfile = profiles.find(p => p.name === currentProfileName);
                if (!existingProfile) {
                    const profileName = newProfileName || currentProfileName;
                    if (profiles.find(p => p.name === profileName)) return { success: true, message: "Profile already exists" };

                    let sharedUsersValue = sharedUsers;
                    if (sharedUsers !== undefined && sharedUsers !== null) {
                        if (String(sharedUsers).toLowerCase() === 'unlimited') sharedUsersValue = 'unlimited';
                        else {
                            const numUsers = Number(sharedUsers);
                            if (isNaN(numUsers) || numUsers < 1) return { success: false, message: "Invalid shared users value. Use a positive number or 'Unlimited'" };
                            sharedUsersValue = numUsers.toString();
                        }
                    }

                    let time = '';
                    if (uptimeLimit && uptimeLimit.trim() !== "Unlimited" && uptimeLimit.trim() !== "NoExpiry") {
                        time = this.formatUptime(uptimeLimit);
                        if (!this.isValidMikrotikTime(time)) return { success: false, message: `Invalid session-timeout format: ${time}. Use format like "1h30m" or "1d"` };
                    }

                    const isDataPackage = String(category || '').toLowerCase() === 'data';
                    const addMacCookie = isDataPackage ? "no" : "yes";
                    const macCookieTimeout = !isDataPackage && time ? time : undefined;
                    await this.mikrotik.addHotspotProfile(channel, {
                        name: profileName,
                        rateLimit,
                        sharedUsers: sharedUsersValue || 0,
                        pool,
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
                }
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

    async updatePPPoEPlan(req, res) {
        const { token, id, station, name, profile, servicename, pool, price, period, status } = req.body;
        if (!token || !id || !station || !name || !profile || !servicename || !price || !period || !status) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

            const platformID = auth.admin.platformID;
            const existing = await this.db.getPPPoEPlanById(id);
            if (!existing || existing.platformID !== platformID) {
                return res.status(404).json({ success: false, message: "PPPoE plan not found" });
            }

            const stations = await this.db.getStations(platformID);
            const stationRecord = stations.find((s) => s.mikrotikHost === station);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            if (!isRadius && !pool) {
                return res.status(400).json({ success: false, message: "Pool is required for API PPPoE plans" });
            }

            const normalizedStatus = String(status || "").toLowerCase() === "inactive" ? "inactive" : "active";
            const updated = await this.db.updatePPPoEPlan(id, {
                station,
                name,
                profile,
                servicename,
                pool: isRadius ? "" : pool,
                price,
                period,
                status: normalizedStatus,
            });
            if (!updated) {
                return res.status(500).json({ success: false, message: "Failed to update plan" });
            }
            return res.json({ success: true, message: "PPPoE plan updated successfully", plan: updated });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to update plan" });
        }
    }

    async deletePPPoEPlan(req, res) {
        const { token, id } = req.body;
        if (!token || !id) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }
        try {
            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
            if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

            const platformID = auth.admin.platformID;
            const existing = await this.db.getPPPoEPlanById(id);
            if (!existing || existing.platformID !== platformID) {
                return res.status(404).json({ success: false, message: "PPPoE plan not found" });
            }

            const pppoeUsers = (await this.db.getPPPoE(platformID)) || [];
            const hasUsers = pppoeUsers.some((entry) => entry.planId === id);
            if (hasUsers) {
                return res.status(400).json({
                    success: false,
                    message: "Cannot delete plan with existing PPPoE users. Reassign or delete users first.",
                });
            }

            const deleted = await this.db.deletePPPoEPlan(id);
            if (!deleted) {
                return res.status(500).json({ success: false, message: "Failed to delete plan" });
            }
            return res.json({ success: true, message: "PPPoE plan deleted successfully" });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to delete plan" });
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
            const sourcePlan = await this.db.getPPPoEPlanById(planId);
            if (!sourcePlan || sourcePlan.platformID !== platformID) {
                return res.status(404).json({ success: false, message: "PPPoE plan not found" });
            }
            if (sourcePlan.station !== station) {
                return res.status(400).json({ success: false, message: "Selected plan belongs to a different station" });
            }
            const stations = (await this.db.getStations(platformID)) || [];
            const stationRecord =
                stations.find((s) => s.mikrotikHost === station) ||
                stations.find((s) => s.mikrotikHost === sourcePlan.station) ||
                null;
            const linkGroupId = stationRecord?.linkGroupId || null;
            const linkedStations = linkGroupId
                ? stations.filter((s) => s.linkGroupId === linkGroupId)
                : stationRecord
                    ? [stationRecord]
                    : [];
            const targets = linkedStations.length > 0 ? linkedStations : [{ mikrotikHost: station, systemBasis: "API" }];

            const plans = (await this.db.getPPPoEPlans(platformID)) || [];
            const pickPlanForStation = (stationHost) => {
                if (!stationHost) return null;
                return (
                    plans.find((p) => p.station === stationHost && p.name === sourcePlan.name) ||
                    plans.find(
                        (p) =>
                            p.station === stationHost &&
                            p.profile === sourcePlan.profile &&
                            p.servicename === sourcePlan.servicename &&
                            p.pool === sourcePlan.pool
                    ) ||
                    null
                );
            };
            const computeExpireAt = (plan) => {
                let expireAt = null;
                if (plan?.period) {
                    const match = String(plan.period).toLowerCase().match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
                    if (match && normalizedStatus === "active") {
                        const value = parseInt(match[1]);
                        const unit = match[2].toLowerCase();
                        expireAt = Utils.addPeriod(new Date(), value, unit);
                    }
                }
                if (normalizedStatus === "expired") expireAt = new Date();
                if (normalizedStatus === "inactive") expireAt = null;
                return expireAt;
            };

            const config = await this.db.getPlatformConfig(platformID);
            const amountForPlan = (plan) => (normalizedStatus === "active" ? "0" : String(plan?.price || "0"));
            const sourceExpireAt = computeExpireAt(sourcePlan);
            const sourceAmount = amountForPlan(sourcePlan);
            const paymentLink = Math.random().toString(36).substring(2, 15);

            let accountNumber = "";
            if (config?.mpesaShortCodeType?.toLowerCase() === "paybill") {
                const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
                accountNumber = Array.from({ length: 3 }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join("");
            }

            const created = [];
            const createdDbIds = [];
            const addedSecretHosts = [];
            let didUpsertRadius = false;
            const isdisabled = normalizedStatus === "active" ? "no" : "yes";

            const existingDb = await this.db.getPPPoE(platformID);
            const existingOnTargets = (existingDb || []).find(
                (p) => p.clientname === clientname && targets.some((t) => t?.mikrotikHost && p.station === t.mikrotikHost)
            );
            if (existingOnTargets) {
                return res.status(400).json({ success: false, message: "PPPoE user already exists on a linked station" });
            }

            try {
                for (const t of targets) {
                    const stationHost = t?.mikrotikHost;
                    if (!stationHost) continue;
                    const basis = String(t?.systemBasis || "API").toUpperCase();
                    const targetPlan = pickPlanForStation(stationHost);
                    const effectivePlan = targetPlan || sourcePlan;
                    const expireAt = computeExpireAt(effectivePlan);
                    const amount = amountForPlan(effectivePlan);

                    if (basis !== "RADIUS") {
                        const connection = await this.config.createSingleMikrotikClient(platformID, stationHost);
                        if (!connection?.channel) throw new Error(`No valid MikroTik connection for ${stationHost}`);
                        const { channel } = connection;
                        try {
                            const existingSecrets = await this.mikrotik.listSecrets(channel);
                            const existingSecret = existingSecrets.find((s) => s.name === clientname);
                            if (existingSecret) {
                                throw new Error(`PPPoE user already exists on router ${stationHost}`);
                            }
                            await this.mikrotik.addSecret(channel, {
                                name: clientname,
                                password: clientpassword,
                                service: "pppoe",
                                profile: effectivePlan.profile,
                                disabled: isdisabled,
                            });
                            addedSecretHosts.push(stationHost);
                        } finally {
                            await this.safeCloseChannel(channel);
                        }
                    } else if (!didUpsertRadius) {
                        const speedSource = effectivePlan.profile || effectivePlan.name || "";
                        const speedVal = String(speedSource).replace(/[^0-9.]/g, "");
                        const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
                        await this.db.upsertRadiusUser({
                            username: clientname,
                            password: clientpassword,
                            groupname: effectivePlan.name,
                            rateLimit,
                            dataLimitBytes: null,
                            expireAt: normalizedStatus === "active" ? (expireAt || null) : new Date(Date.now() - 60000),
                            period: effectivePlan.period,
                            sessionTimeoutSeconds: null,
                        });
                        didUpsertRadius = true;
                    }

                    const pppoeData = {
                        name: effectivePlan.name,
                        profile: effectivePlan.profile,
                        servicename: effectivePlan.servicename,
                        station: stationHost,
                        pool: effectivePlan.pool,
                        platformID,
                        devices: "100",
                        price: effectivePlan.price,
                        period: effectivePlan.period,
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
                        planId: targetPlan ? targetPlan.id : null,
                    };
                    const result = await this.db.createPPPoE(pppoeData);
                    created.push(result);
                    if (result?.id) createdDbIds.push(result.id);
                }
            } catch (err) {
                if (didUpsertRadius) {
                    try { await this.db.deleteRadiusUser(clientname); } catch { }
                }
                for (const id of createdDbIds) {
                    try { await this.db.deletePPPoE(id); } catch { }
                }
                for (const host of addedSecretHosts) {
                    try {
                        const connection = await this.config.createSingleMikrotikClient(platformID, host);
                        if (!connection?.channel) continue;
                        const { channel } = connection;
                        try {
                            const secrets = await this.mikrotik.listSecrets(channel);
                            const secret = secrets.find((s) => s.name === clientname);
                            if (secret) await this.mikrotik.deleteSecret(channel, secret[".id"]);
                        } finally {
                            await this.safeCloseChannel(channel);
                        }
                    } catch { }
                }
                throw err;
            }

            if (created.length === 0) {
                return res.status(500).json({ success: false, message: "No target stations available for PPPoE creation" });
            }
            const primary = created.find((p) => p.station === station) || created[0] || null;

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
                            package: sourcePlan.name,
                            price: sourcePlan.price,
                            amount: sourceAmount,
                            expiry: sourceExpireAt ? sourceExpireAt : null,
                            paymentLink: `<a href="https://${platform.url}/pppoe?info=${paymentLink}">https://${platform.url}/pppoe?info=${paymentLink}</a>`,
                            accountNumber: accountNumber || "",
                        })
                        : `<p>Your PPPoE credentials have been created by <strong>${platform.name}</strong>.</p><p><strong>-- PPPoE Credentials --</strong><br />Name: ${clientname}<br />Password: ${clientpassword}</p><p>For more status and information about this service, visit:<br /><a href="https://${platform.url}/pppoe?info=${paymentLink}">https://${platform.url}/pppoe?info=${paymentLink}</a></p>`;
                } else {
                    message = template?.pppoeInactiveTemplate
                        ? Utils.formatMessage(template.pppoeInactiveTemplate, {
                            name: clientname,
                            password: clientpassword,
                            email,
                            company: platform.name,
                            package: sourcePlan.name,
                            price: sourcePlan.price,
                            amount: sourceAmount,
                            expiry: sourceExpireAt ? sourceExpireAt : null,
                            paymentLink: `<a href="https://${platform.url}/pppoe?info=${paymentLink}">https://${platform.url}/pppoe?info=${paymentLink}</a>`,
                            accountNumber: accountNumber || "",
                        })
                        : `<p>Your PPPoE account is currently inactive.</p><p><strong>-- PPPoE Credentials --</strong><br />Name: ${clientname}<br />Password: ${clientpassword}</p><p>To activate your credentials, please pay KSH ${sourceAmount} for your ${sourcePlan.name} plan.<br />Visit <a href="https://${platform.url}/pppoe?info=${paymentLink}">https://${platform.url}/pppoe?info=${paymentLink}</a> to complete payment.</p>`;
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
                                username: sourcePlan.name,
                                period: sourcePlan.period,
                                amount: sourceAmount,
                                package: sourcePlan.profile,
                                expiry: sourceExpireAt,
                                paymentLink: `https://${platform.url}/pppoe?info=${paymentLink}`,
                                accountNumber: accountNumber || "",
                            });
                        } else {
                            sms_message = Utils.formatMessage(sms.pppoeInactiveSMS, {
                                company: platform.name,
                                username: sourcePlan.name,
                                period: sourcePlan.period,
                                amount: sourceAmount,
                                package: sourcePlan.profile,
                                expiry: sourceExpireAt,
                                paymentLink: `https://${platform.url}/pppoe?info=${paymentLink}`,
                                accountNumber: accountNumber || "",
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
            return res.json({
                success: true,
                message: targets.length > 1 ? `PPPoE created on ${targets.length} linked stations` : "PPPoE created successfully",
                pppoe: primary,
                linkedStations: targets.map((t) => t?.mikrotikHost).filter(Boolean),
            });
        } catch (error) {
            return res.status(500).json({ success: false, message: "An error occured, try again!" });
	        }
	    }

	    async importPPPoEUsersFromRouter(req, res) {
	        const { token, sourceStation, destinationStation } = req.body || {};
	        if (!token || !sourceStation || !destinationStation) {
	            return res.status(400).json({ success: false, message: "Missing required fields" });
	        }
	        if (String(sourceStation) === String(destinationStation)) {
	            return res.status(400).json({ success: false, message: "Source and destination stations cannot be the same" });
	        }

	        let sourceChannel = null;
	        let destinationChannel = null;
	        try {
	            const auth = await this.auth.AuthenticateRequest(token);
	            if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
	            if (auth.admin.role !== "superuser") return res.status(403).json({ success: false, message: "Unauthorised!" });
	            const platformID = auth.admin.platformID;

	            const existingDb = (await this.db.getPPPoE(platformID)) || [];
	            const sourceDb = existingDb.filter((entry) => entry.station === sourceStation);
	            const destinationDb = existingDb.filter((entry) => entry.station === destinationStation);
	            const destinationByName = new Map(destinationDb.map((entry) => [entry.clientname, entry]));

	            let dbCreated = 0;
	            let dbUpdated = 0;
	            const dbResults = [];

	            for (const entry of sourceDb) {
	                const username = String(entry.clientname || "").trim();
	                if (!username) continue;

	                const password = String(entry.clientpassword || "");
	                const profile = String(entry.profile || "default");
	                const status = String(entry.status || "active").toLowerCase() === "active" ? "active" : "inactive";

	                const existing = destinationByName.get(username);
	                if (existing?.id) {
	                    const updated = await this.db.updatePPPoE(existing.id, {
	                        name: entry.name || existing.name,
	                        profile,
	                        servicename: entry.servicename || existing.servicename,
	                        pool: entry.pool || existing.pool,
	                        price: entry.price || existing.price,
	                        period: entry.period || existing.period,
	                        devices: entry.devices || existing.devices,
	                        clientpassword: password,
	                        status,
	                        email: entry.email || existing.email,
	                        phone: entry.phone || existing.phone,
	                        customFields: entry.customFields || existing.customFields || {},
	                    });
	                    if (updated) {
	                        dbUpdated += 1;
	                        dbResults.push(updated);
	                    }
	                    continue;
	                }

	                const paymentLink = Math.random().toString(36).substring(2, 15);
	                const created = await this.db.createPPPoE({
	                    name: entry.name || profile || "Imported",
	                    profile,
	                    servicename: entry.servicename || "",
	                    station: destinationStation,
	                    pool: entry.pool || "",
	                    platformID,
	                    devices: entry.devices || "100",
	                    price: entry.price || null,
	                    period: entry.period || null,
	                    status,
	                    clientname: username,
	                    clientpassword: password,
	                    interface: entry.interface || "",
	                    maxsessions: entry.maxsessions || "",
	                    amount: "0",
	                    paymentLink,
	                    email: entry.email || null,
	                    phone: entry.phone || null,
	                    customFields: entry.customFields || {},
	                });
	                if (created) {
	                    dbCreated += 1;
	                    destinationByName.set(username, created);
	                    dbResults.push(created);
	                }
	            }

	            const summary = {
	                sourceStation,
	                destinationStation,
	                scanned: sourceDb.length,
	                dbCreated,
	                dbUpdated,
	                routerConnected: false,
	                routerAdded: 0,
	                routerSkippedExisting: 0,
	                routerErrors: [],
	            };

	            const destinationConnection = await this.config.createSingleMikrotikClient(platformID, destinationStation);
	            if (destinationConnection?.channel) {
	                destinationChannel = destinationConnection.channel;
	                summary.routerConnected = true;
	                try {
	                    const destinationSecrets = await this.mikrotik.listSecrets(destinationChannel);
	                    const existingNames = new Set(
	                        (Array.isArray(destinationSecrets) ? destinationSecrets : [])
	                            .map((s) => (s?.name ? String(s.name) : ""))
	                            .filter(Boolean)
	                    );

	                    for (const entry of sourceDb) {
	                        const username = String(entry.clientname || "").trim();
	                        if (!username) continue;
	                        if (existingNames.has(username)) {
	                            summary.routerSkippedExisting += 1;
	                            continue;
	                        }

	                        const password = String(entry.clientpassword || "");
	                        const profile = String(entry.profile || "default");
	                        const isDisabled = String(entry.status || "active").toLowerCase() !== "active";
	                        const disabled = isDisabled ? "yes" : "no";

	                        try {
	                            await this.mikrotik.addSecret(destinationChannel, {
	                                name: username,
	                                password,
	                                service: "pppoe",
	                                profile,
	                                disabled,
	                            });
	                            summary.routerAdded += 1;
	                        } catch (error) {
	                            summary.routerErrors.push({
	                                name: username,
	                                message: error?.message || String(error),
	                            });
	                        }
	                    }
	                } finally {
	                    await this.safeCloseChannel(destinationChannel);
	                    destinationChannel = null;
	                }
	            }

	            await this.pushDashboardStats(platformID);
	            return res.json({
	                success: true,
	                message: sourceDb.length > 0 ? "PPPoE import completed" : "No PPPoE users found for source station",
	                summary,
	                imported: dbResults,
	            });
	        } catch (error) {
	            return res.status(500).json({ success: false, message: "Failed to import PPPoE users" });
	        } finally {
	            await this.safeCloseChannel(sourceChannel);
	            await this.safeCloseChannel(destinationChannel);
	        }
	    }

	    async updatePPPoEUser(req, res) {
	        const { token, id, planId, clientname, clientpassword, status, email, phone, customFields, expiresAt } = req.body;
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
            if (client.platformID !== platformID) {
                return res.status(403).json({ success: false, message: "Unauthorised!" });
            }
            const plan = planId ? await this.db.getPPPoEPlanById(planId) : null;
            if (planId && (!plan || plan.platformID !== platformID)) {
                return res.status(404).json({ success: false, message: "PPPoE plan not found" });
            }
            if (plan && plan.station !== client.station) {
                return res.status(400).json({ success: false, message: "Selected plan belongs to a different station" });
            }

            const stations = await this.db.getStations(platformID);
            const stationRecord = stations.find((s) => s.mikrotikHost === client.station);
            const isRadius = stationRecord?.systemBasis === "RADIUS";
            const effectiveStatus = normalizedStatus || String(client.status || "active").toLowerCase();
            const platformClients = (await this.db.getPPPoE(platformID)) || [];
            const duplicateClient = platformClients.find(
                (entry) => entry.id !== id && entry.station === client.station && entry.clientname === clientname
            );
            if (duplicateClient) {
                return res.status(400).json({ success: false, message: "PPPoE user already exists on this station" });
            }

            let expireAt = client.expiresAt ? new Date(client.expiresAt) : null;
            let overrideExpireAt = null;
            if (expiresAt) {
                const parsed = new Date(expiresAt);
                if (Number.isNaN(parsed.getTime())) {
                    return res.status(400).json({ success: false, message: "Invalid expiresAt value" });
                }
                overrideExpireAt = parsed;
            }

            if (overrideExpireAt && effectiveStatus === "active") {
                expireAt = overrideExpireAt;
            } else if (plan?.period) {
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
	                    dataLimitBytes: null,
	                    expireAt: effectiveStatus === "active" ? (expireAt || null) : new Date(Date.now() - 60000),
	                    period: plan ? plan.period : client.period,
	                    sessionTimeoutSeconds: null,
	                });
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
            if (client.platformID !== platformID) {
                return res.status(403).json({ success: false, message: "Unauthorised!" });
            }
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
            } else {
                const speedSource = client.profile || client.name || "";
                const speedVal = String(speedSource).replace(/[^0-9.]/g, "");
                const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
                let expireAt = null;
                if (newStatus === "active" && client.period) {
                    const match = String(client.period).toLowerCase().match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
                    if (match) {
                        expireAt = Utils.addPeriod(new Date(), parseInt(match[1]), match[2].toLowerCase());
                    }
                }
                await this.db.upsertRadiusUser({
                    username: client.clientname,
                    password: client.clientpassword,
                    groupname: client.name,
                    rateLimit,
                    dataLimitBytes: null,
                    expireAt: newStatus === "active" ? expireAt : new Date(Date.now() - 60000),
                    period: client.period,
                    sessionTimeoutSeconds: null,
                });
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
            if (client && client.platformID !== platformID) {
                return res.status(403).json({ success: false, message: "Unauthorised!" });
            }
            const existingDb = (await this.db.getPPPoE(platformID)) || [];
            const duplicateClient = existingDb.find(
                (entry) => entry.id !== id && entry.station === station && entry.clientname === clientname
            );
            if (duplicateClient) {
                return res.status(400).json({ success: false, message: "PPPoE user already exists on this station" });
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
            if (isRadius) {
                const speedSource = thisprofile || name || "";
                const speedVal = String(speedSource).replace(/[^0-9.]/g, "");
                const rate = speedVal ? `${speedVal}M/${speedVal}M` : "";
                await this.db.upsertRadiusUser({
                    username: clientname,
                    password: clientpassword,
                    groupname: name,
                    rateLimit: rate,
                    dataLimitBytes: null,
                    expireAt: effectiveStatus === "active" ? (expireAt || null) : new Date(Date.now() - 60000),
                    period: period,
                    sessionTimeoutSeconds: null,
                });
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
            let accountNumber = id ? (client?.accountNumber || "") : "";
            const config = await this.db.getPlatformConfig(platformID);
            if (!id && config) {
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
                        accountNumber: accountNumber || "",
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
                        accountNumber: accountNumber || "",
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
                            accountNumber: accountNumber || "",
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
                            accountNumber: accountNumber || "",
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
            if (client.platformID !== platformID) {
                return res.status(403).json({ success: false, message: "Unauthorised!" });
            }
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
            await this.db.deletePPPoE(id);
            this.cache.delPrefix(`main:pppoe:${platformID}:`);
            this.cache.delPrefix(`main:search:${platformID}:pppoe`);
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
            const serverWgPublicKey = process.env.WIREGUARD_PUBLIC_KEY || "xPCGwCHqAGaAbBlYHs6Af7OIAdoBsAQ5PVvEjmZb2zo=";
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
            await this.ensureHotspotWalledGarden(channel);

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
                const radiusServerIp = stationRecord?.radiusServerIp || getRadiusServerIp();
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
                if (!bridgeInterface) {
                    return res.status(400).json({
                        success: false,
                        message: "No valid interface found for PPPoE server on this station.",
                    });
                }
                const poolBaseName = "PPPoE_Pool";
                const poolRange = "41.41.0.2-41.41.255.254";
                const gatewayAddress = "41.41.0.1/16";
                const gatewayNetwork = "41.41.0.0";

                // Pool is required for both API and RADIUS PPPoE deployments.
                const pools = await this.mikrotik.listPools(channel);
                let poolName = "";
                const exactPool = pools.find((p) => String(p.name || "") === poolBaseName);
                if (exactPool) {
                    poolName = poolBaseName;
                } else {
                    const fallbackPool = pools.find((p) => String(p.name || "").startsWith(`${poolBaseName}_`));
                    if (fallbackPool?.name) {
                        poolName = String(fallbackPool.name);
                    }
                }
                if (!poolName) {
                    poolName = poolBaseName;
                    await this.mikrotik.addPool(channel, {
                        name: poolName,
                        ranges: poolRange,
                        comment: "PPPoE Auto Configuration Pool",
                    });
                } else {
                    const targetPool = pools.find((p) => String(p.name || "") === poolName);
                    if (targetPool?.[".id"] && String(targetPool.ranges || "") !== poolRange) {
                        await this.mikrotik.updatePool(channel, targetPool[".id"], { ranges: poolRange });
                    }
                }

                // Ensure gateway IP exists on the chosen PPPoE interface for both system bases.
                const addresses = await this.mikrotik.listIPAddresses(channel);
                const hasGateway = Array.isArray(addresses)
                    ? addresses.some((a) =>
                        String(a.address || "").startsWith("41.41.0.1/") &&
                        String(a.interface || "") === String(bridgeInterface || "")
                    )
                    : false;
                if (!hasGateway) {
                    await this.mikrotik.addIPAddress(channel, {
                        address: gatewayAddress,
                        network: gatewayNetwork,
                        intf: bridgeInterface,
                        comment: "PPPoE Auto Configuration Gateway",
                    });
                }

                const profiles = await this.mikrotik.listPPPProfiles(channel);
                const speeds = [5, 8, 10, 15, 20];
                for (let speed of speeds) {
                    const profileName = `${speed}MBPS`;
                    const existing = profiles.find(p => p.name === profileName);
                    if (!existing) {
                        await this.mikrotik.addPPPProfile(channel, {
                            name: profileName,
                            localAddress: "41.41.0.1",
                            remoteAddress: poolName,
                            dnsServer: "1.1.1.1",
                            rateLimit: `${speed}M/${speed}M`
                        });
                    } else if (existing[".id"]) {
                        const updates = {};
                        if (String(existing["remote-address"] || "") !== poolName) {
                            updates["remote-address"] = poolName;
                        }
                        if (String(existing["local-address"] || "") !== "41.41.0.1") {
                            updates["local-address"] = "41.41.0.1";
                        }
                        if (String(existing["dns-server"] || "") !== "1.1.1.1") {
                            updates["dns-server"] = "1.1.1.1";
                        }
                        if (String(existing["rate-limit"] || "") !== `${speed}M/${speed}M`) {
                            updates["rate-limit"] = `${speed}M/${speed}M`;
                        }
                        if (Object.keys(updates).length > 0) {
                            await this.mikrotik.updatePPPProfile(channel, existing[".id"], updates);
                        }
                    }
                }
                if (isRadius) {
                    const radiusServerIp = stationRecord?.radiusServerIp || getRadiusServerIp();
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

                const priceMap = {
                    3: "1200",
                    5: "1500",
                    8: "1800",
                    10: "2000",
                    15: "2500",
                    20: "3000"
                };

                for (const speed of speeds) {
                    const profileName = `${speed}MBPS`;
                    const exists = stationPlans.find((plan) => plan.name === profileName);
                    if (exists) continue;
                    const price = priceMap[speed] || String(speed);
                    const created = await this.db.createPPPoEPlan({
                        platformID,
                        station,
                        name: profileName,
                        profile: profileName,
                        servicename: servername,
                        pool: poolName,
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
            return res.status(500).json({
                success: false,
                message: error?.message || "An error occurred during PPPoE auto configuration",
            });
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
                const pools = await this.mikrotik.listPools(channel);
                const base = "PPPoE_Pool";
                let poolName = null;
                if (pools.find((p) => p.name === base)) {
                    poolName = base;
                } else {
                    const fallback = pools.find((p) => String(p.name || "").startsWith(`${base}_`));
                    if (fallback?.name) poolName = String(fallback.name);
                }
                if (!poolName) {
                    return res.json({ autoconfigured: false, message: "No valid PPPoE Pool found" });
                }

                const speeds = [5, 8, 10, 15, 20];
                const profiles = await this.mikrotik.listPPPProfiles(channel);
                for (let speed of speeds) {
                    const profileName = `${speed}MBPS`;
                    const profile = profiles.find(p => p.name === profileName);
                    if (!profile) return res.json({ autoconfigured: false, message: `Profile ${profileName} not found` });
                    if (profile["remote-address"] !== poolName) {
                        return res.json({ autoconfigured: false, message: `Profile ${profileName} not linked to ${poolName}` });
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
                    const radiusServerIp = stationRecord?.radiusServerIp || getRadiusServerIp();
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
	                const dhcpClientInterfaces = new Set();
	                try {
	                    const dhcpClients = await channel.write("/ip/dhcp-client/print", ["?disabled=no"]);
	                    for (const entry of Array.isArray(dhcpClients) ? dhcpClients : []) {
	                        const intf = String(entry.interface || "").trim();
	                        if (intf) dhcpClientInterfaces.add(intf);
	                    }
	                } catch {
	                    // If DHCP client menu is unavailable, skip WAN detection.
	                }
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
	                    const nameLower = name.toLowerCase();
	                    if (!name) return false;
	                    if (nameLower === "ether1") return false;
	                    // Don't bridge the WAN interface (DHCP client).
	                    if (dhcpClientInterfaces.has(name)) return false;
	                    // Never bridge SFP/SFP+ ports.
	                    if (nameLower.startsWith("sfp")) return false;
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
	                await this.ensureHotspotWalledGarden(channel);
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
                // Ensure the hotspot server has the address pool set (some routers ignore it on add).
                const createdServers = await channel.write("/ip/hotspot/print", [`?name=${serverName}`]);
                const createdServer = Array.isArray(createdServers) ? createdServers[0] : null;
                if (createdServer && createdServer[".id"]) {
                    const currentPool = String(createdServer["address-pool"] || "").trim();
                    if (!currentPool || currentPool.toLowerCase() === "none" || currentPool !== poolName) {
                        await channel.write("/ip/hotspot/set", [
                            `=.id=${createdServer[".id"]}`,
                            `=address-pool=${poolName}`,
                        ]);
                    }
                }

                if (isRadius && stationRecord?.radiusClientSecret) {
                    const radiusServerIp = stationRecord.radiusServerIp || getRadiusServerIp();
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
                    const upload = await this.uploadHotspotLoginTemplate(platformID, stationRecord?.mikrotikHost || station);
                    if (!upload.success) uploadError = upload.message || "Failed to upload login.html";
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

                const radiusServerIp = stationRecord?.radiusServerIp || getRadiusServerIp();
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
                role: auth.admin.role,
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
        const token = req.params?.token || req.query.token;
        const serverUrl = (req.query.server || "").toString().replace(/\/+$/, "");
        const requestedName = (req.query.name || "").toString();
        const requestedBasis = (req.query.systemBasis || "").toString();
        if (!token) return res.status(400).send("Missing token");
        const session = this.routerAutoSessions.get(token);
        if (!session) return res.status(404).send("Invalid session");
        const platformID = session.platformID;

        try {
            const platform = await this.db.getPlatform(platformID);
            const rawSsid = (platform?.name).toString().trim();
            const ssid = rawSsid.replace(/[\r\n"]/g, "").slice(0, 32);

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
            const stations = session.role === "superuser"
                ? await this.db.getAllStations()
                : await this.db.getStations(platformID);
            const normalizeHost = (host) => (typeof host === "string" ? host.trim() : "");
            const stationHosts = (stations || [])
                .map((s) => normalizeHost(s.mikrotikHost))
                .filter(Boolean);
            const reservedHosts = Array.from(this.routerAutoSessions.values())
                .filter((s) => s && s.platformID === platformID)
                .map((s) => normalizeHost(s.mikrotikHost))
                .filter(Boolean);
            const usedHosts = stationHosts.concat(reservedHosts);
            const sessionHost = normalizeHost(session.mikrotikHost);
            const isAutoIp = (ip) => {
                if (!/^10\.10\.10\.\d+$/.test(ip)) return false;
                const last = Number(ip.split(".")[3]);
                return last >= 2 && last <= 254;
            };
            const internalIp =
                sessionHost && isAutoIp(sessionHost)
                    ? sessionHost
                    : this.getNextAutoRouterIp(usedHosts);
            if (!internalIp) {
                return res.status(400).send("No available IPs in 10.10.10.0/24");
            }

            const apiUser = session.apiUser || `nova-${crypto.randomBytes(3).toString("hex")}`;
            const apiPass = session.apiPass || crypto.randomBytes(6).toString("hex");
            session.apiUser = apiUser;
            session.apiPass = apiPass;
            session.mikrotikHost = internalIp;
            this.routerAutoSessions.set(token, session);

	            const callbackBaseUrl = this.getRouterCallbackBaseUrl();
	            const baseUrl = serverUrl || callbackBaseUrl || `${req.protocol}://${req.get("host")}`;
	            const routerosBasePrimaryUrl = String(process.env.ROUTEROS_BASE_URL || `${baseUrl}/routeros`).replace(/\/+$/, "");
	            const routerosBaseFallbackUrl = String(`${baseUrl}/routeros`).replace(/\/+$/, "");
            const logBase = `${baseUrl}/mkt/auto-router/log?token=${token}&msg=`;
            const completeUrl = `${baseUrl}/mkt/auto-router/complete?token=${token}`;
            const routerName = (session.name || "")
                .toString()
                .replace(/"/g, "")
                .replace(/\s+/g, "-");
            const scriptUrl = `${baseUrl}/mkt/auto-router/script/${token}`;
            const endpointAddress = (process.env.SERVER_IP || "77.37.97.244").toString().split(":")[0];
            const endpointPort = (process.env.SERVER_WIREGUARD_PORT || "51820").toString();
	            const serverWgPublicKey = process.env.WIREGUARD_PUBLIC_KEY || "xPCGwCHqAGaAbBlYHs6Af7OIAdoBsAQ5PVvEjmZb2zo=";
	            const radiusServerIp = getRadiusServerIp();
	            const domain = (process.env.DOMAIN || process.env.NEXT_PUBLIC_DOMAIN || "novawifi.co.ke").toString();
	            const walledGardenHosts = this.getHotspotWalledGardenHosts();
	            const rescueConfig = getMikrotikRescueConfig(internalIp);
	            const rescueScript = buildMikrotikRescueScript(rescueConfig);
	            const apiAllowedAddresses = rescueConfig.enabled
	                ? `10.10.10.0/24,${rescueConfig.rescueSubnet}`
	                : "10.10.10.0/24";
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
                        `$safeFetch ($logBase . "radius-config-start")`,
                        `/radius add address=${radiusServerIp} secret=${session.radiusClientSecret} service=ppp,hotspot timeout=300ms`,
                        `/radius incoming set accept=yes`,
                        `/ppp aaa set use-radius=yes accounting=yes interim-update=1m`,
                        `$safeFetch ($logBase . "radius-config-done")`,
                    ]
                    : [];

            const script = [
                `:local token "${token}"`,
                `:local logBase "${logBase}"`,
                `:local completeUrl "${completeUrl}"`,
                `:local scriptUrl "${scriptUrl}"`,
	                `:local routerosBasePrimary "${routerosBasePrimaryUrl}"`,
	                `:local routerosBaseFallback "${routerosBaseFallbackUrl}"`,
                `:local routerName "${routerName}"`,
                `:local internalIp "${internalIp}"`,
                `:local apiUser "${apiUser}"`,
                `:local apiPass "${apiPass}"`,
                `:local ssid "${ssid}"`,
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
	                `:local dot [:find $rosVer "."]`,
	                `:local rosMaj 0`,
	                `:do { :set rosMaj [:tonum [:pick $rosVer 0 $dot]] } on-error={ :set rosMaj 0 }`,
	                `:if ($rosMaj < 7) do={`,
	                `$safeFetch ($logBase . "routeros-old-" . $rosVer)`,
	                `:local downloaded false`,
	                `:local pkgBase1 ($routerosBasePrimary . "/" . $arch)`,
	                `:local pkgBase2 ($routerosBaseFallback . "/" . $arch)`,
	                `:do {`,
	                `/tool fetch url=($pkgBase1 . "/routeros.npk") dst-path="routeros.npk" keep-result=yes`,
	                `/tool fetch url=($pkgBase1 . "/wireless.npk") dst-path="wireless.npk" keep-result=yes`,
	                `:do { /tool fetch url=($pkgBase1 . "/hotspot.npk") dst-path="hotspot.npk" keep-result=yes } on-error={ $safeFetch ($logBase . "hotspot-package-missing") }`,
	                `:set downloaded true`,
	                `} on-error={`,
	                `$safeFetch ($logBase . "routeros-download-primary-failed")`,
	                `}`,
	                `:if (!$downloaded) do={`,
	                `:do {`,
	                `/tool fetch url=($pkgBase2 . "/routeros.npk") dst-path="routeros.npk" keep-result=yes`,
	                `/tool fetch url=($pkgBase2 . "/wireless.npk") dst-path="wireless.npk" keep-result=yes`,
	                `:do { /tool fetch url=($pkgBase2 . "/hotspot.npk") dst-path="hotspot.npk" keep-result=yes } on-error={ $safeFetch ($logBase . "hotspot-package-missing") }`,
	                `:set downloaded true`,
	                `} on-error={`,
	                `$safeFetch ($logBase . "routeros-download-fallback-failed")`,
	                `}`,
	                `}`,
	                `:if (!$downloaded) do={ :error "routeros-packages-download-failed" }`,
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
	                `:do { :execute "/interface wireless set [find] ssid=$ssid disabled=no" } on-error={}`,
	                `:do { :execute "/interface wifi set [find] ssid=$ssid disabled=no" } on-error={}`,
	                `:do { :execute "/interface wifiwave2 set [find] ssid=$ssid disabled=no" } on-error={}`,
                `:delay 10s`,
                `/ip service set api address=${apiAllowedAddresses}`,
                `/ip service set www-ssl disabled=no`,
                `/ip service set api disabled=no`,
                `/ip service set ftp disabled=no`,
                `$safeFetch ($logBase . "api-access-enabled")`,
                `/ip firewall filter add chain=input src-address=10.10.10.0/24 protocol=tcp dst-port=8728 action=accept comment="Allow API from WireGuard"`,
                `/interface list member add list=LAN interface=wireguard`,
                `/ip firewall filter add action=accept chain=input dst-port=13231 protocol=udp`,
                `/ip firewall filter add action=accept chain=input src-address=10.10.10.0/24`,
	            ...rescueScript,
                `/ip dns set servers=8.8.8.8,1.1.1.1 allow-remote-requests=yes`,
	                ...walledGardenHosts.map((host) =>
	                    `:do { :if ([:len [/ip/hotspot/walled-garden/find dst-host="${host}"]] = 0) do={ /ip/hotspot/walled-garden/add dst-host="${host}" action=allow } } on-error={ $safeFetch ($logBase . "hotspot-walled-garden-skip") }`
	                ),
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
        const normalized = String(domain || "").trim().toLowerCase();
        if (!/^[a-z0-9.-]+$/.test(normalized)) return null;
        if (normalized.includes("..") || normalized.includes("/") || normalized.startsWith(".") || normalized.endsWith(".")) return null;
        return normalized;
    }

    normalizeProxyTargetUrl(targetUrl) {
        const text = String(targetUrl || "").trim();
        if (!text) return null;
        try {
            const url = new URL(text);
            if (!["http:", "https:"].includes(url.protocol)) return null;
            url.hash = "";
            return url.toString().replace(/\/$/, "");
        } catch (_error) {
            return null;
        }
    }

    normalizeMikrotikInternalHost(host) {
        const normalized = String(host || "").trim().split("/")[0];
        if (!/^10\.10\.10\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(normalized)) return "";
        return normalized;
    }

    buildMikrotikWebfigTarget(host) {
        const internalHost = this.normalizeMikrotikInternalHost(host);
        return internalHost ? `http://${internalHost}` : null;
    }

    getWildcardCertificatePaths(domain) {
        const baseDomain = process.env.DOMAIN || "novawifi.co.ke";
        const certDir = process.env.WILDCARD_CERT_DIR || `/etc/letsencrypt/live/${baseDomain}`;
        const certPath = process.env.WILDCARD_CERT_PATH || `${certDir}/fullchain.pem`;
        const keyPath = process.env.WILDCARD_KEY_PATH || `${certDir}/privkey.pem`;
        return {
            baseDomain,
            certPath,
            keyPath,
            hasWildcardCert: domain.endsWith(baseDomain) && fs.existsSync(certPath) && fs.existsSync(keyPath),
        };
    }

    buildNginxConfig(domain, targetUrl) {
        const target = this.normalizeProxyTargetUrl(targetUrl);
        if (!target) return null;
        const { certPath, keyPath, hasWildcardCert } = this.getWildcardCertificatePaths(domain);
        const sslOptions = process.env.SSL_OPTIONS_PATH || "/etc/letsencrypt/options-ssl-nginx.conf";
        const sslDhParam = process.env.SSL_DHPARAM_PATH || "/etc/letsencrypt/ssl-dhparams.pem";
        const proxyLines = [
            "    location / {",
            `        proxy_pass ${target};`,
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
            "",
        ];

        if (!hasWildcardCert) {
            return [
                "server {",
                "    listen 80;",
                `    server_name ${domain};`,
                "",
                ...proxyLines,
                "}",
                "",
            ].join("\n");
        }

        return [
            "server {",
            "    listen 80;",
            `    server_name ${domain};`,
            "    return 301 https://$host$request_uri;",
            "}",
            "",
            "server {",
            "    listen 443 ssl;",
            `    server_name ${domain};`,
            "",
            `    ssl_certificate     ${certPath};`,
            `    ssl_certificate_key ${keyPath};`,
            ...(fs.existsSync(sslOptions) ? [`    include ${sslOptions};`] : []),
            ...(fs.existsSync(sslDhParam) ? [`    ssl_dhparam ${sslDhParam};`] : []),
            "",
            ...proxyLines,
            "}",
            "",
        ].join("\n");
    }

    async addReverseProxySite(domain, targetUrl) {
        const safeDomain = this.sanitizeDomain(domain);
        if (!safeDomain) {
            return { success: false, message: "Invalid domain provided." };
        }

        const target = this.normalizeProxyTargetUrl(targetUrl);
        if (!target) {
            return { success: false, message: "Invalid reverse proxy target URL." };
        }

        const config = this.buildNginxConfig(safeDomain, target);
        if (!config) {
            return { success: false, message: "Failed to build nginx config." };
        }
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

            let ssl = { success: true, message: "Using wildcard SSL certificate." };
            const { hasWildcardCert } = this.getWildcardCertificatePaths(safeDomain);
            if (!hasWildcardCert && process.env.SKIP_LETSENCRYPT !== "true") {
                ssl = await this.installLetsEncryptCert(safeDomain);
                if (!ssl.success) {
                    return {
                        success: false,
                        message: `Nginx configured for ${safeDomain}, but Let's Encrypt SSL failed.`,
                        error: ssl.error || ssl.message,
                    };
                }
            }

            return {
                success: true,
                message: `Nginx reverse proxy configured for ${safeDomain}`,
                ssl,
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
            try {
                await runSudo(["/bin/cp", "-a", wgConfPath, backupPath]);
            } catch (backupErr) {
                console.warn("[WireGuard] backup skipped", backupErr?.toString?.() || backupErr);
                await fsp.writeFile(`/tmp/${wgName}.conf.bak-${Date.now()}`, fileData, "utf8").catch(() => { });
            }

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
            const internalHost = this.normalizeMikrotikInternalHost(payload.mikrotikHost);
            const webfigTargetUrl = this.buildMikrotikWebfigTarget(internalHost);
            if (!internalHost || !webfigTargetUrl) {
                return { success: false, message: "MikroTik internal host must be a 10.10.10.x address." };
            }
            payload.mikrotikHost = internalHost;

            const existingHost = stations.find(s => s.mikrotikHost?.trim() === payload.mikrotikHost?.trim());
            const existingKey = stations.find(s => s.mikrotikPublicKey?.trim() === payload.publicKey?.trim());
            const existing = existingHost || existingKey;

            if (!existing) {
                if (payload.ddns) {
                    const existingDnsName = stations.find(s =>
                        s.mikrotikPublicHost?.trim() === payload.ddns?.trim() ||
                        s.mikrotikDDNS?.trim() === payload.ddns?.trim()
                    );
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
                    mikrotikDDNS: "",
                    mikrotikPublicHost: payload.ddns || payload.publicIp || "",
                    mikrotikWebfigHost,
                    platformID,
                    adminID,
                    systemBasis,
                    radiusClientName: session.radiusClientName || null,
                    radiusClientSecret: session.radiusClientSecret || null,
                    radiusClientIp: systemBasis === "RADIUS" ? getRadiusClientIp(payload.mikrotikHost, payload.publicIp || "") : null,
                    radiusServerIp: systemBasis === "RADIUS" ? (session.radiusServerIp || "") : null,
                });

                const proxy = await this.addReverseProxySite(mikrotikWebfigHost, webfigTargetUrl);
                if (!proxy.success) {
                    warnings.push(proxy.message || "Failed to create reverse proxy site");
                }
            } else {
                stationResult = await this.db.updateStation(existing.id, {
                    name,
                    mikrotikHost: payload.mikrotikHost,
                    mikrotikPublicKey: payload.publicKey,
                    mikrotikUser: payload.mikrotikUser,
                    mikrotikPassword: encryptedPassword,
                    mikrotikDDNS: "",
                    mikrotikPublicHost: payload.ddns || payload.publicIp || "",
                    systemBasis,
                    radiusClientName: session.radiusClientName || existing.radiusClientName || null,
                    radiusClientSecret: session.radiusClientSecret || existing.radiusClientSecret || null,
                    radiusClientIp: systemBasis === "RADIUS" ? getRadiusClientIp(payload.mikrotikHost, payload.publicIp || existing.radiusClientIp || "") : existing.radiusClientIp || null,
                    radiusServerIp: systemBasis === "RADIUS" ? (session.radiusServerIp || existing.radiusServerIp || "") : existing.radiusServerIp || null,
                });
            }

            if (systemBasis === "RADIUS" && session.radiusClientName && session.radiusClientSecret) {
                const radiusClientIp = getRadiusClientIp(payload.mikrotikHost, payload.publicIp || "");
                if (!radiusClientIp) {
                    warnings.push("RADIUS client not added: missing router client IP");
                } else {
                    const addResult = await ensureRadiusClient({
                        name: session.radiusClientName,
                        ip: radiusClientIp,
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

            const seedResult = await this.seedStationScriptsOnConnect(platformID, {
                mikrotikHost: stationResult?.mikrotikHost || payload.mikrotikHost,
                systemBasis,
            });
	            if (!seedResult.success) {
	                warnings.push(seedResult.message || "Failed to seed station scripts");
	            }

	            const loginTemplateResult = await this.uploadHotspotLoginTemplate(
	                platformID,
	                stationResult?.mikrotikHost || payload.mikrotikHost
	            ).catch((error) => ({ success: false, message: error?.message || "Failed to upload login.html" }));
	            if (!loginTemplateResult.success) {
	                warnings.push(loginTemplateResult.message || "Failed to upload login.html");
	            }

	            const warningMessage = warnings.length > 0 ? ` Warnings: ${warnings.join(" | ")}` : "";
	            return {
	                success: true,
	                message: `Station saved.${warningMessage}`,
	                station: stationResult,
	                seedScripts: seedResult,
	                loginTemplate: loginTemplateResult,
	            };
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

    async fetchActiveConnectionsPerStation(platformID) {
        const stations = await this.db.getStations(platformID);
        const perStation = {};
        let totalHotspot = 0;
        let totalPPPoE = 0;

        for (const station of stations) {
            const stationId = station?.id;
            if (!stationId) continue;

            let hotspotCount = 0;
            let pppoeCount = 0;
            try {
                const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
                if (!connection?.channel) {
                    perStation[stationId] = { hotspot: 0, pppoe: 0 };
                    continue;
                }
                const { channel } = connection;
                try {
                    const hotspotActive = await this.mikrotik.listHotspotActiveUsers(channel);
                    const pppActive = await this.mikrotik.listPPPActiveUsers(channel);
                    hotspotCount = (hotspotActive && hotspotActive.length) ? hotspotActive.length : 0;
                    pppoeCount = (pppActive && pppActive.length) ? pppActive.length : 0;
                } finally {
                    await this.safeCloseChannel(channel);
                }
            } catch (error) {
                hotspotCount = 0;
                pppoeCount = 0;
            }

            perStation[stationId] = { hotspot: hotspotCount, pppoe: pppoeCount };
            totalHotspot += hotspotCount;
            totalPPPoE += pppoeCount;
        }

        return {
            totals: { hotspot: totalHotspot, pppoe: totalPPPoE },
            perStation,
        };
    }

    async fetchActiveConnectionsForStation(platformID, stationId) {
        if (!platformID || !stationId) return { hotspot: 0, pppoe: 0 };
        const station = await this.db.getStation(stationId);
        if (!station || station.platformID !== platformID) return { hotspot: 0, pppoe: 0 };

        const connection = await this.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
        if (!connection?.channel) return { hotspot: 0, pppoe: 0 };

        const { channel } = connection;
        try {
            const hotspotActive = await this.mikrotik.listHotspotActiveUsers(channel);
            const pppActive = await this.mikrotik.listPPPActiveUsers(channel);
            return {
                hotspot: (hotspotActive && hotspotActive.length) ? hotspotActive.length : 0,
                pppoe: (pppActive && pppActive.length) ? pppActive.length : 0,
            };
        } finally {
            await this.safeCloseChannel(channel);
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
	                    expireAt,
	                    period: pkg.period,
	                    sessionTimeoutSeconds: null,
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

    async seedCleanupExpiredHotspotScriptForPlatform(platformID, options = {}) {
        if (!platformID) {
            return {
                success: false,
                message: "Missing platformID",
                summary: { total: 0, success: 0, failed: 0 },
                results: [],
            };
        }

        const stations = await this.db.getStations(platformID);
        if (!Array.isArray(stations) || stations.length === 0) {
            return {
                success: false,
                message: "No stations found",
                summary: { total: 0, success: 0, failed: 0 },
                results: [],
            };
        }

        const stationId = options.stationId || null;
        const host = options.host || null;

        let targets = stations.filter(
            (s) => s?.mikrotikHost && String(s?.systemBasis || "").toUpperCase() === "API"
        );
        if (stationId) {
            targets = targets.filter((s) => s.id === stationId);
        }
        if (host) {
            targets = targets.filter((s) => s.mikrotikHost === host);
        }

        if (targets.length === 0) {
            return {
                success: false,
                message: "No API-basis stations matched the request",
                summary: { total: 0, success: 0, failed: 0 },
                results: [],
            };
        }

        const results = [];
        for (const station of targets) {
            const seeded = await this.seedCleanupExpiredHotspotScriptForStation(platformID, station);
            results.push({
                id: station.id,
                name: station.name || station.mikrotikHost,
                host: station.mikrotikHost,
                ...seeded,
            });
        }

        const successCount = results.filter((r) => r.success).length;
        const failedCount = results.length - successCount;

        return {
            success: failedCount === 0,
            message: `Cleanup script seeded on ${successCount}/${results.length} API stations`,
            summary: { total: results.length, success: successCount, failed: failedCount },
            results,
        };
    }

    sanitizeBackupPathPart(value) {
        return String(value || "")
            .trim()
            .replace(/[^a-zA-Z0-9._:-]/g, "");
    }

    generateBackupToken(length = 32) {
        return this.generateCode(length);
    }

    getAutoBackupUploadScriptSource({ ftpTargetBase, notifyUrl, token, platformID, host }) {
        const safeFtpTargetBase = String(ftpTargetBase || "").trim();
        const safeNotifyUrl = String(notifyUrl || "").trim();
        const safeToken = this.sanitizeBackupPathPart(token);
        const safePlatformID = this.sanitizeBackupPathPart(platformID);
        const safeHost = this.sanitizeBackupPathPart(host);

        return `:local ftpTargetBase "${safeFtpTargetBase}"
:local notifyUrl "${safeNotifyUrl}"
:local token "${safeToken}"
:local platformID "${safePlatformID}"
:local host "${safeHost}"

:if (([:len $ftpTargetBase] = 0) or ([:len $notifyUrl] = 0) or ([:len $token] = 0) or ([:len $platformID] = 0) or ([:len $host] = 0)) do={
    :error "missing required backup variables"
}

:foreach f in=[/file find] do={
    :local fn [/file get $f name]
    :if (([:find $fn "backup_"] = 0) and ([:find $fn ".backup"] != nil)) do={
        /file remove $f
    }
}
:delay 1s

:local d [/system clock get date]
:local t [/system clock get time]
:local monthMap {"jan"="01";"feb"="02";"mar"="03";"apr"="04";"may"="05";"jun"="06";"jul"="07";"aug"="08";"sep"="09";"oct"="10";"nov"="11";"dec"="12"}
:local year ""
:local month ""
:local day ""
:if ([:find $d "/"] != nil) do={
    :set year [:pick $d 7 11]
    :local monKey [:pick $d 0 3]
    :set month ($monthMap->$monKey)
    :set day [:pick $d 4 6]
} else={
    :set year [:pick $d 0 4]
    :set month [:pick $d 5 7]
    :set day [:pick $d 8 10]
}
:local h [:pick $t 0 2]
:local m [:pick $t 3 5]
:local s [:pick $t 6 8]
:local stamp ($year . "-" . $month . "-" . $day . "_" . $h . "-" . $m . "-" . $s)
:local backupBase ("backup_" . $stamp)
:local fileName ($backupBase . ".backup")

/system backup save name=$backupBase dont-encrypt=yes
:delay 5s

:if ([:len [/file find where name=$fileName]] = 0) do={
    :error ("backup file not found: " . $fileName)
}

:local targetFtp ($ftpTargetBase . "/" . $host . "/" . $fileName)
:local uploaded false
:do {
    /tool fetch url=$targetFtp mode=ftp upload=yes src-path=$fileName keep-result=no
    :set uploaded true
} on-error={
    :set uploaded false
}

:if ($uploaded = false) do={
    :do {
        /tool fetch url=$targetFtp mode=sftp upload=yes src-path=$fileName keep-result=no
        :set uploaded true
    } on-error={
        :set uploaded false
    }
}

:if ($uploaded = true) do={
    :local notifyTarget ($notifyUrl . "?token=" . $token . "&platformID=" . $platformID . "&host=" . $host . "&filename=" . $fileName)
    :do {
        /tool fetch url=$notifyTarget http-method=post keep-result=no check-certificate=no
    } on-error={}

    :foreach f in=[/file find] do={
        :local fn [/file get $f name]
        :if (([:find $fn "backup_"] = 0) and ([:find $fn ".backup"] != nil) and ($fn != $fileName)) do={
            /file remove $f
        }
    }
    :delay 1s
    :foreach f in=[/file find where name=$fileName] do={ /file remove $f }
}`;
    }

    getAutoBackupSeedRsc({ ftpTargetBase, notifyUrl, token, platformID, host }) {
        const scriptName = "nova-auto-backup-upload";
        const schedulerName = "nova-auto-backup-upload-5m";
        const source = this.getAutoBackupUploadScriptSource({
            ftpTargetBase,
            notifyUrl,
            token,
            platformID,
            host,
        });

        return [
            `/system script remove [find where name="${scriptName}"]`,
            `/system script add name="${scriptName}" source={`,
            source,
            `}`,
            `/system scheduler remove [find where name="${schedulerName}"]`,
            `/system scheduler add name="${schedulerName}" interval=5m on-event="${scriptName}" start-time=startup`,
        ].join("\n");
    }

    getBackupFtpTargetBase() {
        const explicit = process.env.ROUTER_BACKUP_FTP_TARGET_BASE;
        if (explicit) {
            return String(explicit).trim().replace(/\/+$/, "");
        }

        const ftpUser = encodeURIComponent(String(process.env.FTP_USER || "").trim());
        const ftpPassword = encodeURIComponent(String(process.env.FTP_PASSWORD || "").trim());
        const ftpHost = String(
            process.env.ROUTER_BACKUP_FTP_HOST ||
            process.env.FTP_HOST ||
            process.env.SERVER_IP ||
            ""
        ).trim();
        if (!ftpUser || !ftpPassword || !ftpHost) return "";

        return `ftp://${ftpUser}:${ftpPassword}@${ftpHost}/backups/remote-hosts`;
    }

    getBackupNotifyUrl() {
        const explicit = process.env.ROUTER_BACKUP_NOTIFY_URL;
        if (explicit) return String(explicit).trim().replace(/\/+$/, "");
        const base = this.getRouterApiBaseUrl();
        if (!base) return "";
        return `${String(base).trim().replace(/\/+$/, "")}/mkt/router-backup/notify`;
    }

    async getAutoBackupSeedScript(req, res) {
        try {
            const ftpTargetBase = String(
                req.query.ftpTargetBase ||
                this.getBackupFtpTargetBase()
            ).trim();
            const notifyUrl = String(
                req.query.notifyUrl ||
                this.getBackupNotifyUrl()
            ).trim();
            const token = String(req.query.token || req.params?.token || "").trim();
            const platformID = String(req.query.platformID || req.params?.platformID || "").trim();
            const host = String(req.query.host || req.params?.host || "").trim();

            if (!ftpTargetBase || !notifyUrl || !token || !platformID || !host) {
                return res.status(400).send("Missing required query params");
            }

            res.setHeader("Content-Type", "text/plain");
            return res.status(200).send(
                this.getAutoBackupSeedRsc({ ftpTargetBase, notifyUrl, token, platformID, host })
            );
        } catch (error) {
            return res.status(500).send("Failed to generate auto-backup seed script");
        }
    }

    async getStationSeedScripts(req, res) {
        try {
            const { token, stationId, host } = req.body || {};
            if (!token) {
                return res.status(400).json({ success: false, message: "Missing token" });
            }

            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) {
                return res.status(401).json({ success: false, message: auth.message });
            }
            if (auth.admin.role !== "superuser") {
                return res.status(403).json({ success: false, message: "Unauthorised!" });
            }

            const platformID = auth.admin.platformID;
            const stations = await this.db.getStations(platformID);
            if (!Array.isArray(stations) || stations.length === 0) {
                return res.status(404).json({ success: false, message: "No stations found" });
            }

            let station = null;
            if (stationId) {
                station = stations.find((s) => String(s.id) === String(stationId));
            } else if (host) {
                station = stations.find((s) => String(s.mikrotikHost) === String(host));
            } else {
                station = stations[0];
            }

            if (!station?.mikrotikHost) {
                return res.status(404).json({ success: false, message: "Station not found" });
            }

            const safeHost = this.sanitizeBackupPathPart(station.mikrotikHost);
            try {
                await fsp.mkdir(path.join(appRoot, "backups", "remote-hosts", safeHost), { recursive: true });
            } catch { }
            try {
                await fsp.mkdir(path.join(path.sep, "backups", "remote-hosts", safeHost), { recursive: true });
            } catch { }
            const existingBackup = await this.db.getPlatformMikrotikBackUpByHost(platformID, safeHost);
            const backupToken =
                this.sanitizeBackupPathPart(existingBackup?.token) ||
                this.sanitizeBackupPathPart(process.env.ROUTER_BACKUP_TOKEN || process.env.API_TOKEN) ||
                this.generateBackupToken(32);

            if (!existingBackup?.id) {
                await this.db.createPlatformMikrotikBackUp({
                    status: "script-ready",
                    path: "",
                    platformID,
                    host: safeHost,
                    filename: "",
                    token: backupToken,
                });
            } else if (!existingBackup?.token) {
                await this.db.updatePlatformMikrotikBackUp(existingBackup.id, {
                    status: existingBackup?.status || "script-ready",
                    path: existingBackup?.path || "",
                    platformID,
                    host: safeHost,
                    filename: existingBackup?.filename || "",
                    token: backupToken,
                });
            }

            const baseUrl = this.getRouterApiBaseUrl();
            if (!baseUrl) {
                return res.status(500).json({
                    success: false,
                    message: "Missing ROUTER_PUBLIC_BASE_URL/NEXT_PUBLIC_SERVER_URL/SERVER_URL/ROUTEROS_BASE_URL/API_DOMAIN/DOMAIN",
                });
            }

            const cleanupUrl = `${String(baseUrl).replace(/\/+$/, "")}/mkt/seed/cleanup-expired-hotspot.rsc`;
            const autoBackupUrl = `${String(baseUrl).replace(/\/+$/, "")}/mkt/seed/auto-backup-script/${encodeURIComponent(platformID)}/${encodeURIComponent(safeHost)}/${encodeURIComponent(backupToken)}.rsc`;

            const cleanupCmd = `/tool fetch url="${cleanupUrl}" dst-path="cleanup-expired-hotspot.rsc" keep-result=yes; /import file-name=cleanup-expired-hotspot.rsc; /file/remove cleanup-expired-hotspot.rsc`;
            const autoBackupCmd = `/tool fetch url="${autoBackupUrl}" dst-path="nova-auto-backup-upload.rsc" keep-result=yes; /import file-name=nova-auto-backup-upload.rsc; /file/remove nova-auto-backup-upload.rsc`;

            return res.status(200).json({
                success: true,
                message: "Station scripts generated successfully",
                platformID,
                station: {
                    id: station.id,
                    name: station.name || station.mikrotikHost,
                    host: station.mikrotikHost,
                    systemBasis: station.systemBasis || "API",
                },
                scripts: {
                    cleanupExpiredHotspot: {
                        fileName: "cleanup-expired-hotspot.rsc",
                        url: cleanupUrl,
                        command: cleanupCmd,
                    },
                    autoBackupUpload: {
                        fileName: "nova-auto-backup-upload.rsc",
                        url: autoBackupUrl,
                        command: autoBackupCmd,
                    },
                },
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: error?.message || "Failed to generate station scripts",
            });
        }
    }

    async seedAutoBackupScriptForStation(platformID, station) {
        const scriptFileName = "nova-auto-backup-upload.rsc";
        const host = this.sanitizeBackupPathPart(station?.mikrotikHost);
        if (!host) {
            return { success: false, message: "Missing station host" };
        }
        try {
            await fsp.mkdir(path.join(appRoot, "backups", "remote-hosts", host), { recursive: true });
        } catch { }
        try {
            await fsp.mkdir(path.join(path.sep, "backups", "remote-hosts", host), { recursive: true });
        } catch { }

        const ftpTargetBase = this.getBackupFtpTargetBase();
        const notifyUrl = this.getBackupNotifyUrl();
        if (!ftpTargetBase || !notifyUrl) {
            return { success: false, message: "Missing FTP backup target or notify URL configuration" };
        }

        const existingBackup = await this.db.getPlatformMikrotikBackUpByHost(platformID, host);
        const token =
            this.sanitizeBackupPathPart(existingBackup?.token) ||
            this.sanitizeBackupPathPart(process.env.ROUTER_BACKUP_TOKEN || process.env.API_TOKEN) ||
            this.generateBackupToken(32);

        const baseUrl = this.getRouterApiBaseUrl();
        if (!baseUrl) {
            return { success: false, message: "Missing ROUTER_PUBLIC_BASE_URL/NEXT_PUBLIC_SERVER_URL/SERVER_URL/ROUTEROS_BASE_URL/API_DOMAIN/DOMAIN" };
        }
        const scriptUrl = `${String(baseUrl).replace(/\/+$/, "")}/mkt/seed/auto-backup-script/${encodeURIComponent(platformID)}/${encodeURIComponent(host)}/${encodeURIComponent(token)}.rsc`;

        const connection = await this.config.createSingleMikrotikClient(platformID, host);
        if (!connection?.channel) {
            return { success: false, message: "No valid MikroTik connection" };
        }

        const { channel } = connection;
        try {
            await this.writeWithTimeout(channel, "/tool/fetch", [
                `=url=${scriptUrl}`,
                `=dst-path=${scriptFileName}`,
                "=keep-result=yes",
            ], 45000);

            await this.writeWithTimeout(channel, "/import", [
                `=file-name=${scriptFileName}`,
            ], 60000);

            try {
                await this.writeWithTimeout(channel, "/file/remove", [
                    `=numbers=${scriptFileName}`,
                ], 15000);
            } catch { }

            const backupData = {
                status: existingBackup?.status || "script-seeded",
                path: existingBackup?.path || "",
                platformID,
                host,
                filename: existingBackup?.filename || "",
                token,
            };

            if (existingBackup?.id) {
                await this.db.updatePlatformMikrotikBackUp(existingBackup.id, backupData);
            } else {
                await this.db.createPlatformMikrotikBackUp(backupData);
            }

            return { success: true, message: "Auto-backup script imported and scheduler seeded successfully" };
        } catch (error) {
            return { success: false, message: error?.message || "Failed to seed auto-backup script" };
        } finally {
            await this.safeCloseChannel(channel);
        }
    }

    async seedAutoBackupScriptForPlatform(platformID, options = {}) {
        if (!platformID) {
            return {
                success: false,
                message: "Missing platformID",
                summary: { total: 0, success: 0, failed: 0 },
                results: [],
            };
        }

        const stations = await this.db.getStations(platformID);
        if (!Array.isArray(stations) || stations.length === 0) {
            return {
                success: false,
                message: "No stations found",
                summary: { total: 0, success: 0, failed: 0 },
                results: [],
            };
        }

        const stationId = options.stationId || null;
        const host = options.host || null;

        let targets = stations.filter((s) => {
            if (!s?.mikrotikHost) return false;
            const basis = String(s?.systemBasis || "").toUpperCase();
            return basis === "API" || basis === "RADIUS";
        });

        if (stationId) {
            targets = targets.filter((s) => s.id === stationId);
        }
        if (host) {
            targets = targets.filter((s) => s.mikrotikHost === host);
        }

        if (targets.length === 0) {
            return {
                success: false,
                message: "No API/RADIUS stations matched the request",
                summary: { total: 0, success: 0, failed: 0 },
                results: [],
            };
        }

        const results = [];
        for (const station of targets) {
            const seeded = await this.seedAutoBackupScriptForStation(platformID, station);
            results.push({
                id: station.id,
                name: station.name || station.mikrotikHost,
                host: station.mikrotikHost,
                systemBasis: station.systemBasis,
                ...seeded,
            });
        }

        const successCount = results.filter((r) => r.success).length;
        const failedCount = results.length - successCount;

        return {
            success: failedCount === 0,
            message: `Auto-backup script seeded on ${successCount}/${results.length} stations`,
            summary: { total: results.length, success: successCount, failed: failedCount },
            results,
        };
    }

    async seedStationScriptsOnConnect(platformID, station = {}) {
        const host = String(
            station?.mikrotikHost ||
            station?.host ||
            ""
        ).trim();

        if (!platformID || !host) {
            return {
                success: false,
                connected: false,
                host,
                message: "Missing platformID/host for station seeding",
            };
        }

        let channel = null;
        try {
            const connection = await this.config.createSingleMikrotikClient(platformID, host);
            if (!connection?.channel) {
                return {
                    success: false,
                    connected: false,
                    host,
                    message: "Router not connected, skipped seeding",
                };
            }

            channel = connection.channel;
            await this.safeCloseChannel(channel);

            const stationBasis = String(
                station?.systemBasis ||
                (
                    (await this.db.getStations(platformID))?.find((s) => s?.mikrotikHost === host)?.systemBasis
                ) ||
                "API"
            ).toUpperCase();

            let cleanupSeed = {
                success: true,
                message: "Cleanup seed skipped for non-API station",
                summary: { total: 0, success: 0, failed: 0 },
                results: [],
            };
            if (stationBasis === "API") {
                cleanupSeed = await this.seedCleanupExpiredHotspotScriptForPlatform(platformID, { host });
            }

            const autoBackupSeed = await this.seedAutoBackupScriptForPlatform(platformID, { host });

            const success = Boolean(cleanupSeed.success) && Boolean(autoBackupSeed.success);
            return {
                success,
                connected: true,
                host,
                message: success
                    ? "Station connected and seed scripts applied"
                    : "Station connected but one or more seed scripts failed",
                cleanupSeed,
                autoBackupSeed,
            };
        } catch (error) {
            return {
                success: false,
                connected: false,
                host,
                message: error?.message || "Failed to connect and seed station scripts",
            };
        } finally {
            await this.safeCloseChannel(channel);
        }
    }

    async seedAutoBackupScript(req, res) {
        try {
            const { token } = req.body || {};
            if (!token) {
                return res.status(400).json({ success: false, message: "Missing token" });
            }

            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) {
                return res.status(401).json({ success: false, message: auth.message });
            }
            if (auth.admin.role !== "superuser") {
                return res.status(403).json({ success: false, message: "Unauthorised!" });
            }

            const platformID = auth.admin.platformID;
            const seeded = await this.seedAutoBackupScriptForPlatform(platformID);
            const statusCode = seeded.summary?.total ? 200 : 404;
            return res.status(statusCode).json(seeded);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to seed auto-backup script",
                error: error?.message || String(error),
            });
        }
    }

    async uploadRouterBackup(req, res) {
        try {
            const host = this.sanitizeBackupPathPart(req.query?.host);
            const platformID = this.sanitizeBackupPathPart(req.query?.platformID);
            const token = this.sanitizeBackupPathPart(req.query?.token || req.headers["x-backup-token"]);
            const rawFilename = this.sanitizeBackupPathPart(req.query?.filename || "");
            const filename = rawFilename.endsWith(".backup") ? rawFilename : `${rawFilename || "backup"}.backup`;

            if (!host) {
                return res.status(400).json({ success: false, message: "Missing host" });
            }
            if (!platformID) {
                return res.status(400).json({ success: false, message: "Missing platformID" });
            }
            if (!token) {
                return res.status(400).json({ success: false, message: "Missing token" });
            }
            if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
                return res.status(400).json({ success: false, message: "Missing backup payload" });
            }

            const existing = await this.db.getPlatformMikrotikBackUpByHost(platformID, host);
            const expectedToken =
                this.sanitizeBackupPathPart(existing?.token) ||
                this.sanitizeBackupPathPart(process.env.ROUTER_BACKUP_TOKEN || process.env.API_TOKEN);

            if (!expectedToken || token !== expectedToken) {
                return res.status(401).json({ success: false, message: "Unauthorised backup upload" });
            }

            const folderPath = path.join(appRoot, "backups", "remote-hosts", host);
            await fsp.mkdir(folderPath, { recursive: true });
            try {
                const existingFiles = await fsp.readdir(folderPath);
                for (const file of existingFiles) {
                    if (file.startsWith("backup_") && file.endsWith(".backup")) {
                        await fsp.unlink(path.join(folderPath, file)).catch(() => null);
                    }
                }
            } catch { }
            const filePath = path.join(folderPath, filename);
            await fsp.writeFile(filePath, req.body);

            const relativePath = path.join("backups", "remote-hosts", host, filename);
            const data = {
                status: "updated",
                path: relativePath,
                platformID,
                host,
                filename,
                token: existing?.token || token,
            };
            if (existing?.id) {
                await this.db.updatePlatformMikrotikBackUp(existing.id, data);
            } else {
                await this.db.createPlatformMikrotikBackUp(data);
            }

            return res.status(200).json({
                success: true,
                message: "Backup uploaded successfully",
                data: { host, filename, size: req.body.length },
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Backup upload failed",
                error: error?.message || String(error),
            });
        }
    }

    async notifyRouterBackupUploaded(req, res) {
        try {
            const host = this.sanitizeBackupPathPart(req.query?.host);
            const platformID = this.sanitizeBackupPathPart(req.query?.platformID);
            const token = this.sanitizeBackupPathPart(req.query?.token || req.headers["x-backup-token"]);
            const rawFilename = this.sanitizeBackupPathPart(req.query?.filename || "");
            const filename = rawFilename.endsWith(".backup") ? rawFilename : `${rawFilename || "backup"}.backup`;

            if (!host) return res.status(400).json({ success: false, message: "Missing host" });
            if (!platformID) return res.status(400).json({ success: false, message: "Missing platformID" });
            if (!token) return res.status(400).json({ success: false, message: "Missing token" });

            const existing = await this.db.getPlatformMikrotikBackUpByHost(platformID, host);
            const expectedToken =
                this.sanitizeBackupPathPart(existing?.token) ||
                this.sanitizeBackupPathPart(process.env.ROUTER_BACKUP_TOKEN || process.env.API_TOKEN);
            if (!expectedToken || token !== expectedToken) {
                return res.status(401).json({ success: false, message: "Unauthorised backup notify" });
            }

            const candidatePaths = [
                path.join(appRoot, "backups", "remote-hosts", host, filename),
                path.join(path.sep, "backups", "remote-hosts", host, filename),
            ];
            let foundPath = "";
            for (const p of candidatePaths) {
                try {
                    const stat = await fsp.stat(p);
                    if (stat.isFile() && stat.size > 0) {
                        foundPath = p;
                        break;
                    }
                } catch { }
            }

            if (!foundPath) {
                return res.status(404).json({ success: false, message: "Uploaded backup file not found on server" });
            }

            const relativePath = path
                .relative(appRoot, foundPath)
                .replace(/\\/g, "/");

            const data = {
                status: "updated",
                path: relativePath.startsWith("..") ? `backups/remote-hosts/${host}/${filename}` : relativePath,
                platformID,
                host,
                filename,
                token: existing?.token || token,
            };
            if (existing?.id) {
                await this.db.updatePlatformMikrotikBackUp(existing.id, data);
            } else {
                await this.db.createPlatformMikrotikBackUp(data);
            }

            return res.status(200).json({
                success: true,
                message: "Backup upload processed successfully",
                host,
                filename,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: error?.message || "Backup notify failed",
            });
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
        const stationId = data?.stationId || data?.stationID;
        const stationHostFromPayload =
            data?.routerHost ||
            (data?.station && typeof data.station === "object"
                ? data.station.mikrotikHost || data.station.host
                : data?.station) ||
            data?.host;

        try {
            if (!platformID) {
                return {
                    success: false,
                    message: "Missing platformID!",
                };
            }
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
            if (pkg.platformID && pkg.platformID !== platformID) {
                return {
                    success: false,
                    message: "Selected package does not belong to your platform.",
                };
            }
            const profileName = pkg.name;
            let selectedStation = null;
            if (stationId) {
                selectedStation = await this.db.getStation(stationId);
                if (!selectedStation || selectedStation.platformID !== platformID) {
                    return {
                        success: false,
                        message: "Selected station not found!",
                    };
                }
            }

            const requestedHost = selectedStation?.mikrotikHost || stationHostFromPayload || pkg.routerHost;
            if (requestedHost && pkg.routerHost && requestedHost !== pkg.routerHost) {
                return {
                    success: false,
                    message: "Selected package does not belong to the selected station/router.",
                };
            }

            const hostdata = await this.db.getStations(platformID);
            if (!hostdata) {
                return {
                    success: false,
                    message: "Failed to add user to MikroTik, Router not found!",
                };
            }

            const host = requestedHost || pkg.routerHost;
            const stationRecord = selectedStation || hostdata.find((s) => s.mikrotikHost === host);
            if (!stationRecord) {
                return {
                    success: false,
                    message: "Failed to add user to MikroTik, Router not found!",
                };
            }
            const linkGroupId = stationRecord?.linkGroupId || null;
            const linkedStations = linkGroupId
                ? hostdata.filter((s) => s.linkGroupId === linkGroupId)
                : [stationRecord];
            const apiStations = linkedStations.filter(
                (s) => String(s?.systemBasis || "API").toUpperCase() !== "RADIUS"
            );
            const radiusStations = linkedStations.filter(
                (s) => String(s?.systemBasis || "API").toUpperCase() === "RADIUS"
            );
            const hasRadius = radiusStations.length > 0;
            const isMoreThanOneDevice = Number(pkg.devices) > 1;
            const isData = pkg.category === "Data";
            const baseCode = code;
            const loginIdentifier =
                isMoreThanOneDevice || isData
                    ? baseCode
                    : (mac && mac !== "null"
                        ? mac
                        : baseCode);

            if (loginIdentifier && platformID) {
                const existingByUsername = await this.db.getUserByUsernameAndPlatform(loginIdentifier, platformID);
                if (existingByUsername) {
                    return {
                        success: true,
                        message: "User already exists",
                        code: existingByUsername,
                    };
                }
            }
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

            let addUserToMikrotik = { success: true, username: loginIdentifier, password: loginIdentifier };
            const addedUserHosts = [];
            if (apiStations.length > 0) {
                for (const s of apiStations) {
                    const stationHost = s?.mikrotikHost;
                    if (!stationHost) continue;
                    const result = await this.manageMikrotikUser({
                        platformID,
                        action: "add",
                        profileName,
                        host: stationHost,
                        code: loginIdentifier,
                        expireAt,
                    });
                    if (!result?.success) {
                        for (const addedHost of addedUserHosts) {
                            try {
                                await this.manageMikrotikUser({
                                    platformID,
                                    action: "remove",
                                    host: addedHost,
                                    username: loginIdentifier,
                                });
                            } catch { }
                        }
                        return {
                            success: false,
                            message: `Failed to add user to linked station (${stationHost}): ${result?.message || "Unknown error"}`,
                        };
                    }
                    addedUserHosts.push(stationHost);
                    addUserToMikrotik = result;
                }
            }

            if (hasRadius) {
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
	                    expireAt,
	                    period: pkg.period,
	                    sessionTimeoutSeconds: null,
	                });
            }

            if (addUserToMikrotik.success) {
                const finalUsername = addUserToMikrotik.username || loginIdentifier;
                const finalPassword = addUserToMikrotik.password || loginIdentifier;
                const existingByCode = code ? await this.db.getUserByCodeAndPlatform(code, platformID) : null;
                if (existingByCode) {
                    return { success: true, message: "Code already exists", code: existingByCode };
                }
                const existingByUsername = finalUsername
                    ? await this.db.getUserByUsernameAndPlatform(finalUsername, platformID)
                    : null;
                if (existingByUsername) {
                    return { success: true, message: "User already exists", code: existingByUsername };
                }

                let addedcode = null;
                try {
                    addedcode = await this.db.createUser({
                        status: "active",
                        code: code,
                        platformID: platformID,
                        phone: phone,
                        username: finalUsername,
                        password: finalPassword,
                        packageID: packageID,
                        expireAt: expireAt,
                        token: token,
                        mac: mac
                    });
                } catch (err) {
                    try {
                        if (hasRadius) {
                            await this.db.deleteRadiusUser(finalUsername);
                        }
                        for (const addedHost of addedUserHosts.length ? addedUserHosts : (apiStations || []).map((s) => s?.mikrotikHost).filter(Boolean)) {
                            try {
                                await this.manageMikrotikUser({
                                    platformID,
                                    action: "remove",
                                    host: addedHost,
                                    username: finalUsername,
                                });
                            } catch { }
                        }
                    } catch { }
                    throw err;
                }

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
