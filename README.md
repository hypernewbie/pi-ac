# pi-ac: adaptive compaction for Pi

A Pi extension that starts native compaction early during long-running tasks. It uses Pi's default summary and resumes a task if compaction interrupts it.

## Behavior

- Checks context after each completed turn.
- Uses the lower of 50% of the context window, 230,000 tokens, and Pi's native threshold by default.
- Estimates next-turn growth from the last five observed context increases.
- Triggers only when the turn can continue and no messages are queued. Pi handles completed turns and an already-crossed native threshold.
- Uses Pi's default summary. If `/ac compact` interrupts an active task, pi-ac queues one continuation. It does not add a prompt when Pi is idle.
- End-of-turn compaction is on by default. It triggers at the higher of 200,000 tokens or 40% of the context window, then waits ten minutes before compacting.
- An optional compactor model can handle every pi-ac-triggered compaction. By default, pi-ac keeps the active model.

## Commands

| Command | Action |
|---|---|
| `/ac` or `/ac help` | Show help and current session status |
| `/ac status` | Show usage, thresholds, compactor model, growth forecast, and last compaction |
| `/ac compact [focus]` | Run Pi's compaction; resume an interrupted task |
| `/ac threshold <default\|1-100\|off>` | Set this session's adaptive target; `default` restores 50%/230,000 tokens, `off` uses Pi's threshold |
| `/ac end-turn <default\|off\|token-count\|percent%>` | Set the end-of-turn threshold; on by default at max(200,000 tokens, 40%) |
| `/ac end-turn-delay <minutes>` | Set this session's wait before end-of-turn compaction; default is 10, `0` is immediate |
| `/ac compactor current` | Save the active `provider/model` as the compactor for this session |
| `/ac compactor clear` | Clear the saved compactor and use the active model |
| `/ac enable` / `/ac disable` | Enable or disable proactive compaction for this session |

Type `/ac ` to see command suggestions. Setting commands also suggest common values.

pi-ac does not prune messages or add a footer or statusline.

## Threshold behavior

At each turn end, pi-ac adds its growth estimate to the current context size and compares the result with the lower of the percentage target, 230,000 tokens, and Pi's native threshold. The default percentage is 50%. The estimate uses the last five observed increases. `/ac threshold <1-100>` changes the percentage for this session; `default` restores 50%, and `off` uses Pi's threshold without the percentage or 230,000-token cap.

## End-of-turn compaction

End-of-turn compaction is on by default. Its threshold is the higher of 200,000 tokens or 40% of the current model's context window. Set a custom absolute threshold, such as `/ac end-turn 120000`, or a percentage, such as `/ac end-turn 80%`. Use `/ac end-turn default` to restore the default, or `/ac end-turn off` to disable it.

After Pi settles a completed run, pi-ac waits ten minutes before compacting. Set another delay with `/ac end-turn-delay <minutes>`; `0` means no wait. The delay is session-only and resets to ten minutes in a new session.

Pi has no native delay option. pi-ac uses a session timer and clears it when a new run starts, another compaction occurs, `/ac end-turn off` or `/ac disable` is used, or the session shuts down. When the timer fires, pi-ac rechecks the threshold, idle state, queued messages, and Pi's `compaction.enabled` setting. It skips aborted runs and runs that already compacted. End-of-turn compaction does not queue a continuation.

## Compactor model

By default, pi-ac does not switch models. `/ac compactor current` saves the active `provider/model` slug for this session. When pi-ac compacts, it switches to that model for Pi's summary, then restores the model and thinking level that were active before compaction. This applies to `/ac compact`, adaptive compaction, and end-of-turn compaction. Use `/ac compactor clear` to return to the active-model behavior. The saved model resets when a new session starts.

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
