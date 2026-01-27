#!/bin/bash
#
# AURIGE Update Script for Raspberry Pi 5
# Updates the application from git and rebuilds
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

AURIGE_DIR="/opt/aurige"

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Check root
if [ "$EUID" -ne 0 ]; then
    log_error "This script must be run as root. Use: sudo bash $0"
fi

echo ""
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}    AURIGE Update Script${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# Stop services
log_info "Stopping services..."
systemctl stop aurige-web || true
systemctl stop aurige-api || true

# Pull latest changes
log_info "Pulling latest changes..."
cd "$AURIGE_DIR"
git pull origin main

# Update frontend
log_info "Updating frontend..."
cd "$AURIGE_DIR/frontend"
npm install --legacy-peer-deps
npm run build

# Update backend
log_info "Updating backend..."
cd "$AURIGE_DIR/backend"
./venv/bin/pip install -r requirements.txt

# Restart services
log_info "Restarting services..."
systemctl daemon-reload
systemctl start aurige-api
systemctl start aurige-web
systemctl restart nginx

log_success "Update complete!"
echo ""
echo -e "Services status:"
systemctl status aurige-web --no-pager -l | head -5
systemctl status aurige-api --no-pager -l | head -5
echo ""
