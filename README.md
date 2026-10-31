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
| `/ac`, `/ac help`, or `/autocompact` | Show help and current session status |
| `/ac status` | Show usage, thresholds, compactor model and thinking level, growth forecast, and last compaction |
| `/ac compact [focus]` | Run Pi's compaction; resume an interrupted task |
| `/ac threshold <default\|1-100\|off>` | Set the global adaptive target; `default` restores 50%/230,000 tokens, `off` uses Pi's threshold |
| `/ac end-turn <default\|off\|token-count\|percent%>` | Set the global end-of-turn threshold; on by default at max(200,000 tokens, 40%) |
| `/ac end-turn-delay <minutes>` | Set this session's wait before end-of-turn compaction; default is 10, `0` is immediate |
| `/ac compactor <provider/model> [thinking]` | Set and save a compactor model slug and optional thinking level |
| `/ac compactor current [thinking]` | Save the active model, with an optional thinking level |
| `/ac compactor clear` | Clear the saved override and use the active model and thinking level |
| `/ac enable` / `/ac disable` | Enable or disable proactive compaction for this session |

The `/autocompact` command is an alias for `/ac` and accepts the same subcommands.

Type `/ac ` to see command suggestions. Setting commands also suggest common values.

pi-ac does not prune messages or add a footer or statusline.

## Threshold behavior

At each turn end, pi-ac adds its growth estimate to the current context size and compares the result with the lower of the percentage target, 230,000 tokens, and Pi's native threshold. The default percentage is 50%. The estimate uses the last five observed increases. `/ac threshold <1-100>` changes the percentage and saves it globally; `default` restores 50%, and `off` uses Pi's threshold without the percentage or 230,000-token cap.

## End-of-turn compaction

End-of-turn compaction is on by default. Its threshold is the higher of 200,000 tokens or 40% of the current model's context window. Set a custom absolute threshold, such as `/ac end-turn 120000`, or a percentage, such as `/ac end-turn 80%`. The value saves globally. Use `/ac end-turn default` to restore the default, or `/ac end-turn off` to disable it.

After Pi settles a completed run, pi-ac waits ten minutes before compacting. Set another delay with `/ac end-turn-delay <minutes>`; `0` means no wait. The delay is session-only and resets to ten minutes in a new session.

Pi has no native delay option. pi-ac uses a session timer and clears it when a new run starts, another compaction occurs, `/ac end-turn off` or `/ac disable` is used, or the session shuts down. When the timer fires, pi-ac rechecks the threshold, idle state, queued messages, and Pi's `compaction.enabled` setting. It skips aborted runs and runs that already compacted. End-of-turn compaction does not queue a continuation.

## Threshold persistence

`/ac threshold` and `/ac end-turn` save global overrides under the Pi agent directory:

- `pi-ac/threshold.json` stores the adaptive threshold.
- `pi-ac/end-turn.json` stores the end-of-turn threshold.

The default agent directory is `~/.pi/agent`. Set `PI_CODING_AGENT_DIR` to use another base directory. pi-ac loads each override when a session starts. A valid command saves the new value before it becomes active. `off` is saved as `null`; `default` removes only that setting's file.

A missing file uses the built-in default. If a file is invalid or unreadable at startup, pi-ac warns and uses the complete built-in default for that setting. A failed save leaves the active value unchanged. pi-ac does not replace or delete an invalid file. Repair or remove the named file manually, then run the command again.

Threshold changes do not update other running Pi sessions. The end-of-turn delay and enable state remain session-only.

## Compactor model

By default, pi-ac uses the active model and thinking level. Set a separate summary model with `/ac compactor provider/model-id high`; the provider is the part before the first slash, and the remaining text is the model ID. Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. If omitted, pi-ac uses the active session's thinking level. You can also set startup defaults with `pi --ac-compactor-model provider/model-id --ac-compactor-thinking high`. If only the thinking flag is set, pi-ac uses the active model.

Slash commands save the setting in the trusted project's `.pi/pi-ac.json` when that `.pi/` directory exists. Otherwise, they save it user-wide in `pi-ac.json` under Pi's agent directory (normally `~/.pi/agent/`). Project config takes precedence over user config; if no project config exists, pi-ac reads the user config. CLI flags override saved settings for that launch and do not change either file. `/ac compactor clear` removes the saved config currently in use; clearing a project override allows the user config to apply in the next session.

Saved compactor files use this format:

```json
{
  "version": 1,
  "model": "provider/model-id",
  "thinking": "high"
}
```

Omit `thinking` to use the session's level. Failed saves and clears leave the active setting unchanged. pi-ac does not overwrite or remove malformed files or files with an unsupported version; repair or remove the named file manually. Other running sessions keep their existing settings until a new session starts.

The setting applies to manual, adaptive, and end-of-turn compaction. After a summary, pi-ac restores the model and thinking level that were active before compaction. An invalid or unavailable saved model or thinking level warns and falls back to the active session model and level. If a configured model cannot be activated, or does not support the requested level, pi-ac warns and still compacts with the active session model and level. Use `/ac compactor current [thinking]` to save the current model explicitly, or `/ac compactor clear` to remove the active persisted override.

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
