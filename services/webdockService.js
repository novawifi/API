//@ts-check

const axios = require("axios");

class WebdockService {
  constructor() {
    this.baseURL = process.env.WEBDOCK_API_URL || "https://api.webdock.io/v1";
    this.token = process.env.WEBDOCK_API_TOKEN || "";
    this.timeout = Number(process.env.WEBDOCK_TIMEOUT_MS || 20000);
    this.application = process.env.WEBDOCK_APPLICATION || "Nova/1.0";
    this.defaultLocationId = process.env.WEBDOCK_LOCATION_ID || "";
    this.defaultImageSlug = process.env.WEBDOCK_IMAGE_SLUG || "ubuntu-noble";
    this.defaultPlatform = process.env.WEBDOCK_PLATFORM || "epyc_vps";
    this.defaultCpuThreads = Number(process.env.WEBDOCK_STARTER_CPU_THREADS || 2);
    this.defaultRamGb = Number(process.env.WEBDOCK_STARTER_RAM_GB || 4);
    this.defaultDiskGb = Number(process.env.WEBDOCK_STARTER_DISK_GB || 30);
    this.defaultNetworkBandwidth = Number(process.env.WEBDOCK_STARTER_NETWORK_BANDWIDTH || 1);

    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Application": this.application,
      },
    });

    this.client.interceptors.request.use((config) => {
      if (this.token) config.headers.Authorization = `Bearer ${this.token}`;
      return config;
    });
  }

  isConfigured() {
    return Boolean(this.token && this.defaultLocationId);
  }

  assertConfigured() {
    if (!this.token) throw new Error("WEBDOCK_API_TOKEN is not configured");
    if (!this.defaultLocationId) throw new Error("WEBDOCK_LOCATION_ID is not configured");
  }

  getCallbackId(response) {
    return response?.headers?.["x-callback-id"] || response?.headers?.["X-Callback-ID"] || null;
  }

  getCallbackSequence(response) {
    const raw = response?.headers?.["x-callback-sequence"] || response?.headers?.["X-Callback-Sequence"];
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return String(raw).split(",").map((item) => item.trim()).filter(Boolean);
    }
  }

  async request(method, url, data, options = {}) {
    const response = await this.client.request({ method, url, data, ...options });
    return {
      data: response.data,
      status: response.status,
      callbackId: this.getCallbackId(response),
      callbackSequence: this.getCallbackSequence(response),
      rateLimit: {
        limit: response.headers?.["x-ratelimit-limit"],
        remaining: response.headers?.["x-ratelimit-remaining"],
        reset: response.headers?.["x-ratelimit-reset"],
      },
    };
  }

  async ping() {
    return this.request("GET", "/ping");
  }

  async listLocations() {
    return this.request("GET", "/locations");
  }

  async listImages(locationId = this.defaultLocationId) {
    return this.request("GET", "/images", null, { params: { locationId } });
  }

  async listPlatforms() {
    return this.request("GET", "/platforms");
  }

  async listProfiles(locationId = this.defaultLocationId) {
    return this.request("GET", "/profiles", null, { params: { locationId } });
  }

  async listAccountScripts() {
    this.assertConfigured();
    return this.request("GET", "/account/scripts");
  }

  async createAccountScript({ name, filename, content }) {
    this.assertConfigured();
    return this.request("POST", "/account/scripts", { name, filename, content });
  }

  async updateAccountScript(scriptId, { name, filename, content }) {
    this.assertConfigured();
    if (!scriptId) throw new Error("scriptId is required");
    return this.request("PATCH", `/account/scripts/${encodeURIComponent(scriptId)}`, { name, filename, content });
  }

  async createCustomProfile({ platform, cpuThreads, ramGb, diskGb, networkBandwidth }) {
    this.assertConfigured();
    return this.request("POST", "/profiles", {
      platform: platform || this.defaultPlatform,
      cpu_threads: Number(cpuThreads || this.defaultCpuThreads),
      ram: Number(ramGb || this.defaultRamGb),
      disk_space: Number(diskGb || this.defaultDiskGb),
      network_bandwidth: Number(networkBandwidth || this.defaultNetworkBandwidth),
    });
  }

  async deleteCustomProfile(profileSlug) {
    if (!profileSlug) return null;
    return this.request("DELETE", `/profiles/${encodeURIComponent(profileSlug)}`);
  }

  async provisionServer({ name, slug, profileSlug, imageSlug, locationId, userScriptId }) {
    this.assertConfigured();
    const payload = {
      name,
      slug,
      locationId: locationId || this.defaultLocationId,
      profileSlug,
      imageSlug: imageSlug || this.defaultImageSlug,
      virtualization: "kvm",
    };
    if (userScriptId) payload.userScriptId = userScriptId;
    return this.request("POST", "/servers", payload);
  }

  async getServer(serverSlug) {
    return this.request("GET", `/servers/${encodeURIComponent(serverSlug)}`);
  }

  async deleteServer(serverSlug) {
    return this.request("DELETE", `/servers/${encodeURIComponent(serverSlug)}`);
  }

  async rebootServer(serverSlug) {
    return this.request("POST", `/servers/${encodeURIComponent(serverSlug)}/actions/reboot`);
  }

  async dryRunResize(serverSlug, profileSlug) {
    return this.request("POST", `/servers/${encodeURIComponent(serverSlug)}/actions/resize/dryrun`, { profileSlug });
  }

  async resizeServer(serverSlug, profileSlug) {
    return this.request("POST", `/servers/${encodeURIComponent(serverSlug)}/actions/resize`, { profileSlug });
  }

  async getMetrics(serverSlug) {
    return this.request("GET", `/servers/${encodeURIComponent(serverSlug)}/metrics`);
  }

  async getInstantMetrics(serverSlug) {
    return this.request("GET", `/servers/${encodeURIComponent(serverSlug)}/metrics/now`);
  }

  async getEvents(callbackId) {
    return this.request("GET", "/events", null, {
      params: {
        callbackId,
        per_page: 10,
      },
    });
  }

  makeSlug(platformID) {
    return String(platformID || "nova")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 12) || `nova${Date.now().toString().slice(-8)}`;
  }

  firstString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return undefined;
  }

  makeDatabaseName(platformID, platform = {}) {
    const template = process.env.DEDICATED_DATABASE_NAME_TEMPLATE || "nova_{platformID}";
    const platformSlug = String(platform?.url || platform?.name || platformID || "platform")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    return template
      .replace(/\{platformID\}/g, String(platformID || "").toLowerCase())
      .replace(/\{platformSlug\}/g, platformSlug || String(platformID || "").toLowerCase())
      .replace(/[^a-z0-9_]/gi, "_")
      .replace(/^_+|_+$/g, "");
  }

  defaultServerDetails(platformID, platform = {}) {
    return {
      rootUser: process.env.DEDICATED_SERVER_ROOT_USER || "root",
      databaseName: this.makeDatabaseName(platformID, platform),
      sshPort: String(process.env.DEDICATED_SERVER_SSH_PORT || 22),
      sshStatus: "provisioning",
    };
  }

  normalizeServer(server) {
    if (!server) return {};
    const profile = server.profileData || {};
    const credentials = server.credentials || server.serverCredentials || {};
    const shellUser =
      server.shellUser ||
      server.adminUser ||
      server.defaultShellUser ||
      credentials.shellUser ||
      credentials.username;
    const ipAddress = this.firstString(
      server.ip,
      server.ipv4,
      server.ipAddress,
      server.publicIp,
      server.publicIPv4,
      server.network?.ipv4,
      server.network?.publicIp,
    );
    const sshPassword = this.firstString(
      server.sshPassword,
      server.rootPassword,
      server.adminPassword,
      server.shellPassword,
      server.password,
      credentials.sshPassword,
      credentials.rootPassword,
      credentials.adminPassword,
      credentials.password,
    );
    const databaseName = this.firstString(
      server.databaseName,
      server.postgresDatabase,
      server.postgresqlDatabase,
      server.mysqlDatabase,
      server.database?.name,
    );

    const normalized = {
      webdockSlug: this.firstString(server.slug, server.webdockSlug),
      webdockId: server.id !== undefined && server.id !== null ? String(server.id) : undefined,
      webdockStatus: this.firstString(server.status, server.webdockStatus),
      profileSlug: this.firstString(server.profile, server.profileSlug, profile.slug),
      ipAddress,
      rootUser: this.firstString(shellUser, server.rootUser),
      sshPassword,
      sshPort: String(server.sshPort || server.ssh_port || 22),
      sshStatus: sshPassword
        ? "password available"
        : server.SSHPasswordAuthEnabled
          ? "password enabled"
          : "key only",
      nginxStatus: String(server.webServer || "").toLowerCase() === "nginx" ? "active" : undefined,
      databaseName,
      providerData: server,
      cpuThreads: profile?.cpu?.threads || server.cpuThreads || undefined,
      ramGb: profile?.ram ? Math.round(Number(profile.ram) / 1024) : undefined,
      diskGb: profile?.disk ? Math.round(Number(profile.disk) / 1024) : undefined,
      networkBandwidth: profile?.network_bandwidth || undefined,
      lastSyncedAt: new Date(),
      pendingDeletionAt: server.pendingDeletion ? new Date() : null,
    };
    return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
  }

  latestSamplingValue(sampling) {
    if (!sampling) return null;
    if (Array.isArray(sampling)) return sampling.length ? Number(sampling[sampling.length - 1]?.amount || 0) : null;
    return Number(sampling.amount || 0);
  }

  normalizeInstantMetrics(metrics, server = {}) {
    const profile = server.profileData || {};
    const diskAllowed = metrics?.disk?.allowed || profile.disk || null;
    const diskUsed = this.latestSamplingValue(metrics?.disk?.lastSamplings);
    const memoryUsed = this.latestSamplingValue(metrics?.memory?.latestUsageSampling);
    const memoryTotal = profile.ram || (server.ramGb ? Number(server.ramGb) * 1024 : null);
    const cpuUsed = this.latestSamplingValue(metrics?.cpu?.latestUsageSampling);
    const cpuThreads = profile?.cpu?.threads || server.cpuThreads || null;

    return {
      raw: metrics,
      disk: {
        usedMiB: diskUsed,
        allowedMiB: diskAllowed,
        usedPercent: diskAllowed && diskUsed !== null ? Number(((diskUsed / diskAllowed) * 100).toFixed(1)) : null,
      },
      memory: {
        usedMiB: memoryUsed,
        totalMiB: memoryTotal,
        usedPercent: memoryTotal && memoryUsed !== null ? Number(((memoryUsed / memoryTotal) * 100).toFixed(1)) : null,
      },
      cpu: {
        usedSeconds: cpuUsed,
        threads: cpuThreads,
      },
      network: metrics?.network || null,
      processes: this.latestSamplingValue(metrics?.processes?.latestProcessesSampling),
      checkedAt: new Date().toISOString(),
    };
  }
}

module.exports = { WebdockService };
