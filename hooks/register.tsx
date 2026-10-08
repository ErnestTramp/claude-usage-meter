import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { UsageMeterPace, UsageMeterSample, UsageMeterWindow } from '../types'
import { AMBER, CORAL, MINT, barSpans, levelColor, miniLabel, sheetLayout } from './line'
import { buildRows } from './rows'
import {
  type Buckets,
  type TokenUsage,
  addTokens,
  blendPctPerToken,
  isFresh,
  measurePctPerToken,
  parseBuckets,
  tokensPerMin,
  weightOf,
} from './tokens'
import { fmtDuration, freshen, mergeWindows, parsePlanWindows, recordSamples } from './usage'

const windows = atom({ plugin: 'usage-meter', key: 'windows' } as const, [])
const history = atom({ plugin: 'usage-meter', key: 'history' } as const, {})
const isOpen = atom({ plugin: 'usage-meter', key: 'isOpen' } as const, false)
const pace = atom({ plugin: 'usage-meter', key: 'pace' } as const, { tokensPerMin: 0, pctPerToken: null })

const STORE_KEY = 'usage-meter:history'
const TOKENS_PREFIX = 'usage-meter:tok:'
const SINCE_KEY = 'usage-meter:since'
const RATIO_KEY = 'usage-meter:pct-per-token'
/** The pace and the countdowns refresh this often, so the meter feels live. */
const TICK_MS = 5_000
/** The app's usage card is asked once a minute (every 12th beat). */
const POLL_EVERY = 12
/** The footer button is "live" if it drew within this long; else the status line steps in. */
const FOOTER_LIVE_MS = 90_000
/** Give the footer this long after start to draw before falling back. */
const FOOTER_GRACE_MS = 45_000

let lastPoll = 'not polled yet'
let lastLine: string | undefined | null = null
let startedAt = 0
let footerAt = 0
/** Whether the app's live usage card answers: until it has, Claude Code's own (stale-prone) readings are not trusted as samples. */
let appState: 'unknown' | 'ok' | 'none' = 'unknown'
let sessionKey = ''
let mine: Buckets = []
let isDirty = false
let loggingSince: number | null = null

/** Counts one model request's tokens (this session's main loop or any subagent's). */
async function noteTokens($: EngineInterface, usage: TokenUsage | null): Promise<void> {
  if (usage === null) return
  try {
    const now = await $.clock.now()
    mine = addTokens(mine, now, weightOf(usage))
    isDirty = true
    if (loggingSince === null) {
      loggingSince = now
      await $.store.set(SINCE_KEY, now)
    }
  } catch {
    // counting is best effort; the chat must never notice
  }
}

/** Every running session's token slots: this one's from memory, the rest from the shared store. */
async function allBuckets($: EngineInterface, now: number): Promise<Buckets[]> {
  const all: Buckets[] = [mine]
  for (const key of await $.store.keys()) {
    if (!key.startsWith(TOKENS_PREFIX) || key === TOKENS_PREFIX + sessionKey) continue
    const other = parseBuckets(await $.store.get(key))
    if (other === null || !isFresh(other, now)) {
      await $.store.delete(key)
      continue
    }
    all.push(other)
  }

  return all
}

/**
 * The beat: shares this session's tokens, works out the pace from every session's, keeps the
 * fallback status line in step (shown only when the footer button is not drawing, so the number is
 * never on screen twice), and asks the drawings to redraw.
 */
async function refresh($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (sessionKey !== '' && isDirty) {
    isDirty = false
    await $.store.set(TOKENS_PREFIX + sessionKey, mine)
  }
  const all = await allBuckets($, now)
  const list = await read($, windows)
  const samples = await read($, history)

  if (loggingSince === null) {
    const since = await $.store.get(SINCE_KEY)
    if (typeof since === 'number') loggingSince = since
  }
  let ratio = (await read($, pace)).pctPerToken
  if (ratio === null) {
    const saved = await $.store.get(RATIO_KEY)
    if (typeof saved === 'number') ratio = saved
  }
  const session = list.find(w => w.kind === 'five_hour')
  if (session !== undefined) {
    const measured = measurePctPerToken(freshen(session, now), samples.five_hour ?? [], all, loggingSince, now)
    const blended = blendPctPerToken(ratio, measured)
    if (blended !== null && (ratio === null || Math.abs(blended - ratio) / ratio > 0.05)) {
      await $.store.set(RATIO_KEY, blended)
    }
    ratio = blended
  }
  const next: UsageMeterPace = { tokensPerMin: tokensPerMin(all, now), pctPerToken: ratio }
  await update($, pace, () => next)

  const rows = buildRows(list, samples, now, next)
  const isFooterLive = footerAt !== 0 && now - footerAt < FOOTER_LIVE_MS
  const isFooterDue = footerAt === 0 && now - startedAt < FOOTER_GRACE_MS
  const line = isFooterLive || isFooterDue ? undefined : miniLabel(rows)
  if (line !== lastLine) {
    lastLine = line
    $.ui.status(line)
  }
  $.ui.invalidate('ui.render')
}

