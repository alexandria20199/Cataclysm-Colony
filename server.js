const express = require("express");
const bcrypt = require("bcrypt");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");
const { pool, query, initializeDatabase } = require("./database-pg");

const app = express();
const PORT = process.env.PORT || 3000;
const OWNER_USERNAME = "alexandria201999";
const CODE_TTL_MINUTES = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const isPlaceholderValue = value => !value || /replace-with|your-|\.example|re_\.\.\.|USER:PASSWORD|HOST\/DATABASE/i.test(value);

class PostgresSessionStore extends session.Store {
    get(sid, callback) {
        query("SELECT sess FROM app_sessions WHERE sid = $1 AND expire > CURRENT_TIMESTAMP", [sid])
            .then(result => callback(null, result.rows[0]?.sess || null)).catch(callback);
    }
    set(sid, sess, callback = () => {}) {
        const expires = sess.cookie?.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 7 * 86400000);
        query(`INSERT INTO app_sessions (sid, sess, expire) VALUES ($1, $2::jsonb, $3)
            ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`, [sid, JSON.stringify(sess), expires])
            .then(() => callback(null)).catch(callback);
    }
    destroy(sid, callback = () => {}) {
        query("DELETE FROM app_sessions WHERE sid = $1", [sid]).then(() => callback(null)).catch(callback);
    }
    touch(sid, sess, callback = () => {}) {
        const expires = sess.cookie?.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 7 * 86400000);
        query("UPDATE app_sessions SET expire = $2 WHERE sid = $1", [sid, expires]).then(() => callback(null)).catch(callback);
    }
}

function rateLimit(scope, maxHits, windowMs) {
    return async (req, res, next) => {
        const key = crypto.createHash("sha256").update(`${scope}:${req.ip || req.socket.remoteAddress || "unknown"}`).digest("hex");
        try {
            const result = await query(`
                INSERT INTO rate_limit_buckets (bucket_key, hits, window_started_at) VALUES ($1, 1, CURRENT_TIMESTAMP)
                ON CONFLICT (bucket_key) DO UPDATE SET
                    hits = CASE WHEN rate_limit_buckets.window_started_at <= CURRENT_TIMESTAMP - ($2 * INTERVAL '1 millisecond') THEN 1 ELSE rate_limit_buckets.hits + 1 END,
                    window_started_at = CASE WHEN rate_limit_buckets.window_started_at <= CURRENT_TIMESTAMP - ($2 * INTERVAL '1 millisecond') THEN CURRENT_TIMESTAMP ELSE rate_limit_buckets.window_started_at END
                RETURNING hits`, [key, windowMs]);
            if (Number(result.rows[0]?.hits) > maxHits) return res.status(429).json({ error: "Too many attempts. Please wait and try again." });
            next();
        } catch (error) {
            console.error("RATE LIMIT ERROR:", error);
            res.status(503).json({ error: "Security checks are temporarily unavailable." });
        }
    };
}

function passwordCodeHash(code) {
    const secret = process.env.PASSWORD_CODE_SECRET || process.env.SESSION_SECRET;
    if (!secret) throw new Error("Password verification secret is not configured.");
    return crypto.createHmac("sha256", secret).update(String(code)).digest("hex");
}

function generateRecoveryCodes(count = 10) {
    return Array.from({ length: count }, () => crypto.randomBytes(16).toString("hex").toUpperCase());
}

function recoveryCodeHash(code) {
    return passwordCodeHash(`recovery:${String(code).replace(/[-\s]/g, "").toUpperCase()}`);
}

async function replaceRecoveryCodes(userId, codes) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("UPDATE password_recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL", [userId]);
        for (const code of codes) {
            await client.query("INSERT INTO password_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [userId, recoveryCodeHash(code)]);
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function sendVerificationEmail(email, code, purpose) {
    if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) throw new Error("Email delivery is not configured.");
    const action = purpose === "recovery" ? "reset your password" : "change your password";
    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [email], subject: "Your Cataclysm Colony verification code",
            text: `Your code to ${action} is ${code}. It expires in ${CODE_TTL_MINUTES} minutes. If you did not request this, ignore this email.` })
    });
    if (!response.ok) throw new Error(`Email provider returned ${response.status}.`);
}

async function issuePasswordCode(user, purpose) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const hash = passwordCodeHash(code);
    await query("UPDATE password_verification_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL", [user.id, purpose]);
    await query(`INSERT INTO password_verification_codes (user_id, purpose, code_hash, expires_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP + ($4 * INTERVAL '1 minute'))`, [user.id, purpose, hash, CODE_TTL_MINUTES]);
    try { await sendVerificationEmail(user.email, code, purpose); }
    catch (error) {
        await query("UPDATE password_verification_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND purpose = $2 AND code_hash = $3 AND used_at IS NULL", [user.id, purpose, hash]).catch(() => {});
        throw error;
    }
}

async function consumePasswordCode(userId, purpose, code) {
    const result = await query(`SELECT id, code_hash FROM password_verification_codes
        WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP AND attempts < 5
        ORDER BY created_at DESC LIMIT 1`, [userId, purpose]);
    const record = result.rows[0];
    if (!record) return false;
    const expected = Buffer.from(record.code_hash, "hex");
    const actual = Buffer.from(passwordCodeHash(code), "hex");
    const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!matches) {
        await query("UPDATE password_verification_codes SET attempts = attempts + 1 WHERE id = $1 AND used_at IS NULL", [record.id]);
        return false;
    }
    const consumed = await query(`UPDATE password_verification_codes SET used_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP AND attempts < 5 RETURNING id`, [record.id]);
    return consumed.rowCount === 1;
}

function getChatKey() {
    const encoded = process.env.NEWSROOM_CHAT_KEY || "";
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null;
    const key = Buffer.from(encoded, "base64");
    return key.length === 32 ? key : null;
}

function encryptChatMessage(message) {
    const key = getChatKey();
    if (!key) throw new Error("NEWSROOM_CHAT_KEY must be a base64-encoded 32-byte key.");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(message, "utf8"), cipher.final()]);
    return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), auth_tag: cipher.getAuthTag().toString("base64") };
}

function decryptChatMessage(row) {
    const key = getChatKey();
    if (!key) throw new Error("NEWSROOM_CHAT_KEY must be a base64-encoded 32-byte key.");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

async function storeImage(dataUrl) {
    if (typeof dataUrl !== "string" || dataUrl.length > Math.ceil(MAX_IMAGE_BYTES * 1.4)) throw new Error("Choose an image smaller than 8 MB.");
    const match = dataUrl.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Choose an image smaller than 8 MB.");
    const { CLOUDINARY_CLOUD_NAME: cloud, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = process.env;
    if (!cloud || !apiKey || !apiSecret) throw new Error("Cloudinary image hosting is not configured.");
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = process.env.CLOUDINARY_FOLDER || "cataclysm-colony";
    const signature = crypto.createHash("sha1").update(`folder=${folder}&timestamp=${timestamp}${apiSecret}`).digest("hex");
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: `image/${match[1].toLowerCase()}` }), `upload.${match[1]}`);
    form.append("api_key", apiKey); form.append("timestamp", String(timestamp)); form.append("folder", folder); form.append("signature", signature);
    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`, { method: "POST", body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.secure_url) throw new Error("Could not save the image to Cloudinary.");
    return result.secure_url;
}

async function hostedImage(value) {
    if (!value) return "";
    if (typeof value !== "string") throw new Error("Image value is invalid.");
    if (value.startsWith("data:")) return storeImage(value);
    let url;
    try { url = new URL(value); } catch { throw new Error("Image must be an HTTPS URL or an uploaded image."); }
    if (url.protocol !== "https:") throw new Error("Image URLs must use HTTPS.");
    return url.href;
}


// ============================================================
// DATABASE HELPERS
// ============================================================

async function getCurrentUser(req) {

    if (!req.session.userId) {
        return null;
    }

    const result = await query(`
        SELECT
            id,
            username,
            email,
            profile_picture,
            bio,
            role,
            is_admin,
            is_verified,
            created_at
        FROM users
        WHERE id = $1
    `, [
        req.session.userId
    ]);

    return result.rows[0] || null;
}


async function createNotification(
    recipientId,
    type,
    title,
    message,
    link = "",
    imageUrl = ""
) {

    await query(`
        INSERT INTO notifications (
            recipient_id,
            type,
            title,
            message,
            link,
            image_url
        )
        VALUES ($1, $2, $3, $4, $5, $6)
    `, [
        recipientId,
        type,
        title,
        message,
        link,
        imageUrl
    ]);
}


// ============================================================
// AUTHENTICATION HELPERS
// ============================================================

function requireLogin(req, res, next) {

    if (!req.session.userId) {

        return res.status(401).json({
            error: "You must be logged in."
        });
    }

    next();
}


async function requireAdmin(req, res, next) {

    try {

        const user =
            await getCurrentUser(req);

        if (!user) {

            return res.status(401).json({
                error: "You must be logged in."
            });
        }

        if (
            user.role !== "owner" &&
            user.role !== "admin"
        ) {

            return res.status(403).json({
                error:
                    "Administrator access required."
            });
        }

        req.currentUser = user;

        next();

    } catch (error) {

        console.error(
            "ADMIN AUTH ERROR:",
            error
        );

        res.status(500).json({
            error:
                "Could not verify administrator access."
        });
    }
}


async function requireOwner(req, res, next) {

    try {

        const user =
            await getCurrentUser(req);

        if (!user) {

            return res.status(401).json({
                error: "You must be logged in."
            });
        }

        if (user.role !== "owner") {

            return res.status(403).json({
                error:
                    "Owner access required."
            });
        }

        req.currentUser = user;

        next();

    } catch (error) {

        console.error(
            "OWNER AUTH ERROR:",
            error
        );

        res.status(500).json({
            error:
                "Could not verify owner access."
        });
    }
}


// ============================================================
// TAG HELPERS
// ============================================================

function normalizeTags(tags) {

    if (!tags) {
        return [];
    }

    let list;

    if (Array.isArray(tags)) {
        list = tags;
    } else {
        list = String(tags).split(",");
    }

    return [
        ...new Set(
            list
                .map(tag =>
                    String(tag)
                        .trim()
                        .toLowerCase()
                )
                .filter(Boolean)
                .slice(0, 20)
        )
    ];
}


async function syncArticleTags(
    articleId,
    tags
) {

    const normalized =
        normalizeTags(tags);

    const clientResult =
        await query("SELECT 1");

    // Remove old relationships first.
    await query(`
        DELETE FROM article_tags
        WHERE article_id = $1
    `, [
        articleId
    ]);

    for (const tag of normalized) {

        await query(`
            INSERT INTO tags (name)
            VALUES ($1)
            ON CONFLICT (name)
            DO NOTHING
        `, [
            tag
        ]);

        const tagResult =
            await query(`
                SELECT id
                FROM tags
                WHERE name = $1
            `, [
                tag
            ]);

        const row =
            tagResult.rows[0];

        if (row) {

            await query(`
                INSERT INTO article_tags (
                    article_id,
                    tag_id
                )
                VALUES ($1, $2)
                ON CONFLICT (
                    article_id,
                    tag_id
                )
                DO NOTHING
            `, [
                articleId,
                row.id
            ]);
        }
    }
}


// ============================================================
// OWNER BOOTSTRAP
// ============================================================

async function bootstrapOwner() {

    const ownerUsername =
        "alexandria201999";

    try {

        const result =
            await query(`
                SELECT
                    id,
                    username,
                    role,
                    is_admin
                FROM users
                WHERE LOWER(username) = $1
                ORDER BY (username = $1) DESC, id ASC
                LIMIT 1
            `, [
                ownerUsername
            ]);

        const owner =
            result.rows[0];

        if (owner) {

            await query(`
                UPDATE users SET role = 'user', is_admin = 0
                WHERE LOWER(username) = $1 AND role = 'owner' AND id <> $2
            `, [ownerUsername, owner.id]);

            await query(`
                UPDATE users
                SET
                    role = 'owner',
                    is_admin = 1
                WHERE id = $1
            `, [
                owner.id
            ]);

            console.log("");
            console.log("========================================");
            console.log("       Cataclysm Colony OWNER");
            console.log("========================================");
            console.log(
                `Owner account: ${ownerUsername}`
            );
            console.log("Role:          owner");
            console.log("Admin access:  enabled");
            console.log("========================================");
            console.log("");

        } else {

            if (process.env.NODE_ENV === "production") {
                throw new Error(`Required Owner account "${ownerUsername}" is missing from the hosted database.`);
            }

            console.log("");
            console.log("OWNER BOOTSTRAP:");
            console.log(
                `User "${ownerUsername}" does not exist yet.`
            );
            console.log(
                "Create the account first, then restart the server."
            );
            console.log("");
        }

    } catch (error) {

        console.error(
            "OWNER BOOTSTRAP ERROR:",
            error
        );
        if (process.env.NODE_ENV === "production") throw error;
    }
}


// ============================================================
// BASIC SERVER SETUP
// ============================================================

if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
    app.use((req, res, next) => {
        if (req.secure) return next();
        return res.redirect(308, `https://${req.get("host")}${req.originalUrl}`);
    });
}

