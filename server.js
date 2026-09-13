require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const pino = require('pino');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');
const cookie = require('cookie');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const http = require('http');


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

// =========================
// ADMIN PANEL / SELF-UPDATE CONFIG
// =========================
const PROJECT_ROOT = __dirname;
const UPDATES_DIR = path.join(PROJECT_ROOT, 'updates');
const PENDING_DIR = path.join(UPDATES_DIR, 'pending');
const SESSION_COOKIE_NAME = 'admin_session';
const SESSION_TTL_MS = 30 * 60 * 1000;       // 30 min idle timeout
const SESSION_ABS_MAX_MS = 4 * 60 * 60 * 1000; // 4 hour hard cap
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;  // 100 MB zip cap
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;   // GC uploads left un-applied for 1h
const CODE_BACKUP_RETENTION = 10;
const BOOT_TEST_TIMEOUT_MS = 12000;
const BOOT_TEST_PORT = Number(process.env.UPDATE_TEST_PORT) || 39871;

// Directories / dotfiles that a code update is never allowed to touch.
// Matched against the FIRST path segment of each zip entry.
const UPDATE_FORBIDDEN_TOP_SEGMENTS = new Set([
  'node_modules', '.git', 'data', 'backups', 'updates'
]);
// Exact relative paths (anywhere in the tree) that are always forbidden.
const UPDATE_FORBIDDEN_EXACT = new Set(['.env', '.env.example', '.git']);

for (const dir of [UPDATES_DIR, PENDING_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

// =========================
// ADMIN SESSIONS (in-memory — single instance only; see ecosystem.config.js
// exec_mode:"fork", instances:1. If you ever move to cluster/multi-instance,
// swap this Map for a shared store e.g. sqlite/redis.)
// =========================
const adminSessions = new Map(); // token -> { createdAt, lastSeenAt }

function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  adminSessions.set(token, { createdAt: now, lastSeenAt: now });
  return token;
}

function touchAndValidateSession(token) {
  if (!token) return false;
  const s = adminSessions.get(token);
  if (!s) return false;
  const now = Date.now();
  if (now - s.lastSeenAt > SESSION_TTL_MS || now - s.createdAt > SESSION_ABS_MAX_MS) {
    adminSessions.delete(token);
    return false;
  }
  s.lastSeenAt = now;
  return true;
}

function destroySession(token) {
  if (token) adminSessions.delete(token);
}

// Periodic sweep of expired sessions so the Map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of adminSessions.entries()) {
    if (now - s.lastSeenAt > SESSION_TTL_MS || now - s.createdAt > SESSION_ABS_MAX_MS) {
      adminSessions.delete(token);
    }
  }
}, 5 * 60 * 1000).unref();

function getSessionTokenFromReq(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  try {
    const parsed = cookie.parse(header);
    return parsed[SESSION_COOKIE_NAME] || null;
  } catch {
    return null;
  }
}

function hasValidSession(req) {
  return touchAndValidateSession(getSessionTokenFromReq(req));
}

// Constant-time compare of a caller-supplied secret/password against ADMIN_SECRET.
// Reused by the header-based API auth, the admin login form, and the
// re-confirmation step required before an update is applied.
function secretMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const candidateHash = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const secretHash = crypto.createHash('sha256').update(ADMIN_SECRET_BUF).digest();
  return crypto.timingSafeEqual(candidateHash, secretHash);
}

