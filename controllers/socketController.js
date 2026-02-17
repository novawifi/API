// @ts-check

const socketIo = require("socket.io");
const { DataBase } = require("../helpers/databaseOperation");
const { Auth } = require("./authController");
const fs = require("fs");
const path = require("path");
const appRoot = require("app-root-path").path;
const cache = require("../utils/cache");
const { MikrotikConnection } = require("../configs/mikrotikConfig");


class Socket {
    constructor() {
        this.db = new DataBase();
        this.auth = new Auth();
        this.conn = new MikrotikConnection();
        this.io = null;
        this.clients = new Map();
        this.supportPresence = new Map();
        this.supportPlatformPresence = new Map();
        this.supportPlatformSubscribers = new Map();
        this.supportManagers = new Set();
        this.cache = cache;

        this.SUPPORT_UPLOADS_DIR = path.join(appRoot, "public", "support-uploads");

    }

    ensureSupportUploadsDir() {
        if (!fs.existsSync(this.SUPPORT_UPLOADS_DIR)) {
            fs.mkdirSync(this.SUPPORT_UPLOADS_DIR, { recursive: true });
        }
    };

    sanitizeFileName(name) {
        if (!name) return "attachment";
        return name.replace(/[^a-zA-Z0-9._-]/g, "_");
    };

