/** One rate-limit window: percent used (0 to 100+) and when it resets (epoch ms). */
export type UsageMeterWindow = {
  kind: string
  pct: number
  resetsAt?: number
  /** Where the reading came from: the app's live usage card, or Claude Code's last response. */
  src?: 'app' | 'engine'
}

/** A reading of a window, kept so the burn rate can be measured. */
export type UsageMeterSample = { t: number; pct: number; resetsAt?: number }

/** How fast limit is being used right now. */
export type UsageMeterPace = {
  /** Weighted tokens per minute across every running session, over the last few minutes. */
  tokensPerMin: number
  /** Percent of the session limit one weighted token costs, learned from how the percent moved. */
  pctPerToken: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      windows: UsageMeterWindow[]
      history: Record<string, UsageMeterSample[]>
      /** The sheet above the input is showing. */
      isOpen: boolean
      pace: UsageMeterPace
    }
  }
}
