// @ts-check

const { DataBase } = require("../helpers/databaseOperation");
const { Auth } = require("./authController");
const cache = require("../utils/cache");
const fs = require("fs");
const path = require("path");
const appRoot = require("app-root-path").path;

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

class SupportController {
    constructor() {
        this.db = new DataBase();
        this.auth = new Auth();
        this.cache = cache;
    }

    async resolveSenderName(message, thread) {
        if (!message) return "";
        if (message.senderRole === "admin" && message.senderID) {
            const admin = await this.db.getAdminByID(message.senderID);
            return admin?.name || admin?.email || "Support Agent";
        }
        if (message.senderRole === "manager" && message.senderID) {
            const manager = await this.db.getSuperUserById(message.senderID);
            return manager?.name || manager?.email || "Nova Support";
        }
        if (message.senderRole === "customer") {
            return thread?.subject || "Customer";
        }
        return "";
    }

    async enrichThread(thread) {
        if (!thread || !Array.isArray(thread.messages)) return thread;
        const messages = [];
        for (const msg of thread.messages) {
            const senderName = await this.resolveSenderName(msg, thread);
            messages.push({ ...msg, senderName });
        }
        return { ...thread, messages };
    }

    getToken(req) {
        const header = req.headers.authorization || "";
        if (header.startsWith("Bearer ")) {
            return header.slice(7);
        }
        return req.body?.token || "";
    }

    async requireAuth(req, res) {
        const token = this.getToken(req);
        const auth = await this.auth.AuthenticateRequest(token);
        if (!auth.success) {
            res.status(401).json({ success: false, message: auth.message });
            return null;
        }
        const isManager = !!auth.superuser;
        const admin = auth.admin || null;
        const manager = auth.superuser || null;
        return { isManager, admin, manager };
    }

    async requirePublicAccess(req, res, platformID) {
        if (!platformID) {
            res.status(400).json({ success: false, message: "Platform ID is required." });
            return null;
        }
        const plugin = await this.db.getPlatformPlugin(platformID, "live-support");
        if (!plugin || (plugin.status && plugin.status !== "active")) {
            res.status(403).json({ success: false, message: "Live support is not enabled." });
            return null;
        }
        const service = await this.db.getSystemServiceByKey("live-support");
        if (service && Number(service.price) > 0) {
            const platform = await this.db.getPlatformByplatformID(platformID);
            const isPremium = String(platform?.status || "").toLowerCase() === "premium";
            if (!isPremium) {
                const bill = await this.db.getPlatformBillingByName(service.name, platformID);
                if (!bill || String(bill.status || "").toLowerCase() !== "paid") {
                    res.status(403).json({ success: false, message: "Live support is unpaid." });
                    return null;
                }
            }
        }
        return { platformID };
    }

    async listTickets(req, res) {
        const auth = await this.requireAuth(req, res);
        if (!auth) return;

        const platformKey = auth.isManager ? "all" : auth.admin.platformID;
        const cacheKey = `support:tickets:${platformKey}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return res.status(200).json(cached);
        }

        const threads = auth.isManager
            ? await this.db.getSupportThreads("ticket")
            : await this.db.getSupportThreadsByPlatform(auth.admin.platformID, "ticket");

        const response = { success: true, threads };
        this.cache.set(cacheKey, response, 15000);
        return res.status(200).json(response);
    }

    async listLive(req, res) {
        const auth = await this.requireAuth(req, res);
        if (!auth) return;

        const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 100));
        const page = Math.max(1, Number(req.query.page) || 1);
        const offset = (page - 1) * limit;
        const channel = req.query.channel ? String(req.query.channel) : undefined;

        const platformKey = auth.isManager ? "all" : auth.admin.platformID;
        const cacheKey = `support:live:${platformKey}:${page}:${limit}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return res.status(200).json(cached);
        }

        const result = auth.isManager
            ? await this.db.getSupportThreadsPaged("live", limit, offset, channel)
            : await this.db.getSupportThreadsByPlatformPaged(auth.admin.platformID, "live", limit, offset, channel);