    saveAttachments(threadId, attachments = []) {
        if (!Array.isArray(attachments) || attachments.length === 0) return [];
        this.ensureSupportUploadsDir();
        return attachments
            .map((attachment) => {
                const raw = attachment?.data || attachment?.base64 || "";
                if (!raw) return null;
                const parts = raw.split(";base64,");
                const base64Data = parts.length > 1 ? parts.pop() : raw;
                const safeName = this.sanitizeFileName(attachment?.name);
                const filename = `${threadId}-${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;
                const finalPath = path.join(this.SUPPORT_UPLOADS_DIR, filename);
                try {
                    fs.writeFileSync(finalPath, Buffer.from(base64Data, "base64"));
                    const type = attachment?.type || "application/octet-stream";
                    const kind = type.startsWith("image/") ? "image" : "file";
                    return {
                        id: filename,
                        name: attachment?.name || safeName,
                        type,
                        kind,
                        url: `/support-uploads/${filename}`,
                    };
                } catch (error) {
                    console.error("Error saving attachment:", error);
                    return null;
                }
            })
            .filter(Boolean);
    };

    async emitCachedDashboardStats(socket) {
        const platformID = socket?.user?.platformID;
        if (!platformID) return;
        const record = await this.db.getDashboardStats(platformID);
        if (!record) return;
        const response = {
            success: true,
            message: "Dashboard stats fetched",
            stats: record.stats || {},
            funds: record.funds || {},
            networkusage: record.networkUsage || [],
            IsB2B: record.isB2B || false,
        };
        socket.emit("stats", response);
    }

    async SocketInstance(server) {
        if (!this.io) {
            // @ts-ignore
            this.io = socketIo(server, { cors: { origin: "*" } });

            this.io.use(async (socket, next) => {
                const token = socket.handshake.auth?.token;

                if (!token) {
                    socket.user = null;
                    return next();
                }

                try {
                    const auth = await this.auth.AuthenticateRequest(token);
                    if (!auth.success) {
                        return socket.emit("platform-error", {
                            error: auth.message,
                        });
                    }
                    socket.user = auth.admin || null;
                    socket.superuser = auth.superuser || null;
                    next();
                } catch (err) {
                    socket.emit("platform-error", { error: "Failed to get user data" });
                    socket.user = null;
                    socket.superuser = null;
                    next();
                }
            });

            this.io.on("connection", async (socket) => {
                this.clients.set(socket.id, socket);
                this.io.emit("client-count", this.clients.size);

                if (socket.user) {
                    try {
                        const platformData = await this.db.getPlatform(socket.user.platformID)
                        const platformData2 = await this.db.getPlatformByplatformID(socket.user.platformID)
                        if (platformData) {
                            const platformRoom = `platform-${platformData.platformID}`;
                            socket.join(platformRoom);
                            console.log(
                                `User ${socket.user.id} joined secure room platform-${platformData.platformID}`
                            );
                            this.log(platformData.platformID, `User ${socket.user.id} joined secure room platform-${platformData.platformID}`, {
                                context: "socket",
                                level: "info",
                            });
                            this.io.to(platformRoom).emit("joined-platform", { platformId: platformData.platformID });
                            this.io.to(platformRoom).emit("platform-data", platformData2);
                    await this.emitCachedDashboardStats(socket);
                }

                if (socket.user?.platformID) {
                    const platformID = socket.user.platformID;
                    let presence = this.supportPlatformPresence.get(platformID);
                    if (!presence) {
                        presence = { admins: new Set(), customers: new Set() };
                        this.supportPlatformPresence.set(platformID, presence);
                    }
                    presence.admins.add(socket.id);
                    this.emitPlatformPresence(platformID);
                }
                if (socket.superuser) {
                    this.supportManagers.add(socket.id);
                    this.emitAllPlatformPresence();
                }
                    } catch (error) {
                        console.error("Error auto-joining platform:", error);
                    }
                }

                socket.on("client-data", async (data) => {
                    const { platform, ip } = data;
                    try {
                        const platformData = await this.db.getPlatformByUrl(platform);
                        socket.emit("platform-data", platformData);
                    } catch (error) {
                        console.error(`Error fetching platform for ${platform}:`, error);
                        socket.emit("platform-error", { error: "Failed to get platform data" });
                    }
                });

                socket.on("client-data_2", async (data) => {
                    const { plat_id, ip } = data;
                    try {
                        const platformData = await this.db.getPlatform(plat_id);
                        socket.emit("platform-data", platformData);
                    } catch (error) {
                        console.error(`Error fetching platform for ${data.plat_id}:`, error);
                        socket.emit("platform-error", { error: "Failed to get platform data" });
                    }
                });
                socket.on("connect-mikrotik", async (data) => {
                    const token = data.token;
                    try {
                        const result = await this.conn.createMikrotikClient(token);
                        socket.emit("connection-status", result);
                    } catch (error) {
                        console.error("Mikrotik Connection Error:", error);
                        socket.emit("platform-error", { error: "Failed to connect to MikroTik routers." });
                    }
                });

                socket.on("join-room", async (checkoutRequestId) => {
                    console.log(`Socket ${socket.id} joining room ${checkoutRequestId}`);
                    socket.join(checkoutRequestId);
                    const payment = await this.db.getMpesaByCode(checkoutRequestId);
                    if (payment) {
                        const platform = await this.db.getPlatform(payment.platformID);
                        if (platform) this.log(platform?.id, `Socket ${socket.id} joining room ${checkoutRequestId}`);
                    }
                });

                socket.on("leave-room", async (checkoutRequestId) => {
                    console.log(`Socket ${socket.id} leaving room ${checkoutRequestId}`);
                    socket.leave(checkoutRequestId);
                    const payment = await this.db.getMpesaByCode(checkoutRequestId);
                    if (payment) {
                        const platform = await this.db.getPlatform(payment.platformID);
                        if (platform) this.log(platform?.id, `Socket ${socket.id} leaving room ${checkoutRequestId}`);
                    }
                });

                socket.on("support:join", async (data) => {
                    const threadId = data?.threadId;
                    if (!threadId) return;
                    console.log("[support:join]", { socketId: socket.id, threadId });
                    const thread = await this.db.getSupportThreadById(threadId);
                    if (!thread) {
                        return socket.emit("support:error", { message: "Thread not found" });
                    }

                    const isManager = !!socket.superuser;
                    if (!isManager && socket.user?.platformID !== thread.platformID) {
                        return socket.emit("support:error", { message: "Forbidden" });
                    }

                    socket.join(`support-${threadId}`);
                    if (!socket.data.supportThreads) {
                        socket.data.supportThreads = new Set();
                    }
                    socket.data.supportThreads.add(threadId);

                    let presence = this.supportPresence.get(threadId);
                    if (!presence) {
                        presence = { admins: new Set(), managers: new Set(), customers: new Set() };
                        this.supportPresence.set(threadId, presence);
                    }
                    if (isManager) {
                        presence.managers.add(socket.id);
                    } else {
                        presence.admins.add(socket.id);
                    }

                    this.io.to(`support-${threadId}`).emit("support:presence", {
                        threadId,
                        adminOnline: presence.admins.size > 0,
                        managerOnline: presence.managers.size > 0,
                        customerOnline: presence.customers.size > 0,
                    });
                    socket.emit("support:thread", { thread });
                });

                socket.on("support:presence:platform:join", async (data) => {
                    const platformID = data?.platformID;
                    if (!platformID) return;
                    socket.join(`support-platform-${platformID}`);
                    if (!socket.data.supportPlatformIds) {
                        socket.data.supportPlatformIds = new Set();
                    }
                    socket.data.supportPlatformIds.add(platformID);

                    let subscribers = this.supportPlatformSubscribers.get(platformID);
                    if (!subscribers) {
                        subscribers = new Set();
                        this.supportPlatformSubscribers.set(platformID, subscribers);
                    }
                    subscribers.add(socket.id);

                    this.emitPlatformPresence(platformID);
                });

                socket.on("support:presence:platform:leave", (data) => {
                    const platformID = data?.platformID;
                    if (!platformID) return;
                    socket.leave(`support-platform-${platformID}`);
                    if (socket.data.supportPlatformIds) {
                        socket.data.supportPlatformIds.delete(platformID);
                    }
                    const subscribers = this.supportPlatformSubscribers.get(platformID);
                    if (subscribers) {
                        subscribers.delete(socket.id);
                        if (subscribers.size === 0) {
                            this.supportPlatformSubscribers.delete(platformID);
                        }
                    }
                });

                socket.on("support:public:join", async (data) => {
                    const threadId = data?.threadId;
                    const phone = data?.phone;
                    if (!threadId || !phone) return;
                    console.log("[support:public:join]", { socketId: socket.id, threadId, phone });
                    const thread = await this.db.getSupportThreadById(threadId);
                    if (!thread) {
                        return socket.emit("support:error", { message: "Thread not found" });
                    }
                    if (thread.type !== "live" || thread.channel !== "public") {
                        return socket.emit("support:error", { message: "Forbidden" });
                    }
                    const plugin = await this.db.getPlatformPlugin(thread.platformID, "live-support");
                    if (!plugin || (plugin.status && plugin.status !== "active")) {
                        return socket.emit("support:error", { message: "Live support is not enabled" });
                    }
                    const service = await this.db.getSystemServiceByKey("live-support");
                    if (service && Number(service.price) > 0) {
                        const platform = await this.db.getPlatformByplatformID(thread.platformID);
                        const isPremium = String(platform?.status || "").toLowerCase() === "premium";
                        if (!isPremium) {
                            const bill = await this.db.getPlatformBillingByName(service.name, thread.platformID);
                            if (!bill || String(bill.status || "").toLowerCase() !== "paid") {
                                return socket.emit("support:error", { message: "Live support is unpaid" });
                            }
                        }
                    }
                    if (String(thread.subject || "") !== String(phone)) {
                        return socket.emit("support:error", { message: "Forbidden" });
                    }

                    socket.join(`support-${threadId}`);
                    if (!socket.data.supportThreads) {
                        socket.data.supportThreads = new Set();
                    }
                    socket.data.supportThreads.add(threadId);

                    let presence = this.supportPresence.get(threadId);
                    if (!presence) {
                        presence = { admins: new Set(), managers: new Set(), customers: new Set() };
                        this.supportPresence.set(threadId, presence);
                    }
                    presence.customers.add(socket.id);

                    this.io.to(`support-${threadId}`).emit("support:presence", {
                        threadId,
                        adminOnline: presence.admins.size > 0,
                        managerOnline: presence.managers.size > 0,
                        customerOnline: presence.customers.size > 0,
                    });
                    socket.emit("support:thread", { thread });
                });

                socket.on("support:leave", (data) => {
                    const threadId = data?.threadId;
                    if (!threadId) return;
                    socket.leave(`support-${threadId}`);
                    if (socket.data.supportThreads) {
                        socket.data.supportThreads.delete(threadId);
                    }
                    const presence = this.supportPresence.get(threadId);
                    if (presence) {
                        presence.admins.delete(socket.id);
                        presence.managers.delete(socket.id);
                        presence.customers.delete(socket.id);
                        this.io.to(`support-${threadId}`).emit("support:presence", {
                            threadId,
                            adminOnline: presence.admins.size > 0,
                            managerOnline: presence.managers.size > 0,
                            customerOnline: presence.customers.size > 0,
                        });
                        if (presence.admins.size === 0 && presence.managers.size === 0 && presence.customers.size === 0) {
                            this.supportPresence.delete(threadId);
                        }
                    }
                });

                socket.on("support:message", async (data) => {
                    const threadId = data?.threadId;
                    const body = data?.body;
                    const attachments = data?.attachments;
                    if (!threadId || !body) return;

                    const thread = await this.db.getSupportThreadById(threadId);
                    if (!thread) {
                        return socket.emit("support:error", { message: "Thread not found" });
                    }

                    const isManager = !!socket.superuser;
                    if (!isManager && socket.user?.platformID !== thread.platformID) {
                        return socket.emit("support:error", { message: "Forbidden" });
                    }

                    const senderRole = isManager ? "manager" : "admin";
                    const senderID = isManager ? socket.superuser?.id || null : socket.user?.id || null;

                    const savedAttachments = this.saveAttachments(threadId, attachments);
                    const message = await this.db.createSupportMessage({
                        threadID: threadId,
                        senderRole,
                        senderID,
                        body,
                        attachments: savedAttachments.length ? savedAttachments : undefined,
                    });

                    const updateData = { updatedAt: new Date() };
                    if (isManager && !thread.managerID) {
                        updateData.managerID = socket.superuser?.id || null;
                    }
                    if (thread.type === "live" && thread.status === "waiting" && isManager) {
                        updateData.status = "active";
                    }
                    await this.db.updateSupportThread(threadId, updateData);

                    let senderName = "";
                    if (isManager && senderID) {
                        const manager = await this.db.getSuperUserById(senderID);
                        senderName = manager?.name || manager?.email || "Nova Support";
                    } else if (!isManager && senderID) {
                        const admin = await this.db.getAdminByID(senderID);
                        senderName = admin?.name || admin?.email || "Support Agent";
                    }

                    this.io.to(`support-${threadId}`).emit("support:message", {
                        threadId,
                        message: { ...message, senderName },
                    });
                });

                socket.on("support:typing", async (data) => {
                    const threadId = data?.threadId;
                    if (!threadId) return;
                    console.log("[support:typing]", { socketId: socket.id, threadId, isTyping: data?.isTyping });
                    const thread = await this.db.getSupportThreadById(threadId);
                    if (!thread) {
                        return socket.emit("support:error", { message: "Thread not found" });
                    }

                    const isManager = !!socket.superuser;
                    if (!isManager && socket.user?.platformID !== thread.platformID) {
                        return socket.emit("support:error", { message: "Forbidden" });
                    }

                    this.io.to(`support-${threadId}`).emit("support:typing", {
                        threadId,
                        isTyping: Boolean(data?.isTyping),
                        senderRole: isManager ? "manager" : "admin",
                    });
                });


                socket.on("support:public:message", async (data) => {
                    const threadId = data?.threadId;
                    const body = data?.body;
                    const phone = data?.phone;
                    if (!threadId || !body || !phone) return;

                    const thread = await this.db.getSupportThreadById(threadId);
                    if (!thread) {
                        return socket.emit("support:error", { message: "Thread not found" });
                    }
                    if (String(thread.status || "").toLowerCase() === "closed") {
                        return socket.emit("support:error", { message: "Chat closed. Please start a new chat." });
                    }
                    if (thread.type !== "live" || thread.channel !== "public") {
                        return socket.emit("support:error", { message: "Forbidden" });
                    }
                    const plugin = await this.db.getPlatformPlugin(thread.platformID, "live-support");
                    if (!plugin || (plugin.status && plugin.status !== "active")) {
                        return socket.emit("support:error", { message: "Live support is not enabled" });
                    }
                    const service = await this.db.getSystemServiceByKey("live-support");
                    if (service && Number(service.price) > 0) {
                        const platform = await this.db.getPlatformByplatformID(thread.platformID);
                        const isPremium = String(platform?.status || "").toLowerCase() === "premium";
                        if (!isPremium) {
                            const bill = await this.db.getPlatformBillingByName(service.name, thread.platformID);
                            if (!bill || String(bill.status || "").toLowerCase() !== "paid") {
                                return socket.emit("support:error", { message: "Live support is unpaid" });
                            }
                        }
                    }
                    if (String(thread.subject || "") !== String(phone)) {
                        return socket.emit("support:error", { message: "Forbidden" });
                    }

                    const savedAttachments = this.saveAttachments(threadId, data?.attachments);
                    const message = await this.db.createSupportMessage({
                        threadID: threadId,
                        senderRole: "customer",
                        senderID: null,
                        body,
                        attachments: savedAttachments.length ? savedAttachments : undefined,
                    });

                    await this.db.updateSupportThread(threadId, { updatedAt: new Date() });

                    this.io.to(`support-${threadId}`).emit("support:message", {
                        threadId,
                        message: { ...message, senderName: thread.subject || "Customer" },
                    });
                });


                socket.on("router-auto:join", (data) => {
                    const token = data?.token;
                    if (!token) return;
                    socket.join(`router-auto-${token}`);
                    socket.emit("router-auto:joined", { token });
                });

                socket.on("router-auto:leave", (data) => {
                    const token = data?.token;
                    if (!token) return;
                    socket.leave(`router-auto-${token}`);
                });

                socket.on("disconnect", () => {
                    this.clients.delete(socket.id);
                    this.io.emit("client-count", this.clients.size);
                    if (socket.data.supportThreads) {
                        for (const threadId of socket.data.supportThreads) {
                            const presence = this.supportPresence.get(threadId);
                            if (presence) {
                                presence.admins.delete(socket.id);
                                presence.managers.delete(socket.id);
                                presence.customers.delete(socket.id);
                                this.io.to(`support-${threadId}`).emit("support:presence", {
                                    threadId,
                                    adminOnline: presence.admins.size > 0,
                                    managerOnline: presence.managers.size > 0,
                                    customerOnline: presence.customers.size > 0,
                                });
                                if (presence.admins.size === 0 && presence.managers.size === 0 && presence.customers.size === 0) {
                                    this.supportPresence.delete(threadId);
                                }
                            }
                        }
                    }
                    if (socket.user?.platformID) {
                        const platformID = socket.user.platformID;
                        const presence = this.supportPlatformPresence.get(platformID);
                        if (presence) {
                            presence.admins.delete(socket.id);
                            presence.customers.delete(socket.id);
                            if (presence.admins.size === 0 && presence.customers.size === 0) {
                                this.supportPlatformPresence.delete(platformID);
                            }
                        }
                        this.emitPlatformPresence(platformID);
                    }
                    if (socket.superuser) {
                        this.supportManagers.delete(socket.id);
                        this.emitAllPlatformPresence();
                    }
                    if (socket.data.supportPlatformIds) {
                        for (const platformID of socket.data.supportPlatformIds) {
                            const subscribers = this.supportPlatformSubscribers.get(platformID);
                            if (subscribers) {
                                subscribers.delete(socket.id);
                                if (subscribers.size === 0) {
                                    this.supportPlatformSubscribers.delete(platformID);
                                }
                            }
                        }
                    }
                });
            });
        }
        return this.io;
    };

    emitPlatformPresence(platformID) {
        if (!this.io || !platformID) return;
        const presence = this.supportPlatformPresence.get(platformID);
        const adminOnline = presence ? presence.admins.size > 0 : false;
        const managerOnline = this.supportManagers.size > 0;
        this.io.to(`support-platform-${platformID}`).emit("support:presence:platform", {
            platformID,
            adminOnline,
            managerOnline,
            agentOnline: adminOnline || managerOnline,
        });
    }

    emitAllPlatformPresence() {
        if (!this.io) return;
        for (const platformID of this.supportPlatformSubscribers.keys()) {
            this.emitPlatformPresence(platformID);
        }
    }

    emitEvent(event, data, room = "") {
        if (this.io) {
            if (room) {
                this.io.to(room).emit(event, data);
            } else {
                this.io.emit(event, data);
            }
        }
    };

    emitToRoom(room, event, data) {
        if (this.io && room) {
            this.io.to(room).emit(event, data);
        }
    }

    log(platformID, message, meta = {}) {
        if (!platformID || !this.io) return;
        let formatted = message;
        if (typeof message !== "string") {
            try {
                formatted = JSON.stringify(message);
            } catch {
                formatted = String(message);
            }
        }
        const payload = {
            message: formatted,
            at: new Date().toISOString(),
            ...meta,
        };
        this.emitEvent("terminal-log", payload, `platform-${platformID}`);
    }

}

const socketManager = new Socket();

module.exports = { Socket, socketManager }
