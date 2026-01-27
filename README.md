# AURIGE - CAN Bus Analysis Tool

Professional CAN bus analysis tool for automotive forensics and diagnostics, designed for Raspberry Pi 5.

## Hardware Requirements

- **Raspberry Pi 5** (ARM64)
- CAN interface (MCP2515, Waveshare CAN HAT, or similar)
- SD Card (16GB minimum, 32GB recommended)
- Power supply (5V 5A USB-C recommended)

## Software Prerequisites

- Raspberry Pi OS (64-bit, Debian Bookworm based)
- Internet connection for installation

## Quick Installation

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/aurige/main/scripts/install_pi.sh | sudo bash
```

### Manual Installation

1. **Update system and install dependencies:**

```bash
sudo apt-get update
sudo apt-get install -y curl git nginx python3 python3-venv python3-pip can-utils build-essential
```

2. **Install Node.js LTS:**

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash -
sudo apt-get install -y nodejs
```

3. **Clone the repository:**

```bash
sudo mkdir -p /opt/aurige
cd /opt/aurige
sudo git clone https://github.com/YOUR_REPO/aurige.git .
```

4. **Setup frontend:**

```bash
cd /opt/aurige/frontend
sudo npm install --legacy-peer-deps
sudo npm run build
```

5. **Setup backend:**

```bash
cd /opt/aurige/backend
sudo python3 -m venv venv
sudo ./venv/bin/pip install -r requirements.txt
```

6. **Install systemd services:**

```bash
sudo cp /opt/aurige/deploy/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable aurige-web aurige-api
sudo systemctl start aurige-web aurige-api
```

7. **Configure nginx:**

```bash
sudo cp /opt/aurige/deploy/nginx-aurige.conf /etc/nginx/sites-available/aurige
sudo ln -sf /etc/nginx/sites-available/aurige /etc/nginx/sites-enabled/aurige
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl restart nginx
```

## Accessing AURIGE

After installation, access the application at:

| Service | URL |
|---------|-----|
| Web Interface | `http://<raspberry-pi-ip>/` |
| API | `http://<raspberry-pi-ip>/api` |
| API Docs | `http://<raspberry-pi-ip>/api/docs` |
| Health Check | `http://<raspberry-pi-ip>/api/health` |

To find your Raspberry Pi's IP address:

```bash
hostname -I
```

## Service Management

### Start Services

```bash
sudo systemctl start aurige-web
sudo systemctl start aurige-api
```

### Stop Services

```bash
sudo systemctl stop aurige-web
sudo systemctl stop aurige-api
```

### Restart Services

```bash
sudo systemctl restart aurige-web
sudo systemctl restart aurige-api
sudo systemctl restart nginx
```

### Check Service Status

```bash
sudo systemctl status aurige-web
sudo systemctl status aurige-api
```

## Viewing Logs

### Real-time Logs

```bash
# Web frontend logs
sudo journalctl -u aurige-web -f

# API backend logs
sudo journalctl -u aurige-api -f

# Nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Historical Logs

```bash
# Last 100 lines of web logs
sudo journalctl -u aurige-web -n 100

# Logs since boot
sudo journalctl -u aurige-api -b

# Logs from specific time
sudo journalctl -u aurige-web --since "2025-01-27 10:00:00"
```

## Updating AURIGE

### From Git Repository

```bash
cd /opt/aurige
sudo git pull origin main

# Rebuild frontend
cd /opt/aurige/frontend
sudo npm install --legacy-peer-deps
sudo npm run build

# Update backend dependencies
cd /opt/aurige/backend
sudo ./venv/bin/pip install -r requirements.txt

# Restart services
sudo systemctl restart aurige-web aurige-api
```

### Re-run Installer

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/aurige/main/scripts/install_pi.sh | sudo bash
```

## CAN Interface Setup

### Enable CAN Interface

```bash
# Load CAN kernel modules
sudo modprobe can
sudo modprobe can_raw
sudo modprobe mcp251x  # For MCP2515 based interfaces

# Bring up CAN0 at 500kbps
sudo ip link set can0 type can bitrate 500000
sudo ip link set up can0

# Verify
ip link show can0
```

