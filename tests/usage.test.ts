import { describe, expect, test } from 'claude-code/testing'

import { barCells, barSpans, miniLabel, textBar } from '../hooks/line'
import { buildRows, verdictFor } from '../hooks/rows'
import {
  DAY,
  HOUR,
  MINUTE,
  fmtDuration,
  forecast,
  kindForLabel,
  labelFor,
  mergeWindows,
  parsePlanWindows,
  recordSamples,
} from '../hooks/usage'

const NOW = 1_000_000_000_000

describe('labels and durations', () => {
  test('formats durations', () => {
    expect(fmtDuration(20_000)).toBe('<1m')
    expect(fmtDuration(47 * MINUTE)).toBe('47m')
    expect(fmtDuration(2 * HOUR + 14 * MINUTE)).toBe('2h 14m')
    expect(fmtDuration(3 * HOUR)).toBe('3h')
    expect(fmtDuration(2 * DAY + 3 * HOUR)).toBe('2d 3h')
  })

  test('a per-model week is labelled with just the model', () => {
    expect(labelFor('seven_day_fable')).toBe('Fable')
    expect(labelFor('seven_day')).toBe('Week')
    expect(labelFor('five_hour')).toBe('Session')
  })

  test('maps the app card labels to window kinds', () => {
    expect(kindForLabel('5-hour limit')).toBe('five_hour')
    expect(kindForLabel('Weekly · all models')).toBe('seven_day')
    expect(kindForLabel('Weekly · Fable')).toBe('seven_day_fable')
  })
})

describe('reading the app usage card', () => {
  test('parses get_usage text content', () => {
    const body = {
      plan: {
        status: 'ok',
        windows: [
          { label: '5-hour limit', percentUsed: 11, resetsAt: '2026-10-08T15:39:59.554Z' },
          { label: 'Weekly · all models', percentUsed: 83, resetsAt: '2026-10-10T13:59:59.554Z' },
          { label: 'Weekly · Fable', percentUsed: 3, resetsAt: '2026-10-10T13:59:59.554Z' },
        ],
      },
    }
    const out = parsePlanWindows({ content: [{ type: 'text', text: JSON.stringify(body) }] })
    expect(out.map(w => w.kind)).toEqual(['five_hour', 'seven_day', 'seven_day_fable'])
    expect(out[1]?.pct).toBe(83)
    expect(out[0]?.resetsAt).toBe(Date.parse('2026-10-08T15:39:59.554Z'))
  })

  test('shrugs off an unreadable answer', () => {
    expect(parsePlanWindows({ content: [{ type: 'text', text: 'nope' }] })).toEqual([])
    expect(parsePlanWindows({ content: [] })).toEqual([])
  })
})

describe('merging and sampling', () => {
  const resetsAt = NOW + 2 * HOUR

  test('a rounding dip inside one window is ignored', () => {
    const merged = mergeWindows(
      [{ kind: 'five_hour', pct: 11.4, resetsAt }],
      [{ kind: 'five_hour', pct: 11, resetsAt: resetsAt + 500 }],
    )
    expect(merged[0]?.pct).toBe(11.4)
  })

  test('a reset window replaces the old one', () => {
    const merged = mergeWindows(
      [{ kind: 'five_hour', pct: 90, resetsAt }],
      [{ kind: 'five_hour', pct: 2, resetsAt: resetsAt + 5 * HOUR }],
    )
    expect(merged[0]?.pct).toBe(2)
  })

  test('samples are added only when a window rises', () => {
    const w = [{ kind: 'five_hour', pct: 10, resetsAt }]
    const first = recordSamples({}, w, NOW)
    expect(first.changed).toBe(true)
    const same = recordSamples(first.history, w, NOW + MINUTE)
    expect(same.changed).toBe(false)
    expect(same.history).toBe(first.history)
    const rose = recordSamples(first.history, [{ kind: 'five_hour', pct: 12, resetsAt }], NOW + 2 * MINUTE)
    expect(rose.history.five_hour).toHaveLength(2)
  })
})

describe('forecast', () => {
  test('a fast recent burn runs out before the reset', () => {
    const resetsAt = NOW + HOUR
    const win = { kind: 'five_hour', pct: 50, resetsAt }
    const samples = [{ t: NOW - 30 * MINUTE, pct: 20, resetsAt }]
    const f = forecast(win, samples, NOW)
    expect(f.basis).toBe('recent')
    expect(Math.round(f.rate ?? 0)).toBe(60)
    expect(f.willRunOut).toBe(true)
    expect(Math.round((f.msToFull ?? 0) / MINUTE)).toBe(50)
  })

  test('a slow average survives to the reset', () => {
    const resetsAt = NOW + HOUR
    const f = forecast({ kind: 'five_hour', pct: 40, resetsAt }, [], NOW)
    expect(f.basis).toBe('average')
    expect(f.willRunOut).toBe(false)
    expect(Math.round(f.projectedAtReset ?? 0)).toBe(50)
  })

  test('no change over the lookback reads as idle', () => {
    const resetsAt = NOW + 2 * HOUR
    const samples = [{ t: NOW - 80 * MINUTE, pct: 30, resetsAt }]
    const f = forecast({ kind: 'five_hour', pct: 30, resetsAt }, samples, NOW)
    expect(f.rate).toBe(0)
    expect(f.msToFull).toBeNull()
    expect(f.willRunOut).toBe(false)
  })

  test('a full window says so', () => {
    const f = forecast({ kind: 'five_hour', pct: 100, resetsAt: NOW + HOUR }, [], NOW)
    expect(f.isFull).toBe(true)
  })
})

