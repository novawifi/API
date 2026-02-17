// @ts-check

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const { SMS } = require("../controllers/smsController");

test("sendSMS returns error for unsupported provider", async () => {
    const sms = new SMS();
    const result = await sms.sendSMS("254700000000", "Hello", { provider: "Unknown" });
    assert.equal(result.success, false);
    assert.equal(result.message, "Unsupported SMS provider");
});

test("sendSMS posts to provider and handles success", async () => {
    const sms = new SMS();
    const original = axios.post;
    try {
        axios.post = async (_url, _payload) => ({
            status: 200,
            data: { "response-code": 200, "response-description": "Success" },
        });
        const result = await sms.sendSMS("254700000000", "Hello", { provider: "TextSMS" });
        assert.equal(result.success, true);
        assert.equal(result.message, "Success");
    } finally {
        axios.post = original;
    }
});
