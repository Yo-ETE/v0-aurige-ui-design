#!/bin/bash
#
# AURIGE Installation Script for Raspberry Pi 5
# This script installs and configures AURIGE on a fresh Raspberry Pi OS (ARM64)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/aurige/main/scripts/install_pi.sh | sudo bash
#
# Or locally:
#   sudo bash scripts/install_pi.sh
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
AURIGE_DIR="/opt/aurige"
REPO_URL="${AURIGE_REPO_URL:-https://github.com/YOUR_REPO/aurige.git}"
BRANCH="${AURIGE_BRANCH:-main}"

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# Check if running as root
check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "This script must be run as root. Use: sudo bash $0"
    fi
}

# Check architecture
check_arch() {
    ARCH=$(uname -m)
    if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
        log_warn "This script is optimized for ARM64. Detected: $ARCH"
    fi
    log_success "Architecture: $ARCH"
}

# Install system dependencies
install_system_deps() {
    log_info "Updating package lists..."
    apt-get update

    log_info "Installing system dependencies..."
    apt-get install -y \
        curl \
        git \
        nginx \
        python3 \
        python3-venv \
        python3-pip \
        can-utils \
        build-essential

    log_success "System dependencies installed"
}

# Install Node.js LTS
install_nodejs() {
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v)
        log_info "Node.js already installed: $NODE_VERSION"
    else
        log_info "Installing Node.js LTS..."
        curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
        apt-get install -y nodejs
        log_success "Node.js installed: $(node -v)"
    fi

    # Install npm if not present
    if ! command -v npm &> /dev/null; then
        apt-get install -y npm
    fi
    log_success "npm installed: $(npm -v)"
}

# Create directory structure
setup_directories() {
    log_info "Creating directory structure..."
    
    mkdir -p "$AURIGE_DIR"
    mkdir -p "$AURIGE_DIR/frontend"
    mkdir -p "$AURIGE_DIR/backend"
    mkdir -p "$AURIGE_DIR/data/missions"
    mkdir -p "$AURIGE_DIR/data/logs"
    
    log_success "Directory structure created at $AURIGE_DIR"
}

# Copy project files
copy_project_files() {
    log_info "Copying project files..."
    
    # Determine source directory
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
    
    # Check if we're running from a cloned repo
    if [ -d "$PROJECT_ROOT/app" ] && [ -d "$PROJECT_ROOT/backend" ]; then
        log_info "Installing from local directory: $PROJECT_ROOT"
        
        # Copy frontend files (Next.js)
        cp -r "$PROJECT_ROOT/app" "$AURIGE_DIR/frontend/"
        cp -r "$PROJECT_ROOT/components" "$AURIGE_DIR/frontend/"
        cp -r "$PROJECT_ROOT/lib" "$AURIGE_DIR/frontend/"
        cp -r "$PROJECT_ROOT/hooks" "$AURIGE_DIR/frontend/"
        cp -r "$PROJECT_ROOT/public" "$AURIGE_DIR/frontend/"
        [ -d "$PROJECT_ROOT/styles" ] && cp -r "$PROJECT_ROOT/styles" "$AURIGE_DIR/frontend/"
        cp "$PROJECT_ROOT/package.json" "$AURIGE_DIR/frontend/"
        [ -f "$PROJECT_ROOT/pnpm-lock.yaml" ] && cp "$PROJECT_ROOT/pnpm-lock.yaml" "$AURIGE_DIR/frontend/"
        [ -f "$PROJECT_ROOT/package-lock.json" ] && cp "$PROJECT_ROOT/package-lock.json" "$AURIGE_DIR/frontend/"
        cp "$PROJECT_ROOT/tsconfig.json" "$AURIGE_DIR/frontend/"
        cp "$PROJECT_ROOT/next.config.mjs" "$AURIGE_DIR/frontend/"
        cp "$PROJECT_ROOT/postcss.config.mjs" "$AURIGE_DIR/frontend/"
        [ -f "$PROJECT_ROOT/components.json" ] && cp "$PROJECT_ROOT/components.json" "$AURIGE_DIR/frontend/"
        
        # Copy backend files (FastAPI)
        cp -r "$PROJECT_ROOT/backend/"* "$AURIGE_DIR/backend/"
        
        # Copy deploy files
        cp "$PROJECT_ROOT/deploy/"*.service /etc/systemd/system/
        cp "$PROJECT_ROOT/deploy/nginx-aurige.conf" /etc/nginx/sites-available/aurige
        
    else
        # Clone from git
        log_info "Cloning from repository: $REPO_URL"
        
        TEMP_DIR=$(mktemp -d)
        git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TEMP_DIR"
        
        # Copy files
        cp -r "$TEMP_DIR/app" "$AURIGE_DIR/frontend/"
        cp -r "$TEMP_DIR/components" "$AURIGE_DIR/frontend/"
        cp -r "$TEMP_DIR/lib" "$AURIGE_DIR/frontend/"
        cp -r "$TEMP_DIR/hooks" "$AURIGE_DIR/frontend/"
        cp -r "$TEMP_DIR/public" "$AURIGE_DIR/frontend/"
        [ -d "$TEMP_DIR/styles" ] && cp -r "$TEMP_DIR/styles" "$AURIGE_DIR/frontend/"
        cp "$TEMP_DIR/package.json" "$AURIGE_DIR/frontend/"
        [ -f "$TEMP_DIR/pnpm-lock.yaml" ] && cp "$TEMP_DIR/pnpm-lock.yaml" "$AURIGE_DIR/frontend/"
        [ -f "$TEMP_DIR/package-lock.json" ] && cp "$TEMP_DIR/package-lock.json" "$AURIGE_DIR/frontend/"
        cp "$TEMP_DIR/tsconfig.json" "$AURIGE_DIR/frontend/"
        cp "$TEMP_DIR/next.config.mjs" "$AURIGE_DIR/frontend/"
        cp "$TEMP_DIR/postcss.config.mjs" "$AURIGE_DIR/frontend/"
        [ -f "$TEMP_DIR/components.json" ] && cp "$TEMP_DIR/components.json" "$AURIGE_DIR/frontend/"
        
        cp -r "$TEMP_DIR/backend/"* "$AURIGE_DIR/backend/"
        
        cp "$TEMP_DIR/deploy/"*.service /etc/systemd/system/
        cp "$TEMP_DIR/deploy/nginx-aurige.conf" /etc/nginx/sites-available/aurige
        
        rm -rf "$TEMP_DIR"
    fi
    
    log_success "Project files copied"
}

