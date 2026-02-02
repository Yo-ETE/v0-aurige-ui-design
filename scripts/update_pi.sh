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

# Pull latest changes using fetch + reset to avoid divergent branch issues
log_info "Fetching latest changes..."
cd /tmp/aurige

# Add safe directory
git config --global --add safe.directory /tmp/aurige

# Fetch all
git fetch origin

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)
log_info "Current branch: $CURRENT_BRANCH"

# Try to reset to origin/{current_branch}, fallback to origin/main
if git rev-parse --verify "origin/$CURRENT_BRANCH" >/dev/null 2>&1; then
    log_info "Resetting to origin/$CURRENT_BRANCH..."
    git reset --hard "origin/$CURRENT_BRANCH"
else
    log_info "Branch $CURRENT_BRANCH not found on origin, using origin/main..."
    git reset --hard origin/main
fi

log_success "Git updated to: $(git rev-parse --short HEAD)"

# Run install script to copy files and rebuild
log_info "Running install script..."
bash /tmp/aurige/scripts/install_pi.sh

# install_pi.sh already restarts services, so we're done
log_success "Update complete!"
