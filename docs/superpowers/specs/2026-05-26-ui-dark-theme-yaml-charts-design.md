# UI: Dark Theme, YAML Preview Fix, Live Results Charts

**Date:** 2026-05-26  
**Status:** Approved

## Summary

Three UI improvements to the OMB k8s control plane frontend:

1. **Dark theme** — migrate from light to Slate Dark, matching the reference repo style
2. **YAML preview fix** — make previews fill their column width and support bidirectional resize
3. **Live results charts** — Recharts-based chart panel on the run detail page with live WebSocket updates and OMB/Redpanda source badges

---

## Section 1 — Dark Theme (Slate)

### CSS variable changes (`index.css`)

| Variable | Current | New |
|---|---|---|
| `--color-bg` | `#f0f2f5` | `#0f1117` |
| `--color-surface` | `#ffffff` | `#171c28` |
| `--color-border` | `#d9dde5` | `#2a3045` |
| `--color-text` | `#1a1a2e` | `#e8edf8` |
| `--color-text-muted` | `#6b7280` | `#7a8399` |
| `--color-nav-bg` | `#1a1a2e` | `#1a1a2e` (unchanged) |
| `--color-nav-hover` | `#2d2d4a` | `#2d2d4a` (unchanged) |
| `--color-success` | `#16a34a` | `#4ade80` |
| `--color-warning` | `#d97706` | `#fbbf24` |
| `--color-error` | `#dc2626` | `#f87171` |

### Secondary surface colors

All hardcoded light colors in rule bodies must shift to dark equivalents:

| Usage | Current | New |
|---|---|---|
| Table header background | `#f8f9fa` | `#131929` |
| Table row hover | `#fafafa` | `rgba(255,255,255,0.03)` |
| Table row separator | `#f0f0f0` | `#1e2640` |
| Section label background | `#fafafa` | `#131929` |
| Connection box background | `#f8f9fa` | `#131929` |
| Password display background | `#fafafa` | `#131929` |
| Inline editor background | `#fffef0` | `#141c2e` |
| Mode-tabs background | `#f5f5f5` | `#0f1117` |
| Projected load box | `#f0fdf4` / green borders | `rgba(74,222,128,0.08)` / `rgba(74,222,128,0.2)` border |
| `.btn-secondary` hover | `#f5f5f5` | `rgba(255,255,255,0.06)` |
| `.btn-danger` background | `#fff` | `transparent` |
| `.btn-ghost` hover | `#fef2f2` | `rgba(230,57,70,0.1)` |

### Alert backgrounds

| Alert | Background | Border | Text |
|---|---|---|---|
| `alert-warning` | `rgba(251,191,36,0.08)` | `rgba(251,191,36,0.3)` | `#fbbf24` |
| `alert-error` | `rgba(248,113,113,0.08)` | `rgba(248,113,113,0.3)` | `#f87171` |
| `alert-success` | `rgba(74,222,128,0.08)` | `rgba(74,222,128,0.3)` | `#4ade80` |
| `alert-info` | `rgba(96,165,250,0.08)` | `rgba(96,165,250,0.3)` | `#60a5fa` |

### Status badges

Dark-tinted backgrounds instead of light pastels:

| Badge | Background | Text |
|---|---|---|
| `badge-running` | `rgba(29,78,216,0.2)` | `#60a5fa` |
| `badge-completed` | `rgba(21,128,61,0.2)` | `#4ade80` |
| `badge-failed` | `rgba(185,28,28,0.2)` | `#f87171` |
| `badge-pending` | `rgba(107,114,128,0.15)` | `#9ca3af` |
| `badge-cancelled` | `rgba(133,77,14,0.2)` | `#fbbf24` |

### Setup banner

| Current | New |
|---|---|
| `background: #fffbeb` | `background: rgba(251,191,36,0.08)` |
| `border-bottom: 1px solid #fcd34d` | `border-bottom: 1px solid rgba(251,191,36,0.3)` |
| `color: #92400e` | `color: #fbbf24` |

