import type { MeterRow } from './rows'

const FILL = '━'
const GHOST = '╌'
const REST = '─'

export const MINT = '#5fd7a7'
export const AMBER = '#f2b84b'
export const CORAL = '#f0644e'
const TRACK = '#3a3a44'

export function levelColor(pct: number): string {
  if (pct < 50) return MINT
  if (pct < 80) return AMBER
  return CORAL
}

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `t` of the way from `a` to `b`. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = channels(a)
  const [br, bg, bb] = channels(b)
  const part = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, '0')

  return `#${part(ar, br)}${part(ag, bg)}${part(ab, bb)}`
}

/** How many of `cells` are filled, projected, and empty. */
export function barCells(
  cells: number,
  bar: { pct: number; ghostPct: number | null },
): { fill: number; ghost: number; rest: number } {
  const share = (pct: number) => Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells)
  let fill = share(bar.pct)
  if (bar.pct > 0 && fill === 0) fill = 1
  const end = bar.ghostPct === null ? fill : Math.max(fill, share(bar.ghostPct))

  return { fill, ghost: end - fill, rest: cells - end }
}

/** A thin line: heavy where used, dashed where the pace will take it, light where free. */
export function textBar(cells: number, bar: { pct: number; ghostPct: number | null }): string {
  const { fill, ghost, rest } = barCells(cells, bar)

  return FILL.repeat(fill) + GHOST.repeat(ghost) + REST.repeat(rest)
}

export type Span = { text: string; color?: string; dim?: boolean; bold?: boolean }

/** The bar as coloured runs: used, where the pace lands at reset, free. */
export function barSpans(row: MeterRow, cells: number): Span[] {
  const { fill, ghost, rest } = barCells(cells, row)
  const ghostColor = row.alert !== null ? CORAL : levelColor(row.ghostPct ?? row.pct)
  const spans: Span[] = [{ text: FILL.repeat(fill), color: levelColor(row.pct) }]
  if (ghost > 0) spans.push({ text: GHOST.repeat(ghost), color: mix(ghostColor, TRACK, 0.5) })
  if (rest > 0) spans.push({ text: REST.repeat(rest), color: TRACK })

  return spans
}

/** The least text that is still a stat: "5h 62%". */
export function miniLabel(rows: MeterRow[]): string | undefined {
  const first = rows[0]

  return first === undefined ? undefined : `${first.short} ${first.pctText}`
}