app.use(express.json({ limit: "12mb" }));

app.use(express.urlencoded({
    extended: true,
    limit: "12mb"
}));

app.use(
    session({
        secret: process.env.SESSION_SECRET || "cataclysm-colony-local-development-only",
        store: new PostgresSessionStore(),

        resave: false,

        saveUninitialized: false,

        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure:
                process.env.NODE_ENV === "production",

            maxAge:
                1000 * 60 * 60 * 24 * 7
        }
    })
);

app.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("origin")) {
        try {
            if (new URL(req.get("origin")).host !== req.get("host")) return res.status(403).json({ error: "Cross-origin request blocked." });
        } catch { return res.status(403).json({ error: "Invalid request origin." }); }
    }
    next();
});

app.use((req, res, next) => {
    const pathname = req.path;
        const allowed = new Set(["index.html", "login.html", "register.html", "profile.html", "article.html", "write.html", "admin.html", "settings.html", "editorial-policy.html", "login.js", "register.js", "profile.js", "write.js", "theme.js", "notifications.js", "style.css"]);
    if (pathname.startsWith("/api/")) return next();
    if (pathname === "/") return res.redirect("/index.html");
    if (pathname.startsWith("/images/") || pathname.startsWith("/uploads/")) return next();
    if (pathname.slice(1).includes("/") || !allowed.has(path.basename(pathname).toLowerCase())) return res.status(404).send("Not found");
    next();
});

app.use(express.static(__dirname));


// ============================================================
// REGISTER
// ============================================================

app.post(
    "/api/register",
    rateLimit("register", 5, 60 * 60 * 1000),
    async (req, res) => {

        const {
            username,
            email,
            password
        } = req.body;

        if (typeof username !== "string" || typeof email !== "string" || typeof password !== "string" || !username.trim() || !email.trim() || !password) {

            return res.status(400).json({
                error:
                    "Please fill in all fields."
            });
        }

        const cleanUsername =
            username.trim();

        const cleanEmail =
            email.trim().toLowerCase();

        if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) {
            return res.status(400).json({ error: "Enter a valid email address." });
        }

        if (cleanUsername.length < 3) {

            return res.status(400).json({
                error:
                    "Username must be at least 3 characters."
            });
        }

        if (cleanUsername.length > 30) {

            return res.status(400).json({
                error:
                    "Username must be 30 characters or less."
            });
        }

        if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {

            return res.status(400).json({
                error:
                    "Password must be at least 8 characters and no more than 72 UTF-8 bytes."
            });
        }

        try {

            const existingResult =
                await query(`
                    SELECT id
                    FROM users
                    WHERE LOWER(username) = LOWER($1)
                    OR email = $2
                `, [
                    cleanUsername,
                    cleanEmail
                ]);

            if (
                existingResult.rows.length
            ) {

                return res.status(409).json({
                    error:
                        "That username or email is already registered."
                });
            }

            const passwordHash =
                await bcrypt.hash(
                    password,
                    12
                );

            const result =
                await query(`
                    INSERT INTO users (
                        username,
                        email,
                        password_hash,
                        role,
                        is_admin
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        CASE WHEN LOWER($1) = $4 THEN 'owner' ELSE 'user' END,
                        CASE WHEN LOWER($1) = $4 THEN 1 ELSE 0 END
                    )
                    RETURNING id
                `, [
                    cleanUsername,
                    cleanEmail,
                    passwordHash,
                    OWNER_USERNAME
                ]);

            res.status(201).json({
                message:
                    "Account created successfully.",

                user_id:
                    result.rows[0].id
            });

        } catch (error) {

            console.error(
                "REGISTER ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Something went wrong while creating your account."
            });
        }
    }
);


// ============================================================
// LOGIN
// ============================================================

app.post(
    "/api/login",
    rateLimit("login", 10, 15 * 60 * 1000),
    async (req, res) => {

        const {
            username,
            password
        } = req.body;

        if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password) {

            return res.status(400).json({
                error:
                    "Please enter your username and password."
            });
        }

        try {

            const result =
                await query(`
                    SELECT
                        id,
                        username,
                        email,
                        password_hash,
                        role,
                        is_admin,
                        is_verified
                    FROM users
                    WHERE LOWER(username) = LOWER($1)
                `, [
                    username.trim()
                ]);

            const user =
                result.rows[0];

            if (!user) {

                return res.status(401).json({
                    error:
                        "Invalid username or password."
                });
            }

            const passwordMatches = user.password_hash && await bcrypt.compare(password, user.password_hash);

            if (!passwordMatches) {

                return res.status(401).json({
                    error:
                        "Invalid username or password."
                });
            }

            await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
            req.session.userId = user.id;
            await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));

            res.json({
                message:
                    "Login successful.",

                username:
                    user.username,

                role:
                    user.role,

                is_admin:
                    user.role === "owner" ||
                    user.role === "admin",

                is_owner:
                    user.role === "owner",

                is_verified:
                    user.is_verified === 1
            });

        } catch (error) {

            console.error(
                "LOGIN ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Something went wrong while logging in."
            });
        }
    }
);


// ============================================================
// CURRENT USER
// ============================================================

app.get(
    "/api/me",
    async (req, res) => {

        try {

            const user =
                await getCurrentUser(req);

            if (!user) {

                return res.status(401).json({
                    error:
                        "Not logged in."
                });
            }

            res.json({
                ...user,

                is_admin:
                    user.role === "owner" ||
                    user.role === "admin",

                is_owner:
                    user.role === "owner",

                is_verified:
                    user.is_verified === 1
            });

        } catch (error) {

            console.error(
                "CURRENT USER ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not load your account."
            });
        }
    }
);


// ============================================================
// UPDATE MY PROFILE
// ============================================================

app.put(
    "/api/me",
    requireLogin,
    async (req, res) => {

        const {
            bio,
            profile_picture
        } = req.body;

        try {

            await query(`
                UPDATE users
                SET
                    bio = $1,
                    profile_picture = $2
                WHERE id = $3
            `, [
                typeof bio === "string"
                    ? bio.trim()
                    : "",

                await hostedImage(typeof profile_picture === "string" ? profile_picture.trim() : ""),

                req.session.userId
            ]);

            res.json({
                message:
                    "Profile updated successfully."
            });

        } catch (error) {

            console.error(
                "PROFILE UPDATE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not update profile."
            });
        }
    }
);


// ============================================================
// ACCOUNT SETTINGS
// ============================================================

app.put(
    "/api/me/email",
    requireLogin,
    async (req, res) => {

        const email =
            typeof req.body.email === "string"
                ? req.body.email
                    .trim()
                    .toLowerCase()
                : "";

        if (
            !/^\S+@\S+\.\S+$/.test(email)
        ) {

            return res.status(400).json({
                error:
                    "Enter a valid email address."
            });
        }

        try {

            const existing =
                await query(`
                    SELECT id
                    FROM users
                    WHERE email = $1
                    AND id != $2
                `, [
                    email,
                    req.session.userId
                ]);

            if (existing.rows.length) {

                return res.status(409).json({
                    error:
                        "That email address is already in use."
                });
            }

            await query(`
                UPDATE users
                SET email = $1
                WHERE id = $2
            `, [
                email,
                req.session.userId
            ]);

            res.json({
                message:
                    "Email address updated.",

                email
            });

        } catch (error) {

            console.error(
                "UPDATE EMAIL ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not update email."
            });
        }
    }
);


app.post("/api/password/change/request", requireLogin, rateLimit("password-change-code", 3, 60 * 60 * 1000), async (req, res) => {
    try {
        const result = await query("SELECT id, email FROM users WHERE id = $1", [req.session.userId]);
        if (!result.rows[0]) return res.status(401).json({ error: "Please sign in again." });
        await issuePasswordCode(result.rows[0], "change");
        res.json({ message: "A verification code was sent to your account email." });
    } catch (error) {
        console.error("PASSWORD CODE EMAIL ERROR:", error);
        const configurationError = /not configured/i.test(error.message);
        res.status(configurationError ? 503 : 502).json({ error: configurationError ? "Email delivery is not configured. Contact the site owner." : "Could not send the verification email. Try again shortly." });
    }
});

app.put(
    "/api/me/password",
    requireLogin,
    rateLimit("password-change-verify", 8, 15 * 60 * 1000),
    async (req, res) => {

        const currentPassword =
            typeof req.body.current_password === "string"
                ? req.body.current_password
                : "";

        const newPassword =
            typeof req.body.new_password === "string"
                ? req.body.new_password
                : "";

        if (
            !currentPassword ||
            !newPassword
        ) {

            return res.status(400).json({
                error:
                    "Enter your current password and a new password."
            });
        }

        if (newPassword.length < 8 || Buffer.byteLength(newPassword, "utf8") > 72) {

            return res.status(400).json({
                error:
                    "New passwords must be at least 8 characters."
            });
        }

        try {

            const result =
                await query(`
                    SELECT password_hash
                    FROM users
                    WHERE id = $1
                `, [
                    req.session.userId
                ]);

            const user =
                result.rows[0];

            const matches =
                user &&
                await bcrypt.compare(
                    currentPassword,
                    user.password_hash
                );

            if (!matches) {

                return res.status(401).json({
                    error:
                        "Your current password is incorrect."
                });
            }

            const passwordHash =
                await bcrypt.hash(
                    newPassword,
                    12
                );

            await query(`
                UPDATE users
                SET password_hash = $1
                WHERE id = $2
            `, [
                passwordHash,
                req.session.userId
            ]);

            await query("DELETE FROM app_sessions WHERE sess->>'userId' = $1 AND sid <> $2", [String(req.session.userId), req.sessionID]);

            res.json({
                message:
                    "Password updated."
            });

        } catch (error) {

            console.error(
                "UPDATE PASSWORD ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not update password."
            });
        }
    }
);


// ============================================================
// NOTIFICATIONS
// ============================================================

app.post("/api/password/recovery/request", rateLimit("password-recovery-request", 5, 60 * 60 * 1000), async (req, res) => {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter the email address on your account." });
    try {
        const result = await query("SELECT id, email FROM users WHERE LOWER(email) = $1", [email]);
        if (result.rows[0]) await issuePasswordCode(result.rows[0], "recovery");
        res.status(202).json({ message: "If that address belongs to an account, a verification code has been sent." });
    } catch (error) {
        console.error("PASSWORD RECOVERY EMAIL ERROR:", error);
        const configurationError = /not configured/i.test(error.message);
        res.status(configurationError ? 503 : 502).json({ error: configurationError ? "Email delivery is not configured. Contact the site owner." : "Could not send the verification email. Try again shortly." });
    }
});

