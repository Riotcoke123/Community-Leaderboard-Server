# Community Leaderboard Server

A high-performance Node.js + Express backend that aggregates posts from multiple communities,
calculates weighted scores, and builds a live leaderboard using SQLite. Includes a
password-protected admin panel with a safe, self-validating update system for deploying
code changes without SSH access.

---

## Features

- Auto-fetch posts from configured communities
- Custom score calculation (score × 3.14)
- Live aggregated leaderboard per author
- SQLite database with WAL mode
- Auto-refresh every 70 seconds
- Automatic DB backups every 6 hours
- Author tracking + eviction system
- Secure admin API with secret auth (header-based, for scripts/automation)
- **Admin panel** with session-based login (browser UI)
- **Self-update system** — upload a zip from the admin panel and deploy it live, with
  automatic backup, validation, and rollback on failure
- Security hardening (Helmet, CORS, rate limits, CSP)

---

## Project Structure

```
.
├── server.js
├── package.json
├── .env
├── .gitignore
├── views/
│   ├── admin.html            # admin panel (session-gated)
│   └── admin-login.html      # admin login form
├── public/
│   ├── index.html
│   ├── css/style.css
│   ├── js/leaderboard.js
│   └── admin/
│       ├── admin.css
│       ├── admin.js
│       └── login.js
├── updates/pending/          # transient — staged uploads awaiting apply (gitignored)
├── backups/                  # DB backups + code backups (gitignored)
└── leaderboard.db            # SQLite database (gitignored)
```

---

## Environment Variables

```
PORT=3001
DB_PATH=./leaderboard.db
ADMIN_SECRET=your_super_secure_admin_secret
COMMUNITY=community1,community2
API_BASE_URL=https://example.com/api/posts
X_API_KEY=your_key
X_API_PLATFORM=your_platform
X_API_SECRET=your_secret
X_XSRF_TOKEN=your_token
CORS_ORIGINS=http://localhost:3000,https://yourdomain.com
BACKUP_DIR=./backups
```

`ADMIN_SECRET` doubles as both the `X-Admin-Secret` header value for scripted API access
**and** the admin panel login password. It must be at least 16 characters — the server
refuses to start otherwise. Use a long, random value and don't reuse it elsewhere.

---

## Running the Server

```
npm install
node server.js
```

Dev mode:

```
npx nodemon server.js
```

---

## Public API Endpoints

### GET /api/leaderboard

Returns ranked authors by score.

```json
[
  {
    "author": "user123",
    "original_score": 120,
    "calculated_score": 377,
    "post_count": 15,
    "last_active_ago": "2 hours ago"
  }
]
```

### GET /api/stats

```json
{
  "totalPosts": 1200,
  "totalAuthors": 85,
  "authorCap": 500
}
```

---

## Admin API (header auth)

Send `X-Admin-Secret: your_secret` on each request. Useful for scripts, cron jobs, or
CI — no browser session required.

- `GET  /api/authors`
- `POST /api/refresh`
- `POST /api/reset`
- `POST /api/nuke`
- `POST /api/backup`
- `GET  /api/backup/download/db`
- `GET  /api/backup/download/json`

---

## Admin Panel (browser)

Visit `/admin/login` and sign in with `ADMIN_SECRET` as the password. This starts a
30-minute-idle / 4-hour-max session (`httpOnly`, `SameSite=Strict` cookie) that also
satisfies the admin API endpoints above — no need to know or paste the raw secret into
every request from the browser.

From `/admin` you can:

- Trigger a refresh, create a backup, soft-reset, or nuke-and-rebuild the DB
- **Deploy an update** (see below)
- Manually roll back to any retained code backup

### Deploying an update

1. Upload a `.zip` — either the **full project** or just the **changed files**, preserving
   their folder structure. Zip paths must be relative to the project root (e.g. `server.js`,
   `public/admin/admin.js`) — no wrapping top-level folder.
2. The server validates every entry before touching disk: no path traversal, no symlinks,
   no writes to `node_modules/`, `.git/`, `data/`, `backups/`, `updates/`, or `.env`, and
   per-file / total size caps.