describe('rows', () => {
  const windows = [
    { kind: 'seven_day_fable', pct: 3, resetsAt: NOW + 2 * DAY },
    { kind: 'five_hour', pct: 11, resetsAt: NOW + 2 * HOUR + 21 * MINUTE },
    { kind: 'seven_day', pct: 83, resetsAt: NOW + 2 * DAY },
  ]

  test('lists session, week and Fable, and warns about the hot week', () => {
    const rows = buildRows(windows, {}, NOW)
    expect(rows.map(r => r.short)).toEqual(['5h', 'Wk', 'Fable'])
    expect(rows[0]?.pctText).toBe('11%')
    expect(rows[1]?.alert).toMatch(/^empty in /)
    expect(rows[2]?.alert).toBeNull()
  })

  test('a window that already reset reads as empty', () => {
    const rows = buildRows([{ kind: 'five_hour', pct: 95, resetsAt: NOW - MINUTE }], {}, NOW)
    expect(rows[0]?.pctText).toBe('0%')
  })
})

describe('the verdict chip', () => {
  const at = (pct: number, hours: number, samples: { t: number; pct: number; resetsAt: number }[] = []) =>
    forecast({ kind: 'five_hour', pct, resetsAt: NOW + hours * HOUR }, samples, NOW)

  test('on course to run out says how long is left at this rate', () => {
    const v = verdictFor('Session', at(70, 2))
    expect(v.tone).toBe('warn')
    expect(v.text).toMatch(/^At this rate you have 1h \d+m left on this session limit$/)
  })

  test('a light pace says the reset comes first', () => {
    const v = verdictFor('Session', at(11, 2))
    expect(v).toEqual({ tone: 'ok', text: 'Session limit resets before you run out' })
  })

  test('no change lately reads as not using much', () => {
    const resetsAt = NOW + 2 * HOUR
    const v = verdictFor('Session', at(30, 2, [{ t: NOW - 80 * MINUTE, pct: 30, resetsAt }]))
    expect(v.text).toBe('Not using much')
  })

  test('with no pace to go on it only says when the reset is', () => {
    const f = forecast({ kind: 'five_hour', pct: 20, resetsAt: NOW + HOUR }, [], NOW)
    expect(verdictFor('Session', { ...f, rate: null, basis: 'none' }).text).toBe('Session limit resets in 1h')
  })

  test('a full window says so', () => {
    const v = verdictFor('Session', at(100, 1))
    expect(v).toEqual({ tone: 'hit', text: 'Session limit hit, resets in 1h' })
  })
})

describe('the status line', () => {
  const bar = { pct: 62, ghostPct: 80 }

  test('cells split into fill, projection and rest', () => {
    expect(barCells(10, bar)).toEqual({ fill: 6, ghost: 2, rest: 2 })
    expect(barCells(10, { ...bar, ghostPct: null })).toEqual({ fill: 6, ghost: 0, rest: 4 })
  })

  test('a sliver of use still shows one cell', () => {
    expect(barCells(16, { pct: 1, ghostPct: null }).fill).toBe(1)
    expect(barCells(16, { pct: 0, ghostPct: null }).fill).toBe(0)
  })

  test('the bar is thin line glyphs, heavy then dashed then light', () => {
    expect(textBar(10, bar)).toBe('\u2501'.repeat(6) + '\u254c'.repeat(2) + '\u2500'.repeat(2))
  })

  test('the least text that is still a stat is the first limit and its percent', () => {
    const rows = buildRows(
      [
        { kind: 'seven_day', pct: 83, resetsAt: NOW + 2 * DAY },
        { kind: 'five_hour', pct: 11, resetsAt: NOW + 2 * HOUR },
      ],
      {},
      NOW,
    )
    expect(miniLabel(rows)).toBe('5h 11%')
    expect(miniLabel([])).toBeUndefined()
  })

  test('the menu bar is coloured runs that add up to the width', () => {
    const rows = buildRows([{ kind: 'five_hour', pct: 30, resetsAt: NOW + 2 * HOUR }], {}, NOW)
    const spans = barSpans(rows[0]!, 20)
    expect(spans.reduce((n, s) => n + s.text.length, 0)).toBe(20)
    expect(spans[0]?.color).toBe('#5fd7a7')
  })
})
