// @ts-check

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { SupportController } = require("../controllers/supportController");

test("getToken returns bearer token from header", async () => {
    const ctrl = new SupportController();
    const req = { headers: { authorization: "Bearer abc123" }, body: {} };
    const token = ctrl.getToken(req);
    assert.equal(token, "abc123");
});

test("resolveSenderName resolves admin and customer", async () => {
    const ctrl = new SupportController();
    ctrl.db = {
        getAdminByID: async () => ({ name: "Admin A", email: "a@example.com" }),
        getSuperUserById: async () => null,
    };
    const adminName = await ctrl.resolveSenderName(
        { senderRole: "admin", senderID: "a1" },
        { subject: "Customer X" }
    );
    const customerName = await ctrl.resolveSenderName(
        { senderRole: "customer" },
        { subject: "Customer X" }
    );
    assert.equal(adminName, "Admin A");
    assert.equal(customerName, "Customer X");
});
