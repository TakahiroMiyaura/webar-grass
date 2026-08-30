// Hooks the headless harness (tools/bench.mjs) reads. Declared rather than cast so the
// bench page and the script cannot drift apart silently.
import type {FrameStats} from '../xr/perf'

declare global {
  interface Window {
    __ready?: boolean
    __bench?: Partial<FrameStats> & {
      calls: number
      triangles: number
      live: number
      flowersLive: number
      n: number
      dpr: number
      shadows: boolean
      feed: boolean
      flowers: boolean
    }
    __measure?: (frameCount?: number) => Promise<FrameStats | null>
    __setState?: (patch: Record<string, unknown>) => Promise<void>
  }
}

export {}
