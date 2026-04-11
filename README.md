<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Community Leaderboard Server</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      max-width: 900px;
      margin: 40px auto;
      padding: 0 20px;
      background: #0d1117;
      color: #e6edf3;
    }
    h1, h2, h3 {
      color: #58a6ff;
    }
    code, pre {
      background: #161b22;
      padding: 10px;
      border-radius: 6px;
      overflow-x: auto;
      display: block;
      color: #e6edf3;
    }
    a {
      color: #79c0ff;
    }
    .box {
      background: #161b22;
      padding: 15px;
      border-radius: 8px;
      margin: 10px 0;
    }
    hr {
      border: 0;
      border-top: 1px solid #30363d;
      margin: 30px 0;
    }
  </style>
</head>
<body>

<h1>📊 Community Leaderboard Server</h1>

<p>
A high-performance Node.js + Express backend that aggregates posts from multiple communities,
calculates weighted scores, and builds a live leaderboard using SQLite.
</p>

<hr>

<h2>🚀 Features</h2>
<ul>
  <li>📡 Auto-fetch posts from configured communities</li>
  <li>🧮 Custom score calculation (score × 3.14)</li>
  <li>🏆 Live aggregated leaderboard per author</li>
  <li>🗄️ SQLite database with WAL mode</li>
  <li>🔄 Auto-refresh every 70 seconds</li>
  <li>💾 Automatic backups every 6 hours</li>
  <li>🧑 Author tracking + eviction system</li>
  <li>🔐 Secure admin API with secret auth</li>
  <li>🛡️ Security hardening (Helmet, CORS, rate limits)</li>
</ul>

<hr>

<h2>📁 Project Structure</h2>
<pre>
.
├── server.js
├── leaderboard.db
├── backups/
├── .env
└── public/
</pre>

<hr>

<h2>⚙️ Installation</h2>
<pre>
git clone https://github.com/yourusername/leaderboard-server.git
cd leaderboard-server
npm install
</pre>

<hr>

<h2>🔐 Environment Variables</h2>
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

<h2>▶️ Running the Server</h2>
<pre>
node server.js
</pre>

<p>Dev mode:</p>
<pre>
npx nodemon server.js
</pre>

<hr>

<h2>📡 API Endpoints</h2>

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

<h2>🔐 Admin Header</h2>
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

<h2>🧠 Scoring Logic</h2>
<pre>
calculated_score = ceil(score_up × 3.14)
</pre>

<hr>

<h2>🛡️ Security</h2>
<ul>
  <li>Helmet HTTP headers</li>
  <li>Rate limiting (public + admin)</li>
  <li>CORS whitelist support</li>
  <li>Admin secret authentication</li>
  <li>Request size limits</li>
</ul>

<hr>

<h2>💾 Backups</h2>
<ul>
  <li>Auto backup every 6 hours</li>
  <li>Keeps last 10 backups</li>
  <li>Exports authors to JSON</li>
</ul>

<hr>

<h2>⚠️ Notes</h2>
<ul>
  <li>Requires valid upstream API credentials</li>
  <li>Uses SQLite WAL mode</li>
  <li>Auto-refresh every 70 seconds</li>
</ul>

<hr>

<h2>📜 License</h2>
<p>MIT</p>

</body>
</html>
