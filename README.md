# Cataclysm Colony

Cataclysm Colony is an Express and PostgreSQL editorial site. Production content, accounts, sessions, rate limits, verification codes, and newsroom messages live in PostgreSQL. New user and article images are stored with Cloudinary; the app never writes uploads to its local filesystem.

## Production setup

1. Use Node.js 20 or newer and a hosted PostgreSQL service. Set `DATABASE_URL` to the provider's TLS connection string; the server refuses to fall back to a local database.
2. Configure every variable in `.env.example` in the hosting provider's secret/environment settings. Generate independent random values for `SESSION_SECRET`, `PASSWORD_CODE_SECRET`, and `NEWSROOM_CHAT_KEY`. Keep the chat key stable: changing it makes previously stored chat messages unreadable.
3. Email is optional at launch. Until `RESEND_API_KEY` and a verified sender in `EMAIL_FROM` are configured, password change and recovery code requests safely report that email delivery is unavailable. Once configured, codes are sent through Resend; the app never prints codes to logs or returns them to the browser.
4. Configure Cloudinary credentials. Profile pictures, article images, and owner broadcast images are saved as hosted HTTPS URLs; production startup fails if required providers or encryption keys are missing.
5. Deploy with `npm start`. The server creates and safely extends the PostgreSQL schema at startup, promotes the existing `alexandria201999` account to Owner, and refuses production HTTP by redirecting requests to HTTPS.

Do not deploy `.env`, database backups, or `node_modules`. Do not use the server's local `uploads` directory for new user content.

## Roles and private newsroom

Only the Owner can grant or revoke Admin. Admin and Owner routes enforce their roles on the server. Newsroom chat endpoints require Admin or Owner and store messages using AES-256-GCM with `NEWSROOM_CHAT_KEY`; production HTTPS protects messages in transit. Viewer routes do not expose chat access.

## Checks

Run `npm test` for the security and route-guard tests. The PostgreSQL schema is applied additively during startup, including persistent sessions, password verification codes, and encrypted newsroom messages.
