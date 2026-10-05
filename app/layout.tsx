import React from "react"
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { FloatingTerminal } from "@/components/floating-terminal"
import { Toaster } from "@/components/ui/toaster"
import { AuthGate } from "@/components/auth-gate"
import { AuthProvider } from "@/lib/auth-context"

const _geist = Geist({ subsets: ["latin"] });
const _geistMono = Geist_Mono({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: 'AURIGE - CAN Bus Analysis',
  description: 'Professional CAN bus analysis tool for automotive forensics and diagnostics',
  applicationName: 'AURIGE',
  // Icone d'ecran d'accueil iOS (apple-icon.png) + favicon (icon.png) auto-cables par app/.
  appleWebApp: {
    capable: true,
    title: 'AURIGE',
    statusBarStyle: 'black-translucent',
  },
}

export const viewport: Viewport = {
  themeColor: '#1a1a2e',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body className="font-sans antialiased bg-background text-foreground" suppressHydrationWarning>
        <AuthProvider>
          <AuthGate>
            {children}
            <FloatingTerminal />
          </AuthGate>
        </AuthProvider>
        <Toaster />
      </body>
    </html>
  )
}