app.post("/api/password/recovery/complete", rateLimit("password-recovery-complete", 8, 15 * 60 * 1000), async (req, res) => {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const code = typeof req.body.code === "string" ? req.body.code.trim() : "";
    const newPassword = typeof req.body.new_password === "string" ? req.body.new_password : "";
    if (!/^\S+@\S+\.\S+$/.test(email) || !/^\d{6}$/.test(code) || newPassword.length < 8 || Buffer.byteLength(newPassword, "utf8") > 72) {
        return res.status(400).json({ error: "Enter your account email, the six-digit code, and a new password of at least eight characters." });
    }
    try {
        const result = await query("SELECT id FROM users WHERE LOWER(email) = $1", [email]);
        const user = result.rows[0];
        if (!user || !await consumePasswordCode(user.id, "recovery", code)) return res.status(400).json({ error: "That code is invalid, expired, or already used." });
        const passwordHash = await bcrypt.hash(newPassword, 12);
        await query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, user.id]);
        await query("DELETE FROM app_sessions WHERE sess->>'userId' = $1", [String(user.id)]);
        res.json({ message: "Password reset successfully. You can now sign in." });
    } catch (error) {
        console.error("PASSWORD RECOVERY ERROR:", error);
        res.status(500).json({ error: "Could not reset the password." });
    }
});

app.post("/api/me/recovery-codes", requireLogin, rateLimit("recovery-codes-create", 5, 60 * 60 * 1000), async (req, res) => {
    const currentPassword = typeof req.body.current_password === "string" ? req.body.current_password : "";
    if (!currentPassword) return res.status(400).json({ error: "Enter your current password to create recovery codes." });
    try {
        const result = await query("SELECT password_hash FROM users WHERE id = $1", [req.session.userId]);
        if (!result.rows[0] || !await bcrypt.compare(currentPassword, result.rows[0].password_hash || "")) {
            return res.status(401).json({ error: "Your current password is incorrect." });
        }
        const codes = generateRecoveryCodes();
        await replaceRecoveryCodes(req.session.userId, codes);
        res.json({ message: "Save these codes somewhere private. They are shown only once; creating a new set disables every old code.", codes });
    } catch (error) {
        console.error("RECOVERY CODE ISSUE ERROR:", error);
        res.status(500).json({ error: "Could not create recovery codes." });
    }
});

app.post("/api/password/recovery/code", rateLimit("password-recovery-code", 8, 15 * 60 * 1000), async (req, res) => {
    const username = typeof req.body.username === "string" ? req.body.username.trim().toLowerCase() : "";
    const code = typeof req.body.code === "string" ? req.body.code.trim() : "";
    const newPassword = typeof req.body.new_password === "string" ? req.body.new_password : "";
    if (!username || username.length > 64 || !/^[a-f0-9]{32}$/i.test(code.replace(/[-\s]/g, "")) || newPassword.length < 8 || Buffer.byteLength(newPassword, "utf8") > 72) {
        return res.status(400).json({ error: "Enter your username, one unused recovery code, and a new password of at least eight characters." });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const replacementCodes = generateRecoveryCodes();
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const found = await client.query("SELECT id FROM users WHERE LOWER(username) = $1", [username]);
        const userId = found.rows[0]?.id;
        if (!userId) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "The username or recovery code is incorrect, already used, or unavailable." });
        }
        const consumed = await client.query(`UPDATE password_recovery_codes SET used_at = CURRENT_TIMESTAMP
            WHERE id = (SELECT id FROM password_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE)
            AND used_at IS NULL RETURNING id`, [userId, recoveryCodeHash(code)]);
        if (consumed.rowCount !== 1) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "The username or recovery code is incorrect, already used, or unavailable." });
        }
        await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
        await client.query("UPDATE password_recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL", [userId]);
        for (const replacement of replacementCodes) {
            await client.query("INSERT INTO password_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [userId, recoveryCodeHash(replacement)]);
        }
        await client.query("DELETE FROM app_sessions WHERE sess->>'userId' = $1", [String(userId)]);
        await client.query("COMMIT");
        res.json({ message: "Password reset. Save this new set of recovery codes now; the old set has been disabled. You can then sign in.", codes: replacementCodes });
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("OFFLINE PASSWORD RECOVERY ERROR:", error);
        res.status(500).json({ error: "Could not reset the password." });
    } finally {
        client.release();
    }
});

app.get(
    "/api/notifications",
    requireLogin,
    async (req, res) => {

        try {

            const notificationResult =
                await query(`
                    SELECT
                        id,
                        type,
                        title,
                        message,
                        link,
                        image_url,
                        is_read,
                        created_at
                    FROM notifications
                    WHERE recipient_id = $1
                    ORDER BY
                        created_at DESC,
                        id DESC
                    LIMIT 30
                `, [
                    req.session.userId
                ]);

            const unreadResult =
                await query(`
                    SELECT COUNT(*) AS count
                    FROM notifications
                    WHERE recipient_id = $1
                    AND is_read = 0
                `, [
                    req.session.userId
                ]);

            res.json({
                notifications:
                    notificationResult.rows,

                unread:
                    Number(
                        unreadResult.rows[0]?.count || 0
                    )
            });

        } catch (error) {

            console.error(
                "NOTIFICATIONS ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not load notifications."
            });
        }
    }
);


app.post(
    "/api/notifications/read",
    requireLogin,
    async (req, res) => {

        try {

            await query(`
                UPDATE notifications
                SET is_read = 1
                WHERE recipient_id = $1
                AND is_read = 0
            `, [
                req.session.userId
            ]);

            res.json({
                message:
                    "Notifications marked as read."
            });

        } catch (error) {

            console.error(
                "READ NOTIFICATIONS ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not update notifications."
            });
        }
    }
);


// ============================================================
// OWNER ANNOUNCEMENTS
// ============================================================

app.post(
    "/api/owner/announcements",
    requireOwner,
    async (req, res) => {

        const title =
            typeof req.body.title === "string"
                ? req.body.title.trim()
                : "";

        const message =
            typeof req.body.message === "string"
                ? req.body.message.trim()
                : "";

        const imageInput = typeof req.body.image === "string" ? req.body.image : "";

        if (!title || !message) {

            return res.status(400).json({
                error:
                    "An announcement needs both a title and a message."
            });
        }

        if (
            title.length > 120 ||
            message.length > 1000
        ) {

            return res.status(400).json({
                error:
                    "Keep the title under 120 characters and the message under 1,000."
            });
        }

        try {

            const imageUrl = imageInput ? await hostedImage(imageInput) : "";
            const announcementResult = await query(`
                INSERT INTO notifications (recipient_id, type, title, message, link, image_url)
                SELECT id, 'announcement', $1, $2, '', $3 FROM users
                RETURNING recipient_id
            `, [title, message, imageUrl]);

            res.json({
                message:
                    `Announcement sent to ${announcementResult.rowCount} account${announcementResult.rowCount === 1 ? "" : "s"}.`,

                recipient_count:
                    announcementResult.rowCount
            });

        } catch (error) {

            console.error(
                "ANNOUNCEMENT ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not send the announcement."
            });
        }
    }
);


// ============================================================
// DATABASE INITIALIZATION
// ============================================================

app.get("/api/newsroom/messages", requireAdmin, async (req, res) => {
    if (!getChatKey()) return res.status(503).json({ error: "Private newsroom chat is not configured." });
    try {
        const result = await query(`SELECT m.id, m.ciphertext, m.iv, m.auth_tag, m.created_at, u.username
            FROM newsroom_messages m JOIN users u ON u.id = m.sender_id
            WHERE u.role IN ('owner', 'admin') ORDER BY m.id DESC LIMIT 100`);
        const messages = result.rows.reverse().map(row => ({
            id: row.id,
            username: row.username,
            message: decryptChatMessage(row),
            created_at: row.created_at
        }));
        res.json({ messages });
    } catch (error) {
        console.error("NEWSROOM CHAT READ ERROR:", error);
        res.status(500).json({ error: "Could not load newsroom messages." });
    }
});

app.post("/api/newsroom/messages", requireAdmin, rateLimit("newsroom-chat", 30, 60 * 60 * 1000), async (req, res) => {
    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
    if (!getChatKey()) return res.status(503).json({ error: "Private newsroom chat is not configured." });
    if (!message || message.length > 2000) return res.status(400).json({ error: "Messages must be between 1 and 2,000 characters." });
    try {
        const encrypted = encryptChatMessage(message);
        const result = await query(`INSERT INTO newsroom_messages (sender_id, ciphertext, iv, auth_tag)
            VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
            [req.currentUser.id, encrypted.ciphertext, encrypted.iv, encrypted.auth_tag]);
        res.status(201).json({ message: { id: result.rows[0].id, username: req.currentUser.username, message, created_at: result.rows[0].created_at } });
    } catch (error) {
        console.error("NEWSROOM CHAT WRITE ERROR:", error);
        res.status(500).json({ error: "Could not save newsroom message." });
    }
});

// ============================================================
// PRIVATE STAFF CHAT
// ============================================================

app.get("/api/staff/chat/people", requireAdmin, async (req, res) => {
    try {
        const result = await query(`SELECT id, username, role, profile_picture FROM users
            WHERE role IN ('owner', 'admin') AND id <> $1 ORDER BY LOWER(username)`, [req.currentUser.id]);
        res.json({ people: result.rows });
    } catch (error) {
        console.error("STAFF CHAT PEOPLE ERROR:", error);
        res.status(500).json({ error: "Could not load staff members." });
    }
});

app.get("/api/staff/chat/conversations", requireAdmin, async (req, res) => {
    if (!getChatKey()) return res.status(503).json({ error: "Staff chat is not configured." });
    try {
        const result = await query(`SELECT c.id, c.title, c.is_group, c.created_at,
            (SELECT string_agg(u.username, ', ' ORDER BY LOWER(u.username)) FROM staff_conversation_members cm
                JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = c.id AND cm.user_id <> $1) AS participants,
            last_message.ciphertext, last_message.iv, last_message.auth_tag, last_message.created_at AS last_message_at,
            sender.username AS last_sender
            FROM staff_conversations c
            JOIN staff_conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = $1
            LEFT JOIN LATERAL (SELECT m.ciphertext, m.iv, m.auth_tag, m.created_at, m.sender_id
                FROM staff_chat_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) last_message ON TRUE
            LEFT JOIN users sender ON sender.id = last_message.sender_id
            ORDER BY COALESCE(last_message.created_at, c.created_at) DESC`, [req.currentUser.id]);
        const conversations = result.rows.map(row => ({
            id: row.id,
            title: row.is_group ? row.title : (row.participants || "Staff chat"),
            is_group: row.is_group,
            participants: row.participants || "",
            updated_at: row.last_message_at || row.created_at,
            preview: row.ciphertext ? decryptChatMessage(row) : "Start the conversation",
            last_sender: row.last_sender || ""
        }));
        res.json({ conversations });
    } catch (error) {
        console.error("STAFF CHAT LIST ERROR:", error);
        res.status(500).json({ error: "Could not load staff conversations." });
    }
});

app.post("/api/staff/chat/conversations", requireAdmin, rateLimit("staff-chat-create", 15, 60 * 60 * 1000), async (req, res) => {
    const memberIds = Array.isArray(req.body.member_ids)
        ? [...new Set(req.body.member_ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0 && id !== req.currentUser.id))]
        : [];
    const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!getChatKey()) return res.status(503).json({ error: "Staff chat is not configured." });
    if (!memberIds.length || memberIds.length > 30) return res.status(400).json({ error: "Choose at least one staff member." });
    const isGroup = memberIds.length > 1;
    if (isGroup && (title.length < 2 || title.length > 60)) return res.status(400).json({ error: "Group names must be 2 to 60 characters." });
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const eligible = await client.query("SELECT id FROM users WHERE id = ANY($1::int[]) AND role IN ('owner', 'admin')", [memberIds]);
        if (eligible.rowCount !== memberIds.length) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Only current Admins and the Owner can be added to staff chat." });
        }
        if (!isGroup) {
            const existing = await client.query(`SELECT c.id FROM staff_conversations c
                WHERE c.is_group = FALSE
                AND EXISTS (SELECT 1 FROM staff_conversation_members a WHERE a.conversation_id = c.id AND a.user_id = $1)
                AND EXISTS (SELECT 1 FROM staff_conversation_members b WHERE b.conversation_id = c.id AND b.user_id = $2)
                AND (SELECT COUNT(*) FROM staff_conversation_members x WHERE x.conversation_id = c.id) = 2
                LIMIT 1`, [req.currentUser.id, memberIds[0]]);
            if (existing.rows[0]) {
                await client.query("COMMIT");
                return res.json({ id: existing.rows[0].id, existing: true });
            }
        }
        const created = await client.query("INSERT INTO staff_conversations (title, is_group, created_by) VALUES ($1, $2, $3) RETURNING id", [isGroup ? title : "", isGroup, req.currentUser.id]);
        const conversationId = created.rows[0].id;
        for (const userId of [req.currentUser.id, ...memberIds]) {
            await client.query("INSERT INTO staff_conversation_members (conversation_id, user_id) VALUES ($1, $2)", [conversationId, userId]);
        }
        await client.query("COMMIT");
        res.status(201).json({ id: conversationId, existing: false });
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("STAFF CHAT CREATE ERROR:", error);
        res.status(500).json({ error: "Could not create the conversation." });
    } finally {
        client.release();
    }
});

app.get("/api/staff/chat/conversations/:id/messages", requireAdmin, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "Invalid conversation." });
    if (!getChatKey()) return res.status(503).json({ error: "Staff chat is not configured." });
    try {
        const membership = await query("SELECT 1 FROM staff_conversation_members WHERE conversation_id = $1 AND user_id = $2", [req.params.id, req.currentUser.id]);
        if (!membership.rowCount) return res.status(404).json({ error: "Conversation not found." });
        const result = await query(`SELECT m.id, m.ciphertext, m.iv, m.auth_tag, m.created_at, u.username
            FROM staff_chat_messages m JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = $1 ORDER BY m.id DESC LIMIT 100`, [req.params.id]);
        res.json({ messages: result.rows.reverse().map(row => ({ id: row.id, username: row.username, message: decryptChatMessage(row), created_at: row.created_at })) });
    } catch (error) {
        console.error("STAFF CHAT HISTORY ERROR:", error);
        res.status(500).json({ error: "Could not load this conversation." });
    }
});

app.post("/api/staff/chat/conversations/:id/messages", requireAdmin, rateLimit("staff-chat-message", 60, 60 * 60 * 1000), async (req, res) => {
    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "Invalid conversation." });
    if (!message || message.length > 2000) return res.status(400).json({ error: "Messages must be between 1 and 2,000 characters." });
    if (!getChatKey()) return res.status(503).json({ error: "Staff chat is not configured." });
    try {
        const membership = await query("SELECT 1 FROM staff_conversation_members WHERE conversation_id = $1 AND user_id = $2", [req.params.id, req.currentUser.id]);
        if (!membership.rowCount) return res.status(404).json({ error: "Conversation not found." });
        const encrypted = encryptChatMessage(message);
        const result = await query(`INSERT INTO staff_chat_messages (conversation_id, sender_id, ciphertext, iv, auth_tag)
            VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
            [req.params.id, req.currentUser.id, encrypted.ciphertext, encrypted.iv, encrypted.auth_tag]);
        res.status(201).json({ message: { id: result.rows[0].id, username: req.currentUser.username, message, created_at: result.rows[0].created_at } });
    } catch (error) {
        console.error("STAFF CHAT SEND ERROR:", error);
        res.status(500).json({ error: "Could not send the message." });
    }
});

