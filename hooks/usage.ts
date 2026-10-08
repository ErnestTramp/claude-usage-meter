import type { UsageMeterPace, UsageMeterSample, UsageMeterWindow } from '../types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

type History = Record<string, UsageMeterSample[]>

const SAME_WINDOW_MS = 5 * MINUTE
/** A run-out this close to the reset is not worth a warning. */
export const RUN_OUT_MARGIN_MS = 10 * MINUTE
const KEEP_MS = 8 * DAY
const KEEP_SAMPLES = 240

export function windowLength(kind: string): number | null {
  if (kind.startsWith('five_hour')) return 5 * HOUR
  if (kind.startsWith('seven_day')) return 7 * DAY
  return null
}

function titleCase(slug: string): string {
  return slug
    .split('_')
    .filter(part => part !== '')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function labelFor(kind: string): string {
  if (kind === 'five_hour') return 'Session'
  if (kind === 'seven_day') return 'Week'
  const model = /^seven_day_(.+)$/.exec(kind)
  if (model !== null) return titleCase(model[1] ?? '')
  if (kind === 'spend_limit') return 'Spend'
  return titleCase(kind)
}

function rank(kind: string): number {
  if (kind === 'five_hour') return 0
  if (kind === 'seven_day') return 1
  if (kind.startsWith('seven_day_')) return 2
  return 3
}

export function sortWindows(list: UsageMeterWindow[]): UsageMeterWindow[] {
  return [...list].sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind))
}

