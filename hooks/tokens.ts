import type { UsageMeterSample, UsageMeterWindow } from '../types'
import { MINUTE, sameWindow } from './usage'

/** [slot index since the epoch, weighted tokens used in that slot]. Slots are 10 seconds long. */
export type Buckets = [number, number][]

export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const SLOT_MS = 10_000
const KEEP_SLOTS = 600
/** The pace looks at this long a stretch: short enough to feel live, long enough not to flap. */
const PACE_SPAN_MS = 3 * MINUTE

const slotOf = (ms: number): number => Math.floor(ms / SLOT_MS)

/** Tokens weighted the way the API prices them: output 5x, cache write 1.25x, cache read 0.1x. */
export function weightOf(u: TokenUsage): number {
  return (
    u.input_tokens +
    5 * u.output_tokens +
    1.25 * u.cache_creation_input_tokens +
    0.1 * u.cache_read_input_tokens
  )
}

/** Adds `w` to the slot `now` falls in, dropping slots older than 100 minutes. */
export function addTokens(buckets: Buckets, now: number, w: number): Buckets {
  const slot = slotOf(now)
  const kept = buckets.filter(([s]) => s > slot - KEEP_SLOTS)
  const last = kept.at(-1)
  if (last !== undefined && last[0] === slot) return [...kept.slice(0, -1), [slot, last[1] + w]]

  return [...kept, [slot, w]]
}

/** Weighted tokens in the slots from the one holding `from` to the one holding `to`. */
export function tokensBetween(buckets: Buckets, from: number, to: number): number {
  const first = slotOf(from)
  const last = slotOf(to)

  return buckets.reduce((n, [s, w]) => (s >= first && s <= last ? n + w : n), 0)
}

/** Weighted tokens per minute over the last three minutes, summed over every session. */
export function tokensPerMin(all: Buckets[], now: number): number {
  const sum = all.reduce((n, b) => n + tokensBetween(b, now - PACE_SPAN_MS, now), 0)

  return sum / (PACE_SPAN_MS / MINUTE)
}

/** True when the slot index is one a live session could still be writing (not stale). */
export function isFresh(buckets: Buckets, now: number): boolean {
  const last = buckets.at(-1)

  return last !== undefined && last[0] > slotOf(now) - KEEP_SLOTS
}

/** Reads buckets back from the store, or null when the value is not that shape. */
export function parseBuckets(value: unknown): Buckets | null {
  if (!Array.isArray(value)) return null
  const out: Buckets = []
  for (const item of value as unknown[]) {
    if (!Array.isArray(item) || typeof item[0] !== 'number' || typeof item[1] !== 'number') return null
    out.push([item[0], item[1]])
  }

  return out
}

/**
 * Percent of the limit one weighted token costs, measured over the last hour or so: how far
 * the percent rose since an anchor reading 15 to 90 minutes old, over the tokens used since.
 * Null when there is no usable anchor, the rise is under 3 points (too coarse), or token
 * logging began after the anchor (the tokens would be undercounted).
 */
export function measurePctPerToken(
  win: UsageMeterWindow,
  samples: UsageMeterSample[],
  all: Buckets[],
  loggingSince: number | null,
  now: number,
): number | null {
  const anchor = samples
    .filter(
      s =>
        sameWindow(s.resetsAt, win.resetsAt) && now - s.t >= 15 * MINUTE && now - s.t <= 90 * MINUTE,
    )
    .sort((a, b) => a.t - b.t)[0]
  if (anchor === undefined || loggingSince === null || loggingSince > anchor.t) return null

  const rise = win.pct - anchor.pct
  const tokens = all.reduce((n, b) => n + tokensBetween(b, anchor.t, now), 0)

  return rise >= 3 && tokens > 0 ? rise / tokens : null
}

/** Smooths a new measurement into the old one so a single odd hour does not swing the forecast. */
export function blendPctPerToken(prev: number | null, measured: number | null): number | null {
  if (measured === null) return prev

  return prev === null ? measured : prev * 0.7 + measured * 0.3
}
