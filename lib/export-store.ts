import { create } from "zustand"

export interface ExportedFrame {
  canId: string
  data: string
  timestamp?: string
  source: string // nom du log source
}

interface ExportStore {
  frames: ExportedFrame[]
  
  // Add frames from isolation
  addFrames: (frames: ExportedFrame[]) => void
  
  // Clear all
  clearFrames: () => void
  
  // Remove a single frame
  removeFrame: (index: number) => void
}

export const useExportStore = create<ExportStore>((set) => ({
  frames: [],
  
  addFrames: (newFrames) => {
    set((state) => ({
      frames: [...state.frames, ...newFrames],
    }))
  },
  
  clearFrames: () => {
    set({ frames: [] })
  },
  
  removeFrame: (index) => {
    set((state) => ({
      frames: state.frames.filter((_, i) => i !== index),
    }))
  },
}))
