const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
process.env.SESSION_SECRET ||= crypto.randomBytes(32).toString("hex");
process.env.NEWSROOM_CHAT_KEY = crypto.randomBytes(32).toString("base64");
process.env.NODE_ENV = "test";

const { app, encryptChatMessage, decryptChatMessage, passwordCodeHash } = require("../server");

test("newsroom messages are authenticated-encrypted at rest and decrypt correctly", () => {
    const plaintext = "A private editorial discussion.";
    const encrypted = encryptChatMessage(plaintext);
    assert.notEqual(encrypted.ciphertext, plaintext);
    assert.equal(decryptChatMessage(encrypted), plaintext);
});

test("tampered newsroom ciphertext fails authentication", () => {
    const encrypted = encryptChatMessage("do not alter");
    const bytes = Buffer.from(encrypted.ciphertext, "base64");
    bytes[0] ^= 1;
    encrypted.ciphertext = bytes.toString("base64");
    assert.throws(() => decryptChatMessage(encrypted));
});

test("email verification codes are stored as keyed hashes", () => {
    const code = "042781";
    const hash = passwordCodeHash(code);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.notEqual(hash, code);
    assert.equal(passwordCodeHash(code), hash);
    assert.notEqual(passwordCodeHash("042782"), hash);
});

test("sensitive endpoints use role-specific middleware", () => {
    const layers = app.router.stack;
    const route = (method, pathname) => {
        const layer = layers.find(item => item.route?.path === pathname && item.route.methods[method]);
        assert.ok(layer, `${method.toUpperCase()} ${pathname} exists`);
        return layer.route.stack.map(item => item.name);
    };
    assert.equal(route("get", "/api/newsroom/messages")[0], "requireAdmin");
    assert.equal(route("post", "/api/newsroom/messages")[0], "requireAdmin");
    assert.equal(route("post", "/api/owner/announcements")[0], "requireOwner");
    assert.equal(route("post", "/api/owner/users/:id/promote")[0], "requireOwner");
    assert.equal(route("post", "/api/owner/users/:id/demote")[0], "requireOwner");
    assert.equal(route("post", "/api/admin/articles/:id/approve")[0], "requireAdmin");
    assert.equal(route("post", "/api/admin/articles/:id/reject")[0], "requireAdmin");
    assert.ok(route("post", "/api/password/recovery/request").length >= 2);
    assert.ok(route("post", "/api/password/recovery/complete").length >= 2);
});

test("anonymous viewers are denied every private newsroom route", async t => {
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const read = await fetch(`${base}/api/newsroom/messages`);
    assert.equal(read.status, 401);
    const send = await fetch(`${base}/api/newsroom/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "viewer attempt" })
    });
    assert.equal(send.status, 401);
    const page = await fetch(`${base}/admin.html`);
    assert.equal(page.status, 200);
    const backend = await fetch(`${base}/database-pg.js`);
    assert.equal(backend.status, 404);
});
