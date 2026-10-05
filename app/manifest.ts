import type { MetadataRoute } from "next"

// Manifest PWA : permet l'ajout a l'ecran d'accueil (icone AURIGE + mode standalone).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AURIGE - Mastery of CAN",
    short_name: "AURIGE",
    description: "Suite embarquee d'analyse et de reverse-engineering du bus CAN automobile.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1a1a2e",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}
