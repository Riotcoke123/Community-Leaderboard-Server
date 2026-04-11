require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const pino = require('pino');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');


const PORT = process.env.PORT || 3001;
const MAX_AUTHORS = 500;
const AUTO_UPDATE_INTERVAL = 70 * 1000; // Updated from 90 to 70 seconds
const BACKUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';

// Admin secret — set ADMIN_SECRET in your .env (required)
const ADMIN_SECRET = process.env.ADMIN_SECRET;
if (!ADMIN_SECRET || ADMIN_SECRET.length < 16) {
  console.error(
    'FATAL: ADMIN_SECRET must be set in .env and be at least 16 characters long.'
  );
  process.exit(1);
}

// Allowed origins for CORS (comma-separated in CORS_ORIGINS env var)
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Use pino-pretty for colourised output in dev; fall back to plain JSON in prod
// (avoids crash when pino-pretty is not installed)
let logger;
try {
  require.resolve('pino-pretty');
  logger = pino({
    transport: { target: 'pino-pretty', options: { colorize: true } }
  });
} catch {
  logger = pino(); // plain JSON — always available
}

// Parse comma-separated COMMUNITY env var into an array
const COMMUNITIES = (process.env.COMMUNITY || '')
  .split(',')
  .map(c => c.trim())
  .filter(Boolean);

if (COMMUNITIES.length === 0) {
  logger.error('No communities configured. Set COMMUNITY in your .env file.');
  process.exit(1);
}

logger.info({ communities: COMMUNITIES }, 'Configured communities');

// =========================
// DATABASE
// =========================
const dbPath = process.env.DB_PATH || './leaderboard.db';

// Create backup directory if it doesn't exist
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS leaderboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL UNIQUE,
  original_score INTEGER NOT NULL,
  calculated_score INTEGER NOT NULL,
  last_active_ms INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  post_id TEXT UNIQUE,
  title TEXT,
  score INTEGER NOT NULL,
  calculated_score INTEGER NOT NULL,
  created_ms INTEGER,
  url TEXT,
  community TEXT,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS authors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author);
CREATE INDEX IF NOT EXISTS idx_authors_username ON authors(username);
`;

function initDb() {
  const instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');
  instance.exec(SCHEMA_SQL);

  // Migration: add community column to posts if it doesn't exist yet
  const cols = instance.prepare(`PRAGMA table_info(posts)`).all();
  if (!cols.some(c => c.name === 'community')) {
    instance.exec(`ALTER TABLE posts ADD COLUMN community TEXT`);
    logger.info('Migration: added community column to posts table');
  }

  return instance;
}

let db = initDb();

// =========================
// BACKUP & RESTORE
// =========================
function createBackup() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `leaderboard-${timestamp}.db`);
    db.backup(backupPath);
    logger.info({ backupPath }, 'Database backup created');

    // Keep only last 10 backups
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('leaderboard-') && f.endsWith('.db'))
      .sort()
      .reverse();

    if (backups.length > 10) {
      backups.slice(10).forEach(f => {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
        logger.info({ file: f }, 'Old backup deleted');
      });
    }

    return backupPath;
  } catch (err) {
    logger.error({ err }, 'Error creating backup');
    throw err;
  }
}

function exportAuthorsJSON() {
  try {
    const authors = db.prepare(`
      SELECT username, first_seen_at, last_seen_at
      FROM authors
      ORDER BY username
    `).all();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(BACKUP_DIR, `authors-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(authors, null, 2));
    logger.info({ jsonPath, count: authors.length }, 'Authors exported to JSON');

    return jsonPath;
  } catch (err) {
    logger.error({ err }, 'Error exporting authors');
    throw err;
  }
}

// =========================
// HELPERS
// =========================
const calculateScore = score => Math.ceil(score * 3.14);