        const threads = result.rows || [];
        const totalCount = result.totalCount || 0;
        const hasMore = offset + threads.length < totalCount;

        const response = { success: true, threads, page, limit, hasMore, totalCount };
        this.cache.set(cacheKey, response, 10000);
        return res.status(200).json(response);
    }

    async getThread(req, res) {
        const auth = await this.requireAuth(req, res);
        if (!auth) return;

        const { id } = req.params;
        const cacheKey = `support:thread:${id}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return res.status(200).json(cached);
        }
        const thread = await this.db.getSupportThreadById(id);
        if (!thread) {
            return res.status(404).json({ success: false, message: "Thread not found" });
        }

        if (!auth.isManager && thread.platformID !== auth.admin.platformID) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const response = { success: true, thread: await this.enrichThread(thread) };
        this.cache.set(cacheKey, response, 10000);
        return res.status(200).json(response);
    }

    async deleteLiveThread(req, res) {
        const auth = await this.requireAuth(req, res);
        if (!auth) return;
        if (auth.isManager) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const { id } = req.params;
        const thread = await this.db.getSupportThreadById(id);
        if (!thread) {
            return res.status(404).json({ success: false, message: "Thread not found" });
        }

        if (thread.type !== "live") {
            return res.status(400).json({ success: false, message: "Only live chats can be deleted here." });
        }
        if (thread.status !== "closed") {
            return res.status(400).json({ success: false, message: "Only closed chats can be deleted." });
        }
        if (thread.platformID !== auth.admin.platformID) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        await this.db.deleteSupportThreadById(id);
        this.cache.del(`support:thread:${id}`);
        this.cache.del(`support:live:${auth.admin.platformID}:1:20`);
        this.cache.del("support:live:all:1:20");

        return res.status(200).json({ success: true, message: "Live chat deleted." });
    }

    async createTicket(req, res) {
        const auth = await this.requireAuth(req, res);
        if (!auth) return;

        const { subject, message, priority = "medium", channel = "web", attachments } = req.body;
        if (!subject || !message) {
            return res.status(400).json({ success: false, message: "Subject and message are required." });
        }

        const platformID = auth.isManager ? req.body.platformID : auth.admin.platformID;
        if (!platformID) {
            return res.status(400).json({ success: false, message: "Platform ID is required." });
        }

        const thread = await this.db.createSupportThread({
            platformID,
            adminID: auth.admin?.id || null,
            managerID: auth.isManager ? auth.manager?.id || null : null,
            type: "ticket",
            status: "open",
            priority,
            subject,
            channel,
        });

        const senderRole = auth.isManager ? "manager" : "admin";
        const senderID = auth.isManager ? auth.manager?.id || null : auth.admin?.id || null;
        const savedAttachments = saveAttachments(thread.id, attachments);
        const msg = await this.db.createSupportMessage({
            threadID: thread.id,
            senderRole,
            senderID,
            body: message,
            attachments: savedAttachments.length ? savedAttachments : undefined,
        });

        this.cache.del(`support:thread:${thread.id}`);
        this.cache.del(`support:tickets:${platformID}`);
        this.cache.del("support:tickets:all");

        const enrichedThread = await this.enrichThread(thread);
        const senderName = await this.resolveSenderName(msg, thread);
        return res.status(201).json({ success: true, thread: enrichedThread, message: { ...msg, senderName } });
    }

    async createLive(req, res) {
        const auth = await this.requireAuth(req, res);
        if (!auth) return;

        const { message, channel = "web" } = req.body;
        if (!message) {
            return res.status(400).json({ success: false, message: "Message is required." });
        }

        const platformID = auth.isManager ? req.body.platformID : auth.admin.platformID;
        if (!platformID) {
            return res.status(400).json({ success: false, message: "Platform ID is required." });
        }

        const thread = await this.db.createSupportThread({
            platformID,
            adminID: auth.admin?.id || null,
            managerID: auth.isManager ? auth.manager?.id || null : null,
            type: "live",
            status: auth.isManager ? "active" : "waiting",
            channel,
        });

        const senderRole = auth.isManager ? "manager" : "admin";
        const senderID = auth.isManager ? auth.manager?.id || null : auth.admin?.id || null;
        const msg = await this.db.createSupportMessage({
            threadID: thread.id,
            senderRole,
            senderID,
            body: message,
        });

        this.cache.del(`support:thread:${thread.id}`);
        this.cache.delPrefix(`support:live:${platformID}:`);
        this.cache.delPrefix("support:live:all:");

        const enrichedThread = await this.enrichThread(thread);
        const senderName = await this.resolveSenderName(msg, thread);
        return res.status(201).json({ success: true, thread: enrichedThread, message: { ...msg, senderName } });
    }

    async addMessage(req, res) {
        const auth = await this.requireAuth(req, res);
        if (!auth) return;

        const { id } = req.params;
        const { body, attachments } = req.body;
        if (!body) {
            return res.status(400).json({ success: false, message: "Message body is required." });
        }

        const thread = await this.db.getSupportThreadById(id);
        if (!thread) {
            return res.status(404).json({ success: false, message: "Thread not found" });
        }

        if (!auth.isManager && thread.platformID !== auth.admin.platformID) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const senderRole = auth.isManager ? "manager" : "admin";
        const senderID = auth.isManager ? auth.manager?.id || null : auth.admin?.id || null;
        const savedAttachments = saveAttachments(id, attachments);
        const msg = await this.db.createSupportMessage({
            threadID: id,
            senderRole,
            senderID,
            body,
            attachments: savedAttachments.length ? savedAttachments : undefined,
        });

        const updateData = { updatedAt: new Date() };
        if (auth.isManager && !thread.managerID) {
            updateData.managerID = auth.manager?.id || null;
        }
        await this.db.updateSupportThread(id, updateData);

        this.cache.del(`support:thread:${id}`);
        if (thread.type === "ticket") {
            this.cache.del(`support:tickets:${thread.platformID}`);
            this.cache.del("support:tickets:all");
        }
        if (thread.type === "live") {
            this.cache.delPrefix(`support:live:${thread.platformID}:`);
            this.cache.delPrefix("support:live:all:");
        }

        const senderName = await this.resolveSenderName(msg, thread);
        return res.status(201).json({ success: true, message: { ...msg, senderName } });
    }

    async updateStatus(req, res) {
        const auth = await this.requireAuth(req, res);
        if (!auth) return;

        const { id } = req.params;
        const { status } = req.body;
        if (!status) {
            return res.status(400).json({ success: false, message: "Status is required." });
        }

        const thread = await this.db.getSupportThreadById(id);
        if (!thread) {
            return res.status(404).json({ success: false, message: "Thread not found" });
        }

        if (!auth.isManager && thread.platformID !== auth.admin.platformID) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const updated = await this.db.updateSupportThread(id, { status });
        this.cache.del(`support:thread:${id}`);
        if (thread.type === "ticket") {
            this.cache.del(`support:tickets:${thread.platformID}`);
            this.cache.del("support:tickets:all");
        }
        if (thread.type === "live") {
            this.cache.delPrefix(`support:live:${thread.platformID}:`);
            this.cache.delPrefix("support:live:all:");
        }
        if (thread.type === "live") {
            try {
                const { socketManager } = require("./socketController");
                socketManager.emitToRoom(`support-${thread.id}`, "support:thread", {
                    thread: { ...thread, status },
                });
            } catch {
                // ignore socket errors
            }
        }
        return res.status(200).json({ success: true, thread: updated });
    }

    async createPublicLive(req, res) {
        const { platformID, phone, message, attachments } = req.body || {};
        const access = await this.requirePublicAccess(req, res, platformID);
        if (!access) return;
        if (!phone || !message) {
            return res.status(400).json({ success: false, message: "Phone and message are required." });
        }

        const existing = await this.db.getSupportThreadByPlatformSubject(platformID, phone, "live", "public", [
            "waiting",
            "active",
        ]);

        const thread = existing
            ? existing
            : await this.db.createSupportThread({
                platformID,
                adminID: null,
                managerID: null,
                type: "live",
                status: "waiting",
                subject: phone,
                channel: "public",
            });

        const savedAttachments = saveAttachments(thread.id, attachments);
        const msg = await this.db.createSupportMessage({
            threadID: thread.id,
            senderRole: "customer",
            senderID: null,
            body: message,
            attachments: savedAttachments.length ? savedAttachments : undefined,
        });

        this.cache.del(`support:thread:${thread.id}`);
        this.cache.delPrefix(`support:live:${platformID}:`);
        this.cache.delPrefix("support:live:all:");

        const enrichedThread = await this.enrichThread(thread);
        const senderName = await this.resolveSenderName(msg, thread);
        return res.status(201).json({ success: true, thread: enrichedThread, message: { ...msg, senderName } });
    }

    async getPublicLiveThread(req, res) {
        const { id } = req.params;
        const { phone } = req.query;
        const thread = await this.db.getSupportThreadById(id);
        if (!thread || thread.type !== "live" || thread.channel !== "public") {
            return res.status(404).json({ success: false, message: "Thread not found" });
        }
        const access = await this.requirePublicAccess(req, res, thread.platformID);
        if (!access) return;
        if (!phone || String(phone) !== String(thread.subject || "")) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }
        return res.status(200).json({ success: true, thread: await this.enrichThread(thread) });
    }

    async getPublicLiveByPhone(req, res) {
        const { platformID, phone } = req.query || {};
        if (!platformID || !phone) {
            return res.status(400).json({ success: false, message: "Platform ID and phone are required." });
        }
        const access = await this.requirePublicAccess(req, res, String(platformID));
        if (!access) return;
        const thread = await this.db.getSupportThreadByPlatformSubject(
            String(platformID),
            String(phone),
            "live",
            "public",
            ["waiting", "active"]
        );
        if (!thread) {
            return res.status(200).json({ success: true, thread: null });
        }
        return res.status(200).json({ success: true, thread: await this.enrichThread(thread) });
    }

    async addPublicMessage(req, res) {
        const { id } = req.params;
        const { body, phone, attachments } = req.body || {};
        if (!body || !phone) {
            return res.status(400).json({ success: false, message: "Phone and message body are required." });
        }
        const thread = await this.db.getSupportThreadById(id);
        if (!thread || thread.type !== "live" || thread.channel !== "public") {
            return res.status(404).json({ success: false, message: "Thread not found" });
        }
        const access = await this.requirePublicAccess(req, res, thread.platformID);
        if (!access) return;
        if (String(thread.subject || "") !== String(phone)) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        if (String(thread.status || "").toLowerCase() === "closed") {
            const newThread = await this.db.createSupportThread({
                platformID: thread.platformID,
                adminID: null,
                managerID: null,
                type: "live",
                status: "waiting",
                subject: phone,
                channel: "public",
            });
            const savedAttachments = saveAttachments(newThread.id, attachments);
            const newMsg = await this.db.createSupportMessage({
                threadID: newThread.id,
                senderRole: "customer",
                senderID: null,
                body,
                attachments: savedAttachments.length ? savedAttachments : undefined,
            });
            this.cache.del(`support:thread:${newThread.id}`);
            this.cache.delPrefix(`support:live:${thread.platformID}:`);
            this.cache.delPrefix("support:live:all:");
            const senderName = await this.resolveSenderName(newMsg, newThread);
            return res.status(201).json({ success: true, thread: newThread, message: { ...newMsg, senderName } });
        }

        const savedAttachments = saveAttachments(id, attachments);
        const msg = await this.db.createSupportMessage({
            threadID: id,
            senderRole: "customer",
            senderID: null,
            body,
            attachments: savedAttachments.length ? savedAttachments : undefined,
        });
        await this.db.updateSupportThread(id, { updatedAt: new Date() });

        this.cache.del(`support:thread:${id}`);
        this.cache.delPrefix(`support:live:${thread.platformID}:`);
        this.cache.delPrefix("support:live:all:");

        const senderName = await this.resolveSenderName(msg, thread);
        return res.status(201).json({ success: true, message: { ...msg, senderName } });
    }
}

module.exports = { SupportController };