// =========================
// SELF-UPDATE — PATH SAFETY
// =========================
// Validates a single zip-entry path before it's ever written to disk.
// Returns { ok: true, relPath } or { ok: false, reason }.
function validateUpdateEntryPath(rawEntryName) {
  if (typeof rawEntryName !== 'string' || rawEntryName.length === 0) {
    return { ok: false, reason: 'empty path' };
  }
  // Reject backslashes outright — legitimate zip entries use forward slashes;
  // backslashes are a common way to smuggle traversal past naive checks.
  if (rawEntryName.includes('\\')) {
    return { ok: false, reason: `backslash in path: ${rawEntryName}` };
  }
  if (rawEntryName.startsWith('/') || /^[a-zA-Z]:/.test(rawEntryName)) {
    return { ok: false, reason: `absolute path not allowed: ${rawEntryName}` };
  }

  const normalized = path.posix.normalize(rawEntryName);
  if (normalized === '.' || normalized.startsWith('..')) {
    return { ok: false, reason: `path traversal attempt: ${rawEntryName}` };
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.some(seg => seg === '..')) {
    return { ok: false, reason: `path traversal attempt: ${rawEntryName}` };
  }
  if (UPDATE_FORBIDDEN_TOP_SEGMENTS.has(segments[0])) {
    return { ok: false, reason: `updates may not touch "${segments[0]}/": ${rawEntryName}` };
  }
  if (UPDATE_FORBIDDEN_EXACT.has(normalized) || segments.some(seg => UPDATE_FORBIDDEN_EXACT.has(seg))) {
    return { ok: false, reason: `forbidden path: ${rawEntryName}` };
  }

  // Final containment check: the resolved absolute path must stay inside PROJECT_ROOT.
  const resolved = path.resolve(PROJECT_ROOT, normalized);
  if (!resolved.startsWith(PROJECT_ROOT + path.sep)) {
    return { ok: false, reason: `escapes project root: ${rawEntryName}` };
  }

  return { ok: true, relPath: normalized };
}

// Rejects symlink entries embedded in the zip (the exact class of bug fixed
// upstream in adm-zip's own CVE — we re-check defensively here too).
function isSymlinkEntry(entry) {
  try {
    const mode = (entry.header.attr >>> 16) & 0xffff;
    return (mode & 0xf000) === 0xa000; // S_IFLNK
  } catch {
    return false;
  }
}

// Loads a zip buffer and returns { ok, files, totalBytes, reason } after
// validating every entry. Never writes anything to disk.
function inspectUpdateZip(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return { ok: false, reason: 'Not a valid zip file' };
  }

  let entries;
  try {
    entries = zip.getEntries();
  } catch {
    return { ok: false, reason: 'Could not read zip contents' };
  }

  const files = [];
  let totalBytes = 0;
  const MAX_ENTRY_BYTES = 25 * 1024 * 1024;   // 25 MB per file
  const MAX_TOTAL_BYTES = 150 * 1024 * 1024;  // 150 MB uncompressed total

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (isSymlinkEntry(entry)) {
      return { ok: false, reason: `symlinks are not allowed: ${entry.entryName}` };
    }
    const check = validateUpdateEntryPath(entry.entryName);
    if (!check.ok) return { ok: false, reason: check.reason };

    const size = entry.header.size || 0;
    if (size > MAX_ENTRY_BYTES) {
      return { ok: false, reason: `file too large (${size} bytes): ${entry.entryName}` };
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, reason: 'package exceeds total size limit' };
    }
    files.push({ path: check.relPath, size });
  }

  if (files.length === 0) {
    return { ok: false, reason: 'zip contains no files' };
  }

  return { ok: true, zip, files, totalBytes };
}

// =========================
// SELF-UPDATE — PROJECT TREE WALK / CODE BACKUP / RESTORE
// =========================
const CODE_BACKUP_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'data', 'backups', 'updates']);

function walkProjectFiles(dir = PROJECT_ROOT) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(PROJECT_ROOT, abs).split(path.sep).join('/');
    const topSeg = rel.split('/')[0];
    if (entry.isDirectory()) {
      if (CODE_BACKUP_EXCLUDE_DIRS.has(topSeg)) continue;
      out.push(...walkProjectFiles(abs));
    } else if (entry.isFile()) {
      if (UPDATE_FORBIDDEN_EXACT.has(rel) || UPDATE_FORBIDDEN_EXACT.has(entry.name)) continue;
      out.push(rel);
    }
  }
  return out;
}

function createCodeBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `code-backup-${timestamp}.zip`);
  const zip = new AdmZip();
  for (const relPath of walkProjectFiles()) {
    zip.addLocalFile(path.join(PROJECT_ROOT, relPath), path.dirname(relPath) === '.' ? '' : path.dirname(relPath));
  }
  zip.writeZip(backupPath);
  logger.info({ backupPath }, 'Code backup created before update');

  // Retention: keep only the most recent N code backups.
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('code-backup-') && f.endsWith('.zip'))
    .sort()
    .reverse();
  if (backups.length > CODE_BACKUP_RETENTION) {
    backups.slice(CODE_BACKUP_RETENTION).forEach(f => {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      logger.info({ file: f }, 'Old code backup deleted');
    });
  }

  return backupPath;
}

