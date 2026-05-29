# Run Detail Page Enhancements

**Date:** 2026-05-29  
**Status:** Approved

## Problem

When a benchmark run underperforms, there is no immediate visual signal on the Run Detail page. The SE must remember the expected rates from the New Run page and mentally compare them to the live charts and summary tiles. CPU pressure and throughput degradation are visible in the charts but only in isolation — the target is nowhere on the screen.

Additionally, the tile layout buries latency data in a separate table, the progress bar freezes after run completion, and there is no placeholder for future Redpanda broker-side metrics.

---

## Scope

Five changes, all frontend-only (no backend or schema changes):

1. Expected-rate reference lines on throughput charts
2. MetricCard tiles with expected comparison and red/green coloring
3. Tile layout reorganization — latency columns, remove LatencyTable
4. Stub Redpanda broker metric tiles
5. Fix progress bar persisting after run completes

---

## 1. Expected-Rate Reference Lines

### Data flow

`RunDetailPage` already parses `run.workload_config` into `workloadParams`. Compute two new values there:

```js
const expectedMsgSec = Number(workloadParams?.values?.producerRate) || 0
const expectedMBSec  = expectedMsgSec * (Number(workloadParams?.values?.messageSize) || 1024) / 1_048_576
```

Pass both as new props to `RunCharts`:

```jsx
<RunCharts
  ...
  expectedMsgSec={expectedMsgSec}
  expectedMBSec={expectedMBSec}
/>
```

### Chart changes (RunCharts.jsx)

Add a dashed amber `ReferenceLine` to the Throughput (msg/s) chart:

```jsx
{expectedMsgSec > 0 && (
  <ReferenceLine
    y={expectedMsgSec}
    stroke="rgba(245,158,11,0.7)"
    strokeDasharray="4 2"
    label={{ value: 'target', position: 'insideTopRight', fill: 'rgba(245,158,11,0.8)', fontSize: 10 }}
  />
)}
```

Apply the same pattern to the MB/s throughput chart using `expectedMBSec`. Lines appear during live runs and on completed run views.

---

## 2. MetricCard — Expected Comparison + Red/Green Coloring

### During a completed run

`MetricCard` gains an optional `expected` prop (numeric). When present, render it below the actual value in small muted text, and color the actual value based on performance:

- **Green** (`#4ade80`): actual ≥ 95% of expected
- **Red** (`#ef4444`): actual < 95% of expected

```
Publish Rate
35,000 msg/s       ← red
expected: 50,000
```

Only Publish Rate and Consume Rate tiles receive an `expected` prop. Latency tiles are unchanged.

### During a live run

While `run.status === 'running'`, `run.metrics` is null. Compute a live publish rate and consume rate from `livePoints` (post-warmup samples only, using the existing `warmupSamples` value) and render them in the Publish Rate / Consume Rate tiles with the same red/green coloring. Latency tiles remain hidden until the run completes.

---

## 3. Tile Layout Reorganization

### Replace the current layout

Current: flat 6-tile grid + separate LatencyTable component.

New: a single 4-column layout. The `LatencyTable` component is removed entirely — its data folds into the latency columns.

```
┌─────────────────┬─────────────────┬───────────────────┬───────────────────┐
│  Publish Rate   │  Consume Rate   │  Pub Latency      │  E2E Latency      │
│  35,000 msg/s   │  35,000 msg/s   │  Avg     12 ms    │  Avg     18 ms    │
│  (red)          │  (red)          │  P50      8 ms    │  P50     12 ms    │
│  expected:      │  expected:      │  P99     45 ms    │  P99     52 ms    │
│  50,000 msg/s   │  50,000 msg/s   │  P999   120 ms    │  P999   140 ms    │
└─────────────────┴─────────────────┴───────────────────┴───────────────────┘
```

Latency columns show: Avg, P50, P99, P999. No Max row.

Latency columns are hidden while the run is live (latency averages are unreliable mid-run). They appear once `run.metrics` is populated.

The `LatencyTable` component in `RunDetailPage.jsx` is deleted.

---

## 4. Stub Redpanda Broker Metric Tiles

A second row of tiles below the primary metrics row, styled in amber to signal "not yet connected." Two placeholder tiles:

- **Broker Publish Rate** — `—`
- **Broker Bytes In** — `—`

Each tile renders with amber border and background tint, and a small label: `Redpanda metrics — not yet connected`. When the Prometheus broker scraping is wired up, these stubs are replaced with real values pulled from `promSamples`.

---

## 5. Fix Progress Bar After Run Completes

The progress bar currently stays rendered after the run completes, frozen at whatever percentage it reached.

**Fix:** gate the progress bar block on `run.status === 'running'` in `RunCharts`. When the run leaves the running state, unmount the progress bar entirely rather than leaving it frozen.

---

## Files Changed

| File | Change |
|------|--------|
| `control-plane/frontend/src/pages/RunDetailPage.jsx` | Compute `expectedMsgSec`/`expectedMBSec`; pass to RunCharts; live tile computation; new 4-col layout; stub Redpanda tiles; remove LatencyTable usage |
| `control-plane/frontend/src/components/RunCharts.jsx` | Accept `expectedMsgSec`/`expectedMBSec` props; add reference lines; fix progress bar gate |

No backend changes. No new API calls.
