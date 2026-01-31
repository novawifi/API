const socketIo = require("socket.io");
const { DataBase } = require("../helpers/databaseOperation");
const { Auth } = require("./authController");
const fs = require("fs");
const path = require("path");
const appRoot = require("app-root-path").path;
const cache = require("../utils/cache");

const SUPPORT_UPLOADS_DIR = path.join(appRoot, "public", "support-uploads");

const ensureSupportUploadsDir = () => {
    if (!fs.existsSync(SUPPORT_UPLOADS_DIR)) {
        fs.mkdirSync(SUPPORT_UPLOADS_DIR, { recursive: true });
    }
};

const sanitizeFileName = (name) => {
    if (!name) return "attachment";
    return name.replace(/[^a-zA-Z0-9._-]/g, "_");
};

const saveAttachments = (threadId, attachments = []) => {
    if (!Array.isArray(attachments) || attachments.length === 0) return [];
    ensureSupportUploadsDir();
    return attachments
        .map((attachment) => {
            const raw = attachment?.data || attachment?.base64 || "";
            if (!raw) return null;
            const parts = raw.split(";base64,");
            const base64Data = parts.length > 1 ? parts.pop() : raw;
            const safeName = sanitizeFileName(attachment?.name);
            const filename = `${threadId}-${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;
            const finalPath = path.join(SUPPORT_UPLOADS_DIR, filename);
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

class Socket {
    constructor() {
        this.db = new DataBase();
        this.auth = new Auth();
        this.io = null;
        this.clients = new Map();
        this.supportPresence = new Map();
        this.cache = cache;
    }

    emitCachedDashboardStats(socket) {
        const platformID = socket?.user?.platformID;
        if (!platformID) return;
        const cacheKey = `main:dashboard:${platformID}`;
        const cached = this.cache.get(cacheKey);
        if (cached?.success) {
            socket.emit("stats", cached);
        }
    }

    async SocketInstance(server) {
        if (!this.io) {
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
                            socket.join(`platform-${platformData.id}`);
                            console.log(
                                `User ${socket.user.id} joined secure room platform-${platformData.id}`
                            );
                            this.log(platformData.id, `User ${socket.user.id} joined secure room platform-${platformData.id}`)
                            this.io.to(`platform-${platformData.id}`).emit("joined-platform", { platformId: platformData.id });
                            this.io.to(`platform-${platformData.id}`).emit("platform-data", platformData2);
                            this.emitCachedDashboardStats(socket);
                        }
                    } catch (error) {
                        console.error("Error auto-joining platform:", error);
                    }
                }

                socket.on("client-data", async (data) => {
                    try {
                        const { platform, ip } = data;
                        const platformData = await this.db.getPlatformByUrl(platform);
                        socket.emit("platform-data", platformData);
                    } catch (error) {
                        console.error(`Error fetching platform for ${platform}:`, error);
                        socket.emit("platform-error", { error: "Failed to get platform data" });
                    }
                });
                socket.on("client-data_2", async (data) => {
                    try {
                        const { plat_id, ip } = data;
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
                        const result = await createMikrotikClient(token);
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
                        const platform = this.db.getPlatform(payment.platformID);
                        if (platform) this.log(platform.id, `Socket ${socket.id} joining room ${checkoutRequestId}`)
                    }
                });

                socket.on("leave-room", async (checkoutRequestId) => {
                    console.log(`Socket ${socket.id} leaving room ${checkoutRequestId}`);
                    socket.leave(checkoutRequestId);
                    const payment = await this.db.getMpesaByCode(checkoutRequestId);
                    if (payment) {
                        const platform = this.db.getPlatform(payment.platformID);
                        if (platform) this.log(platform.id, `Socket ${socket.id} leaving room ${checkoutRequestId}`)
                    }
                });

                socket.on("support:join", async (data) => {
                    const threadId = data?.threadId;
                    if (!threadId) return;
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
                        presence = { admins: new Set(), managers: new Set() };
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
                        this.io.to(`support-${threadId}`).emit("support:presence", {
                            threadId,
                            adminOnline: presence.admins.size > 0,
                            managerOnline: presence.managers.size > 0,
                        });
                        if (presence.admins.size === 0 && presence.managers.size === 0) {
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

                    const savedAttachments = saveAttachments(threadId, attachments);
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

                    this.io.to(`support-${threadId}`).emit("support:message", {
                        threadId,
                        message,
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
                                this.io.to(`support-${threadId}`).emit("support:presence", {
                                    threadId,
                                    adminOnline: presence.admins.size > 0,
                                    managerOnline: presence.managers.size > 0,
                                });
                                if (presence.admins.size === 0 && presence.managers.size === 0) {
                                    this.supportPresence.delete(threadId);
                                }
                            }
                        }
                    }
                });
            });
        }
        return this.io;
    };

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

    log(id, body) {
        if (id) {
            this.emitEvent(`platform-${id}`, body, "terminal-logs")
        }
    }

}

const socketManager = new Socket();

module.exports = { Socket, socketManager }
