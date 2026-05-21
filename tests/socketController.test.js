// @ts-check

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { socketManager } = require("../controllers/socketController");

test("sanitizeFileName replaces unsafe characters", async () => {
    const name = "a b/c?.txt";
    const safe = socketManager.sanitizeFileName(name);
    assert.equal(safe, "a_b_c_.txt");
});

test("saveAttachments writes files and returns metadata", async () => {
    const tmpDir = path.join("/tmp", `nova-tests-${Date.now()}`);
    socketManager.SUPPORT_UPLOADS_DIR = tmpDir;
    const data = Buffer.from("hello").toString("base64");
    const attachments = [
        { name: "hello.txt", type: "text/plain", base64: data },
    ];
    const result = socketManager.saveAttachments("thread1", attachments);
    assert.equal(result.length, 1);
    const saved = result[0];
    const fullPath = path.join(tmpDir, saved.id);
    assert.ok(fs.existsSync(fullPath));
});
