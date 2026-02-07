#!/usr/bin/env bash
set -euo pipefail

# ================= CONFIG =================
APP_NAME="nova-server"
PORT="3013"
NODE_ENV="production"
# =========================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${API_DIR}"
export NODE_ENV

# Load NVM if installed (so node/npm work in non-interactive SSH)
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

echo "========================================"
echo "[prod] Deploy started at $(date)"
echo "[prod] App dir: ${API_DIR}"
echo "========================================"

# 1️ Install dependencies
echo "[prod] Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci --omit=dev || npm ci
else
  npm install --omit=dev || npm install
fi

# 2️Generate Prisma client
echo "[prod] Generating Prisma client"
npx prisma generate

#  3 Apply DB changes
# ⚠️ WARNING: db push is okay for early-stage apps.
# For strict production, replace with: prisma migrate deploy
echo "[prod] Applying database schema"
npx prisma db push

# 4 Seed system services
if [ -f "${API_DIR}/seed.js" ]; then
  echo "[prod] Seeding system services"
  node seed.js
fi

# 5️ Optional tests (comment out if slowing prod deploys)
if npm run | grep -q "test"; then
  echo "[prod] Running tests"
  npm test || echo "[warn] Tests failed — continuing deploy"
fi

# 6️ Start or restart PM2
if pm2 list | grep -q "${APP_NAME}"; then
  echo "[prod] Restarting PM2 app: ${APP_NAME}"
  pm2 restart "${APP_NAME}" --update-env
else
  echo "[prod] Starting PM2 app: ${APP_NAME}"
  PORT=${PORT} pm2 start index.js --name "${APP_NAME}" --time
fi

# 7️ Save PM2 state
echo "[prod] Saving PM2 process list"
pm2 save

# 8️ Status
echo "[prod] PM2 status"
pm2 status "${APP_NAME}"

echo "========================================"
echo "[prod] Deploy completed successfully at $(date)"
echo "========================================"
