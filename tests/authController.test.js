// @ts-check

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { Auth } = require("../controllers/authController");

test("AuthenticateRequest returns missing token when no token provided", async () => {
    const auth = new Auth();
    auth.db = {
        getSessionByToken: async () => null,
        getSuperUserByToken: async () => null,
    };
    const result = await auth.AuthenticateRequest("");
    assert.equal(result.success, false);
    assert.equal(result.message, "Missing token!");
});

test("AuthenticateRequest returns superuser when session missing but superuser token exists", async () => {
    const auth = new Auth();
    auth.db = {
        getSessionByToken: async () => null,
        getSuperUserByToken: async () => ({ id: "su1", email: "admin@example.com" }),
    };
    const result = await auth.AuthenticateRequest("token");
    assert.equal(result.success, true);
    assert.equal(result.superuser.email, "admin@example.com");
});

test("AuthenticateRequest rejects when session platform mismatches admin", async () => {
    const auth = new Auth();
    auth.db = {
        getSessionByToken: async () => ({ adminID: "a1", platformID: "p1" }),
        getSuperUserByToken: async () => null,
        getAdminByID: async () => ({ id: "a1", platformID: "p2" }),
        getSuperUserById: async () => null,
    };
    const result = await auth.AuthenticateRequest("token");
    assert.equal(result.success, false);
    assert.equal(result.message, "Invalid token provided");
});
