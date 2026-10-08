# Usage Meter

A small usage meter for Claude Code, built as a mod (a plugin of function hooks).

It adds a plain `5h 62%` button in the footer under the prompt, styled like the model and effort selectors. Click it (or type `/meter`) and a compact sheet opens above the input:

| | | | |
|---|---|---|---|
| Session | `━━━━━━╌╌────` | 62% | resets in 2h 14m |
| Week | `━━━━━━━━━╌──` | 83% | resets in 2d |
| Fable | `━───────────` | 3% | resets in 2d |

Under the rows is one line about your pace:

- **At this rate you have 47m left on this session limit** (amber chip) when you are on course to run out before the reset
- **Session limit resets before you run out** when you are not
- **Not using much** when you have been idle

The dashed part of each bar is where your current pace takes it by the reset. The percent changes colour as it fills, and everything updates live.

## Install

```bash
claude plugin marketplace add ErnestTramp/claude-usage-meter
claude plugin install usage-meter@claude-usage-meter
```

Or try it from a clone without installing: `claude --plugin-dir ./claude-usage-meter`.

Needs Claude Code 2.1.287 or newer (the mods feature).

## Commands

- `/meter` shows or hides the sheet
- `/meter debug` prints the raw numbers the meter is receiving

## How it works

- The session and weekly numbers come from the rate-limit figures Claude Code already has, pushed live after each response.
- In the desktop app, once a minute it also asks the app's own read-only usage tool for per-model weekly limits such as Fable. That is how the extra rows appear.
- No login tokens are read, no files are touched, and nothing goes over the network.
- The pace comes from your last 45 minutes (last day for weekly limits), or the average since the window started if there is not enough recent activity.

Built and used in the desktop app's Code tab. In the terminal you should get the session and weekly bars, but the per-model rows need the desktop app, and I have tested that less.

The mods API is new and can change between Claude Code releases, so a future update may need a fix here.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## Licence

MIT
