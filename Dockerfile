# =========================
# 1️⃣ BUILD STAGE
# =========================
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Install build dependencies (required for better-sqlite3 native build)
RUN apk add --no-cache python3 make g++

# Copy package files first (for better layer caching)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy app source
COPY server.js ./
COPY public/ ./public/

# =========================
# 2️⃣ PRODUCTION STAGE
# =========================
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Create data directories (persistent volume mount target)
RUN mkdir -p /app/data /app/data/backups

# Copy only built app + node_modules from builder
COPY --from=builder /app /app

# Set ownership to non-root user
RUN chown -R node:node /app

# Switch to non-root user
USER node

# Expose app port
EXPOSE 3001

# Environment variables
ENV NODE_ENV=production
ENV DB_PATH=/app/data/leaderboard.db
ENV BACKUP_DIR=/app/data/backups

# Healthcheck with timeout protection
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const req=require('http').get('http://localhost:3001/api/stats',res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000);"

# Start the app
CMD ["node", "server.js"]