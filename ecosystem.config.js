module.exports = {
  apps: [
    {
      name: "spic",
      script: "./server.js",

      // Run in cluster mode for better performance (optional)
      exec_mode: "fork", // change to "cluster" later if needed
      instances: 1,

      // Environment variables
      // SECURITY: don't hardcode ADMIN_SECRET (or any other credential) here —
      // this file is meant to be committed to source control, and a real
      // secret checked in becomes visible to anyone with repo access forever
      // (even after it's later removed, it stays in git history). PM2 merges
      // process.env into `env` at launch time, so keep secrets in a
      // gitignored .env file and only set non-secret defaults below.
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3001,

        // API config
        API_BASE_URL: process.env.API_BASE_URL || "https://communities.win/api/v2/",
        COMMUNITY: process.env.COMMUNITY || "your_community_name",

        // Database
        DB_PATH: process.env.DB_PATH || "/root/spictank/data/leaderboard.db",
        BACKUP_DIR: process.env.BACKUP_DIR || "/root/spictank/data/backups",

        // REQUIRED — set this in your shell/.env before starting pm2;
        // server.js refuses to start without it anyway.
        ADMIN_SECRET: process.env.ADMIN_SECRET
      },

      // Restart behavior
      autorestart: true,
      exp_backoff_restart_delay: 100,
      max_memory_restart: "1G",

      // Logging (simplified)
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",

      // Stability
      watch: false,
      max_restarts: 10,
      min_uptime: "10s"
    }
  ]
};