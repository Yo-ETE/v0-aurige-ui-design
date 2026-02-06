/**
 * AURIGE API Configuration
 * 
 * On Raspberry Pi deployment, the frontend is served by nginx on port 80.
 * Nginx proxies /api/* to the FastAPI backend on port 8000.
 * 
 * Environment Variables:
 * - NEXT_PUBLIC_API_URL: Override API base URL (optional, defaults to same origin)
 * - NEXT_PUBLIC_WS_URL: Override WebSocket URL (optional, auto-derived from API_URL)
 * 
 * Examples:
 * - Production (nginx proxy): NEXT_PUBLIC_API_URL is not set (uses /api on same origin)
 * - Development: NEXT_PUBLIC_API_URL=http://192.168.1.100:8000
 * - Direct access: NEXT_PUBLIC_API_URL=http://pi.local:8000
 */

/**
 * Get the API base URL.
 * In production with nginx, this returns empty string (same origin).
 * For direct backend access, set NEXT_PUBLIC_API_URL.
 */
export function getApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    return process.env.NEXT_PUBLIC_API_URL || ""
  }
  return process.env.NEXT_PUBLIC_API_URL || ""
}

/**
 * Get the WebSocket base URL.
 * Auto-derives from current page location if not explicitly set.
 */
export function getWsBaseUrl(): string {
  if (typeof window !== "undefined") {
    if (process.env.NEXT_PUBLIC_WS_URL) {
      return process.env.NEXT_PUBLIC_WS_URL
    }
    // Auto-derive from current location
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    return `${protocol}//${window.location.host}`
  }
  return process.env.NEXT_PUBLIC_WS_URL || ""
}

/**
 * Get the current API host for display purposes.
 * Returns the hostname being used for API calls.
 */
export function getApiHost(): string {
  if (typeof window !== "undefined") {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL
    if (apiUrl) {
      try {
        const url = new URL(apiUrl)
        return url.host
      } catch {
        return apiUrl
      }
    }
    // Using same origin
    return window.location.host
  }
  return "localhost"
}