async function startServer() {

    try {

        if (process.env.NODE_ENV === "production") {
            const missing = [];
            let databaseHost = "";
            try { databaseHost = new URL(process.env.DATABASE_URL).hostname.toLowerCase(); }
            catch { missing.push("valid DATABASE_URL"); }
            if (isPlaceholderValue(process.env.DATABASE_URL)) missing.push("configured hosted DATABASE_URL");
            if (["localhost", "127.0.0.1", "::1"].includes(databaseHost)) missing.push("hosted PostgreSQL DATABASE_URL (not localhost)");
            if (isPlaceholderValue(process.env.SESSION_SECRET) || process.env.SESSION_SECRET.length < 32) missing.push("SESSION_SECRET (random, 32+ characters)");
            if (isPlaceholderValue(process.env.PASSWORD_CODE_SECRET) || process.env.PASSWORD_CODE_SECRET.length < 32) missing.push("PASSWORD_CODE_SECRET (random, 32+ characters)");
            if ([process.env.CLOUDINARY_CLOUD_NAME, process.env.CLOUDINARY_API_KEY, process.env.CLOUDINARY_API_SECRET].some(isPlaceholderValue)) missing.push("valid Cloudinary credentials");
            if (!getChatKey()) missing.push("NEWSROOM_CHAT_KEY (base64-encoded 32-byte key)");
            if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
        }

        await initializeDatabase();

        await bootstrapOwner();

        app.listen(
            PORT,
            () => {

                console.log("");
                console.log("========================================");
                console.log("      CATACLYSM COLONY ONLINE");
                console.log("========================================");
                console.log(
                    `Port: ${PORT}`
                );
                console.log(
                    "Database: Hosted PostgreSQL"
                );
                console.log("========================================");
                console.log("");
            }
        );

    } catch (error) {

        console.error(
            "SERVER STARTUP ERROR:",
            error
        );

        process.exit(1);
    }
}


if (require.main === module) startServer();

module.exports = { app, encryptChatMessage, decryptChatMessage, passwordCodeHash };
// ============================================================
// PUBLIC PROFILE
// ============================================================

app.get("/api/profile/:username", async (req, res) => {

    try {

        const userResult = await query(`
            SELECT
                id,
                username,
                profile_picture,
                bio,
                is_verified,
                role,
                created_at
            FROM users
            WHERE username = $1
        `, [
            req.params.username
        ]);

        const user = userResult.rows[0];

        if (!user) {
            return res.status(404).json({
                error: "User not found."
            });
        }

        const articlesResult = await query(`
            SELECT
                id,
                headline,
                summary,
                image,
                category,
                tags,
                created_at,
                published_at
            FROM articles
            WHERE author_id = $1
            AND status = 'approved'
            ORDER BY published_at DESC
        `, [
            user.id
        ]);

        const articles = articlesResult.rows;

        const followerResult = await query(`
            SELECT COUNT(*) AS count
            FROM follows
            WHERE following_id = $1
        `, [
            user.id
        ]);

        const followingResult = await query(`
            SELECT COUNT(*) AS count
            FROM follows
            WHERE follower_id = $1
        `, [
            user.id
        ]);

        const followerCount =
            Number(followerResult.rows[0].count);

        const followingCount =
            Number(followingResult.rows[0].count);

        let isFollowing = false;

        if (req.session.userId) {

            const followingResult = await query(`
                SELECT id
                FROM follows
                WHERE follower_id = $1
                AND following_id = $2
            `, [
                req.session.userId,
                user.id
            ]);

            isFollowing =
                followingResult.rows.length > 0;
        }

        res.json({

            id: user.id,
            username: user.username,
            profile_picture: user.profile_picture,
            bio: user.bio,

            is_verified:
                user.is_verified === 1 ||
                user.is_verified === true,

            role: user.role,
            created_at: user.created_at,

            article_count: articles.length,
            follower_count: followerCount,
            following_count: followingCount,

            is_following: isFollowing,

            articles
        });

    } catch (error) {

        console.error(
            "PROFILE ERROR:",
            error
        );

        res.status(500).json({
            error: "Could not load profile."
        });
    }
});


// ============================================================
// FOLLOW
// ============================================================

app.post(
    "/api/follow/:username",
    requireLogin,
    async (req, res) => {

        try {

            const targetResult = await query(`
                SELECT id, username
                FROM users
                WHERE username = $1
            `, [
                req.params.username
            ]);

            const targetUser =
                targetResult.rows[0];

            if (!targetUser) {
                return res.status(404).json({
                    error: "User not found."
                });
            }

            if (
                Number(targetUser.id) ===
                Number(req.session.userId)
            ) {
                return res.status(400).json({
                    error:
                        "You cannot follow yourself."
                });
            }

            await query(`
                INSERT INTO follows
                (
                    follower_id,
                    following_id
                )
                VALUES ($1, $2)
            `, [
                req.session.userId,
                targetUser.id
            ]);

            const countResult = await query(`
                SELECT COUNT(*) AS count
                FROM follows
                WHERE following_id = $1
            `, [
                targetUser.id
            ]);

            const count =
                Number(countResult.rows[0].count);

            res.json({
                message:
                    `You are now following ${targetUser.username}.`,

                is_following: true,

                follower_count: count
            });

        } catch (error) {

            if (error.code === "23505") {

                return res.status(409).json({
                    error:
                        "You are already following this user."
                });
            }

            console.error(
                "FOLLOW ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not follow this user."
            });
        }
    }
);


// ============================================================
// UNFOLLOW
// ============================================================

app.delete(
    "/api/follow/:username",
    requireLogin,
    async (req, res) => {

        try {

            const targetResult = await query(`
                SELECT id, username
                FROM users
                WHERE username = $1
            `, [
                req.params.username
            ]);

            const targetUser =
                targetResult.rows[0];

            if (!targetUser) {
                return res.status(404).json({
                    error: "User not found."
                });
            }

            const result = await query(`
                DELETE FROM follows
                WHERE follower_id = $1
                AND following_id = $2
            `, [
                req.session.userId,
                targetUser.id
            ]);

            if (result.rowCount === 0) {
                return res.status(404).json({
                    error:
                        "You are not following this user."
                });
            }

            const countResult = await query(`
                SELECT COUNT(*) AS count
                FROM follows
                WHERE following_id = $1
            `, [
                targetUser.id
            ]);

            const count =
                Number(countResult.rows[0].count);

            res.json({

                message:
                    `You unfollowed ${targetUser.username}.`,

                is_following: false,

                follower_count: count
            });

        } catch (error) {

            console.error(
                "UNFOLLOW ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not unfollow this user."
            });
        }
    }
);


// ============================================================
// ARTICLE CREATE / SUBMIT
// ============================================================

app.post(
    "/api/articles",
    requireLogin,
    async (req, res) => {

        const {
            headline,
            summary,
            body,
            image,
            category,
            tags
        } = req.body;

        if (!headline || !headline.trim()) {
            return res.status(400).json({
                error:
                    "An article needs a headline."
            });
        }

        if (
            !body ||
            !body
                .replace(/<[^>]*>/g, "")
                .trim()
        ) {
            return res.status(400).json({
                error:
                    "Your article cannot be empty."
            });
        }

        const plainBody = body
            .replace(/<[^>]*>/g, "")
            .trim();

        if (plainBody.length < 30) {
            return res.status(400).json({
                error:
                    "Your article needs more content."
            });
        }

        if (!category || !category.trim()) {
            return res.status(400).json({
                error:
                    "Please select a category."
            });
        }

        try {

            const normalizedTags =
                normalizeTags(tags);

            const result = await query(`
                INSERT INTO articles
                (
                    author_id,
                    headline,
                    summary,
                    body,
                    image,
                    category,
                    tags,
                    status,
                    submitted_at
                )
                VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    'pending',
                    CURRENT_TIMESTAMP
                )
                RETURNING id
            `, [
                req.session.userId,
                headline.trim(),
                summary || "",
                body,
                await hostedImage(image || ""),
                category.trim(),
                normalizedTags.join(", ")
            ]);

            const articleId =
                result.rows[0].id;

            await syncArticleTags(
                articleId,
                tags
            );

            res.status(201).json({

                message:
                    "Article submitted for review.",

                article_id:
                    articleId,

                status:
                    "pending"
            });

        } catch (error) {

            console.error(
                "ARTICLE CREATE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not submit your article."
            });
        }
    }
);


// ============================================================
// SAVE DRAFT
// ============================================================