### Test result boxes

| | Background | Border | Text |
|---|---|---|---|
| `.test-result.success` | `rgba(74,222,128,0.08)` | `rgba(74,222,128,0.3)` | `#4ade80` |
| `.test-result.error` | `rgba(248,113,113,0.08)` | `rgba(248,113,113,0.3)` | `#f87171` |

### Log viewer

No change — already dark (`background: #0d0d0d; color: #d4d4d4`).

### SVG chart grid lines

The existing hand-rolled `LineChart` SVG in `RunDetailPage.jsx` uses hardcoded `stroke="#e8e8e8"` for grid lines and `fill="#888"` for axis labels. Update to `stroke="#2a3045"` and `fill="#7a8399"` to match dark theme.

---

## Section 2 — YAML Preview Fix

### Files changed

- `control-plane/frontend/src/components/DriverForm.jsx`
- `control-plane/frontend/src/components/WorkloadForm.jsx`
- `control-plane/frontend/src/index.css`

### Changes

**`index.css`**: Change `.form-textarea { resize: vertical }` to `resize: both`. This applies globally but only the tall YAML preview textareas are affected in practice — all other textareas are short single-field inputs.

**`DriverForm.jsx` and `WorkloadForm.jsx`**: The `<details>` element wrapping the YAML preview currently has no explicit width, causing some browsers to shrink it to fit-content. Add `style={{ width: '100%' }}` to the `<details>` element in both components. Remove the inline `style={{ fontFamily: 'monospace', fontSize: 12 }}` from the textarea and instead rely on `.form-textarea` class styles (which already set the monospace font).

No layout changes — YAML preview stays inside its respective Driver/Workload column (the 2-column `form-row` in `RunsPage.jsx` is unchanged).

---

## Section 3 — Live Results Charts

### New dependency

```
recharts  (latest stable, ~150KB gzipped)
```

Add to `control-plane/frontend/package.json`. No backend changes required.

### New file: `RunCharts.jsx`

**Location:** `control-plane/frontend/src/components/RunCharts.jsx`

**Props:**
```js
{
  livePoints:        Array<LivePoint>,   // populated during live run
  metricsOut:        MetricsOut | null,   // run.metrics from SQLite after completion (throughput_timeseries + backlog_timeseries are JSON strings — parse inside RunCharts)
  promSamples:       Array<PromSample>,  // from /api/prometheus/runs/{id}
  isLive:            bool,               // true while run status === 'running'
}
```

**Types:**
```js
// Built by parsing WebSocket log lines during a run
LivePoint = {
  t:          number,  // elapsed seconds
  pubMsgSec:  number,
  pubMBSec:   number,
  consMsgSec: number,
  consMBSec:  number,
  backlog:    number,
  pubP99:     number | null,
  e2eP99:     number | null,
}

// Parsed from metrics.throughput_timeseries + metrics.backlog_timeseries JSON
// These replace livePoints on completion
TimeSeries = {
  publishRate:  number[],   // one entry per sample_rate_ms interval
  consumeRate:  number[],
  backlog:      number[],
  sampleRateMs: number,
}

// From existing GET /api/prometheus/runs/{id}
PromSample = { t: number, bytes_in_per_sec: number, bytes_out_per_sec: number, records_per_sec: number }
```

**Chart layout:**

The component uses CSS grid to arrange five Recharts `<LineChart>` instances, each wrapped in `<ResponsiveContainer width="100%" height={180}>`. All charts share `syncId="run"` so cursor hover syncs across all simultaneously.

```
Row 1 — 3-column grid:
  [OMB msg/s]  [OMB MB/s]  [OMB Backlog]

Row 2 — 2-column grid:
  [Pub Latency P99/P999]  [E2E Latency P99/P999]

Row 3 — 2-column grid (only rendered if promSamples.length > 0):
  [Broker bytes in/out]  [Records/sec]
```

