const Database = require("better-sqlite3");

const db = new Database("cataclysm_calumny.db");

db.pragma("foreign_keys = ON");


// ============================================================
// USERS
// ============================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,

        password_hash TEXT,

        profile_picture TEXT,
        bio TEXT DEFAULT '',

        role TEXT NOT NULL DEFAULT 'user',
        is_admin INTEGER DEFAULT 0,
        is_verified INTEGER DEFAULT 0,

        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);


// ============================================================
// USER ROLE MIGRATION
// ============================================================

const userColumns = db
    .prepare(`PRAGMA table_info(users)`)
    .all()
    .map(column => column.name);


// Add role to older databases

if (!userColumns.includes("role")) {

    db.exec(`
        ALTER TABLE users
        ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
    `);

    console.log("Added users.role");

}


// ============================================================
// SYNC OLD is_admin DATA WITH NEW ROLE SYSTEM
// ============================================================

// Existing administrators become admins.
// Existing normal users remain users.

db.exec(`
    UPDATE users
    SET role = 'admin'
    WHERE is_admin = 1
    AND role = 'user';
`);


// ============================================================
// ARTICLES
// ============================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        author_id INTEGER NOT NULL,

        headline TEXT NOT NULL,
        summary TEXT DEFAULT '',
        body TEXT NOT NULL,

        image TEXT DEFAULT '',

        category TEXT DEFAULT '',
        tags TEXT DEFAULT '',

        status TEXT DEFAULT 'draft',

        rejection_reason TEXT DEFAULT '',

        featured INTEGER DEFAULT 0,
        homepage_card INTEGER DEFAULT 0,

        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        submitted_at DATETIME,
        published_at DATETIME,

        FOREIGN KEY (author_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    );
`);


// ============================================================
// ARTICLE DATABASE MIGRATION
// ============================================================

const articleColumns = db
    .prepare(`PRAGMA table_info(articles)`)
    .all()
    .map(column => column.name);


// ------------------------------------------------------------
// CATEGORY
// ------------------------------------------------------------

if (!articleColumns.includes("category")) {

    db.exec(`
        ALTER TABLE articles
        ADD COLUMN category TEXT DEFAULT '';
    `);

    console.log("Added articles.category");

}


// ------------------------------------------------------------
// TAGS
// ------------------------------------------------------------

if (!articleColumns.includes("tags")) {

    db.exec(`
        ALTER TABLE articles
        ADD COLUMN tags TEXT DEFAULT '';
    `);

    console.log("Added articles.tags");

}


// ------------------------------------------------------------
// SUMMARY
// ------------------------------------------------------------

if (!articleColumns.includes("summary")) {

    db.exec(`
        ALTER TABLE articles
        ADD COLUMN summary TEXT DEFAULT '';
    `);

    console.log("Added articles.summary");

}


// ------------------------------------------------------------
// REJECTION REASON
// ------------------------------------------------------------

if (!articleColumns.includes("rejection_reason")) {

    db.exec(`
        ALTER TABLE articles
        ADD COLUMN rejection_reason TEXT DEFAULT '';
    `);

    console.log("Added articles.rejection_reason");

}


// ------------------------------------------------------------
// UPDATED AT
// ------------------------------------------------------------

if (!articleColumns.includes("updated_at")) {

    db.exec(`
        ALTER TABLE articles
        ADD COLUMN updated_at DATETIME;
    `);

    db.exec(`
        UPDATE articles
        SET updated_at = CURRENT_TIMESTAMP
        WHERE updated_at IS NULL;
    `);

    console.log("Added articles.updated_at");

}


// ------------------------------------------------------------
// SUBMITTED AT
// ------------------------------------------------------------

if (!articleColumns.includes("submitted_at")) {

    db.exec(`
        ALTER TABLE articles
        ADD COLUMN submitted_at DATETIME;
    `);

    console.log("Added articles.submitted_at");

}


// ------------------------------------------------------------
// PUBLISHED AT
// ------------------------------------------------------------

if (!articleColumns.includes("published_at")) {

    db.exec(`
        ALTER TABLE articles
        ADD COLUMN published_at DATETIME;
    `);

    console.log("Added articles.published_at");

}


// ------------------------------------------------------------
// FEATURED
// ------------------------------------------------------------

if (!articleColumns.includes("featured")) {

    db.exec(`
        ALTER TABLE articles
        ADD COLUMN featured INTEGER DEFAULT 0;
    `);

    console.log("Added articles.featured");

}


// ------------------------------------------------------------
// HOMEPAGE CARD
// ------------------------------------------------------------

if (!articleColumns.includes("homepage_card")) {

    db.exec(`
        ALTER TABLE articles
        ADD COLUMN homepage_card INTEGER DEFAULT 0;
    `);

    console.log("Added articles.homepage_card");

}


// ============================================================
// COMMENTS
// ============================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        article_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        parent_id INTEGER,

        body TEXT NOT NULL,

        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (article_id)
            REFERENCES articles(id)
            ON DELETE CASCADE,

        FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE CASCADE,

        FOREIGN KEY (parent_id)
            REFERENCES comments(id)
            ON DELETE CASCADE
    );
`);


