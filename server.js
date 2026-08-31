const express = require("express");
const bcrypt = require("bcrypt");
const session = require("express-session");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;


// ============================================================
// OWNER BOOTSTRAP
// ============================================================

try {

    const ownerUsername = "alexandria201999";

    const owner = db.prepare(`
        SELECT
            id,
            username,
            role,
            is_admin
        FROM users
        WHERE username = ?
    `).get(ownerUsername);

    if (owner) {

        db.prepare(`
            UPDATE users
            SET
                role = 'owner',
                is_admin = 1
            WHERE username = ?
        `).run(ownerUsername);

        console.log("");
        console.log("========================================");
        console.log("       Cataclysm Colony OWNER");
        console.log("========================================");
        console.log(`Owner account: ${ownerUsername}`);
        console.log("Role:          owner");
        console.log("Admin access:  enabled");
        console.log("========================================");
        console.log("");

    } else {

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
}


// ============================================================
// BASIC SERVER SETUP
// ============================================================

app.use(express.json({
    limit: "15mb"
}));

app.use(express.urlencoded({
    extended: true,
    limit: "15mb"
}));

app.use(
    session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,

        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: false,
            maxAge: 1000 * 60 * 60 * 24 * 7
        }
    })
);

app.use(express.static(__dirname));


// ============================================================
// COMMENT REACTIONS / VOTES DATABASE
// ============================================================

try {

    db.exec(`
        CREATE TABLE IF NOT EXISTS comment_reactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            comment_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            reaction TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

            UNIQUE(comment_id, user_id),

            FOREIGN KEY (comment_id)
                REFERENCES comments(id)
                ON DELETE CASCADE,

            FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS comment_votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            comment_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            vote INTEGER NOT NULL CHECK(vote IN (1, -1)),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

            UNIQUE(comment_id, user_id),

            FOREIGN KEY (comment_id)
                REFERENCES comments(id)
                ON DELETE CASCADE,

            FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment
        ON comment_reactions(comment_id);

        CREATE INDEX IF NOT EXISTS idx_comment_votes_comment
        ON comment_votes(comment_id);
    `);

    console.log("Comment reactions: ONLINE");
    console.log("Comment votes:     ONLINE");

} catch (error) {

    console.error(
        "COMMENT SYSTEM DATABASE ERROR:",
        error
    );
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


function getCurrentUser(req) {

    if (!req.session.userId) {
        return null;
    }

    return db.prepare(`
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
        WHERE id = ?
    `).get(req.session.userId);
}


function createNotification(recipientId, type, title, message, link = "") {

    db.prepare(`
        INSERT INTO notifications (
            recipient_id,
            type,
            title,
            message,
            link
        )
        VALUES (?, ?, ?, ?, ?)
    `).run(
        recipientId,
        type,
        title,
        message,
        link
    );
}


function requireAdmin(req, res, next) {

    const user = getCurrentUser(req);

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
            error: "Administrator access required."
        });
    }

    next();
}


function requireOwner(req, res, next) {

    const user = getCurrentUser(req);

    if (!user) {
        return res.status(401).json({
            error: "You must be logged in."
        });
    }

    if (user.role !== "owner") {
        return res.status(403).json({
            error: "Owner access required."
        });
    }

    next();
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
                .map(tag => String(tag).trim().toLowerCase())
                .filter(Boolean)
                .slice(0, 20)
        )
    ];
}


function syncArticleTags(articleId, tags) {

    const normalized = normalizeTags(tags);

    const deleteOld = db.prepare(`
        DELETE FROM article_tags
        WHERE article_id = ?
    `);

    const createTag = db.prepare(`
        INSERT OR IGNORE INTO tags (name)
        VALUES (?)
    `);

    const getTag = db.prepare(`
        SELECT id
        FROM tags
        WHERE name = ?
    `);

    const connectTag = db.prepare(`
        INSERT OR IGNORE INTO article_tags
        (
            article_id,
            tag_id
        )
        VALUES (?, ?)
    `);

    const transaction = db.transaction(() => {

        deleteOld.run(articleId);

        for (const tag of normalized) {

            createTag.run(tag);

            const row = getTag.get(tag);

            if (row) {
                connectTag.run(articleId, row.id);
            }
        }
    });

    transaction();
}


// ============================================================
// REGISTER
// ============================================================

app.post("/api/register", async (req, res) => {

    const {
        username,
        email,
        password
    } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({
            error: "Please fill in all fields."
        });
    }

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (cleanUsername.length < 3) {
        return res.status(400).json({
            error: "Username must be at least 3 characters."
        });
    }

    if (cleanUsername.length > 30) {
        return res.status(400).json({
            error: "Username must be 30 characters or less."
        });
    }

    if (password.length < 8) {
        return res.status(400).json({
            error: "Password must be at least 8 characters."
        });
    }

    try {

        const existingUser = db.prepare(`
            SELECT id
            FROM users
            WHERE username = ?
            OR email = ?
        `).get(
            cleanUsername,
            cleanEmail
        );

        if (existingUser) {
            return res.status(409).json({
                error: "That username or email is already registered."
            });
        }

        const passwordHash = await bcrypt.hash(
            password,
            12
        );

        const result = db.prepare(`
            INSERT INTO users
            (
                username,
                email,
                password_hash,
                role,
                is_admin
            )
            VALUES (?, ?, ?, 'user', 0)
        `).run(
            cleanUsername,
            cleanEmail,
            passwordHash
        );

        res.status(201).json({
            message: "Account created successfully.",
            user_id: result.lastInsertRowid
        });

    } catch (error) {

        console.error("REGISTER ERROR:", error);

        res.status(500).json({
            error: "Something went wrong while creating your account."
        });
    }
});


