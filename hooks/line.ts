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

/**
 * Lays out the sheet's columns for a card `bodyColumns` wide: the bars take whatever the name,
 * percent and reset columns, their gaps and the close button leave, so the sheet fills the card
 * edge to edge and only the bars grow. When the card is too thin to give the bars at least ten
 * cells beside the reset column, that column is dropped and the bars take its space back.
 */
export function sheetLayout(
  bodyColumns: number,
  columns: { name: number; pct: number; resets: number },
): { cells: number; showResets: boolean } {
  const closeButton = 4
  const minBar = 10
  const fixed = columns.name + columns.pct + closeButton
  const withResets = bodyColumns - fixed - columns.resets - 3 * 2
  if (withResets >= minBar) return { cells: withResets, showResets: true }

  return { cells: Math.max(4, bodyColumns - fixed - 2 * 2), showResets: false }
}

/**
 * A desktop cell is the width of the app's code font, and the sheet's text is drawn in a
 * proportional font, so bars made of line characters cannot fit a cell count there (they come out
 * wider and wrap). The desktop draws the bar as vector instead, this many CSS pixels per cell
 * (measured on the app's default code font).
 */
export const DESKTOP_CELL_PX = 7.9
export const DESKTOP_BAR_HEIGHT = 3

/** The same bar as exact-proportion vector: used, projected (dashed), free. */
export function barSvg(widthPx: number, bar: { pct: number; ghostPct: number | null; alert: string | null }): string {
  const h = DESKTOP_BAR_HEIGHT
  const share = (pct: number) => (Math.min(100, Math.max(0, pct)) / 100) * widthPx
  const fill = bar.pct > 0 ? Math.max(h, share(bar.pct)) : 0
  const end = bar.ghostPct === null ? fill : Math.max(fill, share(bar.ghostPct))
  const ghostColor = bar.alert !== null ? CORAL : levelColor(bar.ghostPct ?? bar.pct)
  const round = (n: number) => Math.round(n * 100) / 100
  const pill = (w: number, color: string) =>
    w > 0 ? `<rect width="${round(w)}" height="${h}" rx="${h / 2}" fill="${color}"/>` : ''
  const dashes =
    end - fill > 0.5
      ? `<line x1="${round(fill)}" x2="${round(end)}" y1="${h / 2}" y2="${h / 2}" stroke="${mix(ghostColor, TRACK, 0.35)}" stroke-width="${h}" stroke-dasharray="4 3"/>`
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(widthPx)} ${h}" width="${round(widthPx)}" height="${h}">${pill(widthPx, TRACK)}${dashes}${pill(fill, levelColor(bar.pct))}</svg>`
}