function timeAgoFromMs(epochMs) {
  const nowMs = Date.now();
  const diffSec = Math.floor((nowMs - epochMs) / 1000);
  const units = [
    { label: 'year', seconds: 31536000 },
    { label: 'month', seconds: 2592000 },
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 },
    { label: 'second', seconds: 1 }
  ];
  for (const u of units) {
    const value = Math.floor(diffSec / u.seconds);
    if (value >= 1) return `${value} ${u.label}${value > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

// =========================
// FETCH POSTS
// =========================
async function fetchPostsForCommunity(community) {
  const apiUrl = `${process.env.API_BASE_URL}?community=${encodeURIComponent(community)}`;
  try {
    const response = await axios.get(apiUrl, {
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0',
        'x-api-key': process.env.X_API_KEY,
        'x-api-platform': process.env.X_API_PLATFORM,
        'x-api-secret': process.env.X_API_SECRET,
        'x-xsrf-token': process.env.X_XSRF_TOKEN,
        referer: `https://communities.win/c/${community}/new`
      },
      timeout: 30000,
      maxContentLength: 10 * 1024 * 1024, // 10 MB upstream response cap
      maxBodyLength: 10 * 1024 * 1024
    });

    const posts = Array.isArray(response.data)
      ? response.data
      : response.data.posts || response.data.data || [];

    return posts.map(p => ({ ...p, _community: community }));
  } catch (err) {
    logger.error({ err, community }, 'Error fetching posts for community');
    return [];
  }
}

async function fetchPosts() {
  const results = await Promise.all(COMMUNITIES.map(fetchPostsForCommunity));
  const all = results.flat();
  logger.info(
    COMMUNITIES.reduce((acc, c, i) => ({ ...acc, [c]: results[i].length }), { total: all.length }),
    'Posts fetched per community'
  );
  return all;
}

// =========================
// UPDATE LEADERBOARD
// =========================
function updateLeaderboard(posts) {
  const upsertPost = db.prepare(`
    INSERT INTO posts (author, post_id, title, score, calculated_score, created_ms, url, community)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      score = excluded.score,
      calculated_score = excluded.calculated_score
    WHERE posts.score != excluded.score
  `);

  const getExistingScore = db.prepare(`SELECT score FROM posts WHERE post_id = ?`);

  const upsertAuthor = db.prepare(`
    INSERT INTO authors (username, first_seen_at, last_seen_at)
    VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(username) DO UPDATE SET
      last_seen_at = CURRENT_TIMESTAMP
  `);

  let newPosts = 0;
  let duplicates = 0;
  let updated = 0;

  const rebuildLeaderboard = db.prepare(`
    INSERT OR REPLACE INTO leaderboard (author, original_score, calculated_score, last_active_ms, updated_at)
    SELECT
      author,
      SUM(score) as original_score,
      SUM(calculated_score) as calculated_score,
      MAX(created_ms) as last_active_ms,
      CURRENT_TIMESTAMP
    FROM posts
    GROUP BY author
  `);

  const getAuthorCount = db.prepare(`SELECT COUNT(*) c FROM authors`);

  const evictLowestAuthor = db.prepare(`
    SELECT a.username
    FROM authors a
    LEFT JOIN leaderboard l ON l.author = a.username
    ORDER BY COALESCE(l.calculated_score, 0) ASC
    LIMIT 1
  `);

  const deleteAuthorPosts = db.prepare(`DELETE FROM posts WHERE author = ?`);
  const deleteAuthorLeaderboard = db.prepare(`DELETE FROM leaderboard WHERE author = ?`);
  const deleteAuthorRecord = db.prepare(`DELETE FROM authors WHERE username = ?`);

  const tx = db.transaction(posts => {
    let hasChanges = false;

    for (const post of posts) {
      if (!post.author || typeof post.score_up !== 'number' || !post.created) continue;
      const postId = post.id || post.post_id || post.postId;
      if (!postId) continue;

      const calculated = calculateScore(post.score_up);
      const createdMs = post.created;
      const community = post._community || COMMUNITIES[0];
      const url = post.permalink || post.url || `https://communities.win/c/${community}/${postId}`;

      try {
        const isNewAuthor = !db.prepare(`SELECT 1 FROM authors WHERE username = ?`).get(post.author);

        if (isNewAuthor && getAuthorCount.get().c >= MAX_AUTHORS) {
          const lowest = evictLowestAuthor.get();
          if (lowest) {
            deleteAuthorPosts.run(lowest.username);
            deleteAuthorLeaderboard.run(lowest.username);
            deleteAuthorRecord.run(lowest.username);
            hasChanges = true;
            logger.info({ evicted: lowest.username }, 'Author cap reached — evicted lowest scorer');
          }
        }

        upsertAuthor.run(post.author);

        const result = upsertPost.run(
          post.author,
          postId,
          post.title || '',
          post.score_up,
          calculated,
          createdMs,
          url,
          community
        );

        if (result.changes > 0) {
          hasChanges = true;
          const existing = getExistingScore.get(postId);
          if (!existing) {
            newPosts++;
          } else {
            updated++;
          }
        } else {
          duplicates++;
        }
      } catch (err) {
        logger.error({ err, postId }, 'Error inserting post');
      }
    }

    if (hasChanges) {
      try {
        db.prepare('DELETE FROM leaderboard').run();
        rebuildLeaderboard.run();
      } catch (err) {
        logger.error({ err }, 'Error rebuilding leaderboard');
        throw err;
      }
    }
  });

  tx(posts);
  return { newPosts, duplicates, updated };
}