// ============================================================
// ARTICLE VOTES
// ============================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS article_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        article_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,

        vote INTEGER NOT NULL,

        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        UNIQUE(article_id, user_id),

        FOREIGN KEY (article_id)
            REFERENCES articles(id)
            ON DELETE CASCADE,

        FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    );
`);


// ============================================================
// SAVED ARTICLES
// ============================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS saved_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        article_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,

        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        UNIQUE(article_id, user_id),

        FOREIGN KEY (article_id)
            REFERENCES articles(id)
            ON DELETE CASCADE,

        FOREIGN KEY (user_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    );
`);


// ============================================================
// FOLLOWS
// ============================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS follows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        follower_id INTEGER NOT NULL,
        following_id INTEGER NOT NULL,

        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        UNIQUE(follower_id, following_id),

        FOREIGN KEY (follower_id)
            REFERENCES users(id)
            ON DELETE CASCADE,

        FOREIGN KEY (following_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    );
`);


// ============================================================
// TAGS
// ============================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        name TEXT NOT NULL UNIQUE
    );
`);


// ============================================================
// ARTICLE ↔ TAG RELATIONSHIP
// ============================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS article_tags (
        article_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,

        UNIQUE(article_id, tag_id),

        FOREIGN KEY (article_id)
            REFERENCES articles(id)
            ON DELETE CASCADE,

        FOREIGN KEY (tag_id)
            REFERENCES tags(id)
            ON DELETE CASCADE
    );
`);


// ============================================================
// NOTIFICATIONS
// ============================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        recipient_id INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'system',
        title TEXT NOT NULL,
        message TEXT DEFAULT '',
        link TEXT DEFAULT '',
        is_read INTEGER NOT NULL DEFAULT 0,

        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (recipient_id)
            REFERENCES users(id)
            ON DELETE CASCADE
    );
`);


// ============================================================
// INDEXES
// ============================================================

db.exec(`
    CREATE INDEX IF NOT EXISTS idx_articles_author
    ON articles(author_id);

    CREATE INDEX IF NOT EXISTS idx_articles_status
    ON articles(status);

    CREATE INDEX IF NOT EXISTS idx_articles_published
    ON articles(published_at);

    CREATE INDEX IF NOT EXISTS idx_articles_featured
    ON articles(featured);

    CREATE INDEX IF NOT EXISTS idx_articles_homepage
    ON articles(homepage_card);

    CREATE INDEX IF NOT EXISTS idx_comments_article
    ON comments(article_id);

    CREATE INDEX IF NOT EXISTS idx_follows_follower
    ON follows(follower_id);

    CREATE INDEX IF NOT EXISTS idx_follows_following
    ON follows(following_id);

    CREATE INDEX IF NOT EXISTS idx_article_tags_article
    ON article_tags(article_id);

    CREATE INDEX IF NOT EXISTS idx_article_tags_tag
    ON article_tags(tag_id);

    CREATE INDEX IF NOT EXISTS idx_users_role
    ON users(role);
`);


// ============================================================
// READY
// ============================================================

console.log("========================================");
console.log("   Cataclysm Colony DATABASE READY");
console.log("========================================");

console.log("Roles:");
console.log("  OWNER");
console.log("  ADMIN");
console.log("  USER");

console.log("Editorial controls:");
console.log("  FEATURED ARTICLES");
console.log("  HOMEPAGE CARDS");

console.log("========================================");


module.exports = db;
