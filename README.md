# pi-ac: adaptive compaction for Pi

A Pi extension that starts native compaction early during long-running tasks. It uses Pi's default summary and resumes a task if compaction interrupts it.

## Behavior

- Checks context after each completed turn.
- Uses an 80% target by default, capped by Pi's native threshold (`contextWindow - reserveTokens`).
- Estimates next-turn growth from the last five observed context increases.
- Triggers only when the turn can continue and no messages are queued. Pi handles completed turns and an already-crossed native threshold.
- Uses Pi's default summary. If `/ac compact` interrupts an active task, pi-ac queues one continuation. It does not add a prompt when Pi is idle.

## Commands

| Command | Action |
|---|---|
| `/ac` or `/ac help` | Show commands and status |
| `/ac status` | Show usage, target, Pi threshold, growth forecast, and last compaction |
| `/ac compact [focus]` | Run Pi's compaction; resume an interrupted task |
| `/ac threshold <1-100\|off>` | Set this session's adaptive target; `off` uses growth forecasting against Pi's threshold |
| `/ac enable` / `/ac disable` | Enable or disable proactive compaction for this session |

pi-ac does not prune messages or add a footer or statusline.

## Threshold behavior

At each turn end, pi-ac adds its growth estimate to the current context size and compares the result with the lower of the percentage target and Pi's native threshold. The estimate uses the last five observed increases. `/ac threshold` changes the percentage for this session; `off` uses only Pi's threshold.

Pi settings control the native threshold and how much history it keeps:

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
