// @ts-check

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const speakeasy = require("speakeasy");

const { TwoFAController } = require("../controllers/twoFAController");

test("generateKey returns a secret with base32", async () => {
    const ctrl = new TwoFAController();
    const secret = ctrl.generateKey("Nova", "admin@example.com");
    assert.ok(secret);
    assert.ok(secret.base32);
});

test("generateQR returns a data URL for valid secret", async () => {
    const ctrl = new TwoFAController();
    const secret = ctrl.generateKey("Nova", "admin@example.com");
    const qr = await ctrl.generateQR(secret);
    assert.ok(qr);
    assert.ok(qr.qrCodeDataURL.startsWith("data:image/png"));
});

test("verifyToken validates TOTP", async () => {
    const ctrl = new TwoFAController();
    const secret = speakeasy.generateSecret({ length: 20 });
    const token = speakeasy.totp({ secret: secret.base32, encoding: "base32" });
    const ok = ctrl.verifyToken(secret.base32, token);
    assert.equal(ok, true);
});
