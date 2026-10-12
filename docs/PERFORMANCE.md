# Measuring and improving Rock latency

Rock has three distinct costs: the external planner's round trips, optional
Laya decisions inside `fast_actions`, and browser/desktop execution. A fast
local decision model does not remove the first cost when a client sends one
action at a time.

## Current execution paths

- Browser page commands reuse a sequential DevTools WebSocket for the current
  tab. Target discovery still runs before commands, and the extension still
  checks tab authorization. Changing tabs switches the connection. A failed or
  cancelled command discards its connection and is never automatically replayed.
- DevTools HTTP requests share a connection pool. Responses are not cached.
- A click retains its new-tab detection window. Once the returned page shows a
  change, the old second fixed 400 ms delay is unnecessary. An unchanged page
  retains that late-update grace period without repeating the click.
- Readiness checks poll a small document/busy-state probe instead of repeatedly
  extracting the full page. Visible `aria-busy="true"` indicators delay return;
  the retry budget is 2.8 seconds and each transport operation retains its own
  timeout. A timeout returns fresh state marked `readiness_timeout`, not a claim
  that the operation completed. For a known asynchronous outcome, use
  `user_browser_wait_for` or a `fast_actions` completion condition.
- Desktop UI Automation resolves an observed window directly by its native
  handle and verifies its full process/handle identity. The prior tree walk,
  nested-dialog handling, and all input checks remain available as fallback.
- Screenshot annotation uses fast lossless PNG compression. At native size,
  the clean model and full-resolution source reuse one encoding. Pixels,
  dimensions, OCR, annotations and region-inspection capabilities are retained.
- Source installations select an available release build ahead of debug.
  `ROCK_BIN_DIR` overrides this selection, and portable `bin/` packages keep
  priority. Restart an MCP connection to pick up a rebuilt executable.

## Timing evidence

Every MCP tool result includes `_meta.rock.tool` and `_meta.rock.elapsed_ms`.
This is server-side wall time, including any approval wait; it does not measure
the external planner. Settled browser results also contain snapshot/readiness
timings. Desktop observations retain capture, OCR, UIA and fusion timings.

Compare builds using the same local fixtures, with the PC idle and builds or
other CPU/GPU-heavy work finished:

```powershell
python scripts/bench-rock.py --binary work/rock-before-performance.exe --report work/before.json --desktop --user-browser --iterations 10
python scripts/bench-rock.py --binary target/release/rock.exe --report work/after.json --desktop --user-browser --iterations 10
```

The benchmark warms up each path, checks field values and click results, rejects
stale managed-browser targets, checks delayed updates and child tabs, and closes
its own signed-in-browser tabs. The pages contain synthetic data and are served
on a temporary loopback port. `--desktop` creates and closes a disposable
WinForms test window. `--skip-browser` isolates desktop measurements.

Reports contain raw timing samples, medians, selected timing metadata, result
sizes and capability checks. Inspect the capability checks as well as speed:
an unsuccessful action must never be counted as a performance improvement.
Desktop clicks change a counter on every iteration, so repeated samples verify
new effects. Foreground state is recorded, but user interaction can change it.

## Client guidance

Send complete known sequences through `fast_actions`, with exact target labels
and explicit completion conditions. The existing deterministic grounding and
batched decision checks can avoid unnecessary Laya or planner round trips.
Reuse an action's returned observation. Request another full capture only when
the state may have changed, and use screenshots for genuinely visual questions.
Keep decisions involving new situations with the planner and keep consequential
actions behind the existing approval mechanism.

The full existing tool catalog and default result contents are retained. These
optimizations do not remove verification, password restrictions, ownership
checks, cancellation, or approval requirements.
