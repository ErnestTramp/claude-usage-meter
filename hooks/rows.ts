import type { UsageMeterPace, UsageMeterSample, UsageMeterWindow } from '../types'
import { type Forecast, fmtDuration, forecast, freshen, labelFor, sortWindows } from './usage'

/** One plain sentence about the pace, and how worried to look. */
export type Verdict = { tone: 'ok' | 'warn' | 'hit'; text: string }

export type MeterRow = {
  kind: string
  label: string
  /** "5h", "Wk", "Fable": what sits beside a bar when several share a line. */
  short: string
  pct: number
  pctText: string
  /** Where the pace lands at reset, past the fill; null when there is nothing to show. */
  ghostPct: number | null
  /** "empty in 47m" or "LIMIT HIT"; null when the pace is safe. */
  alert: string | null
  /** "resets in 2h 14m". */
  resets: string | null
  verdict: Verdict
}

function pctText(pct: number): string {
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`
}

export function shortLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'Wk'
  const model = /^seven_day_(.+)$/.exec(kind)?.[1]
  if (model !== undefined) return model.charAt(0).toUpperCase() + model.slice(1)

  return labelFor(kind)
}

/** "At this rate you have 47m left", or that the reset comes first. */
export function verdictFor(label: string, f: Forecast): Verdict {
  const reset = f.resetsInMs === null ? null : fmtDuration(f.resetsInMs)
  if (f.isFull) {
    return { tone: 'hit', text: `${label} limit hit${reset === null ? '' : `, resets in ${reset}`}` }
  }
  if (f.willRunOut && f.msToFull !== null) {
    return {
      tone: 'warn',
      text: `At this rate you have ${fmtDuration(f.msToFull)} left on this ${label.toLowerCase()} limit`,
    }
  }
  if (f.rate === null) return { tone: 'ok', text: reset === null ? 'Plenty left' : `${label} limit resets in ${reset}` }
  if (f.rate === 0) return { tone: 'ok', text: 'Not using much right now' }

  return { tone: 'ok', text: `${label} limit resets before you run out` }
}

/** What each bar shows, from the raw windows, session first. */
export function buildRows(
  list: UsageMeterWindow[],
  samples: Record<string, UsageMeterSample[]>,
  now: number,
  pace?: UsageMeterPace,
): MeterRow[] {
  return sortWindows(list).map(w => freshen(w, now)).map(w => {
    const f = forecast(w, samples[w.kind] ?? [], now, pace)
    let alert: string | null = null
    if (f.isFull) alert = 'LIMIT HIT'
    else if (f.willRunOut && f.msToFull !== null) alert = `empty in ${fmtDuration(f.msToFull)}`

    const projected = f.projectedAtReset
    const hasGhost = f.willRunOut || (projected !== null && projected > w.pct + 1)

    return {
      kind: w.kind,
      label: labelFor(w.kind),
      short: shortLabel(w.kind),
      pct: w.pct,
      pctText: pctText(w.pct),
      ghostPct: hasGhost ? (f.willRunOut ? 100 : Math.min(100, projected ?? w.pct)) : null,
      alert,
      resets: f.resetsInMs === null ? null : `resets in ${fmtDuration(f.resetsInMs)}`,
      verdict: verdictFor(labelFor(w.kind), f),
    }
  })
}
