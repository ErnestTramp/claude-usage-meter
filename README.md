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

The dashed part of each bar is where your current pace takes it by the reset (red if that means running out). The percent changes colour as it fills. The bars stretch to fill the card at any width, and on a very thin card the reset text drops away so nothing overflows.

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
- No login tokens are read and nothing goes over the network. The only thing it writes is its own small store file (see below).
- The pace is how fast tokens are being used right now across all your running Claude Code sessions (main chats and subagents), looked at over the last few minutes and refreshed every five seconds. It is turned into a percent-per-minute rate with a ratio the mod learns from how your real percentage has moved. Nothing running and nothing moving means no forecast.
- A "you'll run out" warning only appears if the run-out is more than 10 minutes before the reset.
- To do that it keeps token counts (never any text) per session in the plugin's own store under `~/.claude/plugins/store`, and drops them after about 100 minutes.

Built and used in the desktop app's Code tab. In the terminal you should get the session and weekly bars, but the per-model rows need the desktop app, and I have tested that less.

The mods API is new and can change between Claude Code releases, so a future update may need a fix here.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## Licence

MIT