// Restores a previously-created code backup zip on top of the project tree.
function restoreCodeBackup(backupPath) {
  const zip = new AdmZip(backupPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const check = validateUpdateEntryPath(entry.entryName);
    if (!check.ok) continue; // shouldn't happen — we wrote this zip ourselves
    const target = path.join(PROJECT_ROOT, check.relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
  logger.warn({ backupPath }, 'Code backup restored (rollback)');
}

// Writes every validated file from an inspected update zip into the project tree.
// `files` is the already-validated {path, size} list from inspectUpdateZip,
// used only to know which entries are safe; the actual bytes come straight
// from the zip's own entries so path handling stays consistent.
function applyUpdateFiles(zip, files) {
  const wantedPaths = new Set(files.map(f => f.path));
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const relPath = entry.entryName.replace(/\\/g, '/');
    if (!wantedPaths.has(relPath)) continue; // already validated set — skip anything else defensively
    const target = path.join(PROJECT_ROOT, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
}

// =========================
// SELF-UPDATE — VALIDATION (syntax check + isolated boot test)
// =========================
function runSyntaxCheck() {
  const jsFiles = walkProjectFiles().filter(f => f.endsWith('.js'));
  for (const rel of jsFiles) {
    try {
      execFileSync(process.execPath, ['--check', path.join(PROJECT_ROOT, rel)], { stdio: 'pipe', timeout: 10000 });
    } catch (err) {
      return { ok: false, reason: `syntax error in ${rel}: ${(err.stderr || err.message || '').toString().slice(0, 500)}` };
    }
  }
  return { ok: true };
}

function runNpmInstallIfNeeded(files) {
  const touchesDeps = files.some(f => f.path === 'package.json' || f.path === 'package-lock.json');
  if (!touchesDeps) return { ok: true, ran: false };
  try {
    execFileSync('npm', ['install', '--omit=dev'], { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120000 });
    return { ok: true, ran: true };
  } catch (err) {
    return { ok: false, ran: true, reason: `npm install failed: ${(err.stderr || err.message || '').toString().slice(0, 800)}` };
  }
}

// Boots a throwaway copy of the (now-updated) server in a child process on a
// separate port + separate scratch DB, and waits for it to report healthy.
// The LIVE process serving real traffic is never touched by this — Node has
// already loaded its own copy of the old code into memory, so overwriting
// files on disk cannot affect it until a deliberate restart happens.
function runBootTest() {
  return new Promise(resolve => {
    const scratchDb = path.join(os.tmpdir(), `update-boot-test-${Date.now()}.db`);
    const scratchBackupDir = path.join(os.tmpdir(), `update-boot-test-backups-${Date.now()}`);
    fs.mkdirSync(scratchBackupDir, { recursive: true });

    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server.js')], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PORT: String(BOOT_TEST_PORT),
        DB_PATH: scratchDb,
        BACKUP_DIR: scratchBackupDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let settled = false;
    let stderrBuf = '';
    child.stderr.on('data', d => { stderrBuf += d.toString(); });

    const cleanup = () => {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 2000);
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(scratchDb + suffix); } catch { /* noop */ }
      }
      try { fs.rmSync(scratchBackupDir, { recursive: true, force: true }); } catch { /* noop */ }
    };

    const finish = result => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    child.on('error', err => finish({ ok: false, reason: `failed to spawn test process: ${err.message}` }));
    child.on('exit', (code, signal) => {
      if (!settled) finish({ ok: false, reason: `test process exited early (code ${code}, signal ${signal}): ${stderrBuf.slice(0, 800)}` });
    });

    const deadline = Date.now() + BOOT_TEST_TIMEOUT_MS;
    const poll = () => {
      if (settled) return;
      if (Date.now() > deadline) {
        finish({ ok: false, reason: `boot test timed out after ${BOOT_TEST_TIMEOUT_MS}ms: ${stderrBuf.slice(0, 800)}` });
        return;
      }
      const req = http.get({ host: '127.0.0.1', port: BOOT_TEST_PORT, path: '/api/stats', timeout: 1500 }, res => {
        if (res.statusCode === 200) finish({ ok: true });
        else setTimeout(poll, 500);
        res.resume();
      });
      req.on('error', () => setTimeout(poll, 500));
      req.on('timeout', () => { req.destroy(); setTimeout(poll, 500); });
    };
    setTimeout(poll, 800); // give it a moment to start listening
  });
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

// Strip an axios error down to safe-to-log fields only. Axios errors carry
// the full outgoing request config (including our upstream x-api-key /
// x-api-secret / x-xsrf-token headers) as an enumerable property, so logging
// the raw error object would leak those secrets into log files/stdout.
function sanitizeAxiosError(err) {
  return {
    message: err.message,
    code: err.code,
    status: err.response ? err.response.status : undefined,
    statusText: err.response ? err.response.statusText : undefined
  };
}

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
    // Log a sanitized error only — never the raw axios error, since it
    // carries the upstream API credentials in err.config.headers.
    logger.error({ err: sanitizeAxiosError(err), community }, 'Error fetching posts for community');
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
const ADMIN_SECRET_BUF = Buffer.from(ADMIN_SECRET, 'utf8');

function requireAdmin(req, res, next) {
  // Accept either the scripted/API path (X-Admin-Secret header, unchanged
  // behavior) or a valid admin-panel browser session cookie.
  const provided = req.headers['x-admin-secret'];
  const authorized = secretMatches(provided) || hasValidSession(req);

  if (!authorized) {
    logger.warn({ ip: req.ip, path: req.path }, 'Unauthorized admin attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Strict limiter for the login form and for the password re-confirmation
// required before an update is applied/rolled back.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait before trying again.' }
});

const updateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 }
});

