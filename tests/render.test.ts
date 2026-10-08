import type { On } from 'claude-code'
import { type Engine, describe, expect, mock, test } from 'claude-code/testing'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000
/** Percent of the session limit one weighted token costs, as if already learned. */
const RATIO = 1e-5

const iso = (ms: number) => new Date(ms).toISOString()

const measure = (five: number) =>
  ({
    context: { window: 1_000_000 },
    changed: ['rateLimits'],
    rateLimits: [
      { kind: 'five_hour', percentUsed: five, resetsAt: iso(NOW + 2 * HOUR) },
      { kind: 'seven_day', percentUsed: 83, resetsAt: iso(NOW + 2 * DAY) },
      { kind: 'seven_day_fable', percentUsed: 3, resetsAt: iso(NOW + 2 * DAY) },
    ],
  }) as never

const band = (bodyColumns: number) =>
  ({
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 12,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 12 },
      view: {},
    },
  }) as const

/** The engine's bottom layer for these tests, and a way to run one model request through the mod. */
function arrange($: Engine, on: On, outputTokens: number) {
  mock.clock(on, { now: NOW })
  mock.store(on, { 'usage-meter:pct-per-token': RATIO })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [] }) as never)
  on('turn.step', async function* () {
    return {
      turnId: 't',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'opus',
        input_tokens: 0,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  })

  return async () => {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 })
    for await (const chunk of stream) void chunk
    await stream.result
  }
}

describe('the footer button', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows just the 5-hour percent, beside the app's own labels, on ${surface}`, async ($, on) => {
      await arrange($, on, 0)
      await $.session.measure(measure(11))

      const alone = await $.ui.mount({
        plugin: 'usage-meter',
        surface,
        component: 'SessionMode',
        props: { modes: [] },
      })
      expect((await alone.find({ key: 'meter' }))?.text).toBe('5h 11%')
      expect(await alone.find({ text: /83%/ })).toBeUndefined()
      await alone.unmount()

      const beside = await $.ui.mount({
        plugin: 'usage-meter',
        surface,
        component: 'SessionMode',
        props: { modes: ['focus'] },
      })
      expect(await beside.find({ text: /focus/ })).toBeDefined()
      expect(await beside.find({ key: 'meter' })).toBeDefined()
      await beside.unmount()
    })
  }
})

describe('the sheet above the input', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`opens from the button, lists every limit, and closes on ${surface}`, async ($, on) => {
      const useTokens = arrange($, on, 1000)
      await useTokens()
      await $.session.measure(measure(11))

      const footer = await $.ui.mount({
        plugin: 'usage-meter',
        surface,
        component: 'SessionMode',
        props: { modes: [] },
      })
      const sheet = await $.ui.mount({ plugin: 'usage-meter', surface, ...band(100) })
      expect(await sheet.find({ text: /Fable/ })).toBeUndefined()

      await footer.press({ key: 'meter' })
      expect(await sheet.find({ text: /Session/ })).toBeDefined()
      expect(await sheet.find({ text: /11%/ })).toBeDefined()
      expect(await sheet.find({ text: /Week/ })).toBeDefined()
      expect(await sheet.find({ text: /83%/ })).toBeDefined()
      expect(await sheet.findAll({ type: 'Text', text: /^Fable$/ })).toHaveLength(1)
      expect(await sheet.find({ text: /empty in/ })).toBeUndefined()
      expect(await sheet.find({ text: /resets in 2h/ })).toBeDefined()
      expect(await sheet.find({ text: /Session limit resets before you run out/ })).toBeDefined()
      expect(JSON.stringify(await sheet.drawn())).not.toContain('backgroundColor')

      await sheet.press({ key: 'close' })
      expect(await sheet.find({ text: /Fable/ })).toBeUndefined()
      await sheet.unmount()
      await footer.unmount()
    })
  }

  test('says nothing alarming when nothing is running', async ($, on) => {
    await arrange($, on, 0)
    await $.session.measure(measure(21))

    const footer = await $.ui.mount({
      plugin: 'usage-meter',
      surface: 'desktop',
      component: 'SessionMode',
      props: { modes: [] },
    })
    const sheet = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...band(100) })
    await footer.press({ key: 'meter' })
    expect(await sheet.find({ text: /Not using much right now/ })).toBeDefined()
    expect(await sheet.find({ text: /At this rate/ })).toBeUndefined()
    await sheet.unmount()
    await footer.unmount()
  })

  test('stretches the bars to fill the card, keeping the spacing the same', async ($, on) => {
    await arrange($, on, 0)
    await $.session.measure(measure(30))

    const footer = await $.ui.mount({
      plugin: 'usage-meter',
      surface: 'terminal',
      component: 'SessionMode',
      props: { modes: [] },
    })
    const glyphs = async (columns: number) => {
      const sheet = await $.ui.mount({ plugin: 'usage-meter', surface: 'terminal', ...band(columns) })
      const count = (JSON.stringify(await sheet.drawn()).match(/[─━╌]/g) ?? []).length
      await sheet.unmount()

      return count
    }
    await footer.press({ key: 'meter' })
    const narrow = await glyphs(80)
    const wide = await glyphs(200)
    // three bars: each gains the 120 extra columns
    expect(wide - narrow).toBe(3 * 120)
    await footer.unmount()
  })
})

describe('a very thin card', () => {
  test('drops the reset text instead of overflowing, and brings it back when there is room', async ($, on) => {
    await arrange($, on, 0)
    await $.session.measure(measure(30))

    const footer = await $.ui.mount({
      plugin: 'usage-meter',
      surface: 'desktop',
      component: 'SessionMode',
      props: { modes: [] },
    })
    await footer.press({ key: 'meter' })

    const thin = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...band(36) })
    expect(await thin.find({ text: /resets in/ })).toBeUndefined()
    expect(await thin.find({ text: /30%/ })).toBeDefined()
    expect(await thin.find({ text: /Session/ })).toBeDefined()
    await thin.unmount()

    const roomy = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...band(100) })
    expect(await roomy.find({ text: /resets in/ })).toBeDefined()
    await roomy.unmount()
    await footer.unmount()
  })
})

describe('the chip when you are about to run out', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`reads the current token pace and warns in plain amber text on ${surface}`, async ($, on) => {
      const useTokens = arrange($, on, 60_000)
      await useTokens()
      await $.session.measure(measure(11))

      const footer = await $.ui.mount({
        plugin: 'usage-meter',
        surface,
        component: 'SessionMode',
        props: { modes: [] },
      })
      const sheet = await $.ui.mount({ plugin: 'usage-meter', surface, ...band(100) })
      await footer.press({ key: 'meter' })
      expect(await sheet.find({ text: /At this rate you have .* left on this session limit/ })).toBeDefined()
      const drawn = JSON.stringify(await sheet.drawn())
      expect(drawn).not.toContain('backgroundColor')
      expect(drawn).toContain('#f2b84b')
      await sheet.unmount()
      await footer.unmount()
    })
  }
})

describe('the fallback status line', () => {
  test('appears when the footer is not drawing, and steps aside once it is', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const seen: (string | undefined)[] = []
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('ui.status', (_$, e) => {
      seen.push(e.text)

      return { value: undefined }
    })

    await $.session.measure(measure(11))
    expect(seen.at(-1)).toBe('5h 11%')

    const footer = await $.ui.mount({
      plugin: 'usage-meter',
      surface: 'terminal',
      component: 'SessionMode',
      props: { modes: [] },
    })
    await $.session.measure(measure(12))
    expect(seen.at(-1)).toBeUndefined()
    await footer.unmount()
  })
})
