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
# Branch to use - change this if needed
TARGET_BRANCH="main"

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

# Try to get branch from saved config, otherwise use TARGET_BRANCH
SAVED_BRANCH=""
if [ -f "$AURIGE_DIR/branch.txt" ]; then
    SAVED_BRANCH=$(cat "$AURIGE_DIR/branch.txt")
fi

# If saved branch is an old v0 branch, reset to main
if [[ "$SAVED_BRANCH" == v0/* ]]; then
    log_warn "Old v0 branch detected ($SAVED_BRANCH), resetting to main"
    SAVED_BRANCH="main"
    echo "main" > "$AURIGE_DIR/branch.txt" 2>/dev/null || true
fi

BRANCH_TO_USE="${SAVED_BRANCH:-$TARGET_BRANCH}"
log_info "Using branch: $BRANCH_TO_USE"

# Fetch all branches
git fetch origin

# Checkout the target branch
if git rev-parse --verify "origin/$BRANCH_TO_USE" >/dev/null 2>&1; then
    git checkout "$BRANCH_TO_USE"
    log_success "Checked out branch: $BRANCH_TO_USE"
else
    log_warn "Branch $BRANCH_TO_USE not found, trying main..."
    git checkout main
fi

# Save the branch for next time
echo "$BRANCH_TO_USE" > "$AURIGE_DIR/branch.txt" 2>/dev/null || true

log_success "Git cloned: $(git rev-parse --short HEAD)"

# Run install script
log_info "Running install script..."
bash "$TEMP_DIR/scripts/install_pi.sh"

# Clean up
rm -rf "$TEMP_DIR"

log_success "Update complete!"
