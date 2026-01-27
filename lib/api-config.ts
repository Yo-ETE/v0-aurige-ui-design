/**
 * AURIGE API Configuration
 * 
 * Configure API URL via environment variable:
 * NEXT_PUBLIC_API_URL=http://192.168.1.100:8000
 * 
 * Or update the fallback IP below for your Raspberry Pi.
 */

// Fallback IP - used only if NEXT_PUBLIC_API_URL is not set
const FALLBACK_IP = "192.168.1.100"
const FALLBACK_PORT = "8000"

export function getRaspberryPiUrl(): string {
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL
  }
  return `http://${FALLBACK_IP}:${FALLBACK_PORT}`
}

export function getRaspberryPiWsUrl(): string {
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL
  }
  const httpUrl = getRaspberryPiUrl()
  return httpUrl.replace(/^http/, "ws")
}

export const API_CONFIG = {
  getHttpUrl: getRaspberryPiUrl,
  getWsUrl: getRaspberryPiWsUrl,
}
