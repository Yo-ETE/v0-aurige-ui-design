// AURIGE API Configuration
// Update RASPBERRY_PI_IP to match your Raspberry Pi's IP address

const RASPBERRY_PI_IP = "192.168.1.100"
const RASPBERRY_PI_PORT = "8000"

export function getRaspberryPiUrl(): string {
  return `http://${RASPBERRY_PI_IP}:${RASPBERRY_PI_PORT}`
}

export function getRaspberryPiWsUrl(): string {
  return `ws://${RASPBERRY_PI_IP}:${RASPBERRY_PI_PORT}`
}

export const API_CONFIG = {
  ip: RASPBERRY_PI_IP,
  port: RASPBERRY_PI_PORT,
  httpUrl: `http://${RASPBERRY_PI_IP}:${RASPBERRY_PI_PORT}`,
  wsUrl: `ws://${RASPBERRY_PI_IP}:${RASPBERRY_PI_PORT}`,
}