app.post(
    "/api/articles/draft",
    requireLogin,
    async (req, res) => {

        const {
            headline,
            summary,
            body,
            image,
            category,
            tags
        } = req.body;

        try {

            const normalizedTags =
                normalizeTags(tags);

            const result = await query(`
                INSERT INTO articles
                (
                    author_id,
                    headline,
                    summary,
                    body,
                    image,
                    category,
                    tags,
                    status
                )
                VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    'draft'
                )
                RETURNING id
            `, [
                req.session.userId,
                headline || "",
                summary || "",
                body || "",
                await hostedImage(image || ""),
                category || "",
                normalizedTags.join(", ")
            ]);

            const articleId =
                result.rows[0].id;

            await syncArticleTags(
                articleId,
                tags
            );

            res.status(201).json({

                message:
                    "Draft saved.",

                article_id:
                    articleId,

                status:
                    "draft"
            });

        } catch (error) {

            console.error(
                "DRAFT ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not save your draft."
            });
        }
    }
);


// ============================================================
// UPDATE MY DRAFT
// ============================================================

app.put(
    "/api/articles/:id/draft",
    requireLogin,
    async (req, res) => {

        const {
            headline,
            summary,
            body,
            image,
            category,
            tags
        } = req.body;

        try {

            const articleResult = await query(`
                SELECT
                    id,
                    status
                FROM articles
                WHERE id = $1
                AND author_id = $2
            `, [
                req.params.id,
                req.session.userId
            ]);

            const article =
                articleResult.rows[0];

            if (!article) {
                return res.status(404).json({
                    error:
                        "Draft not found."
                });
            }

            if (
                article.status !== "draft" &&
                article.status !== "rejected"
            ) {
                return res.status(400).json({
                    error:
                        "Only drafts or rejected articles can be edited."
                });
            }

            const normalizedTags =
                normalizeTags(tags);

            await query(`
                UPDATE articles
                SET
                    headline = $1,
                    summary = $2,
                    body = $3,
                    image = $4,
                    category = $5,
                    tags = $6,
                    status = 'draft',
                    rejection_reason = '',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $7
                AND author_id = $8
            `, [
                headline || "",
                summary || "",
                body || "",
                await hostedImage(image || ""),
                category || "",
                normalizedTags.join(", "),
                req.params.id,
                req.session.userId
            ]);

            await syncArticleTags(
                req.params.id,
                tags
            );

            res.json({

                message:
                    "Draft updated.",

                article_id:
                    Number(req.params.id),

                status:
                    "draft"
            });

        } catch (error) {

            console.error(
                "UPDATE DRAFT ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not update draft."
            });
        }
    }
);


// ============================================================
// GET SINGLE OWN ARTICLE / DRAFT
// ============================================================

app.get(
    "/api/my-articles/:id",
    requireLogin,
    async (req, res) => {

        try {

            const result = await query(`
                SELECT
                    id,
                    headline,
                    summary,
                    body,
                    image,
                    category,
                    tags,
                    status,
                    rejection_reason,
                    featured,
                    homepage_card,
                    created_at,
                    updated_at,
                    submitted_at,
                    published_at
                FROM articles
                WHERE id = $1
                AND author_id = $2
            `, [
                req.params.id,
                req.session.userId
            ]);

            const article =
                result.rows[0];

            if (!article) {
                return res.status(404).json({
                    error:
                        "Article not found."
                });
            }

            res.json(article);

        } catch (error) {

            console.error(
                "MY ARTICLE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not load article."
            });
        }
    }
);


// ============================================================
// DELETE MY ARTICLE
// ============================================================

app.delete(
    "/api/my-articles/:id",
    requireLogin,
    async (req, res) => {

        try {

            const result = await query(`
                DELETE FROM articles
                WHERE id = $1
                AND author_id = $2
                AND status IN
                    ('draft', 'rejected', 'approved')
            `, [
                req.params.id,
                req.session.userId
            ]);

            if (result.rowCount === 0) {
                return res.status(404).json({
                    error:
                        "Article not found or cannot be deleted."
                });
            }

            res.json({
                message:
                    "Article deleted."
            });

        } catch (error) {

            console.error(
                "DELETE MY ARTICLE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not delete article."
            });
        }
    }
);


// ============================================================
// MY ARTICLES
// ============================================================

app.get(
    "/api/my-articles",
    requireLogin,
    async (req, res) => {

        try {

            const result = await query(`
                SELECT
                    id,
                    headline,
                    summary,
                    image,
                    category,
                    tags,
                    status,
                    rejection_reason,
                    featured,
                    homepage_card,
                    created_at,
                    updated_at,
                    submitted_at,
                    published_at
                FROM articles
                WHERE author_id = $1
                ORDER BY created_at DESC
            `, [
                req.session.userId
            ]);

            res.json(result.rows);

        } catch (error) {

            console.error(
                "MY ARTICLES ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not load your articles."
            });
        }
    }
);

// ============================================================
// ADMIN — PENDING SUBMISSIONS
// ============================================================

app.get(
    "/api/admin/articles",
    requireAdmin,
    async (req, res) => {

        try {

            const result = await query(`
                SELECT
                    articles.id,
                    articles.author_id,
                    articles.headline,
                    articles.summary,
                    articles.body,
                    articles.image,
                    articles.category,
                    articles.tags,
                    articles.status,
                    articles.rejection_reason,
                    articles.featured,
                    articles.homepage_card,
                    articles.created_at,
                    articles.updated_at,
                    articles.submitted_at,

                    users.username,
                    users.profile_picture,
                    users.is_verified

                FROM articles

                JOIN users
                ON users.id = articles.author_id

                WHERE articles.status = 'pending'

                ORDER BY articles.submitted_at ASC
            `);

            res.json(result.rows);

        } catch (error) {

            console.error(
                "ADMIN SUBMISSIONS ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not load submissions."
            });
        }
    }
);


// ============================================================
// ADMIN — APPROVE
// ============================================================

app.post(
    "/api/admin/articles/:id/approve",
    requireAdmin,
    async (req, res) => {

        try {

            const reviewer =
                await getCurrentUser(req);

            const articleResult = await query(`
                SELECT
                    articles.id,
                    articles.author_id,
                    articles.headline

                FROM articles

                JOIN users
                ON users.id = articles.author_id

                WHERE articles.id = $1
                AND articles.status = 'pending'
            `, [
                req.params.id
            ]);

            const article =
                articleResult.rows[0];

            if (!article) {
                return res.status(404).json({
                    error:
                        "Pending article not found."
                });
            }

            const result = await query(`
                UPDATE articles
                SET
                    status = 'approved',
                    published_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP,
                    rejection_reason = ''

                WHERE id = $1
                AND status = 'pending'
            `, [
                req.params.id
            ]);

            if (result.rowCount === 0) {
                return res.status(404).json({
                    error:
                        "Pending article not found."
                });
            }

            await createNotification(
                article.author_id,
                "approval",
                "Your article was approved",
                `“${article.headline}” was approved and published by ${reviewer.username}.`,
                `article.html?id=${article.id}`
            );

            res.json({
                message:
                    "Article approved and published.",

                status:
                    "approved"
            });

        } catch (error) {

            console.error(
                "APPROVE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not approve article."
            });
        }
    }
);


// ============================================================
// ADMIN — REJECT
// ============================================================

app.post(
    "/api/admin/articles/:id/reject",
    requireAdmin,
    async (req, res) => {

        const reason =
            req.body.reason
                ? req.body.reason.trim()
                : "";

        if (!reason || reason.length > 2000) {
            return res.status(400).json({
                error:
                    "Provide a rejection reason of at most 2,000 characters."
            });
        }

        try {

            const reviewer =
                await getCurrentUser(req);

            const articleResult = await query(`
                SELECT
                    articles.id,
                    articles.author_id,
                    articles.headline

                FROM articles

                JOIN users
                ON users.id = articles.author_id

                WHERE articles.id = $1
                AND articles.status = 'pending'
            `, [
                req.params.id
            ]);

            const article =
                articleResult.rows[0];

            if (!article) {
                return res.status(404).json({
                    error:
                        "Pending article not found."
                });
            }

            const result = await query(`
                UPDATE articles
                SET
                    status = 'rejected',
                    rejection_reason = $1,
                    updated_at = CURRENT_TIMESTAMP

                WHERE id = $2
                AND status = 'pending'
            `, [
                reason,
                req.params.id
            ]);

            if (result.rowCount === 0) {
                return res.status(404).json({
                    error:
                        "Pending article not found."
                });
            }

            await createNotification(
                article.author_id,
                "rejection",
                "Your article needs changes",
                `“${article.headline}” was rejected by ${reviewer.username}. Notes: ${reason}`,
                `write.html?edit=${article.id}`
            );

            res.json({
                message:
                    "Article rejected.",

                status:
                    "rejected"
            });

        } catch (error) {

            console.error(
                "REJECT ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not reject article."
            });
        }
    }
);


// ============================================================
// ADMIN — ALL ARTICLES
// ============================================================

app.get(
    "/api/admin/all-articles",
    requireAdmin,
    async (req, res) => {

        try {

            const result = await query(`
                SELECT
                    articles.id,
                    articles.author_id,
                    articles.headline,
                    articles.summary,
                    articles.image,
                    articles.category,
                    articles.tags,
                    articles.status,
                    articles.rejection_reason,
                    articles.featured,
                    articles.homepage_card,
                    articles.created_at,
                    articles.updated_at,
                    articles.submitted_at,
                    articles.published_at,

                    users.username,
                    users.is_verified

                FROM articles

                JOIN users
                ON users.id = articles.author_id

                ORDER BY articles.created_at DESC
            `);

            res.json(result.rows);

        } catch (error) {

            console.error(
                "ADMIN ALL ARTICLES ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not load articles."
            });
        }
    }
);


// ============================================================
// OWNER — DELETE ANY ARTICLE
// ============================================================

app.delete(
    "/api/admin/articles/:id",
    requireOwner,
    async (req, res) => {

        try {

            const articleResult = await query(`
                SELECT id
                FROM articles
                WHERE id = $1
            `, [
                req.params.id
            ]);

            const article =
                articleResult.rows[0];

            if (!article) {
                return res.status(404).json({
                    error:
                        "Article not found."
                });
            }

            await query(`
                DELETE FROM articles
                WHERE id = $1
            `, [
                req.params.id
            ]);

            res.json({
                message:
                    "Article deleted."
            });

        } catch (error) {

            console.error(
                "DELETE ARTICLE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not delete article."
            });
        }
    }
);


// ============================================================
// ADMIN — FEATURE
// ============================================================

app.post(
    "/api/admin/articles/:id/feature",
    requireAdmin,
    async (req, res) => {

        try {

            const articleResult = await query(`
                SELECT
                    id,
                    status

                FROM articles

                WHERE id = $1
            `, [
                req.params.id
            ]);

            const article =
                articleResult.rows[0];

            if (!article) {
                return res.status(404).json({
                    error:
                        "Article not found."
                });
            }

            if (article.status !== "approved") {
                return res.status(400).json({
                    error:
                        "Only approved articles can be featured."
                });
            }

            /*
             * There can only be one featured article.
             */
            await query(`
                UPDATE articles
                SET featured = 0
                WHERE featured = 1
            `);

            await query(`
                UPDATE articles
                SET
                    featured = 1,
                    updated_at = CURRENT_TIMESTAMP

                WHERE id = $1
            `, [
                req.params.id
            ]);

            res.json({
                message:
                    "Article is now featured.",

                featured:
                    true
            });

        } catch (error) {

            console.error(
                "FEATURE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not feature article."
            });
        }
    }
);


// ============================================================
// ADMIN — UNFEATURE
// ============================================================

app.delete(
    "/api/admin/articles/:id/feature",
    requireAdmin,
    async (req, res) => {

        try {

            const result = await query(`
                UPDATE articles
                SET
                    featured = 0,
                    updated_at = CURRENT_TIMESTAMP

                WHERE id = $1
            `, [
                req.params.id
            ]);

            if (result.rowCount === 0) {
                return res.status(404).json({
                    error:
                        "Article not found."
                });
            }

            res.json({
                message:
                    "Article removed from Featured."
            });

        } catch (error) {

            console.error(
                "UNFEATURE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not unfeature article."
            });
        }
    }
);


