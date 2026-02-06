"use client"

import React from "react"

import { Sidebar } from "@/components/sidebar"

interface AppShellProps {
  children: React.ReactNode
  title: string
  description?: string
}

export function AppShell({ children, title, description }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="min-h-screen lg:ml-64">
        <div className="border-b border-border bg-card/30 px-4 py-4 pl-16 lg:px-8 lg:py-6 lg:pl-8">
          <h1 className="text-xl lg:text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-xs lg:text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="p-4 lg:p-8 pb-96">{children}</div>
      </main>
    </div>
  )
}