/** "47m", "2h 14m", "2d 3h". */
export function fmtDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`
}

export function sameWindow(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return Math.abs(a - b) < SAME_WINDOW_MS
}

/**
 * Folds new readings into the old. Within one window the percent only goes up (a lower
 * reading is stale or rounded), and a reading from a window that has already ended is
 * ignored once a newer window is known.
 */
export function mergeWindows(
  prev: UsageMeterWindow[],
  incoming: UsageMeterWindow[],
): UsageMeterWindow[] {
  const byKind = new Map<string, UsageMeterWindow>(prev.map(w => [w.kind, w]))
  for (const w of incoming) {
    const old = byKind.get(w.kind)
    if (old === undefined) {
      byKind.set(w.kind, w)
      continue
    }
    const isOlderWindow =
      old.resetsAt !== undefined && w.resetsAt !== undefined && w.resetsAt < old.resetsAt - SAME_WINDOW_MS
    if (isOlderWindow) continue
    if (sameWindow(old.resetsAt, w.resetsAt)) {
      byKind.set(w.kind, { ...w, pct: Math.max(old.pct, w.pct) })
    } else {
      byKind.set(w.kind, w)
    }
  }

  return sortWindows([...byKind.values()])
}

/**
 * Appends a sample for each window that rose (or is new), drops old ones.
 * Same `history` object back when nothing changed.
 */
export function recordSamples(
  history: History,
  windows: UsageMeterWindow[],
  now: number,
): { history: History; changed: boolean } {
  let changed = false
  const next: History = {}
  for (const [kind, list] of Object.entries(history)) {
    const kept = list.filter(s => now - s.t < KEEP_MS)
    if (kept.length !== list.length) changed = true
    next[kind] = kept
  }
  for (const w of windows) {
    const list = next[w.kind] ?? []
    const last = list.filter(s => sameWindow(s.resetsAt, w.resetsAt)).at(-1)
    if (last === undefined || w.pct > last.pct) {
      const sample: UsageMeterSample =
        w.resetsAt === undefined ? { t: now, pct: w.pct } : { t: now, pct: w.pct, resetsAt: w.resetsAt }
      next[w.kind] = [...list, sample].slice(-KEEP_SAMPLES)
      changed = true
    }
  }

  return changed ? { history: next, changed } : { history, changed }
}

export type Forecast = {
  /** Percent per hour; 0 when idle, null when unknown. */
  rate: number | null
  basis: 'tokens' | 'recent' | 'average' | 'none'
  resetsInMs: number | null
  /** Time until 100% at this pace; null when not burning. 0 when full. */
  msToFull: number | null
  /** Where it will stand at reset at this pace, uncapped. */
  projectedAtReset: number | null
  /** True when 100% comes well before the reset (by more than RUN_OUT_MARGIN_MS). */
  willRunOut: boolean
  isFull: boolean
}

/**
 * Burn rate. For the session limit with a `pace`: tokens per minute right now times the learned
 * percent-per-token, or the percent's own movement over the last few minutes, whichever is
 * higher; nothing running and nothing moving is idle (rate 0). Other windows use the percent's
 * slope over a longer look-back, then the window's average.
 */
export function forecast(
  win: UsageMeterWindow,
  samples: UsageMeterSample[],
  now: number,
  pace?: UsageMeterPace,
): Forecast {
  const resetsInMs = win.resetsAt === undefined ? null : Math.max(0, win.resetsAt - now)
  if (win.pct >= 100) {
    return {
      rate: null,
      basis: 'none',
      resetsInMs,
      msToFull: 0,
      projectedAtReset: win.pct,
      willRunOut: true,
      isFull: true,
    }
  }

  const length = windowLength(win.kind)
  const isShort = length !== null && length <= 5 * HOUR
  const mine = samples
    .filter(s => sameWindow(s.resetsAt, win.resetsAt) && s.t <= now)
    .sort((a, b) => a.t - b.t)

  /** Percent per ms between an anchor sample and now, if the anchor is old enough. */
  const slope = (lookback: number, minSpan: number): number | null => {
    let anchor: UsageMeterSample | undefined
    for (const s of mine) {
      if (s.t <= now - lookback) anchor = s
    }
    anchor ??= mine.find(s => now - s.t <= lookback)
    if (anchor === undefined || now - anchor.t < minSpan) return null

    return Math.max(0, win.pct - anchor.pct) / (now - anchor.t)
  }
  const average = (): number | null => {
    if (length === null || win.resetsAt === undefined) return null
    const elapsed = now - (win.resetsAt - length)
    const minElapsed = isShort ? 10 * MINUTE : 3 * HOUR

    return elapsed >= minElapsed && elapsed <= length * 1.01 ? win.pct / elapsed : null
  }

  let perMs: number | null = null
  let basis: Forecast['basis'] = 'none'
  if (win.kind === 'five_hour' && pace !== undefined) {
    const tokenRate = pace.pctPerToken === null ? null : (pace.pctPerToken * pace.tokensPerMin) / MINUTE
    const moved = slope(10 * MINUTE, 4 * MINUTE)
    if (tokenRate !== null || moved !== null) {
      perMs = Math.max(tokenRate ?? 0, moved ?? 0)
      basis = tokenRate !== null && tokenRate >= (moved ?? 0) ? 'tokens' : 'recent'
    } else if (pace.tokensPerMin === 0) {
      perMs = 0
      basis = 'recent'
    } else {
      perMs = average()
      basis = perMs === null ? 'none' : 'average'
    }
  } else {
    const lookback = length === null ? HOUR : isShort ? 45 * MINUTE : DAY
    const minSpan = length === null || isShort ? 5 * MINUTE : 2 * HOUR
    perMs = slope(lookback, minSpan)
    basis = perMs === null ? 'none' : 'recent'
    if (perMs === null) {
      perMs = average()
      basis = perMs === null ? 'none' : 'average'
    }
  }

  const msToFull = perMs !== null && perMs > 0 ? (100 - win.pct) / perMs : null
  const projectedAtReset =
    perMs !== null && resetsInMs !== null ? win.pct + perMs * resetsInMs : null

  return {
    rate: perMs === null ? null : perMs * HOUR,
    basis,
    resetsInMs,
    msToFull,
    projectedAtReset,
    willRunOut:
      msToFull !== null && (resetsInMs === null || msToFull + RUN_OUT_MARGIN_MS < resetsInMs),
    isFull: false,
  }
}

/** A window that reset while nothing was watching reads as a fresh, empty one. */
export function freshen(win: UsageMeterWindow, now: number): UsageMeterWindow {
  if (win.resetsAt !== undefined && win.resetsAt <= now) return { kind: win.kind, pct: 0 }
  return win
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** "5-hour limit" -> five_hour, "Weekly · all models" -> seven_day, "Weekly · Fable" -> seven_day_fable. */
export function kindForLabel(label: string): string {
  if (/5-?\s*hour/i.test(label)) return 'five_hour'
  const weekly = /^weekly\s*[·:\-–—]\s*(.+)$/i.exec(label.trim())
  if (weekly !== null) {
    const scope = slug(weekly[1] ?? '')
    return scope === 'all_models' || scope === 'all' || scope === '' ? 'seven_day' : `seven_day_${scope}`
  }

  return slug(label)
}

/** Reads the desktop app's `get_usage` answer: `plan.windows[]` with label, percentUsed, resetsAt. */
export function parsePlanWindows(result: {
  content?: readonly { type?: string; text?: string }[]
  structuredContent?: unknown
}): UsageMeterWindow[] {
  let body: unknown = result.structuredContent
  if (body === undefined) {
    const text = result.content?.find(block => typeof block.text === 'string')?.text
    if (text === undefined) return []
    try {
      body = JSON.parse(text)
    } catch {
      return []
    }
  }

  const plan = (body as { plan?: { status?: string; windows?: unknown } } | null)?.plan
  if (plan === undefined || plan === null || !Array.isArray(plan.windows)) return []

  const out: UsageMeterWindow[] = []
  for (const item of plan.windows as unknown[]) {
    const w = item as { label?: unknown; percentUsed?: unknown; resetsAt?: unknown }
    if (typeof w.label !== 'string' || typeof w.percentUsed !== 'number') continue
    const resetsAt = typeof w.resetsAt === 'string' ? Date.parse(w.resetsAt) : Number.NaN
    const kind = kindForLabel(w.label)
    out.push(
      Number.isFinite(resetsAt)
        ? { kind, pct: w.percentUsed, resetsAt }
        : { kind, pct: w.percentUsed },
    )
  }

  return out
}