// ============================================================
// LOGIN
// ============================================================

app.post("/api/login", async (req, res) => {

    const {
        username,
        password
    } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            error: "Please enter your username and password."
        });
    }

    try {

        const user = db.prepare(`
            SELECT
                id,
                username,
                email,
                password_hash,
                role,
                is_admin,
                is_verified
            FROM users
            WHERE username = ?
        `).get(username.trim());

        if (!user) {
            return res.status(401).json({
                error: "Invalid username or password."
            });
        }

        const passwordMatches = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                error: "Invalid username or password."
            });
        }

        req.session.userId = user.id;

        res.json({
            message: "Login successful.",
            username: user.username,
            role: user.role,
            is_admin:
                user.role === "owner" ||
                user.role === "admin",
            is_owner:
                user.role === "owner",
            is_verified:
                user.is_verified === 1
        });

    } catch (error) {

        console.error("LOGIN ERROR:", error);

        res.status(500).json({
            error: "Something went wrong while logging in."
        });
    }
});


// ============================================================
// CURRENT USER
// ============================================================

app.get("/api/me", (req, res) => {

    const user = getCurrentUser(req);

    if (!user) {
        return res.status(401).json({
            error: "Not logged in."
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
});


// ============================================================
// UPDATE MY PROFILE
// ============================================================

app.put("/api/me", requireLogin, (req, res) => {

    const {
        bio,
        profile_picture
    } = req.body;

    try {

        db.prepare(`
            UPDATE users
            SET
                bio = ?,
                profile_picture = ?
            WHERE id = ?
        `).run(
            typeof bio === "string" ? bio.trim() : "",
            typeof profile_picture === "string"
                ? profile_picture.trim()
                : "",
            req.session.userId
        );

        res.json({
            message: "Profile updated successfully."
        });

    } catch (error) {

        console.error("PROFILE UPDATE ERROR:", error);

        res.status(500).json({
            error: "Could not update profile."
        });
    }
});


// ============================================================
// ACCOUNT SETTINGS
// ============================================================

app.put("/api/me/email", requireLogin, (req, res) => {

    const email = typeof req.body.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    if (!/^\S+@\S+\.\S+$/.test(email)) {
        return res.status(400).json({
            error: "Enter a valid email address."
        });
    }

    try {

        const existing = db.prepare(`
            SELECT id FROM users
            WHERE email = ?
            AND id != ?
        `).get(email, req.session.userId);

        if (existing) {
            return res.status(409).json({
                error: "That email address is already in use."
            });
        }

        db.prepare(`
            UPDATE users SET email = ? WHERE id = ?
        `).run(email, req.session.userId);

        res.json({ message: "Email address updated.", email });

    } catch (error) {

        console.error("UPDATE EMAIL ERROR:", error);
        res.status(500).json({ error: "Could not update email." });
    }
});


app.put("/api/me/password", requireLogin, async (req, res) => {

    const currentPassword = typeof req.body.current_password === "string"
        ? req.body.current_password
        : "";

    const newPassword = typeof req.body.new_password === "string"
        ? req.body.new_password
        : "";

    if (!currentPassword || !newPassword) {
        return res.status(400).json({
            error: "Enter your current password and a new password."
        });
    }

    if (newPassword.length < 8) {
        return res.status(400).json({
            error: "New passwords must be at least 8 characters."
        });
    }

    try {

        const user = db.prepare(`
            SELECT password_hash FROM users WHERE id = ?
        `).get(req.session.userId);

        const matches = user && await bcrypt.compare(
            currentPassword,
            user.password_hash
        );

        if (!matches) {
            return res.status(401).json({
                error: "Your current password is incorrect."
            });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);

        db.prepare(`
            UPDATE users SET password_hash = ? WHERE id = ?
        `).run(passwordHash, req.session.userId);

        res.json({ message: "Password updated." });

    } catch (error) {

        console.error("UPDATE PASSWORD ERROR:", error);
        res.status(500).json({ error: "Could not update password." });
    }
});


// ============================================================
// NOTIFICATIONS
// ============================================================

app.get("/api/notifications", requireLogin, (req, res) => {

    try {

        const notifications = db.prepare(`
            SELECT id, type, title, message, link, is_read, created_at
            FROM notifications
            WHERE recipient_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 30
        `).all(req.session.userId);

        const unread = db.prepare(`
            SELECT COUNT(*) AS count
            FROM notifications
            WHERE recipient_id = ?
            AND is_read = 0
        `).get(req.session.userId).count;

        res.json({ notifications, unread });

    } catch (error) {

        console.error("NOTIFICATIONS ERROR:", error);
        res.status(500).json({
            error: "Could not load notifications."
        });
    }
});


app.post("/api/notifications/read", requireLogin, (req, res) => {

    try {

        db.prepare(`
            UPDATE notifications
            SET is_read = 1
            WHERE recipient_id = ?
            AND is_read = 0
        `).run(req.session.userId);

        res.json({ message: "Notifications marked as read." });

    } catch (error) {

        console.error("READ NOTIFICATIONS ERROR:", error);
        res.status(500).json({
            error: "Could not update notifications."
        });
    }
});


// ============================================================
// OWNER — ANNOUNCE TO EVERYONE
// ============================================================

app.post("/api/owner/announcements", requireOwner, (req, res) => {

    const title = typeof req.body.title === "string"
        ? req.body.title.trim()
        : "";

    const message = typeof req.body.message === "string"
        ? req.body.message.trim()
        : "";

    if (!title || !message) {
        return res.status(400).json({
            error: "An announcement needs both a title and a message."
        });
    }

    if (title.length > 120 || message.length > 1000) {
        return res.status(400).json({
            error: "Keep the title under 120 characters and the message under 1,000."
        });
    }

    try {

        const users = db.prepare(`
            SELECT id FROM users
        `).all();

        const insert = db.prepare(`
            INSERT INTO notifications (
                recipient_id, type, title, message, link
            ) VALUES (?, 'announcement', ?, ?, '')
        `);

        const announce = db.transaction(() => {
            users.forEach(user => insert.run(user.id, title, message));
        });

        announce();

        res.json({
            message: `Announcement sent to ${users.length} account${users.length === 1 ? "" : "s"}.`,
            recipient_count: users.length
        });

    } catch (error) {

        console.error("ANNOUNCEMENT ERROR:", error);
        res.status(500).json({
            error: "Could not send the announcement."
        });
    }
});


// ============================================================
// PUBLIC PROFILE
// ============================================================

app.get("/api/profile/:username", (req, res) => {

    try {

        const user = db.prepare(`
            SELECT
                id,
                username,
                profile_picture,
                bio,
                is_verified,
                role,
                created_at
            FROM users
            WHERE username = ?
        `).get(req.params.username);

        if (!user) {
            return res.status(404).json({
                error: "User not found."
            });
        }

        const articles = db.prepare(`
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
            WHERE author_id = ?
            AND status = 'approved'
            ORDER BY published_at DESC
        `).all(user.id);

        const followerCount = db.prepare(`
            SELECT COUNT(*) AS count
            FROM follows
            WHERE following_id = ?
        `).get(user.id).count;

        const followingCount = db.prepare(`
            SELECT COUNT(*) AS count
            FROM follows
            WHERE follower_id = ?
        `).get(user.id).count;

        let isFollowing = false;

        if (req.session.userId) {

            isFollowing = !!db.prepare(`
                SELECT id
                FROM follows
                WHERE follower_id = ?
                AND following_id = ?
            `).get(
                req.session.userId,
                user.id
            );
        }

        res.json({

            id: user.id,
            username: user.username,
            profile_picture: user.profile_picture,
            bio: user.bio,
            is_verified: user.is_verified === 1,
            role: user.role,
            created_at: user.created_at,

            article_count: articles.length,
            follower_count: followerCount,
            following_count: followingCount,

            is_following: isFollowing,

            articles
        });

    } catch (error) {

        console.error("PROFILE ERROR:", error);

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
    (req, res) => {

        try {

            const targetUser = db.prepare(`
                SELECT id, username
                FROM users
                WHERE username = ?
            `).get(req.params.username);

            if (!targetUser) {
                return res.status(404).json({
                    error: "User not found."
                });
            }

            if (
                targetUser.id ===
                req.session.userId
            ) {
                return res.status(400).json({
                    error: "You cannot follow yourself."
                });
            }

            db.prepare(`
                INSERT INTO follows
                (
                    follower_id,
                    following_id
                )
                VALUES (?, ?)
            `).run(
                req.session.userId,
                targetUser.id
            );

            const count = db.prepare(`
                SELECT COUNT(*) AS count
                FROM follows
                WHERE following_id = ?
            `).get(targetUser.id).count;

            res.json({
                message:
                    `You are now following ${targetUser.username}.`,
                is_following: true,
                follower_count: count
            });

        } catch (error) {

            if (
                error.code ===
                "SQLITE_CONSTRAINT_UNIQUE"
            ) {
                return res.status(409).json({
                    error: "You are already following this user."
                });
            }

            console.error("FOLLOW ERROR:", error);

            res.status(500).json({
                error: "Could not follow this user."
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
    (req, res) => {

        try {

            const targetUser = db.prepare(`
                SELECT id, username
                FROM users
                WHERE username = ?
            `).get(req.params.username);

            if (!targetUser) {
                return res.status(404).json({
                    error: "User not found."
                });
            }

            const result = db.prepare(`
                DELETE FROM follows
                WHERE follower_id = ?
                AND following_id = ?
            `).run(
                req.session.userId,
                targetUser.id
            );

            if (!result.changes) {
                return res.status(404).json({
                    error: "You are not following this user."
                });
            }

            const count = db.prepare(`
                SELECT COUNT(*) AS count
                FROM follows
                WHERE following_id = ?
            `).get(targetUser.id).count;

            res.json({
                message:
                    `You unfollowed ${targetUser.username}.`,
                is_following: false,
                follower_count: count
            });

        } catch (error) {

            console.error("UNFOLLOW ERROR:", error);

            res.status(500).json({
                error: "Could not unfollow this user."
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
    (req, res) => {

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
                error: "An article needs a headline."
            });
        }

        if (!body || !body.replace(/<[^>]*>/g, "").trim()) {
            return res.status(400).json({
                error: "Your article cannot be empty."
            });
        }

        const plainBody = body
            .replace(/<[^>]*>/g, "")
            .trim();

        if (plainBody.length < 30) {
            return res.status(400).json({
                error: "Your article needs more content."
            });
        }

        if (!category || !category.trim()) {
            return res.status(400).json({
                error: "Please select a category."
            });
        }

        try {

            const result = db.prepare(`
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
                    submitted_at,
                    updated_at
                )
                VALUES
                (?, ?, ?, ?, ?, ?, ?, 'pending',
                 CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP)
            `).run(
                req.session.userId,
                headline.trim(),
                summary ? summary.trim() : "",
                body,
                image || "",
                category.trim(),
                normalizeTags(tags).join(", ")
            );

            syncArticleTags(
                result.lastInsertRowid,
                tags
            );

            res.status(201).json({
                message:
                    "Article submitted for editorial review.",
                article_id:
                    result.lastInsertRowid,
                status: "pending"
            });

        } catch (error) {

            console.error(
                "ARTICLE SUBMISSION ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not submit your article."
            });
        }
    }
);


// ============================================================
// SAVE NEW DRAFT
// ============================================================

app.post(
    "/api/articles/draft",
    requireLogin,
    (req, res) => {

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

            const result = db.prepare(`
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
                    updated_at
                )
                VALUES
                (?, ?, ?, ?, ?, ?, ?, 'draft',
                 CURRENT_TIMESTAMP)
            `).run(
                req.session.userId,
                headline || "",
                summary || "",
                body || "",
                image || "",
                category || "",
                normalizedTags.join(", ")
            );

            syncArticleTags(
                result.lastInsertRowid,
                tags
            );

            res.status(201).json({
                message: "Draft saved.",
                article_id:
                    result.lastInsertRowid,
                status: "draft"
            });

        } catch (error) {

            console.error("DRAFT ERROR:", error);

            res.status(500).json({
                error: "Could not save your draft."
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
    (req, res) => {

        const {
            headline,
            summary,
            body,
            image,
            category,
            tags
        } = req.body;

        try {

            const article = db.prepare(`
                SELECT id, status
                FROM articles
                WHERE id = ?
                AND author_id = ?
            `).get(
                req.params.id,
                req.session.userId
            );

            if (!article) {
                return res.status(404).json({
                    error: "Draft not found."
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

            db.prepare(`
                UPDATE articles
                SET
                    headline = ?,
                    summary = ?,
                    body = ?,
                    image = ?,
                    category = ?,
                    tags = ?,
                    status = 'draft',
                    rejection_reason = '',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                AND author_id = ?
            `).run(
                headline || "",
                summary || "",
                body || "",
                image || "",
                category || "",
                normalizedTags.join(", "),
                req.params.id,
                req.session.userId
            );

            syncArticleTags(
                req.params.id,
                tags
            );

            res.json({
                message: "Draft updated.",
                article_id: Number(req.params.id),
                status: "draft"
            });

        } catch (error) {

            console.error(
                "UPDATE DRAFT ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not update draft."
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
    (req, res) => {

        try {

            const article = db.prepare(`
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
                WHERE id = ?
                AND author_id = ?
            `).get(
                req.params.id,
                req.session.userId
            );

            if (!article) {
                return res.status(404).json({
                    error: "Article not found."
                });
            }

            res.json(article);

        } catch (error) {

            console.error(
                "MY ARTICLE ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not load article."
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
    (req, res) => {

        try {

            const result = db.prepare(`
                DELETE FROM articles
                WHERE id = ?
                AND author_id = ?
                AND status IN ('draft', 'rejected', 'approved')
            `).run(
                req.params.id,
                req.session.userId
            );

            if (!result.changes) {
                return res.status(404).json({
                    error:
                        "Article not found or cannot be deleted."
                });
            }

            res.json({
                message: "Article deleted."
            });

        } catch (error) {

            console.error(
                "DELETE MY ARTICLE ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not delete article."
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
    (req, res) => {

        try {

            const articles = db.prepare(`
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
                WHERE author_id = ?
                ORDER BY created_at DESC
            `).all(req.session.userId);

            res.json(articles);

        } catch (error) {

            console.error(
                "MY ARTICLES ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not load your articles."
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
    (req, res) => {

        try {

            const articles = db.prepare(`
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
            `).all();

            res.json(articles);

        } catch (error) {

            console.error(
                "ADMIN SUBMISSIONS ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not load submissions."
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
    (req, res) => {

        try {

            const reviewer = getCurrentUser(req);
            const article = db.prepare(`
                SELECT articles.id, articles.author_id, articles.headline, users.role AS author_role
                FROM articles
                JOIN users ON users.id = articles.author_id
                WHERE articles.id = ?
                AND articles.status = 'pending'
            `).get(req.params.id);

            if (!article) {
                return res.status(404).json({
                    error: "Pending article not found."
                });
            }

            if (article.author_role !== "user" && reviewer.role !== "owner") {
                return res.status(403).json({
                    error: "Only the owner can approve an administrator's article."
                });
            }

            const result = db.prepare(`
                UPDATE articles
                SET
                    status = 'approved',
                    published_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP,
                    rejection_reason = ''
                WHERE id = ?
                AND status = 'pending'
            `).run(req.params.id);

            if (!result.changes) {
                return res.status(404).json({
                    error: "Pending article not found."
                });
            }

            createNotification(
                article.author_id,
                "approval",
                "Your article was approved",
                `“${article.headline}” was approved and published by ${reviewer.username}.`,
                `article.html?id=${article.id}`
            );

            res.json({
                message:
                    "Article approved and published.",
                status: "approved"
            });

        } catch (error) {

            console.error("APPROVE ERROR:", error);

            res.status(500).json({
                error: "Could not approve article."
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
    (req, res) => {

        const reason =
            req.body.reason
                ? req.body.reason.trim()
                : "";

        if (!reason) {
            return res.status(400).json({
                error: "Please provide a rejection reason."
            });
        }

        try {

            const reviewer = getCurrentUser(req);
            const article = db.prepare(`
                SELECT articles.id, articles.author_id, articles.headline, users.role AS author_role
                FROM articles
                JOIN users ON users.id = articles.author_id
                WHERE articles.id = ?
                AND articles.status = 'pending'
            `).get(req.params.id);

            if (!article) {
                return res.status(404).json({
                    error: "Pending article not found."
                });
            }

            if (reviewer.role !== "owner") {
                return res.status(403).json({
                    error: "Only the owner can reject submitted articles."
                });
            }

            const result = db.prepare(`
                UPDATE articles
                SET
                    status = 'rejected',
                    rejection_reason = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                AND status = 'pending'
            `).run(
                reason,
                req.params.id
            );

            if (!result.changes) {
                return res.status(404).json({
                    error: "Pending article not found."
                });
            }

            createNotification(
                article.author_id,
                "rejection",
                "Your article needs changes",
                `“${article.headline}” was rejected by the owner. Notes: ${reason}`,
                `write.html?edit=${article.id}`
            );

            res.json({
                message: "Article rejected.",
                status: "rejected"
            });

        } catch (error) {

            console.error("REJECT ERROR:", error);

            res.status(500).json({
                error: "Could not reject article."
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
    (req, res) => {

        try {

            const articles = db.prepare(`
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
            `).all();

            res.json(articles);

        } catch (error) {

            console.error(
                "ADMIN ALL ARTICLES ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not load articles."
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
    (req, res) => {

        try {

            const article = db.prepare(`
                SELECT id
                FROM articles
                WHERE id = ?
            `).get(req.params.id);

            if (!article) {
                return res.status(404).json({
                    error: "Article not found."
                });
            }

            db.prepare(`
                DELETE FROM articles
                WHERE id = ?
            `).run(req.params.id);

            res.json({
                message: "Article deleted."
            });

        } catch (error) {

            console.error(
                "DELETE ARTICLE ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not delete article."
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
    (req, res) => {

        try {

            const article = db.prepare(`
                SELECT id, status
                FROM articles
                WHERE id = ?
            `).get(req.params.id);

            if (!article) {
                return res.status(404).json({
                    error: "Article not found."
                });
            }

            if (article.status !== "approved") {
                return res.status(400).json({
                    error:
                        "Only approved articles can be featured."
                });
            }

            db.exec(`
                UPDATE articles
                SET featured = 0
                WHERE featured = 1
            `);

            db.prepare(`
                UPDATE articles
                SET
                    featured = 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(req.params.id);

            res.json({
                message: "Article is now featured.",
                featured: true
            });

        } catch (error) {

            console.error("FEATURE ERROR:", error);

            res.status(500).json({
                error: "Could not feature article."
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
    (req, res) => {

        try {

            const result = db.prepare(`
                UPDATE articles
                SET
                    featured = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(req.params.id);

            if (!result.changes) {
                return res.status(404).json({
                    error: "Article not found."
                });
            }

            res.json({
                message: "Article removed from Featured."
            });

        } catch (error) {

            console.error(
                "UNFEATURE ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not unfeature article."
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
    (req, res) => {

        try {

            const article = db.prepare(`
                SELECT id, status
                FROM articles
                WHERE id = ?
            `).get(req.params.id);

            if (!article) {
                return res.status(404).json({
                    error: "Article not found."
                });
            }

            if (article.status !== "approved") {
                return res.status(400).json({
                    error:
                        "Only approved articles can be placed on the homepage."
                });
            }

            db.prepare(`
                UPDATE articles
                SET
                    homepage_card = 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(req.params.id);

            res.json({
                message:
                    "Article added to homepage cards.",
                homepage_card: true
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
    (req, res) => {

        try {

            const result = db.prepare(`
                UPDATE articles
                SET
                    homepage_card = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(req.params.id);

            if (!result.changes) {
                return res.status(404).json({
                    error: "Article not found."
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
    (req, res) => {

        try {

            const currentUser = getCurrentUser(req);

            const users = db.prepare(`
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
            `).all();

            res.json({
                current_user_id: currentUser.id,
                users
            });

        } catch (error) {

            console.error(
                "ADMIN USERS ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not load users."
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
    (req, res) => {

        try {

            const user = db.prepare(`
                SELECT
                    id,
                    username,
                    role
                FROM users
                WHERE id = ?
            `).get(req.params.id);

            if (!user) {
                return res.status(404).json({
                    error: "User not found."
                });
            }

            if (user.role === "owner") {
                return res.status(400).json({
                    error:
                        "The owner cannot be modified this way."
                });
            }

            db.prepare(`
                UPDATE users
                SET
                    role = 'admin',
                    is_admin = 1
                WHERE id = ?
            `).run(req.params.id);

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
                error: "Could not promote user."
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
    (req, res) => {

        try {

            const user = db.prepare(`
                SELECT
                    id,
                    username,
                    role
                FROM users
                WHERE id = ?
            `).get(req.params.id);

            if (!user) {
                return res.status(404).json({
                    error: "User not found."
                });
            }

            if (user.role === "owner") {
                return res.status(400).json({
                    error: "The owner cannot be demoted."
                });
            }

            db.prepare(`
                UPDATE users
                SET
                    role = 'user',
                    is_admin = 0
                WHERE id = ?
            `).run(req.params.id);

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
                error: "Could not demote user."
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
    (req, res) => {

        try {

            const user = db.prepare(`
                SELECT id, username
                FROM users
                WHERE id = ?
            `).get(req.params.id);

            if (!user) {
                return res.status(404).json({
                    error: "User not found."
                });
            }

            db.prepare(`
                UPDATE users
                SET is_verified = 1
                WHERE id = ?
            `).run(req.params.id);

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
                error: "Could not verify user."
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
    (req, res) => {

        try {

            const user = db.prepare(`
                SELECT id, username
                FROM users
                WHERE id = ?
            `).get(req.params.id);

            if (!user) {
                return res.status(404).json({
                    error: "User not found."
                });
            }

            db.prepare(`
                UPDATE users
                SET is_verified = 0
                WHERE id = ?
            `).run(req.params.id);

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
                error: "Could not remove verification."
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
    (req, res) => {

        try {

            const currentUser = getCurrentUser(req);

            const targetUser = db.prepare(`
                SELECT
                    id,
                    username,
                    role
                FROM users
                WHERE id = ?
            `).get(req.params.id);

            if (!targetUser) {
                return res.status(404).json({
                    error: "User not found."
                });
            }

            if (
                targetUser.id ===
                currentUser.id
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

            db.prepare(`
                DELETE FROM users
                WHERE id = ?
            `).run(targetUser.id);

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
                error: "Could not delete user."
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

app.get("/api/homepage", (req, res) => {

    try {

        // --------------------------------------------------------
        // 1. Try the manually selected featured article.
        // --------------------------------------------------------

        let featured = db.prepare(`
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
        `).get();


        // --------------------------------------------------------
        // 2. Get manually selected homepage cards.
        // --------------------------------------------------------

        let cards = db.prepare(`
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
        `).all();


        // --------------------------------------------------------
        // 3. FALLBACK
        //
        // If the owner hasn't selected anything for the homepage
        // yet, automatically use the newest approved articles.
        // --------------------------------------------------------

        if (!featured && cards.length === 0) {

            const approvedArticles = db.prepare(`
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
            `).all();


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

            cards = db.prepare(`
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
                AND articles.id != ?

                ORDER BY
                    COALESCE(
                        articles.published_at,
                        articles.created_at
                    ) DESC

                LIMIT 6
            `).all(featured.id);

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

app.get("/api/articles/:id", (req, res) => {

    try {

        const article = db.prepare(`
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

            WHERE articles.id = ?
            AND articles.status = 'approved'
        `).get(req.params.id);

        if (!article) {
            return res.status(404).json({
                error: "Article not found."
            });
        }


        // ========================================================
        // ARTICLE VOTES
        // ========================================================

        const voteCounts = db.prepare(`
            SELECT
                COALESCE(
                    SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END),
                    0
                ) AS likes,

                COALESCE(
                    SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END),
                    0
                ) AS dislikes

            FROM article_votes

            WHERE article_id = ?
        `).get(req.params.id);


        let userVote = 0;
        let isSaved = false;


        if (req.session.userId) {

            const vote = db.prepare(`
                SELECT vote
                FROM article_votes
                WHERE article_id = ?
                AND user_id = ?
            `).get(
                req.params.id,
                req.session.userId
            );

            if (vote) {
                userVote = vote.vote;
            }


            isSaved = !!db.prepare(`
                SELECT id
                FROM saved_articles
                WHERE article_id = ?
                AND user_id = ?
            `).get(
                req.params.id,
                req.session.userId
            );
        }


        // ========================================================
        // COMMENTS
        // ========================================================

        const comments = db.prepare(`
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

            WHERE comments.article_id = ?

            ORDER BY comments.created_at ASC
        `).all(req.params.id);


        // ========================================================
        // ADD REACTIONS / VOTES TO EVERY COMMENT
        // ========================================================

        for (const comment of comments) {

            const reactionData =
                getCommentReactionData(
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

            likes: voteCounts.likes,
            dislikes: voteCounts.dislikes,

            user_vote: userVote,
            is_saved: isSaved,

            comments

        });

    } catch (error) {

        console.error(
            "PUBLIC ARTICLE ERROR:",
            error
        );

        res.status(500).json({
            error: "Could not load article."
        });
    }
});


// ============================================================
// ARTICLE VOTE
// ============================================================

app.post(
    "/api/articles/:id/vote",
    requireLogin,
    (req, res) => {

        const vote = Number(req.body.vote);

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

            const article = db.prepare(`
                SELECT id
                FROM articles
                WHERE id = ?
                AND status = 'approved'
            `).get(req.params.id);

            if (!article) {
                return res.status(404).json({
                    error: "Article not found."
                });
            }

            const existing = db.prepare(`
                SELECT id, vote
                FROM article_votes
                WHERE article_id = ?
                AND user_id = ?
            `).get(
                req.params.id,
                req.session.userId
            );

            if (vote === 0) {

                if (existing) {
                    db.prepare(`
                        DELETE FROM article_votes
                        WHERE id = ?
                    `).run(existing.id);
                }

            } else if (existing) {

                db.prepare(`
                    UPDATE article_votes
                    SET vote = ?
                    WHERE id = ?
                `).run(
                    vote,
                    existing.id
                );

            } else {

                db.prepare(`
                    INSERT INTO article_votes
                    (
                        article_id,
                        user_id,
                        vote
                    )
                    VALUES (?, ?, ?)
                `).run(
                    req.params.id,
                    req.session.userId,
                    vote
                );
            }

            const counts = db.prepare(`
                SELECT
                    COALESCE(
                        SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END),
                        0
                    ) AS likes,

                    COALESCE(
                        SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END),
                        0
                    ) AS dislikes

                FROM article_votes

                WHERE article_id = ?
            `).get(req.params.id);

            res.json({
                likes: counts.likes,
                dislikes: counts.dislikes,
                user_vote: vote
            });

        } catch (error) {

            console.error(
                "VOTE ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not save vote."
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
    (req, res) => {

        try {

            const article = db.prepare(`
                SELECT id
                FROM articles
                WHERE id = ?
                AND status = 'approved'
            `).get(req.params.id);

            if (!article) {
                return res.status(404).json({
                    error: "Article not found."
                });
            }

            db.prepare(`
                INSERT OR IGNORE INTO saved_articles
                (
                    article_id,
                    user_id
                )
                VALUES (?, ?)
            `).run(
                req.params.id,
                req.session.userId
            );

            res.json({
                message: "Article saved.",
                is_saved: true
            });

        } catch (error) {

            console.error(
                "SAVE ARTICLE ERROR:",
                error
            );

            res.status(500).json({
                error: "Could not save article."
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
    (req, res) => {

        try {

            db.prepare(`
                DELETE FROM saved_articles
                WHERE article_id = ?
                AND user_id = ?
            `).run(
                req.params.id,
                req.session.userId
            );

            res.json({
                message: "Article removed from saved articles.",
                is_saved: false
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
    (req, res) => {

        try {

            const articles = db.prepare(`
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

                    saved_articles.created_at AS saved_at

                FROM saved_articles

                JOIN articles
                ON articles.id = saved_articles.article_id

                JOIN users
                ON users.id = articles.author_id

                WHERE saved_articles.user_id = ?
                AND articles.status = 'approved'

                ORDER BY saved_articles.created_at DESC
            `).all(req.session.userId);

            res.json(articles);

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

function getCommentReactionData(
    commentId,
    userId = null
) {

    const reactions = db.prepare(`
        SELECT
            reaction,
            COUNT(*) AS count
        FROM comment_reactions
        WHERE comment_id = ?
        GROUP BY reaction
        ORDER BY count DESC
    `).all(commentId);


    const votes = db.prepare(`
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

        WHERE comment_id = ?
    `).get(commentId);


    let userReaction = null;
    let userVote = 0;


    if (userId) {

        const reaction = db.prepare(`
            SELECT reaction
            FROM comment_reactions
            WHERE comment_id = ?
            AND user_id = ?
        `).get(
            commentId,
            userId
        );


        if (reaction) {
            userReaction = reaction.reaction;
        }


        const vote = db.prepare(`
            SELECT vote
            FROM comment_votes
            WHERE comment_id = ?
            AND user_id = ?
        `).get(
            commentId,
            userId
        );


        if (vote) {
            userVote = vote.vote;
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

function deleteCommentTree(commentId) {

    const ids = [];

    const collect = (id) => {

        ids.push(id);

        const children = db.prepare(`
            SELECT id
            FROM comments
            WHERE parent_id = ?
        `).all(id);

        for (const child of children) {
            collect(child.id);
        }
    };


    collect(commentId);


    const transaction = db.transaction(() => {

        for (const id of ids) {

            db.prepare(`
                DELETE FROM comment_reactions
                WHERE comment_id = ?
            `).run(id);


            db.prepare(`
                DELETE FROM comment_votes
                WHERE comment_id = ?
            `).run(id);


            db.prepare(`
                DELETE FROM comments
                WHERE id = ?
            `).run(id);

        }

    });


    transaction();

}


// ============================================================
// POST COMMENT
// ============================================================

app.post(
    "/api/articles/:id/comments",
    requireLogin,
    (req, res) => {

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

            const article = db.prepare(`
                SELECT id
                FROM articles
                WHERE id = ?
                AND status = 'approved'
            `).get(req.params.id);


            if (!article) {
                return res.status(404).json({
                    error:
                        "Article not found."
                });
            }


            if (parentId) {

                const parent = db.prepare(`
                    SELECT id
                    FROM comments
                    WHERE id = ?
                    AND article_id = ?
                `).get(
                    parentId,
                    req.params.id
                );


                if (!parent) {
                    return res.status(400).json({
                        error:
                            "Parent comment not found."
                    });
                }

            }


            const result = db.prepare(`
                INSERT INTO comments
                (
                    article_id,
                    user_id,
                    parent_id,
                    body
                )
                VALUES (?, ?, ?, ?)
            `).run(
                req.params.id,
                req.session.userId,
                parentId,
                body
            );


            const comment = db.prepare(`
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

                WHERE comments.id = ?
            `).get(
                result.lastInsertRowid
            );


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
    (req, res) => {

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

            const comment = db.prepare(`
                SELECT id
                FROM comments
                WHERE id = ?
            `).get(req.params.id);


            if (!comment) {
                return res.status(404).json({
                    error:
                        "Comment not found."
                });
            }


            const existing = db.prepare(`
                SELECT
                    id,
                    reaction
                FROM comment_reactions
                WHERE comment_id = ?
                AND user_id = ?
            `).get(
                req.params.id,
                req.session.userId
            );


            if (existing) {

                if (
                    existing.reaction === reaction
                ) {

                    db.prepare(`
                        DELETE FROM comment_reactions
                        WHERE id = ?
                    `).run(existing.id);

                } else {

                    db.prepare(`
                        UPDATE comment_reactions
                        SET
                            reaction = ?,
                            created_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(
                        reaction,
                        existing.id
                    );

                }

            } else {

                db.prepare(`
                    INSERT INTO comment_reactions
                    (
                        comment_id,
                        user_id,
                        reaction
                    )
                    VALUES (?, ?, ?)
                `).run(
                    req.params.id,
                    req.session.userId,
                    reaction
                );

            }


            const data =
                getCommentReactionData(
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
    (req, res) => {

        try {

            db.prepare(`
                DELETE FROM comment_reactions
                WHERE comment_id = ?
                AND user_id = ?
            `).run(
                req.params.id,
                req.session.userId
            );


            const data =
                getCommentReactionData(
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
    (req, res) => {

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

            const comment = db.prepare(`
                SELECT id
                FROM comments
                WHERE id = ?
            `).get(req.params.id);


            if (!comment) {
                return res.status(404).json({
                    error:
                        "Comment not found."
                });
            }


            const existing = db.prepare(`
                SELECT
                    id,
                    vote
                FROM comment_votes
                WHERE comment_id = ?
                AND user_id = ?
            `).get(
                req.params.id,
                req.session.userId
            );


            if (vote === 0) {

                if (existing) {

                    db.prepare(`
                        DELETE FROM comment_votes
                        WHERE id = ?
                    `).run(existing.id);

                }

            } else if (existing) {

                if (existing.vote === vote) {

                    db.prepare(`
                        DELETE FROM comment_votes
                        WHERE id = ?
                    `).run(existing.id);

                } else {

                    db.prepare(`
                        UPDATE comment_votes
                        SET vote = ?
                        WHERE id = ?
                    `).run(
                        vote,
                        existing.id
                    );

                }

            } else {

                db.prepare(`
                    INSERT INTO comment_votes
                    (
                        comment_id,
                        user_id,
                        vote
                    )
                    VALUES (?, ?, ?)
                `).run(
                    req.params.id,
                    req.session.userId,
                    vote
                );

            }


            const data =
                getCommentReactionData(
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
    (req, res) => {

        try {

            const comment = db.prepare(`
                SELECT
                    id,
                    user_id
                FROM comments
                WHERE id = ?
            `).get(req.params.id);


            if (!comment) {
                return res.status(404).json({
                    error:
                        "Comment not found."
                });
            }


            if (
                comment.user_id !==
                req.session.userId
            ) {
                return res.status(403).json({
                    error:
                        "You can only delete your own comments."
                });
            }


            deleteCommentTree(
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
    (req, res) => {

        try {

            const comment = db.prepare(`
                SELECT id
                FROM comments
                WHERE id = ?
            `).get(req.params.id);


            if (!comment) {
                return res.status(404).json({
                    error:
                        "Comment not found."
                });
            }


            deleteCommentTree(
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

app.get("/api/tags", (req, res) => {

    try {

        const tags = db.prepare(`
            SELECT
                tags.id,
                tags.name,
                COUNT(article_tags.article_id) AS article_count

            FROM tags

            LEFT JOIN article_tags
            ON article_tags.tag_id = tags.id

            GROUP BY tags.id

            ORDER BY article_count DESC, tags.name ASC
        `).all();

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

app.get("/api/tags/:tag", (req, res) => {

    try {

        const articles = db.prepare(`
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

            WHERE tags.name = ?
            AND articles.status = 'approved'

            ORDER BY articles.published_at DESC
        `).all(
            req.params.tag.toLowerCase()
        );

        res.json(articles);

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

app.get("/api/search", (req, res) => {

    const query =
        req.query.q
            ? req.query.q.trim()
            : "";

    if (!query) {
        return res.json({
            articles: [],
            users: [],
            tags: []
        });
    }

    try {

        const pattern = `%${query}%`;

        const articles = db.prepare(`
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
                articles.headline LIKE ?
                OR articles.summary LIKE ?
                OR articles.body LIKE ?
                OR articles.category LIKE ?
                OR articles.tags LIKE ?
            )

            ORDER BY articles.published_at DESC

            LIMIT 50
        `).all(
            pattern,
            pattern,
            pattern,
            pattern,
            pattern
        );


        const users = db.prepare(`
            SELECT
                id,
                username,
                profile_picture,
                bio,
                is_verified,
                role

            FROM users

            WHERE username LIKE ?
            OR bio LIKE ?

            ORDER BY username ASC

            LIMIT 50
        `).all(
            pattern,
            pattern
        );


        const tags = db.prepare(`
            SELECT
                id,
                name

            FROM tags

            WHERE name LIKE ?

            ORDER BY name ASC

            LIMIT 50
        `).all(pattern);


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
                error: "Could not log out."
            });
        }

        res.json({
            message: "Logged out successfully."
        });
    });
});


// ============================================================
// SERVER STATUS
// ============================================================

app.get("/api/status", (req, res) => {

    res.json({
        status: "online",
        database: "connected",
        site: "Cataclysm Colony",
        version: "full-newsroom-v3-comments"
    });
});


// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    () => {

        console.log("");
        console.log("========================================");
        console.log("       Cataclysm Colony ONLINE");
        console.log("========================================");
        console.log(
            `http://127.0.0.1:${PORT}`
        );
        console.log("");
        console.log("Authentication:       ONLINE");
        console.log("Articles:             ONLINE");
        console.log("Editorial:            ONLINE");
        console.log("Profiles:             ONLINE");
        console.log("Following:            ONLINE");
        console.log("Votes:                ONLINE");
        console.log("Saved:                ONLINE");
        console.log("Comments:             ONLINE");
        console.log("Comment reactions:    ONLINE");
        console.log("Comment votes:        ONLINE");
        console.log("Tags:                 ONLINE");
        console.log("Search:               ONLINE");
        console.log("Owner:                alexandria201999");
        console.log("========================================");
        console.log("");
    }
);
