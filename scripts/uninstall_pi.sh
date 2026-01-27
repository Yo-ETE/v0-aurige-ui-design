#!/bin/bash
#
# AURIGE Uninstall Script for Raspberry Pi 5
# Removes AURIGE from the system
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

AURIGE_DIR="/opt/aurige"

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[ERROR]${NC} This script must be run as root."
    exit 1
fi

echo ""
echo -e "${YELLOW}============================================${NC}"
echo -e "${YELLOW}    AURIGE Uninstall Script${NC}"
echo -e "${YELLOW}============================================${NC}"
echo ""
echo -e "${RED}WARNING: This will remove AURIGE and all data!${NC}"
echo ""
read -p "Are you sure you want to continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Uninstall cancelled."
    exit 0
fi

log_info "Stopping services..."
systemctl stop aurige-web 2>/dev/null || true
systemctl stop aurige-api 2>/dev/null || true

log_info "Disabling services..."
systemctl disable aurige-web 2>/dev/null || true
systemctl disable aurige-api 2>/dev/null || true

log_info "Removing service files..."
rm -f /etc/systemd/system/aurige-web.service
rm -f /etc/systemd/system/aurige-api.service
systemctl daemon-reload

log_info "Removing nginx configuration..."
rm -f /etc/nginx/sites-enabled/aurige
rm -f /etc/nginx/sites-available/aurige
systemctl restart nginx || true

log_info "Removing application directory..."
rm -rf "$AURIGE_DIR"

log_success "AURIGE has been uninstalled."
echo ""
echo "Note: System packages (Node.js, nginx, Python) were not removed."
echo "To remove them: sudo apt-get remove nodejs nginx python3-venv"
echo ""