// ============================================================
// ADMIN — HOMEPAGE CARD
// ============================================================

app.post(
    "/api/admin/articles/:id/homepage",
    requireAdmin,
    async (req, res) => {

        try {

            const articleResult = await query(`
                SELECT
                    id,
                    status

                FROM articles

                WHERE id = $1
            `, [
                req.params.id
            ]);

            const article =
                articleResult.rows[0];

            if (!article) {
                return res.status(404).json({
                    error:
                        "Article not found."
                });
            }

            if (article.status !== "approved") {
                return res.status(400).json({
                    error:
                        "Only approved articles can be placed on the homepage."
                });
            }

            await query(`
                UPDATE articles
                SET
                    homepage_card = 1,
                    updated_at = CURRENT_TIMESTAMP

                WHERE id = $1
            `, [
                req.params.id
            ]);

            res.json({
                message:
                    "Article added to homepage cards.",

                homepage_card:
                    true
            });

        } catch (error) {

            console.error(
                "HOMEPAGE CARD ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not add article to homepage."
            });
        }
    }
);


// ============================================================
// ADMIN — REMOVE HOMEPAGE CARD
// ============================================================

app.delete(
    "/api/admin/articles/:id/homepage",
    requireAdmin,
    async (req, res) => {

        try {

            const result = await query(`
                UPDATE articles
                SET
                    homepage_card = 0,
                    updated_at = CURRENT_TIMESTAMP

                WHERE id = $1
            `, [
                req.params.id
            ]);

            if (result.rowCount === 0) {
                return res.status(404).json({
                    error:
                        "Article not found."
                });
            }

            res.json({
                message:
                    "Article removed from homepage cards."
            });

        } catch (error) {

            console.error(
                "REMOVE HOMEPAGE CARD ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not remove article from homepage."
            });
        }
    }
);

// ============================================================
// ADMIN — USER MANAGEMENT
// ============================================================

app.get(
    "/api/admin/users",
    requireAdmin,
    async (req, res) => {

        try {

            const currentUser =
                await getCurrentUser(req);

            const result = await query(`
                SELECT
                    users.id,
                    users.username,
                    users.email,
                    users.profile_picture,
                    users.bio,
                    users.role,
                    users.is_admin,
                    users.is_verified,
                    users.created_at,

                    (
                        SELECT COUNT(*)
                        FROM articles
                        WHERE articles.author_id = users.id
                    ) AS article_count,

                    (
                        SELECT COUNT(*)
                        FROM follows
                        WHERE follows.following_id = users.id
                    ) AS follower_count

                FROM users

                ORDER BY users.created_at DESC
            `);

            res.json({
                current_user_id:
                    currentUser.id,

                current_user_role:
                    currentUser.role,

                users:
                    result.rows
            });

        } catch (error) {

            console.error(
                "ADMIN USERS ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not load users."
            });
        }
    }
);


// ============================================================
// OWNER — PROMOTE
// ============================================================

app.post(
    "/api/owner/users/:id/promote",
    requireOwner,
    async (req, res) => {

        try {

            const result = await query(`
                SELECT
                    id,
                    username,
                    role

                FROM users

                WHERE id = $1
            `, [
                req.params.id
            ]);

            const user =
                result.rows[0];

            if (!user) {
                return res.status(404).json({
                    error:
                        "User not found."
                });
            }

            if (user.role === "owner") {
                return res.status(400).json({
                    error:
                        "The owner cannot be modified this way."
                });
            }

            await query(`
                UPDATE users
                SET
                    role = 'admin',
                    is_admin = 1

                WHERE id = $1
            `, [
                req.params.id
            ]);

            res.json({
                message:
                    `${user.username} is now an administrator.`
            });

        } catch (error) {

            console.error(
                "PROMOTE ADMIN ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not promote user."
            });
        }
    }
);


// ============================================================
// OWNER — DEMOTE
// ============================================================

app.post(
    "/api/owner/users/:id/demote",
    requireOwner,
    async (req, res) => {

        try {

            const result = await query(`
                SELECT
                    id,
                    username,
                    role

                FROM users

                WHERE id = $1
            `, [
                req.params.id
            ]);

            const user =
                result.rows[0];

            if (!user) {
                return res.status(404).json({
                    error:
                        "User not found."
                });
            }

            if (user.role === "owner") {
                return res.status(400).json({
                    error:
                        "The owner cannot be demoted."
                });
            }

            await query(`
                UPDATE users
                SET
                    role = 'user',
                    is_admin = 0

                WHERE id = $1
            `, [
                req.params.id
            ]);

            res.json({
                message:
                    `${user.username} is no longer an administrator.`
            });

        } catch (error) {

            console.error(
                "DEMOTE ADMIN ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not demote user."
            });
        }
    }
);


// ============================================================
// OWNER — VERIFY
// ============================================================

app.post(
    "/api/owner/users/:id/verify",
    requireOwner,
    async (req, res) => {

        try {

            const result = await query(`
                SELECT
                    id,
                    username

                FROM users

                WHERE id = $1
            `, [
                req.params.id
            ]);

            const user =
                result.rows[0];

            if (!user) {
                return res.status(404).json({
                    error:
                        "User not found."
                });
            }

            await query(`
                UPDATE users
                SET
                    is_verified = 1

                WHERE id = $1
            `, [
                req.params.id
            ]);

            res.json({
                message:
                    `${user.username} is now verified.`
            });

        } catch (error) {

            console.error(
                "VERIFY USER ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not verify user."
            });
        }
    }
);


// ============================================================
// OWNER — REMOVE VERIFICATION
// ============================================================

app.delete(
    "/api/owner/users/:id/verify",
    requireOwner,
    async (req, res) => {

        try {

            const result = await query(`
                SELECT
                    id,
                    username

                FROM users

                WHERE id = $1
            `, [
                req.params.id
            ]);

            const user =
                result.rows[0];

            if (!user) {
                return res.status(404).json({
                    error:
                        "User not found."
                });
            }

            await query(`
                UPDATE users
                SET
                    is_verified = 0

                WHERE id = $1
            `, [
                req.params.id
            ]);

            res.json({
                message:
                    `${user.username} is no longer verified.`
            });

        } catch (error) {

            console.error(
                "REMOVE VERIFICATION ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not remove verification."
            });
        }
    }
);


// ============================================================
// ADMIN / OWNER — DELETE USER
// ============================================================

app.delete(
    "/api/admin/users/:id",
    requireAdmin,
    async (req, res) => {

        try {

            const currentUser =
                await getCurrentUser(req);

            const targetResult = await query(`
                SELECT
                    id,
                    username,
                    role

                FROM users

                WHERE id = $1
            `, [
                req.params.id
            ]);

            const targetUser =
                targetResult.rows[0];

            if (!targetUser) {
                return res.status(404).json({
                    error:
                        "User not found."
                });
            }

            if (
                Number(targetUser.id) ===
                Number(currentUser.id)
            ) {
                return res.status(400).json({
                    error:
                        "You cannot delete your own account from the admin panel."
                });
            }

            if (targetUser.role === "owner") {
                return res.status(403).json({
                    error:
                        "The owner account cannot be deleted."
                });
            }

            if (
                targetUser.role === "admin" &&
                currentUser.role !== "owner"
            ) {
                return res.status(403).json({
                    error:
                        "Only the owner can delete an administrator."
                });
            }

            await query(`
                DELETE FROM users
                WHERE id = $1
            `, [
                targetUser.id
            ]);

            res.json({
                message:
                    `User ${targetUser.username} was deleted.`
            });

        } catch (error) {

            console.error(
                "DELETE USER ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not delete user."
            });
        }
    }
);

// ============================================================
// PUBLIC — HOMEPAGE
// ============================================================
//
// IMPORTANT:
// Manual Featured/Homepage Card flags still take priority.
//
// If no manual homepage selections exist yet, the newest
// approved articles automatically appear instead.
// ============================================================

app.get("/api/homepage", async (req, res) => {

    try {

        // --------------------------------------------------------
        // 1. Try the manually selected featured article.
        // --------------------------------------------------------

        const featuredResult = await query(`
            SELECT
                articles.id,
                articles.author_id,
                articles.headline,
                articles.summary,
                articles.body,
                articles.image,
                articles.category,
                articles.tags,
                articles.published_at,

                users.username,
                users.profile_picture,
                users.is_verified

            FROM articles

            JOIN users
            ON users.id = articles.author_id

            WHERE articles.status = 'approved'
            AND articles.featured = 1

            ORDER BY articles.published_at DESC

            LIMIT 1
        `);

        let featured = featuredResult.rows[0] || null;


        // --------------------------------------------------------
        // 2. Get manually selected homepage cards.
        // --------------------------------------------------------

        const cardsResult = await query(`
            SELECT
                articles.id,
                articles.author_id,
                articles.headline,
                articles.summary,
                articles.body,
                articles.image,
                articles.category,
                articles.tags,
                articles.published_at,

                users.username,
                users.profile_picture,
                users.is_verified

            FROM articles

            JOIN users
            ON users.id = articles.author_id

            WHERE articles.status = 'approved'
            AND articles.homepage_card = 1

            ORDER BY articles.published_at DESC
        `);

        let cards = cardsResult.rows;


        // --------------------------------------------------------
        // 3. FALLBACK
        //
        // If the owner hasn't selected anything for the homepage
        // yet, automatically use the newest approved articles.
        // --------------------------------------------------------

        if (!featured && cards.length === 0) {

            const approvedResult = await query(`
                SELECT
                    articles.id,
                    articles.author_id,
                    articles.headline,
                    articles.summary,
                    articles.body,
                    articles.image,
                    articles.category,
                    articles.tags,
                    articles.published_at,

                    users.username,
                    users.profile_picture,
                    users.is_verified

                FROM articles

                JOIN users
                ON users.id = articles.author_id

                WHERE articles.status = 'approved'

                ORDER BY
                    COALESCE(
                        articles.published_at,
                        articles.created_at
                    ) DESC

                LIMIT 7
            `);

            const approvedArticles = approvedResult.rows;

            if (approvedArticles.length > 0) {

                featured = approvedArticles[0];

                cards = approvedArticles.slice(1);
            }
        }


        // --------------------------------------------------------
        // 4. If a featured article exists but there are no cards,
        //    fill cards with the newest approved articles that
        //    aren't the featured article.
        // --------------------------------------------------------

        if (featured && cards.length === 0) {

            const cardsResult2 = await query(`
                SELECT
                    articles.id,
                    articles.author_id,
                    articles.headline,
                    articles.summary,
                    articles.body,
                    articles.image,
                    articles.category,
                    articles.tags,
                    articles.published_at,

                    users.username,
                    users.profile_picture,
                    users.is_verified

                FROM articles

                JOIN users
                ON users.id = articles.author_id

                WHERE articles.status = 'approved'
                AND articles.id != $1

                ORDER BY
                    COALESCE(
                        articles.published_at,
                        articles.created_at
                    ) DESC

                LIMIT 6
            `, [featured.id]);

            cards = cardsResult2.rows;
        }


        // --------------------------------------------------------
        // 5. If cards exist but there is no featured article,
        //    promote the newest card to featured.
        // --------------------------------------------------------

        if (!featured && cards.length > 0) {

            featured = cards[0];

            cards = cards.slice(1);
        }


        res.json({
            featured: featured || null,
            cards
        });


    } catch (error) {

        console.error(
            "HOMEPAGE ERROR:",
            error
        );

        res.status(500).json({
            error:
                "Could not load homepage articles."
        });
    }
});


// ============================================================
// PUBLIC ARTICLE
// ============================================================