function gcStalePendingUploads() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(PENDING_DIR)) {
      const full = path.join(PENDING_DIR, f);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > PENDING_MAX_AGE_MS) fs.unlinkSync(full);
    }
  } catch (err) {
    logger.warn({ err }, 'Pending-upload GC failed');
  }
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
// ROUTES — ADMIN PANEL (browser session)
// =========================
const VIEWS_DIR = path.join(PROJECT_ROOT, 'views');

app.get('/admin/login', (req, res) => {
  if (hasValidSession(req)) return res.redirect('/admin');
  res.sendFile(path.join(VIEWS_DIR, 'admin-login.html'));
});

app.post('/admin/login', authLimiter, express.json({ limit: '1kb' }), (req, res) => {
  const { password } = req.body || {};
  if (!secretMatches(password)) {
    logger.warn({ ip: req.ip }, 'Failed admin panel login attempt');
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token = createAdminSession();
  res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    path: '/',
    maxAge: SESSION_ABS_MAX_MS / 1000
  }));
  res.json({ success: true });
});

app.post('/admin/logout', (req, res) => {
  destroySession(getSessionTokenFromReq(req));
  res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE_NAME, '', { path: '/', maxAge: 0 }));
  res.json({ success: true });
});

app.get('/admin', (req, res) => {
  if (!hasValidSession(req)) return res.redirect('/admin/login');
  res.sendFile(path.join(VIEWS_DIR, 'admin.html'));
});

// All /admin/update* and /admin/backups* routes below require a valid session.
app.use('/admin/update', requireAdmin);
app.use('/admin/backups', requireAdmin);

// Step 1: upload + validate a package (full or partial — same handling either
// way, since "changed files" just means "whatever's in this zip").
app.post('/admin/update/upload', adminLimiter, updateUpload.single('package'), (req, res) => {
  gcStalePendingUploads();

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded (field name must be "package")' });
  }
  if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
    return res.status(400).json({ error: 'Only .zip files are accepted' });
  }

  const inspection = inspectUpdateZip(req.file.buffer);
  if (!inspection.ok) {
    logger.warn({ ip: req.ip, reason: inspection.reason }, 'Rejected update package');
    return res.status(400).json({ error: inspection.reason });
  }

  const uploadId = crypto.randomUUID();
  fs.writeFileSync(path.join(PENDING_DIR, `${uploadId}.zip`), req.file.buffer);

  const looksFullPackage = inspection.files.some(f => f.path === 'server.js') &&
                            inspection.files.some(f => f.path === 'package.json');

  logger.info({ uploadId, fileCount: inspection.files.length, totalBytes: inspection.totalBytes }, 'Update package staged');

  res.json({
    uploadId,
    files: inspection.files,
    count: inspection.files.length,
    totalBytes: inspection.totalBytes,
    looksFullPackage
  });
});

