# Live HDR Latency Charts

## Background

OMB workers expose a `/cumulative-latencies` HTTP endpoint (same port as the
worker API, default 9080) that returns the live cumulative HDR histogram as
compressed bytes. This is the identical histogram that produces the final P99
in the `--output` JSON file. Polling it during a run gives accurate running
P50/P99/P999 values that will match the final output.

The current live latency charts use per-second rolling-window stats parsed from
OMB log lines. These are interval histograms that reset every second and produce
values that cannot be reconciled with the final HDR output (per-second P99 mean
will always differ from cumulative P99). The live log-based latency charts have
been removed as misleading. This feature replaces them with real HDR data.

## OMB Source Facts (verified)

- **Endpoint**: `GET /cumulative-latencies` on each worker pod
- **Response**: JSON with fields `publishLatencyBytes`, `endToEndLatencyBytes`,
  `publishDelayLatencyBytes`, `scheduleLatencyBytes` — each is a base64-encoded
  compressed HdrHistogram byte array
- **Port**: `settings.omb_worker_port` (9080 in current deployment)
- **Worker DNS**: `omb-worker-{i}.omb-worker.{namespace}.svc.cluster.local`
- **Library**: Python `hdrh` can decode and merge histograms
  (`hdrh.histogram.HdrHistogram` supports `add()` for merging across workers)

## What to Build

### Backend — `services/hdr_live_collector.py` (new file)

Poll all worker pods every 15 s during a run. Merge histograms across workers.
Extract P50/P99/P999 for publish and E2E latency. Store alongside the existing
Prometheus worker samples.

```
async def collect_hdr_live(run_id, namespace, replica_count, prom_url) -> None:
    """Poll /cumulative-latencies on all workers until run is done."""
    while not runner.is_done(run_id):
        await asyncio.sleep(15)
        merged_pub, merged_e2e = merge_worker_histograms(namespace, replica_count)
        if merged_pub and merged_e2e:
            store_hdr_sample(run_id, merged_pub, merged_e2e)
```

Storage: add columns to `prometheus_samples` table:
- `hdr_pub_p50`, `hdr_pub_p99`, `hdr_pub_p999` (REAL, microseconds → convert to ms)
- `hdr_e2e_p50`, `hdr_e2e_p99`, `hdr_e2e_p999` (REAL, ms)

Add ALTER TABLE migrations in `database.py` (follow existing pattern).

The replica count is available from `runner` state (already tracked). Worker
URLs follow the same pattern as `omb_runner.py`:
`http://omb-worker-{i}.omb-worker.{namespace}.svc.cluster.local:{port}/cumulative-latencies`

### Backend — `routers/runs.py`

In `launch_run`, fire `collect_hdr_live` as a background task alongside
`collect_prometheus`. Pass `replica_count` from the runner state (add a
`runner.get_replica_count(run_id)` method or store it in runner state).

### Backend — `models.py` / `schemas.py`

Add the 6 HDR columns to `PrometheusSample` model and `PrometheusSampleOut`
schema (if it exists; otherwise the `/api/prometheus/runs/{id}` endpoint
returns raw dicts — check `routers/prometheus.py`).

### Frontend — `RunCharts.jsx`

Replace the removed live latency charts with a new HDR latency chart row.
This row shows two charts (Publish Latency, E2E Latency) using the
`hdr_pub_p50/p99/p999` and `hdr_e2e_p50/p99/p999` columns from
`promSamples`. Badge: `omb`.

These charts use the same x-axis time base as the existing Prometheus worker
charts (`promTimeBase = runStartedAtMs`).

Show during both live and completed states (they're real HDR data, consistent
with FinalizedCharts final output). Add a note in the chart card:
"cumulative HDR — consistent with final results".

## Key Implementation Notes

- `hdrh` decodes the base64+compressed bytes:
  ```python
  import base64
  from hdrh.histogram import HdrHistogram
  raw = base64.b64decode(encoded_bytes)
  h = HdrHistogram.decode(raw)
  p99_ms = h.get_value_at_percentile(99) / 1000.0  # microseconds → ms
  ```
- Merge across workers with `merged.add(worker_histogram)` before extracting
  percentiles — do NOT average per-worker P99s, that's statistically incorrect.
- The endpoint may return 404 or error before warmup traffic begins — handle
  gracefully and skip that sample.
- `hdrh` is already in the dependency tree via the existing HDR result parser.
  Verify with `grep -r hdrh control-plane/` before adding to requirements.

## Acceptance Criteria

- Live P99 values in the chart track closely to the final HDR P99 in
  FinalizedCharts (within a few percent, converging as the run progresses)
- Chart is absent if no HDR samples were collected (e.g. run completed before
  first poll interval)
- No errors in control-plane logs when workers are unreachable during
  initializing phase
