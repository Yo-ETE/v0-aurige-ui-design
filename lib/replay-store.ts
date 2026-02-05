import { create } from "zustand"
import { persist } from "zustand/middleware"

export interface ReplayFrame {
  canId: string
  data: string
  timestamp: string
  source?: string
}

interface ReplayState {
  frames: ReplayFrame[]
  addFrames: (frames: ReplayFrame[]) => void
  addFrame: (frame: ReplayFrame) => void
  removeFrame: (index: number) => void
  clearFrames: () => void
  updateFrame: (index: number, frame: Partial<ReplayFrame>) => void
}

export const useReplayStore = create<ReplayState>()(
  persist(
    (set) => ({
      frames: [],
      addFrames: (newFrames) =>
        set((state) => ({
          frames: [...state.frames, ...newFrames],
        })),
      addFrame: (frame) =>
        set((state) => ({
          frames: [...state.frames, frame],
        })),
      removeFrame: (index) =>
        set((state) => ({
          frames: state.frames.filter((_, i) => i !== index),
        })),
      clearFrames: () => set({ frames: [] }),
      updateFrame: (index, updatedFrame) =>
        set((state) => ({
          frames: state.frames.map((frame, i) =>
            i === index ? { ...frame, ...updatedFrame } : frame
          ),
        })),
    }),
    {
      name: "aurige-replay-store",
    }
  )
)