app.get("/api/articles/:id", async (req, res) => {

    try {

        const articleResult = await query(`
            SELECT
                articles.id,
                articles.author_id,
                articles.headline,
                articles.summary,
                articles.body,
                articles.image,
                articles.category,
                articles.tags,
                articles.created_at,
                articles.published_at,

                users.username,
                users.profile_picture,
                users.is_verified

            FROM articles

            JOIN users
            ON users.id = articles.author_id

            WHERE articles.id = $1
            AND articles.status = 'approved'
        `, [req.params.id]);

        const article = articleResult.rows[0];

        if (!article) {
            return res.status(404).json({
                error: "Article not found."
            });
        }


        // ========================================================
        // ARTICLE VOTES
        // ========================================================

        const voteCountsResult = await query(`
            SELECT
                COALESCE(
                    SUM(
                        CASE
                            WHEN vote = 1 THEN 1
                            ELSE 0
                        END
                    ),
                    0
                ) AS likes,

                COALESCE(
                    SUM(
                        CASE
                            WHEN vote = -1 THEN 1
                            ELSE 0
                        END
                    ),
                    0
                ) AS dislikes

            FROM article_votes

            WHERE article_id = $1
        `, [req.params.id]);

        const voteCounts = voteCountsResult.rows[0];


        let userVote = 0;
        let isSaved = false;


        if (req.session.userId) {

            const voteResult = await query(`
                SELECT vote

                FROM article_votes

                WHERE article_id = $1
                AND user_id = $2
            `, [
                req.params.id,
                req.session.userId
            ]);

            const vote = voteResult.rows[0];

            if (vote) {
                userVote = Number(vote.vote);
            }


            const savedResult = await query(`
                SELECT id

                FROM saved_articles

                WHERE article_id = $1
                AND user_id = $2
            `, [
                req.params.id,
                req.session.userId
            ]);

            isSaved = savedResult.rows.length > 0;
        }


        // ========================================================
        // COMMENTS
        // ========================================================

        const commentsResult = await query(`
            SELECT
                comments.id,
                comments.article_id,
                comments.user_id,
                comments.parent_id,
                comments.body,
                comments.created_at,

                users.username,
                users.profile_picture,
                users.is_verified

            FROM comments

            JOIN users
            ON users.id = comments.user_id

            WHERE comments.article_id = $1

            ORDER BY comments.created_at ASC
        `, [req.params.id]);

        const comments = commentsResult.rows;


        // ========================================================
        // ADD REACTIONS / VOTES TO EVERY COMMENT
        // ========================================================

        for (const comment of comments) {

            const reactionData =
                await getCommentReactionData(
                    comment.id,
                    req.session.userId || null
                );


            comment.reactions =
                reactionData.reactions;

            comment.likes =
                reactionData.likes;

            comment.dislikes =
                reactionData.dislikes;

            comment.user_reaction =
                reactionData.user_reaction;

            comment.user_vote =
                reactionData.user_vote;
        }


        res.json({

            ...article,

            likes:
                Number(voteCounts.likes || 0),

            dislikes:
                Number(voteCounts.dislikes || 0),

            user_vote:
                userVote,

            is_saved:
                isSaved,

            comments
        });


    } catch (error) {

        console.error(
            "PUBLIC ARTICLE ERROR:",
            error
        );

        res.status(500).json({
            error:
                "Could not load article."
        });
    }
});


// ============================================================
// ARTICLE VOTE
// ============================================================

app.post(
    "/api/articles/:id/vote",
    requireLogin,
    async (req, res) => {

        const vote =
            Number(req.body.vote);


        if (
            vote !== 1 &&
            vote !== -1 &&
            vote !== 0
        ) {
            return res.status(400).json({
                error:
                    "Vote must be 1, -1, or 0."
            });
        }


        try {

            const articleResult = await query(`
                SELECT id

                FROM articles

                WHERE id = $1
                AND status = 'approved'
            `, [req.params.id]);

            const article =
                articleResult.rows[0];


            if (!article) {
                return res.status(404).json({
                    error:
                        "Article not found."
                });
            }


            const existingResult = await query(`
                SELECT
                    id,
                    vote

                FROM article_votes

                WHERE article_id = $1
                AND user_id = $2
            `, [
                req.params.id,
                req.session.userId
            ]);

            const existing =
                existingResult.rows[0];


            if (vote === 0) {

                if (existing) {

                    await query(`
                        DELETE FROM article_votes

                        WHERE id = $1
                    `, [existing.id]);
                }

            } else if (existing) {

                await query(`
                    UPDATE article_votes

                    SET vote = $1

                    WHERE id = $2
                `, [
                    vote,
                    existing.id
                ]);

            } else {

                await query(`
                    INSERT INTO article_votes
                    (
                        article_id,
                        user_id,
                        vote
                    )

                    VALUES ($1, $2, $3)
                `, [
                    req.params.id,
                    req.session.userId,
                    vote
                ]);
            }


            const countsResult = await query(`
                SELECT

                    COALESCE(
                        SUM(
                            CASE
                                WHEN vote = 1 THEN 1
                                ELSE 0
                            END
                        ),
                        0
                    ) AS likes,

                    COALESCE(
                        SUM(
                            CASE
                                WHEN vote = -1 THEN 1
                                ELSE 0
                            END
                        ),
                        0
                    ) AS dislikes

                FROM article_votes

                WHERE article_id = $1
            `, [req.params.id]);

            const counts =
                countsResult.rows[0];


            res.json({

                likes:
                    Number(counts.likes || 0),

                dislikes:
                    Number(counts.dislikes || 0),

                user_vote:
                    vote
            });


        } catch (error) {

            console.error(
                "VOTE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not save vote."
            });
        }
    }
);


// ============================================================
// SAVE ARTICLE
// ============================================================

app.post(
    "/api/articles/:id/save",
    requireLogin,
    async (req, res) => {

        try {

            const articleResult = await query(`
                SELECT id

                FROM articles

                WHERE id = $1
                AND status = 'approved'
            `, [req.params.id]);

            const article =
                articleResult.rows[0];


            if (!article) {
                return res.status(404).json({
                    error:
                        "Article not found."
                });
            }


            await query(`
                INSERT INTO saved_articles
                (
                    article_id,
                    user_id
                )

                VALUES ($1, $2)

                ON CONFLICT (article_id, user_id)
                DO NOTHING
            `, [
                req.params.id,
                req.session.userId
            ]);


            res.json({
                message:
                    "Article saved.",

                is_saved:
                    true
            });


        } catch (error) {

            console.error(
                "SAVE ARTICLE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not save article."
            });
        }
    }
);


// ============================================================
// UNSAVE ARTICLE
// ============================================================

app.delete(
    "/api/articles/:id/save",
    requireLogin,
    async (req, res) => {

        try {

            await query(`
                DELETE FROM saved_articles

                WHERE article_id = $1
                AND user_id = $2
            `, [
                req.params.id,
                req.session.userId
            ]);


            res.json({

                message:
                    "Article removed from saved articles.",

                is_saved:
                    false
            });


        } catch (error) {

            console.error(
                "UNSAVE ARTICLE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not remove saved article."
            });
        }
    }
);


// ============================================================
// MY SAVED ARTICLES
// ============================================================

app.get(
    "/api/saved-articles",
    requireLogin,
    async (req, res) => {

        try {

            const articlesResult = await query(`
                SELECT

                    articles.id,
                    articles.headline,
                    articles.summary,
                    articles.image,
                    articles.category,
                    articles.tags,
                    articles.published_at,

                    users.username,
                    users.profile_picture,
                    users.is_verified,

                    saved_articles.created_at
                        AS saved_at

                FROM saved_articles

                JOIN articles
                ON articles.id =
                    saved_articles.article_id

                JOIN users
                ON users.id =
                    articles.author_id

                WHERE saved_articles.user_id = $1
                AND articles.status = 'approved'

                ORDER BY
                    saved_articles.created_at DESC
            `, [req.session.userId]);


            res.json(
                articlesResult.rows
            );


        } catch (error) {

            console.error(
                "SAVED ARTICLES ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not load saved articles."
            });
        }
    }
);

// ============================================================
// COMMENTS
// ============================================================

async function getCommentReactionData(
    commentId,
    userId = null
) {

    const reactionsResult = await query(`
        SELECT
            reaction,
            COUNT(*) AS count

        FROM comment_reactions

        WHERE comment_id = $1

        GROUP BY reaction

        ORDER BY count DESC
    `, [commentId]);

    const reactions = reactionsResult.rows;


    const votesResult = await query(`
        SELECT

            COALESCE(
                SUM(
                    CASE
                        WHEN vote = 1 THEN 1
                        ELSE 0
                    END
                ),
                0
            ) AS likes,

            COALESCE(
                SUM(
                    CASE
                        WHEN vote = -1 THEN 1
                        ELSE 0
                    END
                ),
                0
            ) AS dislikes

        FROM comment_votes

        WHERE comment_id = $1
    `, [commentId]);

    const votes = votesResult.rows[0];


    let userReaction = null;
    let userVote = 0;


    if (userId) {

        const reactionResult = await query(`
            SELECT reaction

            FROM comment_reactions

            WHERE comment_id = $1
            AND user_id = $2
        `, [
            commentId,
            userId
        ]);

        const reaction =
            reactionResult.rows[0];


        if (reaction) {
            userReaction =
                reaction.reaction;
        }


        const voteResult = await query(`
            SELECT vote

            FROM comment_votes

            WHERE comment_id = $1
            AND user_id = $2
        `, [
            commentId,
            userId
        ]);

        const vote =
            voteResult.rows[0];


        if (vote) {
            userVote =
                Number(vote.vote);
        }
    }


    return {

        reactions,

        likes:
            Number(votes.likes || 0),

        dislikes:
            Number(votes.dislikes || 0),

        user_reaction:
            userReaction,

        user_vote:
            userVote
    };
}


// ============================================================
// DELETE COMMENT TREE
// ============================================================

async function deleteCommentTree(commentId) {

    const ids = [];


    async function collect(id) {

        ids.push(id);


        const childrenResult = await query(`
            SELECT id

            FROM comments

            WHERE parent_id = $1
        `, [id]);

        const children =
            childrenResult.rows;


        for (const child of children) {

            await collect(child.id);
        }
    }


    await collect(commentId);


    const client =
        await pool.connect();


    try {

        await client.query("BEGIN");


        for (const id of ids) {

            await client.query(`
                DELETE FROM comment_reactions

                WHERE comment_id = $1
            `, [id]);


            await client.query(`
                DELETE FROM comment_votes

                WHERE comment_id = $1
            `, [id]);


            await client.query(`
                DELETE FROM comments

                WHERE id = $1
            `, [id]);
        }


        await client.query("COMMIT");


    } catch (error) {

        await client.query("ROLLBACK");

        throw error;

    } finally {

        client.release();
    }
}


// ============================================================
// POST COMMENT
// ============================================================

app.post(
    "/api/articles/:id/comments",
    requireLogin,
    async (req, res) => {

        const body =
            req.body.body
                ? req.body.body.trim()
                : "";


        const parentId =
            req.body.parent_id || null;


        if (!body) {

            return res.status(400).json({
                error:
                    "Comment cannot be empty."
            });
        }


        if (body.length > 5000) {

            return res.status(400).json({
                error:
                    "Comment is too long."
            });
        }


        try {

            const articleResult =
                await query(`
                    SELECT id

                    FROM articles

                    WHERE id = $1
                    AND status = 'approved'
                `, [req.params.id]);


            const article =
                articleResult.rows[0];


            if (!article) {

                return res.status(404).json({
                    error:
                        "Article not found."
                });
            }


            if (parentId) {

                const parentResult =
                    await query(`
                        SELECT id

                        FROM comments

                        WHERE id = $1
                        AND article_id = $2
                    `, [
                        parentId,
                        req.params.id
                    ]);


                const parent =
                    parentResult.rows[0];


                if (!parent) {

                    return res.status(400).json({
                        error:
                            "Parent comment not found."
                    });
                }
            }


            const result =
                await query(`
                    INSERT INTO comments
                    (
                        article_id,
                        user_id,
                        parent_id,
                        body
                    )

                    VALUES ($1, $2, $3, $4)

                    RETURNING id
                `, [
                    req.params.id,
                    req.session.userId,
                    parentId,
                    body
                ]);


            const commentId =
                result.rows[0].id;


            const commentResult =
                await query(`
                    SELECT
                        comments.id,
                        comments.article_id,
                        comments.user_id,
                        comments.parent_id,
                        comments.body,
                        comments.created_at,

                        users.username,
                        users.profile_picture,
                        users.is_verified

                    FROM comments

                    JOIN users
                    ON users.id =
                        comments.user_id

                    WHERE comments.id = $1
                `, [commentId]);


            const comment =
                commentResult.rows[0];


            res.status(201).json({

                ...comment,

                reactions: [],

                likes: 0,

                dislikes: 0,

                user_reaction: null,

                user_vote: 0
            });


        } catch (error) {

            console.error(
                "COMMENT ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not post comment."
            });
        }
    }
);


