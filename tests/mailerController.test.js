// @ts-check

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { Mailer } = require("../controllers/mailerController");

test("normalizeEmailMessage converts plain text and link to HTML", async () => {
    const mailer = new Mailer();
    const result = mailer.normalizeEmailMessage("Hello\nhttps://example.com");
    assert.ok(result.includes("Hello<br />"));
    assert.ok(result.includes("<a href=\"https://example.com\""));
});

test("formatLinksAsButtons adds button style and target/rel", async () => {
    const mailer = new Mailer();
    const html = '<a href="https://example.com">Click</a>';
    const result = mailer.formatLinksAsButtons(html);
    assert.ok(result.includes('style="'));
    assert.ok(result.includes('target="_blank"'));
    assert.ok(result.includes('rel="noopener noreferrer"'));
});

test("buildEmailHtml injects brand name and message", async () => {
    const mailer = new Mailer();
    const html = mailer.buildEmailHtml({
        name: "Ada",
        message: "Welcome",
        company: "Nova Test",
    });
    assert.ok(html.includes("Nova Test"));
    assert.ok(html.includes("Hello Ada"));
    assert.ok(html.includes("Welcome"));
});
