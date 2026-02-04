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
GITHUB_REPO="https://github.com/Yo-ETE/v0-aurige-ui-design.git"
TEMP_DIR="/tmp/aurige-update"

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

# Stop services first
log_info "Stopping services..."
systemctl stop aurige-web aurige-api 2>/dev/null || true

# Clean up temp directory
rm -rf "$TEMP_DIR"

# Clone fresh from GitHub
log_info "Cloning latest from GitHub..."
git clone "$GITHUB_REPO" "$TEMP_DIR"
cd "$TEMP_DIR"

# Get current branch from existing installation or use main
if [ -f "$AURIGE_DIR/repo/.git/HEAD" ]; then
    CURRENT_BRANCH=$(cat "$AURIGE_DIR/repo/.git/HEAD" | sed 's/ref: refs\/heads\///')
    log_info "Detected branch: $CURRENT_BRANCH"
    
    # Check if this branch exists on origin
    if git rev-parse --verify "origin/$CURRENT_BRANCH" >/dev/null 2>&1; then
        git checkout "$CURRENT_BRANCH"
    else
        log_warn "Branch $CURRENT_BRANCH not found, using main"
        git checkout main
    fi
fi

log_success "Git cloned: $(git rev-parse --short HEAD)"

# Run install script
log_info "Running install script..."
bash "$TEMP_DIR/scripts/install_pi.sh"

# Clean up
rm -rf "$TEMP_DIR"

log_success "Update complete!"