// ============================================================
// COMMENT EMOJI REACTION
// ============================================================

app.post(
    "/api/comments/:id/reaction",
    requireLogin,
    async (req, res) => {

        const reaction =
            typeof req.body.reaction === "string"
                ? req.body.reaction.trim()
                : "";


        if (!reaction) {

            return res.status(400).json({
                error:
                    "Please provide a reaction."
            });
        }


        if ([...reaction].length > 16) {

            return res.status(400).json({
                error:
                    "Invalid reaction."
            });
        }


        try {

            const commentResult =
                await query(`
                    SELECT id

                    FROM comments

                    WHERE id = $1
                `, [req.params.id]);


            const comment =
                commentResult.rows[0];


            if (!comment) {

                return res.status(404).json({
                    error:
                        "Comment not found."
                });
            }


            const existingResult =
                await query(`
                    SELECT
                        id,
                        reaction

                    FROM comment_reactions

                    WHERE comment_id = $1
                    AND user_id = $2
                `, [
                    req.params.id,
                    req.session.userId
                ]);


            const existing =
                existingResult.rows[0];


            if (existing) {

                if (
                    existing.reaction ===
                    reaction
                ) {

                    await query(`
                        DELETE FROM comment_reactions

                        WHERE id = $1
                    `, [existing.id]);

                } else {

                    await query(`
                        UPDATE comment_reactions

                        SET
                            reaction = $1,
                            created_at =
                                CURRENT_TIMESTAMP

                        WHERE id = $2
                    `, [
                        reaction,
                        existing.id
                    ]);
                }

            } else {

                await query(`
                    INSERT INTO comment_reactions
                    (
                        comment_id,
                        user_id,
                        reaction
                    )

                    VALUES ($1, $2, $3)
                `, [
                    req.params.id,
                    req.session.userId,
                    reaction
                ]);
            }


            const data =
                await getCommentReactionData(
                    req.params.id,
                    req.session.userId
                );


            res.json(data);


        } catch (error) {

            console.error(
                "COMMENT REACTION ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not save reaction."
            });
        }
    }
);


// ============================================================
// REMOVE COMMENT REACTION
// ============================================================

app.delete(
    "/api/comments/:id/reaction",
    requireLogin,
    async (req, res) => {

        try {

            await query(`
                DELETE FROM comment_reactions

                WHERE comment_id = $1
                AND user_id = $2
            `, [
                req.params.id,
                req.session.userId
            ]);


            const data =
                await getCommentReactionData(
                    req.params.id,
                    req.session.userId
                );


            res.json(data);


        } catch (error) {

            console.error(
                "REMOVE COMMENT REACTION ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not remove reaction."
            });
        }
    }
);


// ============================================================
// COMMENT UPVOTE / DOWNVOTE
// ============================================================

app.post(
    "/api/comments/:id/vote",
    requireLogin,
    async (req, res) => {

        const vote =
            Number(req.body.vote);


        if (
            vote !== 1 &&
            vote !== -1 &&
            vote !== 0
        ) {

            return res.status(400).json({
                error:
                    "Vote must be 1, -1, or 0."
            });
        }


        try {

            const commentResult =
                await query(`
                    SELECT id

                    FROM comments

                    WHERE id = $1
                `, [req.params.id]);


            const comment =
                commentResult.rows[0];


            if (!comment) {

                return res.status(404).json({
                    error:
                        "Comment not found."
                });
            }


            const existingResult =
                await query(`
                    SELECT
                        id,
                        vote

                    FROM comment_votes

                    WHERE comment_id = $1
                    AND user_id = $2
                `, [
                    req.params.id,
                    req.session.userId
                ]);


            const existing =
                existingResult.rows[0];


            if (vote === 0) {

                if (existing) {

                    await query(`
                        DELETE FROM comment_votes

                        WHERE id = $1
                    `, [existing.id]);
                }

            } else if (existing) {

                if (
                    Number(existing.vote) ===
                    vote
                ) {

                    await query(`
                        DELETE FROM comment_votes

                        WHERE id = $1
                    `, [existing.id]);

                } else {

                    await query(`
                        UPDATE comment_votes

                        SET vote = $1

                        WHERE id = $2
                    `, [
                        vote,
                        existing.id
                    ]);
                }

            } else {

                await query(`
                    INSERT INTO comment_votes
                    (
                        comment_id,
                        user_id,
                        vote
                    )

                    VALUES ($1, $2, $3)
                `, [
                    req.params.id,
                    req.session.userId,
                    vote
                ]);
            }


            const data =
                await getCommentReactionData(
                    req.params.id,
                    req.session.userId
                );


            res.json(data);


        } catch (error) {

            console.error(
                "COMMENT VOTE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not save comment vote."
            });
        }
    }
);


// ============================================================
// DELETE OWN COMMENT
// ============================================================

app.delete(
    "/api/comments/:id",
    requireLogin,
    async (req, res) => {

        try {

            const commentResult =
                await query(`
                    SELECT
                        id,
                        user_id

                    FROM comments

                    WHERE id = $1
                `, [req.params.id]);


            const comment =
                commentResult.rows[0];


            if (!comment) {

                return res.status(404).json({
                    error:
                        "Comment not found."
                });
            }


            if (
                Number(comment.user_id) !==
                Number(req.session.userId)
            ) {

                return res.status(403).json({
                    error:
                        "You can only delete your own comments."
                });
            }


            await deleteCommentTree(
                comment.id
            );


            res.json({
                message:
                    "Comment deleted."
            });


        } catch (error) {

            console.error(
                "DELETE OWN COMMENT ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not delete comment."
            });
        }
    }
);


// ============================================================
// ADMIN / OWNER — DELETE ANY COMMENT
// ============================================================

app.delete(
    "/api/admin/comments/:id",
    requireAdmin,
    async (req, res) => {

        try {

            const commentResult =
                await query(`
                    SELECT id

                    FROM comments

                    WHERE id = $1
                `, [req.params.id]);


            const comment =
                commentResult.rows[0];


            if (!comment) {

                return res.status(404).json({
                    error:
                        "Comment not found."
                });
            }


            await deleteCommentTree(
                comment.id
            );


            res.json({
                message:
                    "Comment removed by administrator."
            });


        } catch (error) {

            console.error(
                "ADMIN DELETE COMMENT ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Could not delete comment."
            });
        }
    }
);

// ============================================================
// TAGS
// ============================================================

app.get("/api/tags", async (req, res) => {
    try {
        const result = await query(`
            SELECT
                tags.id,
                tags.name,
                COUNT(article_tags.article_id) AS article_count

            FROM tags

            LEFT JOIN article_tags
            ON article_tags.tag_id = tags.id

            GROUP BY tags.id

            ORDER BY article_count DESC, tags.name ASC
        `);

        const tags = result.rows.map(tag => ({
            ...tag,
            article_count: Number(tag.article_count)
        }));

        res.json(tags);

    } catch (error) {

        console.error("TAGS ERROR:", error);

        res.status(500).json({
            error: "Could not load tags."
        });
    }
});


// ============================================================
// TAG ARTICLES
// ============================================================

app.get("/api/tags/:tag", async (req, res) => {
    try {

        const tagName =
            req.params.tag.toLowerCase();

        const result = await query(`
            SELECT
                articles.id,
                articles.headline,
                articles.summary,
                articles.image,
                articles.category,
                articles.tags,
                articles.published_at,

                users.username,
                users.profile_picture,
                users.is_verified

            FROM tags

            JOIN article_tags
            ON article_tags.tag_id = tags.id

            JOIN articles
            ON articles.id = article_tags.article_id

            JOIN users
            ON users.id = articles.author_id

            WHERE tags.name = $1
            AND articles.status = 'approved'

            ORDER BY articles.published_at DESC
        `, [
            tagName
        ]);

        res.json(result.rows);

    } catch (error) {

        console.error(
            "TAG ARTICLES ERROR:",
            error
        );

        res.status(500).json({
            error:
                "Could not load tag articles."
        });
    }
});


// ============================================================
// SEARCH
// ============================================================

app.get("/api/search", async (req, res) => {

    const searchQuery =
        req.query.q
            ? req.query.q.trim()
            : "";

    if (!searchQuery) {
        return res.json({
            articles: [],
            users: [],
            tags: []
        });
    }

    try {

        const pattern = `%${searchQuery}%`;


        // --------------------------------------------------------
        // SEARCH ARTICLES
        // --------------------------------------------------------

        const articleResult = await query(`
            SELECT
                articles.id,
                articles.headline,
                articles.summary,
                articles.image,
                articles.category,
                articles.tags,
                articles.published_at,

                users.username,
                users.profile_picture,
                users.is_verified

            FROM articles

            JOIN users
            ON users.id = articles.author_id

            WHERE articles.status = 'approved'

            AND (
                articles.headline ILIKE $1
                OR articles.summary ILIKE $2
                OR articles.body ILIKE $3
                OR articles.category ILIKE $4
                OR articles.tags ILIKE $5
            )

            ORDER BY articles.published_at DESC

            LIMIT 50
        `, [
            pattern,
            pattern,
            pattern,
            pattern,
            pattern
        ]);

        const articles =
            articleResult.rows;


        // --------------------------------------------------------
        // SEARCH USERS
        // --------------------------------------------------------

        const userResult = await query(`
            SELECT
                id,
                username,
                profile_picture,
                bio,
                is_verified,
                role

            FROM users

            WHERE username ILIKE $1
            OR bio ILIKE $2

            ORDER BY username ASC

            LIMIT 50
        `, [
            pattern,
            pattern
        ]);

        const users =
            userResult.rows;


        // --------------------------------------------------------
        // SEARCH TAGS
        // --------------------------------------------------------

        const tagResult = await query(`
            SELECT
                id,
                name

            FROM tags

            WHERE name ILIKE $1

            ORDER BY name ASC

            LIMIT 50
        `, [
            pattern
        ]);

        const tags =
            tagResult.rows;


        // --------------------------------------------------------
        // RESPONSE
        // --------------------------------------------------------

        res.json({
            articles,
            users,
            tags
        });

    } catch (error) {

        console.error(
            "SEARCH ERROR:",
            error
        );

        res.status(500).json({
            error: "Search failed."
        });
    }
});


// ============================================================
// LOGOUT
// ============================================================

app.post("/api/logout", (req, res) => {

    req.session.destroy(error => {

        if (error) {

            console.error(
                "LOGOUT ERROR:",
                error
            );

            return res.status(500).json({
                error:
                    "Could not log out."
            });
        }

        res.json({
            message:
                "Logged out successfully."
        });
    });
});


// ============================================================
// SERVER STATUS
// ============================================================

app.get("/api/status", async (req, res) => {
    try {
        await query("SELECT 1");
        res.json({
            status: "online",
            database: "connected",
            site: "Cataclysm Colony",
            version: "deployment-ready-v4-email-pending",
            providers: {
                email: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
                image_storage: Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET),
                encrypted_chat: Boolean(getChatKey())
            }
        });
    } catch (error) {
        console.error("STATUS DATABASE CHECK ERROR:", error);
        res.status(503).json({ status: "degraded", database: "unavailable", site: "Cataclysm Colony" });
    }
});
