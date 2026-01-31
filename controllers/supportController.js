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

        const platformKey = auth.isManager ? "all" : auth.admin.platformID;
        const cacheKey = `support:live:${platformKey}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return res.status(200).json(cached);
        }

        const threads = auth.isManager
            ? await this.db.getSupportThreads("live")
            : await this.db.getSupportThreadsByPlatform(auth.admin.platformID, "live");

        const response = { success: true, threads };
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

        const response = { success: true, thread };
        this.cache.set(cacheKey, response, 10000);
        return res.status(200).json(response);
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

        return res.status(201).json({ success: true, thread, message: msg });
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
        this.cache.del(`support:live:${platformID}`);
        this.cache.del("support:live:all");

        return res.status(201).json({ success: true, thread, message: msg });
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
            this.cache.del(`support:live:${thread.platformID}`);
            this.cache.del("support:live:all");
        }

        return res.status(201).json({ success: true, message: msg });
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
            this.cache.del(`support:live:${thread.platformID}`);
            this.cache.del("support:live:all");
        }
        return res.status(200).json({ success: true, thread: updated });
    }
}

module.exports = { SupportController };