// =========================
// GET LEADERBOARD & STATS
// =========================
function getLeaderboard(limit = 500) {
  const rows = db.prepare(`
    SELECT author, original_score, calculated_score, last_active_ms,
           (SELECT COUNT(*) FROM posts p WHERE p.author = l.author) AS post_count
    FROM leaderboard l
    ORDER BY calculated_score DESC
    LIMIT ?
  `).all(limit);

  return rows.map(r => ({
    author: r.author,
    original_score: r.original_score,
    calculated_score: r.calculated_score,
    post_count: r.post_count,
    last_active_ago: r.last_active_ms ? timeAgoFromMs(r.last_active_ms) : 'unknown'
  }));
}

function getStats() {
  return {
    totalPosts: db.prepare('SELECT COUNT(*) c FROM posts').get().c,
    totalAuthors: db.prepare('SELECT COUNT(DISTINCT author) c FROM posts').get().c,
    authorCap: MAX_AUTHORS
    // Note: communities & topUser intentionally omitted from public stats
  };
}

// =========================
// AUTO FETCH
// =========================
async function fetchAndUpdateData() {
  try {
    logger.info(`Fetching posts @ ${new Date().toLocaleString()}`);
    const posts = await fetchPosts();

    if (!posts.length) {
      logger.warn('No posts found');
      return;
    }

    const result = updateLeaderboard(posts);
    const stats = getStats();
    logger.info({
      newPosts: result.newPosts,
      updated: result.updated,
      duplicates: result.duplicates,
      totalPosts: stats.totalPosts
    }, 'Leaderboard updated');
  } catch (err) {
    logger.error({ err }, 'Fetch and update error');
  }
}

// =========================
// EXPRESS SERVER
// =========================
const app = express();
app.set('trust proxy', 1);
// ── Security headers (Helmet) ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]       // blocks clickjacking
    }
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  noSniff: true,                        // X-Content-Type-Options: nosniff
  frameguard: { action: 'deny' },       // X-Frame-Options: DENY
  xssFilter: true,                      // X-XSS-Protection
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// ── CORS ───────────────────────────────────────────────────────────────────
// If no CORS_ORIGINS are set, only same-origin requests are served.
if (ALLOWED_ORIGINS.length > 0) {
  app.use(cors({
    origin: (origin, cb) => {
      // Allow requests with no origin (server-to-server, curl)
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error('CORS policy: origin not allowed'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Admin-Secret']
  }));
} else {
  // Deny all cross-origin requests
  app.use(cors({ origin: false }));
}

// ── Body parser with strict size cap ──────────────────────────────────────
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

// ── Static files ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  // Don't serve dotfiles (e.g. .env)
  dotfiles: 'deny',
  // Cache static assets
  maxAge: '1h'
}));

// =========================
// RATE LIMITERS
// =========================

// Public read endpoints — generous limit
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 60,               // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

// Admin / destructive endpoints — very tight limit
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 attempts per 15 minutes per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests.' }
});

