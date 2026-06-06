# WebSocket Phase Events

## Problem

The current architecture requires the client to infer run state from indirect
signals: log line content, wall clock math, polling intervals, and ref guards.
This produces a class of hard-to-reproduce bugs:

- WS race: `is_done()` returns True for unknown run IDs, so a WS that opens
  before the runner registers the run immediately signals done, setting
  `wsSignaledDoneRef = true` incorrectly
- Stale closures: polling intervals capture null state at creation time
- Phase detection lag: warmup/benchmark phases are inferred from log line
  content, which only works if the WS is live and the exact strings match
- Cooldown state: computed client-side from `completed_at + cooldown_seconds`,
  requiring per-second ticks in multiple components
- Auto-advance races: the client decides when to navigate based on accumulated
  inferences, which can misfire when any signal is stale or out of order

## Solution

The backend should push explicit, authoritative phase events through the
per-run WebSocket alongside log lines. The client reacts to what the server
tells it — no inference needed.

## Event Schema

```json
{"type": "phase", "phase": "initializing"}
{"type": "phase", "phase": "warmup", "started_at": "2026-06-05T12:00:00Z"}
{"type": "phase", "phase": "running", "started_at": "2026-06-05T12:01:00Z"}
{"type": "phase", "phase": "cooldown", "remaining_seconds": 45}
{"type": "phase", "phase": "done", "status": "completed", "next_run_id": 37}
{"type": "phase", "phase": "done", "status": "failed", "next_run_id": null}
```

Events are injected into the WS stream by `omb_runner._stream_logs()` alongside
log lines. They are NOT stored in `state["lines"]` — they go through a separate
`state["events"]` list that the WS router sends as JSON frames.

## Backend Changes

### `services/omb_runner.py`

In `_stream_logs()`:
- When "Starting warm-up traffic" is detected, append to `state["events"]`:
  `{"type": "phase", "phase": "warmup", "started_at": utcnow().isoformat()}`
- When "Starting benchmark traffic" is detected:
  `{"type": "phase", "phase": "running", "started_at": utcnow().isoformat()}`
- Replace the `asyncio.get_event_loop().call_soon_threadsafe` DB write with
  direct state storage — the WS router reads it

After `state["done"] = True`:
- Append: `{"type": "phase", "phase": "done", "status": "completed"|"failed"}`

### `routers/ws.py`

Track a separate `events_sent` counter. On each loop iteration, forward any
new events from `state["events"]` as JSON frames (in addition to log lines).
Events are forwarded before the log lines for that iteration so the client sees
state changes before the log content that caused them.

For sweep runs, inject the `next_run_id` into the done event. The WS router can
look this up from the DB:
```python
if runner.is_done(run_id):
    next_run_id = await _get_next_sweep_run(run_id, db)
    await websocket.send_text(json.dumps({
        "type": "phase", "phase": "done",
        "status": "completed" if runner.succeeded(run_id) else "failed",
        "next_run_id": next_run_id,
    }))
    break
```

For cooldown: after a sweep run completes, the WS for the NEXT run should emit
cooldown countdown events. The sweep executor (`_execute_sweep`) manages the
cooldown sleep — it should periodically inject cooldown events into the next
run's event queue while sleeping.

### `routers/runs.py`

`launch_run` and `_finish_run` no longer need to detect phase log lines or
manage the cooldown countdown — the WS events carry all of this.

## Frontend Changes

### `RunDetailPage.jsx`

Replace the current inference logic in the WS `onmessage` handler:

```javascript
if (line.includes('Starting warm-up traffic'))  setWarmupStartedAt(prev => prev ?? Date.now())
if (line.includes('Starting benchmark traffic')) setBenchmarkStartedAt(prev => prev ?? Date.now())
```

With event handling:

```javascript
try {
  const msg = JSON.parse(evt.data)
  if (msg.type === 'done') {
    wsSignaledDoneRef.current = { status: msg.status, nextRunId: msg.next_run_id }
    ...
  }
  if (msg.type === 'phase') {
    if (msg.phase === 'warmup')  setWarmupStartedAt(new Date(msg.started_at).getTime())
    if (msg.phase === 'running') setBenchmarkStartedAt(new Date(msg.started_at).getTime())
    if (msg.phase === 'cooldown') setCooldownRemaining(msg.remaining_seconds)
    if (msg.phase === 'done' && msg.next_run_id) navigate(`/runs/${msg.next_run_id}`)
  }
  return
} catch { /* not JSON, fall through to log line handling */ }
```

Auto-advance navigation is now driven by the server's `done` event with
`next_run_id` — not by client-side status polling and ref guards. The entire
`wsSignaledDoneRef` / `prevRunStatusRef` / `sweepRunsRef` auto-advance mechanism
can be removed.

`cooldownRemaining` is driven by server events, not wall clock math.

Phase timestamps (`warmupStartedAt`, `benchmarkStartedAt`) come from the server
event rather than `Date.now()` at log parse time — fixing the navigation-reset
bug this feature set addresses.

### `SweepDetailPage.jsx`

Remove the stale-closure polling pattern. Poll unconditionally on a timer — the
data is authoritative from the server.

### `RunCharts.jsx` / progress bar

The progress bar currently uses `warmupStartedAt` and `benchmarkStartedAt` as
wall-clock anchors. With phase events, these are set precisely from the server
so the progress bar is accurate immediately on page load or navigation.

## Notes

- The `warmup_started_at` / `benchmark_started_at` DB columns added in the
  timer fix PR are still useful for the `loadRun()` seed path (navigating back
  to a running run that has already passed warmup).
- Cooldown events should be emitted on a 1s tick by `_execute_sweep` while it
  sleeps between sweep runs. The WS for the next run should be the receiver.
- This spec does not address the HDR live latency feature (see
  `hdr-live-latency.md`) but the two features are compatible — HDR poll results
  can be pushed as `{"type": "hdr", ...}` events on the same WS.
