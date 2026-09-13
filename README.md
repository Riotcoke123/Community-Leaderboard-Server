<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>

</head>
<body>

<h1>Community Leaderboard Server</h1>

<p>
A high-performance Node.js + Express backend that aggregates posts from multiple communities,
calculates weighted scores, and builds a live leaderboard using SQLite.
</p>

<hr>

<h2>Features</h2>
<ul>
  <li>Auto-fetch posts from configured communities</li>
  <li>Custom score calculation (score × 3.14)</li>
  <li>Live aggregated leaderboard per author</li>
  <li>SQLite database with WAL mode</li>
  <li>Auto-refresh every 70 seconds</li>
  <li>Automatic backups every 6 hours</li>
  <li>Author tracking + eviction system</li>
  <li>Secure admin API with secret auth</li>
  <li>Security hardening (Helmet, CORS, rate limits)</li>
</ul>

<hr>

<h2>Project Structure</h2>
<pre>
.
├── server.js
├── leaderboard.db
├── backups/
├── .env
└── public/
</pre>

<hr>

<h2>Environment Variables</h2>
<pre>
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
</pre>

<hr>

<h2>Running the Server</h2>
<pre>
node server.js
</pre>

<p>Dev mode:</p>
<pre>
npx nodemon server.js
</pre>

<hr>

<h2>API Endpoints</h2>

<h3>GET /api/leaderboard</h3>
<div class="box">
Returns ranked authors by score.
<pre>
[
  {
    "author": "user123",
    "original_score": 120,
    "calculated_score": 377,
    "post_count": 15,
    "last_active_ago": "2 hours ago"
  }
]
</pre>
</div>

<h3>GET /api/stats</h3>
<div class="box">
<pre>
{
  "totalPosts": 1200,
  "totalAuthors": 85,
  "authorCap": 500
}
</pre>
</div>

<hr>

<h2>Admin Header</h2>
<pre>
X-Admin-Secret: your_secret
</pre>

<ul>
  <li>GET /api/authors</li>
  <li>POST /api/refresh</li>
  <li>POST /api/reset</li>
  <li>POST /api/nuke</li>
  <li>POST /api/backup</li>
  <li>/api/backup/download/db</li>
  <li>/api/backup/download/json</li>
</ul>

<hr>

<h2>Scoring Logic</h2>
<pre>
calculated_score = ceil(score_up × 3.14)
</pre>

<hr>

<h2>Security</h2>
<ul>
  <li>Helmet HTTP headers</li>
  <li>Rate limiting (public + admin)</li>
  <li>CORS whitelist support</li>
  <li>Admin secret authentication (constant-time comparison, resistant to timing attacks)</li>
  <li>Request size limits</li>
  <li>Path-traversal-safe backup downloads (whitelisted types, resolved-path verification)</li>
  <li>Upstream API credentials never written to logs (errors are sanitized before logging)</li>
  <li>Static file serving denies dotfiles (<code>.env</code>, etc.)</li>
</ul>

<hr>

<h2>Security Notes for Self-Hosters</h2>
<ul>
  <li>
    <strong>Systemd installs:</strong> <code>install-service.sh</code> now writes <code>ADMIN_SECRET</code>
    and other config to a root-owned, mode-600 <code>data/leaderboard.env</code> file referenced via
    <code>EnvironmentFile=</code>, instead of embedding it directly in
    <code>/etc/systemd/system/leaderboard.service</code>. Unit files under
    <code>/etc/systemd/system</code> are world-readable (0644) by default, so an inline
    <code>Environment=ADMIN_SECRET=...</code> line would leak the secret to any local user
    (e.g. via <code>systemctl cat leaderboard</code>).
  </li>
  <li>
    <strong>PM2 / <code>ecosystem.config.js</code>:</strong> this file is meant to be committed, so it no
    longer hardcodes a real-looking secret. It now reads <code>ADMIN_SECRET</code> (and other config)
    from <code>process.env</code> at launch — set these in a gitignored <code>.env</code> or your shell
    before running <code>pm2 start ecosystem.config.js</code>. If you previously committed a real
    <code>ADMIN_SECRET</code> in this file, treat it as compromised, rotate it, and consider scrubbing
    it from git history.
  </li>
  <li>
    <strong>Never commit a filled-in <code>.env</code>.</strong> <code>.gitignore</code> now also excludes
    <code>*.env</code> and <code>data/</code> (where the systemd installer stores its env file).
  </li>
</ul>

<hr>

<h2>Backups</h2>
<ul>
  <li>Auto backup every 6 hours</li>
  <li>Keeps last 10 backups</li>
  <li>Exports authors to JSON</li>
</ul>

<hr>

<h2>Notes</h2>
<ul>
  <li>Requires valid upstream API credentials</li>
  <li>Uses SQLite WAL mode</li>
  <li>Auto-refresh every 70 seconds</li>
</ul>

<hr>

<h2>License</h2>

<p>
This project is licensed under the
<strong>GNU General Public License v3.0 (GPL-3.0)</strong>.
</p>

<p>
You are free to use, modify, and distribute this software under the terms of the GPL-3.0 license,
provided that any derivative work is also distributed under the same license.
</p>

<p>
Full license text available here:<br>
<a href="https://www.gnu.org/licenses/gpl-3.0.en.html" target="_blank">
https://www.gnu.org/licenses/gpl-3.0.en.html
</a>
</p>

<p>
Source Code Repository:<br>
<a href="https://github.com/Riotcoke123/Community-Leaderboard-Server" target="_blank">
https://github.com/Riotcoke123/Community-Leaderboard-Server
</a>
</p>

<p>
This software is provided "as is", without warranty of any kind, express or implied,
including but not limited to the warranties of merchantability, fitness for a particular purpose,
and noninfringement. In no event shall the authors or copyright holders be liable for any claim,
damages, or other liability arising from the use of this software.
</p>
</body>
</html>