**Source badges:**

Each chart card header renders a small pill badge next to the title:

```jsx
// OMB badge
<span className="source-badge source-badge-omb">OMB</span>

// Redpanda badge
<span className="source-badge source-badge-redpanda">Redpanda</span>
```

CSS in `index.css`:
```css
.source-badge {
  font-size: 10px; font-weight: 500; padding: 1px 6px;
  border-radius: 4px; text-transform: uppercase; letter-spacing: 0.06em;
}
.source-badge-omb {
  background: rgba(51,65,85,0.6); color: #64748b; border: 1px solid #334155;
}
.source-badge-redpanda {
  background: rgba(127,29,29,0.4); color: #f87171; border: 1px solid rgba(153,27,27,0.6);
}
```

**Live log parsing:**

```js
// Regex for OMB's periodic log lines (per-second stats during run)
// Example: "Pub rate: 98,412.3 msg/s / 96.1 MB/s | Cons rate: 97,881.2 msg/s / 95.6 MB/s | Backlog: 0 K msgs | Pub Latency (ms) avg:  8.2 - 50%:  7.4 - 99%: 15.2 - 99.9%: 22.4 | E2E Latency (ms) avg: 11.3 - 50%: 10.1 - 99%: 18.6"
function parseLiveMetric(line, elapsedSec) { ... }
```

The exact regex is determined by the actual OMB log format seen in production runs. The parser attempts to extract pub/cons rates, backlog, pub p99, and e2e p99 from each line. Lines that don't match are silently ignored.

`RunDetailPage.jsx` accumulates parsed points in a `livePoints` state array (one entry per matched log line). On WebSocket `done` message, the component loads the final `metricsTimeseries` from the run's `metrics` field and `promSamples` from the Prometheus endpoint — these replace `livePoints` as the chart data source.

### Changes to `RunDetailPage.jsx`

- Remove the existing hand-rolled `LineChart` SVG component (lines ~59–116).
- Remove the single `promSamples` Prometheus chart render block.
- Add `livePoints` state array populated by the `parseLiveMetric` call inside `ws.onmessage`.
- On run completion (`logDone === true`), call `getPrometheusSamples(id)` as before.
- Render `<RunCharts livePoints={livePoints} metricsTimeseries={run.metrics} promSamples={promSamples} isLive={run.status === 'running'} />` below the metric tiles and above the log viewer.

### Data source priority

| Run state | Chart data source |
|---|---|
| `running` | `livePoints` (WebSocket-parsed) |
| `completed` | `metricsTimeseries` (SQLite timeseries JSON) + `promSamples` |
| `failed` / `cancelled` | `livePoints` if any were captured; otherwise charts hidden |

### OMB log format note

The exact format of OMB's periodic log lines must be verified against actual run output before the regex is finalized. The implementation should log a warning to the browser console if no lines match after 10 seconds of a running run, so the developer can see the actual log format and adjust the regex.

---

## Files Changed

| File | Change type |
|---|---|
| `control-plane/frontend/src/index.css` | Modify — dark theme variables + secondary colors + badge styles |
| `control-plane/frontend/src/components/DriverForm.jsx` | Modify — `<details>` width fix, `resize: both` |
| `control-plane/frontend/src/components/WorkloadForm.jsx` | Modify — same as DriverForm |
| `control-plane/frontend/src/components/RunCharts.jsx` | **New** — Recharts chart panel |
| `control-plane/frontend/src/pages/RunDetailPage.jsx` | Modify — wire RunCharts, live parsing, remove old SVG LineChart |
| `control-plane/frontend/package.json` | Modify — add `recharts` dependency |

No backend changes. No new API endpoints. No Helm/Terraform changes.

---

## Out of Scope

- Sweep detail page charts (separate session)
- Chart interactivity beyond Recharts defaults (zoom, pan, export)
- Latency percentile table on the results page (unchanged)
- Any changes to the New Run form layout beyond the YAML preview fix