# Install frontend dependencies and build
setup_frontend() {
    log_info "Setting up frontend..."
    
    cd "$AURIGE_DIR/frontend"
    
    # Create .env file
    cat > .env.local << EOF
NEXT_PUBLIC_API_URL=/api
EOF
    
    log_info "Installing npm dependencies (this may take a few minutes)..."
    npm install --legacy-peer-deps
    
    log_info "Building Next.js application..."
    npm run build
    
    log_success "Frontend built successfully"
}

# Setup Python virtual environment and install backend
setup_backend() {
    log_info "Setting up backend..."
    
    cd "$AURIGE_DIR/backend"
    
    # Create virtual environment
    python3 -m venv venv
    
    # Install dependencies
    ./venv/bin/pip install --upgrade pip
    ./venv/bin/pip install -r requirements.txt
    
    log_success "Backend setup complete"
}

# Configure nginx
setup_nginx() {
    log_info "Configuring nginx..."
    
    # Remove default site if exists
    rm -f /etc/nginx/sites-enabled/default
    
    # Enable aurige site
    ln -sf /etc/nginx/sites-available/aurige /etc/nginx/sites-enabled/aurige
    
    # Test nginx configuration
    nginx -t
    
    log_success "Nginx configured"
}

# Setup systemd services
setup_services() {
    log_info "Setting up systemd services..."
    
    # Reload systemd
    systemctl daemon-reload
    
    # Enable services
    systemctl enable aurige-web.service
    systemctl enable aurige-api.service
    
    # Start services
    systemctl restart aurige-api.service
    systemctl restart aurige-web.service
    systemctl restart nginx
    
    log_success "Services enabled and started"
}

# Set permissions
set_permissions() {
    log_info "Setting permissions..."
    
    chown -R root:root "$AURIGE_DIR"
    chmod -R 755 "$AURIGE_DIR"
    chmod -R 777 "$AURIGE_DIR/data"
    
    log_success "Permissions set"
}

# Print summary
print_summary() {
    # Get IP address
    IP=$(hostname -I | awk '{print $1}')
    
    echo ""
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN}    AURIGE Installation Complete!${NC}"
    echo -e "${GREEN}============================================${NC}"
    echo ""
    echo -e "Access AURIGE at:"
    echo -e "  ${BLUE}http://${IP}/${NC}          (Web UI)"
    echo -e "  ${BLUE}http://${IP}/api${NC}      (API)"
    echo ""
    echo -e "Useful commands:"
    echo -e "  ${YELLOW}sudo systemctl status aurige-web${NC}   - Check web service"
    echo -e "  ${YELLOW}sudo systemctl status aurige-api${NC}   - Check API service"
    echo -e "  ${YELLOW}sudo journalctl -u aurige-web -f${NC}   - View web logs"
    echo -e "  ${YELLOW}sudo journalctl -u aurige-api -f${NC}   - View API logs"
    echo -e "  ${YELLOW}sudo systemctl restart aurige-web${NC}  - Restart web"
    echo -e "  ${YELLOW}sudo systemctl restart aurige-api${NC}  - Restart API"
    echo ""
    echo -e "Data directory: ${BLUE}$AURIGE_DIR/data${NC}"
    echo ""
}

# Main installation
main() {
    echo ""
    echo -e "${BLUE}============================================${NC}"
    echo -e "${BLUE}    AURIGE Installer for Raspberry Pi 5${NC}"
    echo -e "${BLUE}============================================${NC}"
    echo ""
    
    check_root
    check_arch
    install_system_deps
    install_nodejs
    setup_directories
    copy_project_files
    setup_frontend
    setup_backend
    setup_nginx
    set_permissions
    setup_services
    print_summary
}

# Run main
main "$@"
