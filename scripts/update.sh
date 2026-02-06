#!/bin/bash
#
# AURIGE Quick Update Script
# Updates code from git and restarts services
#

set -e

AURIGE_DIR="/opt/aurige"
REPO_DIR="$AURIGE_DIR/repo"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}[INFO]${NC} Updating AURIGE..."

# Navigate to repo
cd "$REPO_DIR"

# Pull latest changes
echo -e "${BLUE}[INFO]${NC} Pulling latest changes..."
git fetch origin
git reset --hard origin/main

# Update Python dependencies if requirements changed
echo -e "${BLUE}[INFO]${NC} Updating Python dependencies..."
source "$AURIGE_DIR/venv/bin/activate"
pip install -q -r backend/requirements.txt 2>/dev/null || true

# Copy backend to deploy location
echo -e "${BLUE}[INFO]${NC} Deploying backend..."
cp -r backend/* "$AURIGE_DIR/backend/"

# Rebuild frontend if needed
echo -e "${BLUE}[INFO]${NC} Rebuilding frontend..."
cd "$REPO_DIR/frontend"
npm install --silent 2>/dev/null || true
npm run build --silent 2>/dev/null || true

# Copy frontend build
if [ -d ".next" ]; then
    cp -r .next "$AURIGE_DIR/frontend/"
fi

# Restart services
echo -e "${BLUE}[INFO]${NC} Restarting services..."
systemctl restart aurige-api.service
sleep 2
systemctl restart aurige-web.service
systemctl restart nginx

echo -e "${GREEN}[OK]${NC} AURIGE updated and services restarted!"
