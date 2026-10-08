/** One rate-limit window: percent used (0 to 100+) and when it resets (epoch ms). */
export type UsageMeterWindow = { kind: string; pct: number; resetsAt?: number }

/** A reading of a window, kept so the burn rate can be measured. */
export type UsageMeterSample = { t: number; pct: number; resetsAt?: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      windows: UsageMeterWindow[]
      history: Record<string, UsageMeterSample[]>
      /** The sheet above the input is showing. */
      isOpen: boolean
    }
  }
}
