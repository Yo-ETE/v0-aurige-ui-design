"use client"

import React from "react"

import { Sidebar } from "@/components/sidebar"
import { FloatingTerminal } from "@/components/floating-terminal"

interface AppShellProps {
  children: React.ReactNode
  title: string
  description?: string
}

export function AppShell({ children, title, description }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="ml-64 min-h-screen">
        <div className="border-b border-border bg-card/30 px-8 py-6">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="p-8 pb-96">{children}</div>
      </main>
      <FloatingTerminal />
    </div>
  )
}