// Step 2: apply a previously-uploaded package. Requires re-entering the
// admin password, even though the session is already authenticated.
app.post('/admin/update/apply', authLimiter, express.json({ limit: '1kb' }), async (req, res) => {
  const { uploadId, password } = req.body || {};
  if (!secretMatches(password)) {
    logger.warn({ ip: req.ip }, 'Update apply blocked — incorrect password confirmation');
    return res.status(401).json({ error: 'Incorrect password' });
  }
  if (typeof uploadId !== 'string' || !/^[0-9a-f-]{36}$/.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId' });
  }

  const zipPath = path.join(PENDING_DIR, `${uploadId}.zip`);
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'Upload not found or expired — please re-upload the package' });
  }

  // Re-validate from disk — never trust a prior in-memory check.
  const inspection = inspectUpdateZip(fs.readFileSync(zipPath));
  if (!inspection.ok) {
    fs.unlinkSync(zipPath);
    return res.status(400).json({ error: `Package failed re-validation: ${inspection.reason}` });
  }

  let dbBackupName = null, codeBackupPath = null;
  try {
    try {
      dbBackupName = path.basename(createBackup());
      exportAuthorsJSON();
    } catch (err) {
      logger.warn({ err }, 'Pre-update DB backup failed — continuing with code update anyway');
    }

    codeBackupPath = createCodeBackup();

    applyUpdateFiles(inspection.zip, inspection.files);

    const npmResult = runNpmInstallIfNeeded(inspection.files);
    if (!npmResult.ok) throw new Error(npmResult.reason);

    const syntaxResult = runSyntaxCheck();
    if (!syntaxResult.ok) throw new Error(syntaxResult.reason);

    const bootResult = await runBootTest();
    if (!bootResult.ok) throw new Error(bootResult.reason);

    // Success — clean up and schedule a graceful restart so the process
    // manager (PM2 / Docker / systemd, all configured with autorestart)
    // brings the live server back up running the new code.
    fs.unlinkSync(zipPath);
    logger.info({ uploadId, files: inspection.files.map(f => f.path) }, 'Update applied successfully — restarting');

    res.json({
      success: true,
      message: 'Update applied and validated. Server is restarting to load the new code.',
      filesChanged: inspection.files.map(f => f.path),
      codeBackup: path.basename(codeBackupPath),
      dbBackup: dbBackupName
    });

    setTimeout(() => process.exit(0), 1500);
  } catch (err) {
    logger.error({ err: err.message, uploadId }, 'Update failed validation — rolling back');
    let rolledBack = false;
    try {
      if (codeBackupPath) {
        restoreCodeBackup(codeBackupPath);
        // If the failed update touched package.json, resync node_modules
        // with the restored (previous) package.json too.
        if (inspection.files.some(f => f.path === 'package.json' || f.path === 'package-lock.json')) {
          try { execFileSync('npm', ['install', '--omit=dev'], { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120000 }); } catch { /* best-effort */ }
        }
        rolledBack = true;
      }
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'ROLLBACK FAILED — manual intervention required');
    }
    try { fs.unlinkSync(zipPath); } catch { /* already gone */ }

    res.status(500).json({
      error: `Update failed validation and was ${rolledBack ? 'rolled back' : 'NOT rolled back (see server logs immediately)'}: ${err.message}`,
      rolledBack
    });
  }
});

// Manual rollback to any retained code backup (independent of the automatic
// rollback-on-failure above). Also password-confirmed.
app.get('/admin/backups/code', (req, res) => {
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^code-backup-[0-9TZ:.-]+\.zip$/.test(f))
    .sort()
    .reverse();
  res.json({ backups });
});

app.post('/admin/update/rollback', authLimiter, express.json({ limit: '1kb' }), (req, res) => {
  const { password, backupFile } = req.body || {};
  if (!secretMatches(password)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  if (typeof backupFile !== 'string' || !/^code-backup-[0-9TZ:.-]+\.zip$/.test(backupFile)) {
    return res.status(400).json({ error: 'Invalid backup filename' });
  }
  const fullPath = path.resolve(BACKUP_DIR, backupFile);
  if (!fullPath.startsWith(path.resolve(BACKUP_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }

  try {
    restoreCodeBackup(fullPath);
    logger.warn({ backupFile }, 'Manual rollback applied — restarting');
    res.json({ success: true, message: 'Rolled back. Server is restarting.' });
    setTimeout(() => process.exit(0), 1500);
  } catch (err) {
    logger.error({ err }, 'Manual rollback failed');
    res.status(500).json({ error: `Rollback failed: ${err.message}` });
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