3. Review the staged file list, then re-enter your admin password and click **Apply**.
4. The server, in order:
   - backs up the database
   - zips up the current codebase (code backup, kept alongside DB backups, last 10 retained)
   - writes the new files
   - runs `npm install` if `package.json`/`package-lock.json` changed
   - runs `node --check` on every `.js` file in the project
   - boots an isolated copy of the server on a scratch port and scratch database to confirm
     it actually starts (the **live** process is never touched by this step)
5. If every check passes, it restarts itself so your process manager (PM2, Docker, or
   systemd — all of which are configured in this repo with auto-restart) brings the server
   back up running the new code.
6. If **any** check fails, the code backup from step 4 is restored automatically, the live
   process is never restarted, and you get an error explaining what failed. Nothing about
   the running server changes until a validated update passes every check.

The uploaded zip and any abandoned/expired uploads are cleaned up automatically.

---

## Scoring Logic

```
calculated_score = ceil(score_up × 3.14)
```

---

## Security

- Helmet HTTP headers + strict Content-Security-Policy
- Rate limiting (public, admin API, and a separate strict limiter for login/update-apply)
- CORS whitelist support
- Admin secret authentication via constant-time comparison (header **or** session cookie)
- Password re-confirmation required before an update is applied or rolled back, even with
  an active session
- Request size limits (JSON body, uploaded zip, per-file and total zip contents)
- Path-traversal-safe backup downloads and update-file writes (whitelisted types/paths,
  resolved-path verification)
- Update packages are validated for path traversal and symlinks before any file is written
- Upstream API credentials never written to logs (errors are sanitized before logging)
- Static file serving denies dotfiles (`.env`, etc.)
- Dependencies audited with `npm audit` — currently 0 known vulnerabilities

---

## Security Notes for Self-Hosters

- **Systemd installs:** `install-service.sh` writes `ADMIN_SECRET` and other config to a
  root-owned, mode-600 `data/leaderboard.env` file referenced via `EnvironmentFile=`,
  instead of embedding it directly in `/etc/systemd/system/leaderboard.service`. Unit files
  under `/etc/systemd/system` are world-readable (0644) by default, so an inline
  `Environment=ADMIN_SECRET=...` line would leak the secret to any local user (e.g. via
  `systemctl cat leaderboard`).
- **PM2 / `ecosystem.config.js`:** this file is meant to be committed, so it doesn't
  hardcode a real secret. It reads `ADMIN_SECRET` (and other config) from `process.env` at
  launch — set these in a gitignored `.env` or your shell before running
  `pm2 start ecosystem.config.js`. If you previously committed a real `ADMIN_SECRET` in this
  file, treat it as compromised, rotate it, and consider scrubbing it from git history.
- **Never commit a filled-in `.env`.** `.gitignore` also excludes `*.env`, `data/` (where
  the systemd installer stores its env file), and `updates/` (transient update staging).
- **The admin password is a deploy key.** Anyone with it can write files to your server
  through the update system. Treat it accordingly — long, random, and not reused.

---

## Backups

- Auto DB backup every 6 hours; keeps last 10
- Code backup created automatically before every applied update; keeps last 10
- Authors exported to JSON alongside each DB backup

---

## Notes

- Requires valid upstream API credentials
- Uses SQLite WAL mode
- Auto-refresh every 70 seconds
- Single-instance only (`exec_mode: "fork"`, `instances: 1` in `ecosystem.config.js`) —
  admin sessions and update staging are held in memory, not a shared store

---

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

You are free to use, modify, and distribute this software under the terms of the GPL-3.0
license, provided that any derivative work is also distributed under the same license.

Full license text available here:
https://www.gnu.org/licenses/gpl-3.0.en.html

Source Code Repository:
https://github.com/Riotcoke123/Community-Leaderboard-Server

This software is provided "as is", without warranty of any kind, express or implied,
including but not limited to the warranties of merchantability, fitness for a particular
purpose, and noninfringement. In no event shall the authors or copyright holders be liable
for any claim, damages, or other liability arising from the use of this software.