// =========================
// AUTH MIDDLEWARE
// =========================
// Protects destructive admin endpoints.
// Callers must send:  X-Admin-Secret: <your-secret>  header
function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== ADMIN_SECRET) {
    logger.warn({ ip: req.ip, path: req.path }, 'Unauthorized admin attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// =========================
// ROUTES — PUBLIC
// =========================
app.get('/api/leaderboard', publicLimiter, (req, res) => {
  try {
    res.json(getLeaderboard(MAX_AUTHORS));
  } catch (err) {
    logger.error({ err }, 'Error fetching leaderboard');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stats', publicLimiter, (req, res) => {
  try {
    res.json(getStats());
  } catch (err) {
    logger.error({ err }, 'Error fetching stats');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =========================
// ROUTES — ADMIN (auth + strict rate-limit)
// =========================

// List authors — admin only (could expose username data)
app.get('/api/authors', adminLimiter, requireAdmin, (req, res) => {
  try {
    const authors = db.prepare(`
      SELECT username, first_seen_at, last_seen_at
      FROM authors
      ORDER BY last_seen_at DESC
    `).all();
    res.json(authors);
  } catch (err) {
    logger.error({ err }, 'Error fetching authors');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/backup', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const dbBackup = createBackup();
    const jsonBackup = exportAuthorsJSON();
    res.json({
      success: true,
      dbBackup: path.basename(dbBackup),
      jsonBackup: path.basename(jsonBackup)
    });
  } catch (err) {
    logger.error({ err }, 'Error creating backup');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Backup download — admin only, path traversal protected
app.get('/api/backup/download/:type', adminLimiter, requireAdmin, (req, res) => {
  try {
    const { type } = req.params;

    // Strict whitelist — no path traversal possible
    if (type !== 'db' && type !== 'json') {
      return res.status(400).json({ error: 'Invalid backup type. Use "db" or "json".' });
    }

    let files;
    if (type === 'db') {
      files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('leaderboard-') && f.endsWith('.db'))
        .sort()
        .reverse();
    } else {
      files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('authors-') && f.endsWith('.json'))
        .sort()
        .reverse();
    }

    if (files.length === 0) {
      return res.status(404).json({ error: 'No backups found' });
    }

    // Resolve and verify the final path stays inside BACKUP_DIR
    const resolvedBackupDir = path.resolve(BACKUP_DIR);
    const latestBackup = path.resolve(path.join(BACKUP_DIR, files[0]));
    if (!latestBackup.startsWith(resolvedBackupDir + path.sep)) {
      logger.error({ latestBackup }, 'Path traversal attempt detected');
      return res.status(400).json({ error: 'Invalid file path' });
    }

    res.download(latestBackup);
  } catch (err) {
    logger.error({ err }, 'Error downloading backup');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Nuclear reset
app.post('/api/nuke', adminLimiter, requireAdmin, async (req, res) => {
  try {
    let dbBackupName = null;
    let jsonBackupName = null;
    try {
      dbBackupName = path.basename(createBackup());
      jsonBackupName = path.basename(exportAuthorsJSON());
    } catch (backupErr) {
      logger.warn({ err: backupErr }, 'Pre-nuke backup failed — proceeding anyway');
    }

    db.close();
    logger.info('DB connection closed for nuke');

    for (const suffix of ['', '-wal', '-shm']) {
      const filePath = dbPath + suffix;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info({ filePath }, 'Deleted DB file');
      }
    }

    db = initDb();
    logger.info('Fresh DB initialised');

    await fetchAndUpdateData();

    res.json({
      success: true,
      message: 'DB deleted and rebuilt from scratch, fresh fetch triggered',
      backups: { db: dbBackupName, json: jsonBackupName }
    });
  } catch (err) {
    logger.error({ err }, 'Error nuking database');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Soft reset
app.post('/api/reset', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const dbBackup = createBackup();
    const jsonBackup = exportAuthorsJSON();

    db.transaction(() => {
      db.prepare('DELETE FROM posts').run();
      db.prepare('DELETE FROM leaderboard').run();
      db.prepare('DELETE FROM authors').run();
      db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('posts', 'leaderboard', 'authors')").run();
    })();

    logger.info('Database reset — all data wiped');

    await fetchAndUpdateData();

    res.json({
      success: true,
      message: 'All data wiped and fresh fetch triggered',
      backups: {
        db: path.basename(dbBackup),
        json: path.basename(jsonBackup)
      }
    });
  } catch (err) {
    logger.error({ err }, 'Error resetting database');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/refresh', adminLimiter, requireAdmin, async (req, res) => {
  try {
    await fetchAndUpdateData();
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Error refreshing data');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =========================
// 404 CATCH-ALL
// =========================
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// =========================
// START SERVER
// =========================
const server = app.listen(PORT, () => {
  logger.info(`Server running at http://localhost:${PORT}`);
  logger.info({ communities: COMMUNITIES }, 'Tracking communities');

  createBackup();
  exportAuthorsJSON();

  fetchAndUpdateData();

  setInterval(fetchAndUpdateData, AUTO_UPDATE_INTERVAL);
  setInterval(() => {
    createBackup();
    exportAuthorsJSON();
  }, BACKUP_INTERVAL);
});

// =========================
// GRACEFUL SHUTDOWN
// =========================
const shutdown = () => {
  logger.info('Shutting down...');
  server.close(() => {
    db.close();
    logger.info('Server closed, DB connection closed');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// =========================
// GLOBAL ERROR HANDLERS
// =========================
process.on('uncaughtException', err => {
  logger.error({ err }, 'Uncaught Exception');
  process.exit(1);
});

process.on('unhandledRejection', err => {
  logger.error({ err }, 'Unhandled Rejection');
  process.exit(1);
});