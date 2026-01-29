"use client"

/**
 * Isolation Store
 * 
 * Manages the state for the isolation workflow.
 * Logs can be imported from mission captures for binary isolation analysis.
 */

import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"

export interface IsolationLog {
  id: string
  name: string
  filename: string
  missionId: string
  tags: string[]
  frameCount?: number
  children?: IsolationLog[]
}

interface IsolationStore {
  // Current logs being analyzed
  logs: IsolationLog[]
  
  // Import a log from a mission
  importLog: (log: IsolationLog) => void
  
  // Add a child log (from splitting)
  addChildLog: (parentId: string, child: IsolationLog) => void
  
  // Update log tags (success/failed/original)
  updateLogTags: (logId: string, tags: string[]) => void
  
  // Remove a log
  removeLog: (logId: string) => void
  
  // Clear all logs
  clearLogs: () => void
  
  // Find log by ID (recursive)
  findLog: (logId: string) => IsolationLog | null
}

function findLogRecursive(logs: IsolationLog[], logId: string): IsolationLog | null {
  for (const log of logs) {
    if (log.id === logId) return log
    if (log.children) {
      const found = findLogRecursive(log.children, logId)
      if (found) return found
    }
  }
  return null
}

function updateLogRecursive(logs: IsolationLog[], logId: string, updater: (log: IsolationLog) => IsolationLog): IsolationLog[] {
  return logs.map((log) => {
    if (log.id === logId) {
      return updater(log)
    }
    if (log.children) {
      return { ...log, children: updateLogRecursive(log.children, logId, updater) }
    }
    return log
  })
}

function removeLogRecursive(logs: IsolationLog[], logId: string): IsolationLog[] {
  return logs
    .filter((log) => log.id !== logId)
    .map((log) => {
      if (log.children) {
        return { ...log, children: removeLogRecursive(log.children, logId) }
      }
      return log
    })
}

export const useIsolationStore = create<IsolationStore>()(
  persist(
    (set, get) => ({
      logs: [],

      importLog: (log) => {
        // Check if already imported
        const existing = get().findLog(log.id)
        if (existing) return
        
        set((state) => ({
          logs: [...state.logs, { ...log, tags: ["original"] }],
        }))
      },

      addChildLog: (parentId, child) => {
        set((state) => ({
          logs: updateLogRecursive(state.logs, parentId, (log) => ({
            ...log,
            children: [...(log.children || []), child],
          })),
        }))
      },

      updateLogTags: (logId, tags) => {
        set((state) => ({
          logs: updateLogRecursive(state.logs, logId, (log) => ({
            ...log,
            tags,
          })),
        }))
      },

      removeLog: (logId) => {
        set((state) => ({
          logs: removeLogRecursive(state.logs, logId),
        }))
      },

      clearLogs: () => {
        set({ logs: [] })
      },

      findLog: (logId) => {
        return findLogRecursive(get().logs, logId)
      },
    }),
    {
      name: "aurige-isolation",
      storage: createJSONStorage(() => sessionStorage),
    }
  )
)
