import { describe, expect, mock, test } from 'claude-code/testing'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

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

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

describe('the footer button', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows just the 5-hour percent, beside the app's own labels, on ${surface}`, async ($, on) => {
      mock.clock(on, { now: NOW })
      mock.store(on)
      on('session.measure', (_$, e) => ({ changed: e.changed }))
      on('ui.status', () => ({ value: undefined }))
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
      mock.clock(on, { now: NOW })
      mock.store(on)
      on('session.measure', (_$, e) => ({ changed: e.changed }))
      on('ui.status', () => ({ value: undefined }))
      on('ui.render', () => ({ type: 'Text', props: {}, children: [] }) as never)
      await $.session.measure(measure(11))

      const footer = await $.ui.mount({
        plugin: 'usage-meter',
        surface,
        component: 'SessionMode',
        props: { modes: [] },
      })
      const sheet = await $.ui.mount({ plugin: 'usage-meter', surface, ...BAND })
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
})

describe('the chip when you are about to run out', () => {
  test('says how long is left on this session limit, on a highlighted chip', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.render', () => ({ type: 'Text', props: {}, children: [] }) as never)
    await $.session.measure(measure(70))

    const footer = await $.ui.mount({
      plugin: 'usage-meter',
      surface: 'desktop',
      component: 'SessionMode',
      props: { modes: [] },
    })
    const sheet = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', ...BAND })
    await footer.press({ key: 'meter' })
    expect(await sheet.find({ text: /At this rate you have .* left on this session limit/ })).toBeDefined()
    expect(JSON.stringify(await sheet.drawn())).toContain('backgroundColor')
    await sheet.unmount()
    await footer.unmount()
  })
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
