# pi-ac — Adaptive Compaction for Pi

A Pi extension for automatic compaction during long-running work. It keeps the familiar slash-command workflow, uses Pi's standard compaction summary, and resumes an interrupted task automatically.

## What it does

- Watches context growth at completed turns.
- Uses an adaptive target (80% by default), adjusted by recent turn growth and bounded by Pi's effective per-model `reserveTokens` threshold.
- Calls Pi's native compaction with its default summary; it does not create virtual summary blocks or modify context projection.
- If compaction interrupts active work, queues one continuation after compaction. It does not add a continuation when no task was interrupted.
- Leaves completed turns, queued messages, and an already-crossed Pi threshold to Pi.

## Commands

| Command | Action |
|---|---|
| `/ac` or `/ac help` | Show commands and status |
| `/ac status` | Show usage, target, Pi threshold, growth forecast, and last compression |
| `/ac compress [focus]` | Run Pi's compaction; resume an interrupted task |
| `/ac threshold <1-100\|off>` | Set this session's adaptive target; `off` uses growth forecasting against Pi's threshold |
| `/ac enable` / `/ac disable` | Enable or disable proactive compaction for this session |
| `/ac config` | Show effective Pi compaction settings |

There is no `/ac compact` command. pi-ac has no DCP-style range compressor, pruning, custom summary format, stats store, footer, or statusline.

## Threshold behavior

The effective trigger is bounded by both the target percentage and Pi's own threshold (`contextWindow - reserveTokens`). Recent growth over the last five completed turns can move the trigger earlier when the next turn is likely to cross that limit. `PI_AC_TARGET_PERCENT` sets the default target; `/ac threshold` changes it for the current session.

Pi's normal settings remain in control of the native ceiling and retained history:

```json
{
  "compaction": {
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "provider/model-id": {
        "reserveTokens": 32768
      }
    }
  }
}
```

## Install

```sh
pi install git:github.com/hypernewbie/pi-ac
```

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
