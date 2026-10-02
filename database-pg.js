require("dotenv").config();

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Configure hosted PostgreSQL before starting Cataclysm Colony.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    max: Number(process.env.PG_POOL_SIZE || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
    console.error("NEON DATABASE ERROR:", error);
});

async function query(text, params = []) {
    return pool.query(text, params);
}

async function initializeDatabase() {
    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT,
            profile_picture TEXT,
            bio TEXT DEFAULT '',
            role TEXT NOT NULL DEFAULT 'user',
            is_admin INTEGER DEFAULT 0,
            is_verified INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS articles (
            id SERIAL PRIMARY KEY,
            author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            submitted_at TIMESTAMP,
            published_at TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS article_votes (
            id SERIAL PRIMARY KEY,
            article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            vote INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(article_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS saved_articles (
            id SERIAL PRIMARY KEY,
            article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(article_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS follows (
            id SERIAL PRIMARY KEY,
            follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(follower_id, following_id)
        );

        CREATE TABLE IF NOT EXISTS tags (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS article_tags (
            article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            UNIQUE(article_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL DEFAULT 'system',
            title TEXT NOT NULL,
            message TEXT DEFAULT '',
            link TEXT DEFAULT '',
            image_url TEXT DEFAULT '',
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        ALTER TABLE notifications ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';

        CREATE TABLE IF NOT EXISTS app_sessions (
            sid TEXT PRIMARY KEY,
            sess JSONB NOT NULL,
            expire TIMESTAMP NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_app_sessions_expire ON app_sessions(expire);

        CREATE TABLE IF NOT EXISTS password_verification_codes (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            purpose TEXT NOT NULL CHECK (purpose IN ('change', 'recovery')),
            code_hash TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            expires_at TIMESTAMP NOT NULL,
            used_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_password_codes_user_purpose
            ON password_verification_codes(user_id, purpose, created_at DESC);

        CREATE TABLE IF NOT EXISTS password_recovery_codes (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            code_hash TEXT NOT NULL,
            used_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_password_recovery_codes_user
            ON password_recovery_codes(user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS newsroom_messages (
            id BIGSERIAL PRIMARY KEY,
            sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            ciphertext TEXT NOT NULL,
            iv TEXT NOT NULL,
            auth_tag TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_newsroom_messages_created
            ON newsroom_messages(created_at DESC);

        CREATE TABLE IF NOT EXISTS rate_limit_buckets (
            bucket_key TEXT PRIMARY KEY,
            hits INTEGER NOT NULL,
            window_started_at TIMESTAMP NOT NULL,
            blocked_until TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS comment_reactions (
            id SERIAL PRIMARY KEY,
            comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reaction TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(comment_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS comment_votes (
            id SERIAL PRIMARY KEY,
            comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            vote INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(comment_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_articles_author
            ON articles(author_id);

        CREATE INDEX IF NOT EXISTS idx_articles_status
            ON articles(status);

        CREATE INDEX IF NOT EXISTS idx_articles_published
            ON articles(published_at);

        CREATE INDEX IF NOT EXISTS idx_comments_article
            ON comments(article_id);

        CREATE INDEX IF NOT EXISTS idx_follows_follower
            ON follows(follower_id);

        CREATE INDEX IF NOT EXISTS idx_follows_following
            ON follows(following_id);

        CREATE INDEX IF NOT EXISTS idx_users_role
            ON users(role);

        CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username_lower
            ON users (LOWER(username));

        CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower
            ON users (LOWER(email));
    `);

    await query("DELETE FROM app_sessions WHERE expire <= CURRENT_TIMESTAMP");
    await query("DELETE FROM password_verification_codes WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days'");
    await query("DELETE FROM rate_limit_buckets WHERE window_started_at < CURRENT_TIMESTAMP - INTERVAL '24 hours'");

    console.log("NEON DATABASE SCHEMA READY");
}

module.exports = {
    pool,
    query,
    initializeDatabase
};
