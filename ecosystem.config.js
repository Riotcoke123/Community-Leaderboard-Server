module.exports = {
  apps: [
    {
      name: "spic",
      script: "./server.js",

      // Run in cluster mode for better performance (optional)
      exec_mode: "fork", // change to "cluster" later if needed
      instances: 1,

      // Environment variables
      env: {
        NODE_ENV: "production",
        PORT: 3001,

        // API config
        API_BASE_URL: "https://communities.win/api/v2/",
        COMMUNITY: "your_community_name",

        // Database (FIXED PATH)
        DB_PATH: "/root/spictank/data/leaderboard.db",
        BACKUP_DIR: "/root/spictank/data/backups",

        // REQUIRED (must also exist in .env ideally)
        ADMIN_SECRET: "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET"
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