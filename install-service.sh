#!/bin/bash

# Communities.win Leaderboard - Systemd Service Installation Script

set -e

echo "=========================================="
echo "Leaderboard Systemd Service Installer"
echo "=========================================="
echo ""

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT_USER="$(whoami)"

echo "Detected configuration:"
echo "  User: $CURRENT_USER"
echo "  Directory: $CURRENT_DIR"
echo ""

read -p "Is this correct? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Installation cancelled."
    exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed."
    exit 1
fi

NODE_PATH=$(which node)
echo "Node.js found at: $NODE_PATH"
echo ""

# Create data directory
mkdir -p "$CURRENT_DIR/data/backups"

# Generate a random ADMIN_SECRET if not provided
if [ -z "$ADMIN_SECRET" ]; then
  ADMIN_SECRET=$(openssl rand -hex 32)
  echo "Generated ADMIN_SECRET: $ADMIN_SECRET"
  echo "⚠️ Save this somewhere safe!"
fi

# Create service file
SERVICE_FILE="/tmp/leaderboard.service"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Communities.win Leaderboard Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$CURRENT_DIR

ExecStart=$NODE_PATH $CURRENT_DIR/server.js

Restart=always
RestartSec=5

# Environment
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=DB_PATH=$CURRENT_DIR/data/leaderboard.db
Environment=BACKUP_DIR=$CURRENT_DIR/data/backups
Environment=ADMIN_SECRET=$ADMIN_SECRET

# Logging (use journalctl instead of files)
StandardOutput=journal
StandardError=journal

# Safer security settings (won’t break SQLite)
NoNewPrivileges=true
PrivateTmp=true

# Allow writes to app directory
ReadWritePaths=$CURRENT_DIR

[Install]
WantedBy=multi-user.target
EOF

echo "Service file created."
echo ""

# Install service
sudo cp "$SERVICE_FILE" /etc/systemd/system/leaderboard.service
sudo chmod 644 /etc/systemd/system/leaderboard.service

# Reload systemd
sudo systemctl daemon-reload

# Enable service
sudo systemctl enable leaderboard

echo ""

read -p "Start the service now? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    sudo systemctl start leaderboard
    echo ""
    echo "Service started!"
    sleep 2
    sudo systemctl status leaderboard
else
    echo "Service installed but not started."
fi

echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""

echo "Useful commands:"
echo "  sudo systemctl status leaderboard"
echo "  sudo systemctl stop leaderboard"
echo "  sudo systemctl restart leaderboard"
echo "  sudo journalctl -u leaderboard -f"
echo ""

echo "App running at: http://localhost:3001"
echo ""