async function ingest(
  $: EngineInterface,
  incoming: UsageMeterWindow[],
  src: 'app' | 'engine',
): Promise<void> {
  if (incoming.length === 0) return
  const now = await $.clock.now()
  const tagged = incoming.map(w => ({ ...w, src }))
  const merged = await update($, windows, prev => mergeWindows(prev, tagged))
  // Claude Code's own reading can lag the account's real figure (a fresh session starts from an
  // old response), so it is only kept as a sample when the app's usage card is not available.
  if (src === 'app' || appState === 'none') {
    let isChanged = false
    const kept = await update($, history, prev => {
      const r = recordSamples(prev, merged, now)
      isChanged = r.changed

      return r.history
    })
    if (isChanged) await $.store.set(STORE_KEY, kept)
  }
  await refresh($)
}

// The desktop app's own read-only usage card: the account's live figures, including the
// per-model weekly limits the engine's headers leave out. No credentials, no network.
async function poll($: EngineInterface): Promise<void> {
  try {
    const result = await $.mcp.call('ccd_session_mgmt', 'get_usage')
    if (result.isError) {
      lastPoll = 'get_usage answered an error'
      if (appState === 'unknown') appState = 'none'
      return
    }
    const found = parsePlanWindows(result)
    lastPoll = `${found.length} windows from get_usage`
    if (found.length > 0) appState = 'ok'
    else if (appState === 'unknown') appState = 'none'
    await ingest($, found, 'app')
  } catch (error) {
    if (appState === 'unknown') appState = 'none'
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
    sessionKey = Math.floor(Math.random() * 1e9).toString(36)
    mine = []
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
    await ingest($, usage.rateLimits.map(fromRateLimit), 'engine')

    timer?.cancel()
    let beat = 0
    timer = $.clock.every(TICK_MS, async () => {
      beat += 1
      try {
        if (beat % POLL_EVERY === 0) await poll($)
        await refresh($)
      } catch {
        // a missed beat is harmless; the next one catches up
      }
    })
    $.clock.after(1500, () => void poll($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await ingest($, e.rateLimits.map(fromRateLimit), 'engine')

    return next(e)
  })

  // Counts every model request's tokens as it finishes, then hands the response on untouched.
  on('turn.step', async function* ($, _e, next) {
    const response = yield* next(_e)
    await noteTokens($, response.usage)

    return response
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
  // (name, bar, percent, reset) with the bars stretched to fill whatever width the card has.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    if (!(await read($, isOpen))) return next(e)

    const rows = buildRows(
      await read($, windows),
      await read($, history),
      await $.clock.now(),
      await read($, pace),
    )
    if (rows.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const names = rows.map(row => row.label.replace(/ /g, '\u00a0'))
    const widths = {
      name: Math.max(...names.map(name => name.length)),
      pct: Math.max(...rows.map(row => row.pctText.length)),
      resets: Math.max(...rows.map(row => (row.resets ?? '').length)),
    }
    const { cells, showResets } = sheetLayout(e.props.bodyColumns, widths)
    const chip = rows[0]?.verdict
    const chipColor = chip?.tone === 'hit' ? CORAL : chip?.tone === 'warn' ? AMBER : MINT

    return (
      <Box justifyContent="space-between">
        <Box flexDirection="column">
          <Box gap={2}>
            <Box flexDirection="column" width={widths.name} flexShrink={0}>
              {names.map(name => (
                <Text wrap="truncate">{name}</Text>
              ))}
            </Box>
            <Box flexDirection="column" width={cells} flexShrink={0}>
              {rows.map(row => (
                <Text wrap="truncate">
                  {barSpans(row, cells).map(span => (
                    <Text color={span.color}>{span.text}</Text>
                  ))}
                </Text>
              ))}
            </Box>
            <Box flexDirection="column" alignItems="flex-end" width={widths.pct} flexShrink={0}>
              {rows.map(row => (
                <Text bold color={levelColor(row.pct)}>
                  {row.pctText}
                </Text>
              ))}
            </Box>
            {showResets && (
              <Box flexDirection="column" width={widths.resets} flexShrink={0}>
                {rows.map(row => (
                  <Text wrap="truncate" dimColor>
                    {row.resets ?? ''}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
          {chip !== undefined && (
            <Text wrap="truncate" color={chipColor}>
              {chip.text}
            </Text>
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