### Auto-start CAN on Boot

Add to `/etc/network/interfaces.d/can0`:

```
auto can0
iface can0 inet manual
    pre-up /sbin/ip link set can0 type can bitrate 500000
    up /sbin/ip link set up can0
    down /sbin/ip link set down can0
```

### Test CAN Interface

```bash
# Send a test frame
cansend can0 123#DEADBEEF

# Monitor CAN traffic
candump can0
```

## Data Directory Structure

```
/opt/aurige/
├── frontend/          # Next.js application
├── backend/           # FastAPI application
│   └── venv/          # Python virtual environment
└── data/
    ├── missions/      # Mission JSON files
    └── logs/          # CAN capture logs
        └── <mission-id>/
            ├── capture_001.log
            └── capture_001.meta.json
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | `/api` | Frontend API base URL |
| `AURIGE_DATA_DIR` | `/opt/aurige/data` | Data storage directory |
| `PORT` (web) | `3000` | Frontend port |
| `PORT` (api) | `8000` | Backend port |

## Troubleshooting

### Services Won't Start

```bash
# Check for errors
sudo journalctl -u aurige-web -n 50
sudo journalctl -u aurige-api -n 50

# Verify ports aren't in use
sudo netstat -tlnp | grep -E '3000|8000'
```

### Nginx 502 Bad Gateway

```bash
# Check if backend services are running
sudo systemctl status aurige-web aurige-api

# Restart all services
sudo systemctl restart aurige-api aurige-web nginx
```

### CAN Interface Not Found

```bash
# Check if CAN modules are loaded
lsmod | grep can

# Load modules manually
sudo modprobe can
sudo modprobe can_raw

# Check dmesg for hardware errors
dmesg | grep -i can
```

### Permission Denied Errors

```bash
# Fix data directory permissions
sudo chmod -R 777 /opt/aurige/data
```

## API Reference

### System

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/status` | GET | System status (CPU, memory, CAN, network) |

### CAN Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/can/init` | POST | Initialize CAN interface with bitrate |
| `/api/can/stop` | POST | Bring down CAN interface |
| `/api/can/send` | POST | Send single CAN frame |
| `/api/can/{interface}/status` | GET | Get CAN interface status |

### Capture & Replay

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/capture/start` | POST | Start CAN capture to file |
| `/api/capture/stop` | POST | Stop capture |
| `/api/capture/status` | GET | Get capture status |
| `/api/replay/start` | POST | Start log replay |
| `/api/replay/stop` | POST | Stop replay |
| `/api/replay/status` | GET | Get replay status |

### Generator & Fuzzing

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/generator/start` | POST | Start CAN traffic generator |
| `/api/generator/stop` | POST | Stop generator |
| `/api/fuzzing/start` | POST | Start fuzzing sequence |
| `/api/fuzzing/stop` | POST | Stop fuzzing |

### OBD-II Diagnostics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/obd/vin` | POST | Request VIN |
| `/api/obd/dtc/read` | POST | Read DTCs |
| `/api/obd/dtc/clear` | POST | Clear DTCs |
| `/api/obd/reset` | POST | ECU reset |
| `/api/obd/pid` | POST | Read specific OBD PID |

### Missions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/missions` | GET | List all missions |
| `/api/missions` | POST | Create mission |
| `/api/missions/{id}` | GET | Get mission |
| `/api/missions/{id}` | PATCH | Update mission |
| `/api/missions/{id}` | DELETE | Delete mission |
| `/api/missions/{id}/duplicate` | POST | Duplicate mission |
| `/api/missions/{id}/logs` | GET | List mission logs |
| `/api/missions/{id}/logs/{log_id}` | DELETE | Delete log |
| `/api/missions/{id}/logs/{log_id}/download` | GET | Download log |

### WebSocket Streams

| Endpoint | Description |
|----------|-------------|
| `/ws/candump?interface=can0` | Live CAN frame stream |
| `/ws/cansniffer?interface=can0` | Aggregated CAN view |

## License

MIT License - See LICENSE file for details.
