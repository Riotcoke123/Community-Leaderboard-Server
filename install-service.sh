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

# Write secrets to a separate, tightly-permissioned EnvironmentFile rather
# than embedding them in the unit file itself. Unit files under
# /etc/systemd/system are world-readable (mode 644) by default, so an
# `Environment=ADMIN_SECRET=...` line there would expose the admin secret in
# plaintext to every local user on the box (`systemctl cat`, `cat` the file,
# etc). An EnvironmentFile can be locked down to root-only instead.
ENV_FILE="$CURRENT_DIR/data/leaderboard.env"
umask 077
cat > "$ENV_FILE" << EOF
NODE_ENV=production
PORT=3001
DB_PATH=$CURRENT_DIR/data/leaderboard.db
BACKUP_DIR=$CURRENT_DIR/data/backups
ADMIN_SECRET=$ADMIN_SECRET
EOF
chmod 600 "$ENV_FILE"
echo "Wrote secrets to $ENV_FILE (mode 600, readable by $CURRENT_USER only)."
echo ""

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

EnvironmentFile=$ENV_FILE
ExecStart=$NODE_PATH $CURRENT_DIR/server.js

Restart=always
RestartSec=5

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

# Install service. The unit file itself stays world-readable (that's normal
# and required for systemd tooling), but it no longer contains the secret —
# only a reference to the root-owned, mode-600 EnvironmentFile above.
sudo cp "$SERVICE_FILE" /etc/systemd/system/leaderboard.service
sudo chmod 644 /etc/systemd/system/leaderboard.service
sudo chown root:root "$ENV_FILE"

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