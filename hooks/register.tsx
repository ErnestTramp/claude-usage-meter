import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { UsageMeterSample, UsageMeterWindow } from '../types'
import { AMBER, CORAL, MINT, barSpans, levelColor, miniLabel } from './line'
import { buildRows } from './rows'
import { fmtDuration, mergeWindows, parsePlanWindows, recordSamples } from './usage'

const windows = atom({ plugin: 'usage-meter', key: 'windows' } as const, [])
const history = atom({ plugin: 'usage-meter', key: 'history' } as const, {})
const isOpen = atom({ plugin: 'usage-meter', key: 'isOpen' } as const, false)

const STORE_KEY = 'usage-meter:history'
const TICK_MS = 30_000
/** The footer button is "live" if it drew within this long; else the status line steps in. */
const FOOTER_LIVE_MS = 90_000
/** Give the footer this long after start to draw before falling back. */
const FOOTER_GRACE_MS = 45_000

let lastPoll = 'not polled yet'
let lastLine: string | undefined | null = null
let startedAt = 0
let footerAt = 0

/**
 * Keeps the fallback status line in step: shown only when the footer button is not
 * drawing, so the number is never on screen twice. Also asks the drawings to redraw.
 */
async function refresh($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const rows = buildRows(await read($, windows), await read($, history), now)
  const isFooterLive = footerAt !== 0 && now - footerAt < FOOTER_LIVE_MS
  const isFooterDue = footerAt === 0 && now - startedAt < FOOTER_GRACE_MS
  const line = isFooterLive || isFooterDue ? undefined : miniLabel(rows)
  if (line !== lastLine) {
    lastLine = line
    $.ui.status(line)
  }
  $.ui.invalidate('ui.render')
}

async function ingest($: EngineInterface, incoming: UsageMeterWindow[]): Promise<void> {
  if (incoming.length === 0) return
  const now = await $.clock.now()
  const merged = await update($, windows, prev => mergeWindows(prev, incoming))
  let isChanged = false
  const kept = await update($, history, prev => {
    const r = recordSamples(prev, merged, now)
    isChanged = r.changed

    return r.history
  })
  if (isChanged) await $.store.set(STORE_KEY, kept)
  await refresh($)
}

// The desktop app's own read-only usage card, for the windows the engine's
// headers leave out (per-model weekly). No credentials, no network.
async function poll($: EngineInterface): Promise<void> {
  try {
    const result = await $.mcp.call('ccd_session_mgmt', 'get_usage')
    if (result.isError) {
      lastPoll = 'get_usage answered an error'
      return
    }
    const found = parsePlanWindows(result)
    lastPoll = `${found.length} windows from get_usage`
    await ingest($, found)
  } catch (error) {
    lastPoll = `get_usage unavailable (${error instanceof Error ? error.message : String(error)})`
  }
}

function fromRateLimit(r: { kind: string; percentUsed: number; resetsAt?: string }): UsageMeterWindow {
  const resetsAt = r.resetsAt === undefined ? Number.NaN : Date.parse(r.resetsAt)
  return Number.isFinite(resetsAt)
    ? { kind: r.kind, pct: r.percentUsed, resetsAt }
    : { kind: r.kind, pct: r.percentUsed }
}

export const register: Register = on => {
  let timer: Timer | null = null

  on('session.start', async ($, e, next) => {
    startedAt = await $.clock.now()
    await $.command.register({
      name: 'meter',
      description: 'Usage meter: show or hide the stats sheet (or "debug")',
    })

    const saved = await $.store.get(STORE_KEY)
    if (saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
      await update($, history, prev =>
        Object.keys(prev).length === 0 ? (saved as Record<string, UsageMeterSample[]>) : prev,
      )
    }

    const usage = await $.session.usage()
    await ingest($, usage.rateLimits.map(fromRateLimit))

    timer?.cancel()
    let beat = 0
    timer = $.clock.every(TICK_MS, async () => {
      beat += 1
      try {
        if (beat % 2 === 0) await poll($)
        await refresh($)
      } catch {
        // a missed beat is harmless; the next one catches up
      }
    })
    $.clock.after(1500, () => void poll($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await ingest($, e.rateLimits.map(fromRateLimit))

    return next(e)
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
    if (e.args.trim() === 'debug') {
      const now = await $.clock.now()
      const held = await $.state.get({ plugin: 'usage-meter', key: 'windows' } as const)
      const lines = (held.value ?? []).map(
        w =>
          `${w.kind}: ${w.pct}%${w.resetsAt === undefined ? '' : `, resets in ${fmtDuration(w.resetsAt - now)}`}`,
      )

      return { text: [`Usage meter windows (${lines.length}):`, ...lines, `Poll: ${lastPoll}`].join('\n') }
    }

    const open = await update($, isOpen, v => !v)

    return { text: open ? 'Usage sheet shown.' : 'Usage sheet hidden.' }
  })

  // The button under the prompt: the footer's labels with "5h 62%" added, in the same
  // plain white text as the model and effort selectors. Pressing it shows or hides the sheet.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const now = await $.clock.now()
    const label = miniLabel(buildRows(await read($, windows), await read($, history), now))
    if (label === undefined) return next(e)

    footerAt = now
    const { Box, Text, Button } = $.ui.resolve(e)
    const modes = e.props.modes

    return (
      <Box>
        {modes.length > 0 && <Text dimColor>{`${modes.join(' & ')} & `}</Text>}
        <Button
          key="meter"
          plain
          label={label}
          onPress={() => void update($, isOpen, v => !v)}
        />
      </Box>
    )
  })

  // The sheet: every limit on one compact block above the input, in aligned columns
  // (name, bar, percent, forecast) so nothing depends on the font's character widths.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    if (!(await read($, isOpen))) return next(e)

    const rows = buildRows(await read($, windows), await read($, history), await $.clock.now())
    if (rows.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const cells = e.props.bodyColumns >= 72 ? 22 : e.props.bodyColumns >= 52 ? 14 : 8
    const names = rows.map(row => row.label.replace(/ /g, '\u00a0'))
    const nameWidth = Math.max(...names.map(name => name.length)) + 1
    const chip = rows[0]?.verdict

    return (
      <Box justifyContent="space-between">
        <Box flexDirection="column">
          <Box gap={2}>
            <Box flexDirection="column" width={nameWidth} flexShrink={0}>
              {names.map(name => (
                <Text wrap="truncate">{name}</Text>
              ))}
            </Box>
            <Box flexDirection="column" flexShrink={0}>
              {rows.map(row => (
                <Text>
                  {barSpans(row, cells).map(span => (
                    <Text color={span.color}>{span.text}</Text>
                  ))}
                </Text>
              ))}
            </Box>
            <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
              {rows.map(row => (
                <Text bold color={levelColor(row.pct)}>
                  {row.pctText}
                </Text>
              ))}
            </Box>
            <Box flexDirection="column">
              {rows.map(row => (
                <Text wrap="truncate" dimColor>
                  {row.resets ?? ''}
                </Text>
              ))}
            </Box>
          </Box>
          {chip !== undefined && (
            <Box>
              {chip.tone === 'ok' ? (
                <Text wrap="truncate" color={MINT}>
                  {chip.text}
                </Text>
              ) : (
                <Text bold wrap="truncate" color="#14141a" backgroundColor={chip.tone === 'hit' ? CORAL : AMBER}>
                  {` ${chip.text} `}
                </Text>
              )}
            </Box>
          )}
        </Box>
        <Button
          key="close"
          plain
          role="dismiss"
          label="×"
          onPress={() => void update($, isOpen, () => false)}
        />
      </Box>
    )
  })
}
