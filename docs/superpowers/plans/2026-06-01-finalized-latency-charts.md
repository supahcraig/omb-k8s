# Finalized Latency Charts & UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After run completion, show per-second latency charts from the JSON result file, keep all charts visible (no disclosure wrapper), collapse the Run Log automatically, and narrow the nines table.

**Architecture:** Backend adds P50 latency arrays to the `timeSeries` API response. Frontend adds per-second latency charts to `FinalizedCharts` using that data. `RunDetailPage` removes the disclosure wrapper around `RunCharts` for completed runs and converts the Run Log card to an auto-collapsing `<details>`. The nines table gets a `maxWidth` to stop it from stretching full-width.

**Tech Stack:** Python/FastAPI (backend), React 18 + Recharts (frontend)

---

## File Map

**Modified:**
- `control-plane/services/hdr_result_parser.py` — add P50 latency arrays to `timeSeries`
- `control-plane/tests/test_hdr_result_parser.py` — update test fixture and assertions
- `control-plane/frontend/src/components/FinalizedCharts.jsx` — add latency time series charts; narrow nines table
- `control-plane/frontend/src/pages/RunDetailPage.jsx` — remove disclosure wrapper; collapse log on completion; pass `warmupSamples` to FinalizedCharts

---

## Task 1: Add P50 latency arrays to timeSeries in hdr_result_parser.py

**Files:**
- Modify: `control-plane/services/hdr_result_parser.py`
- Modify: `control-plane/tests/test_hdr_result_parser.py`

**Context:** The `timeSeries` dict currently returns P99 and P999 latency arrays. Adding P50 gives the frontend three lines matching what RunCharts shows during live streaming.

- [ ] **Step 1: Write failing test**

In `control-plane/tests/test_hdr_result_parser.py`, add to `_make_result_file` (the fixture data dict) these two keys alongside the existing `publishLatency99pct`:

```python
        "publishLatency50pct":  [3.0, 3.1],
        "endToEndLatency50pct": [3.5, 3.6],
```

Then add a new test after `test_parse_hdr_results_from_file_returns_all_sections`:

```python
def test_parse_hdr_results_timeseries_includes_p50():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        path = f.name
    try:
        _make_result_file(path)
        result = parse_hdr_results_from_file(path)
        assert result is not None
        ts = result["timeSeries"]
        assert "publishLatencyP50"  in ts
        assert "endToEndLatencyP50" in ts
        assert ts["publishLatencyP50"]  == [3.0, 3.1]
        assert ts["endToEndLatencyP50"] == [3.5, 3.6]
    finally:
        os.unlink(path)
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane
python -m pytest tests/test_hdr_result_parser.py::test_parse_hdr_results_timeseries_includes_p50 -v 2>&1 | tail -10
```

Expected: FAIL — `publishLatencyP50` key missing.

- [ ] **Step 3: Add P50 to timeSeries in hdr_result_parser.py**

In `parse_hdr_results_from_file`, find the `"timeSeries"` dict (around line 138). Add two lines:

```python
        "timeSeries": {
            "publishRate":         data.get("publishRate", []),
            "consumeRate":         data.get("consumeRate", []),
            "backlog":             data.get("backlog", []),
            "publishLatencyP50":   data.get("publishLatency50pct", []),
            "publishLatencyP99":   data.get("publishLatency99pct", []),
            "publishLatencyP999":  data.get("publishLatency999pct", []),
            "endToEndLatencyP50":  data.get("endToEndLatency50pct", []),
            "endToEndLatencyP99":  data.get("endToEndLatency99pct", []),
            "endToEndLatencyP999": data.get("endToEndLatency999pct", []),
        },
```

- [ ] **Step 4: Run all backend tests**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane
python -m pytest tests/ -v 2>&1 | tail -15
```

Expected: all tests pass including the new one.

- [ ] **Step 5: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/services/hdr_result_parser.py control-plane/tests/test_hdr_result_parser.py
git commit -m "feat: add P50 latency arrays to timeSeries API response"
```

---

## Task 2: Add latency time series charts and narrow nines table in FinalizedCharts

**Files:**
- Modify: `control-plane/frontend/src/components/FinalizedCharts.jsx`

**Context:** `FinalizedCharts` receives `results` (the HDR API response) and a new `warmupSamples` prop (integer, default 60). It will add two Recharts `LineChart` cards showing per-second P50/P99/P999 latency from `results.timeSeries`. The nines table gets `maxWidth: 360` so it no longer stretches full width.

The color constants needed for latency lines:
- P50: `'#6ee7b7'`, P99: `'#f59e0b'`, P999: `'#fcd34d'` (publish)
- P50: `'#6ee7b7'`, P99: `'#fcd34d'`, P999: `'#fb923c'` (e2e)

`ReferenceArea` and `Legend` need to be added to the Recharts import.

- [ ] **Step 1: Read the current FinalizedCharts.jsx**

Read `/Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend/src/components/FinalizedCharts.jsx` in full before making any changes.

- [ ] **Step 2: Update the Recharts import to include Legend and ReferenceArea**

Find the existing import:
```js
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
```

Replace with:
```js
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceArea, ResponsiveContainer,
} from 'recharts'
```

- [ ] **Step 3: Add latency color constants to C**

The existing `C` object has `publish`, `e2e`, `grid`, `axis`, `bg`, `paper`, `text`. Add latency-specific colors:

```js
const C = {
  publish:  '#e63946',
  e2e:      '#6ee7b7',
  grid:     '#2a3045',
  axis:     '#7a8399',
  bg:       '#171c28',
  paper:    '#1e2538',
  text:     '#e8edf8',
  pubP50:   '#6ee7b7',
  pubP99:   '#f59e0b',
  pubP999:  '#fcd34d',
  e2eP50:   '#6ee7b7',
  e2eP99:   '#fcd34d',
  e2eP999:  '#fb923c',
}
```

- [ ] **Step 4: Add the LatencyTimeSeries chart function**

Add this function before the `SectionHeading` function (after `HistogramRecharts`):

```jsx
function LatencyTimeSeries({ timeSeries, sampleRateMs = 1000, warmupSamples = 60, title, p50Color, p99Color, p999Color }) {
  const stepSec = sampleRateMs / 1000
  const p99arr  = timeSeries?.publishLatencyP99 || timeSeries?.endToEndLatencyP99 || []

  // Detect which prefix this chart uses based on which keys are populated
  const isE2E    = title.toLowerCase().includes('end-to-end')
  const p50arr   = isE2E ? (timeSeries?.endToEndLatencyP50  || []) : (timeSeries?.publishLatencyP50  || [])
  const p99data  = isE2E ? (timeSeries?.endToEndLatencyP99  || []) : (timeSeries?.publishLatencyP99  || [])
  const p999arr  = isE2E ? (timeSeries?.endToEndLatencyP999 || []) : (timeSeries?.publishLatencyP999 || [])

  if (p99data.length === 0) return <div style={{ color: C.axis, fontSize: 12, padding: 8 }}>No data</div>

  const warmupEndSec = warmupSamples * stepSec
  const data = p99data.map((_, i) => ({
    t:    i * stepSec,
    p50:  i < warmupSamples ? null : (p50arr[i]  ?? null),
    p99:  i < warmupSamples ? null : (p99data[i] ?? null),
    p999: i < warmupSamples ? null : (p999arr[i] ?? null),
  }))

  const totalSecs    = data.length * stepSec
  const xTickInterval = totalSecs <= 300 ? 30 : totalSecs <= 1800 ? 300 : 600
  const xTicks        = Array.from({ length: Math.floor(totalSecs / xTickInterval) + 1 }, (_, i) => i * xTickInterval)

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
        <XAxis
          dataKey="t"
          stroke={C.axis}
          tick={{ fill: C.axis, fontSize: 10 }}
          ticks={xTicks}
          tickFormatter={v => `${v}s`}
        />
        <YAxis
          stroke={C.axis}
          tick={{ fill: C.axis, fontSize: 10 }}
          width={50}
          label={{ value: 'ms', angle: -90, position: 'insideLeft', fill: C.axis, fontSize: 10 }}
        />
        <Tooltip
          contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: C.text, fontSize: 11 }}
          formatter={(v, name) => [v != null ? `${v.toFixed(2)} ms` : '—', name]}
          labelFormatter={v => `${v}s`}
        />
        <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
        {warmupSamples > 0 && data.length > 0 && (
          <ReferenceArea x1={0} x2={Math.min(warmupEndSec, data[data.length - 1].t)} fill="rgba(255,255,255,0.04)" />
        )}
        <Line type="monotone" dataKey="p50"  name="p50"   stroke={p50Color}  dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls />
        <Line type="monotone" dataKey="p99"  name="p99"   stroke={p99Color}  dot={false} strokeWidth={2}   connectNulls />
        <Line type="monotone" dataKey="p999" name="p99.9" stroke={p999Color} dot={false} strokeWidth={1.5} strokeDasharray="2 2" connectNulls />
      </LineChart>
    </ResponsiveContainer>
  )
}
```

- [ ] **Step 5: Update FinalizedCharts default export to accept warmupSamples and render the new charts**

Replace the `export default function FinalizedCharts({ results })` signature and body with:

```jsx
export default function FinalizedCharts({ results, warmupSamples = 60 }) {
  if (!results) return null
  const { aggregates, percentileCurves, histograms, timeSeries, metadata } = results
  const pubCurve      = percentileCurves?.publish  || []
  const e2eCurve      = percentileCurves?.endToEnd || []
  const pubHist       = histograms?.publish        || []
  const e2eHist       = histograms?.endToEnd       || []
  const sampleRateMs  = metadata?.sampleRateMillis ?? 1000

  return (
    <div>
      {/* ── Results summary — nines table (narrow) ── */}
      <SectionHeading>Results summary</SectionHeading>
      <div className="card" style={{ padding: '0 0 4px', maxWidth: 360 }}>
        <NinesTable aggregates={aggregates} />
      </div>

      {/* ── Latency time series from JSON ── */}
      <SectionHeading>Latency over time</SectionHeading>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="chart-card">
          <div style={{ fontSize: 12, color: C.text, marginBottom: 6, fontWeight: 500 }}>Publish latency (ms)</div>
          <LatencyTimeSeries
            timeSeries={timeSeries}
            sampleRateMs={sampleRateMs}
            warmupSamples={warmupSamples}
            title="publish"
            p50Color={C.pubP50}
            p99Color={C.pubP99}
            p999Color={C.pubP999}
          />
        </div>
        <div className="chart-card">
          <div style={{ fontSize: 12, color: C.text, marginBottom: 6, fontWeight: 500 }}>End-to-end latency (ms)</div>
          <LatencyTimeSeries
            timeSeries={timeSeries}
            sampleRateMs={sampleRateMs}
            warmupSamples={warmupSamples}
            title="end-to-end"
            p50Color={C.e2eP50}
            p99Color={C.e2eP99}
            p999Color={C.e2eP999}
          />
        </div>
      </div>

      {/* ── Latency distribution — percentile curves ── */}
      <SectionHeading>Latency distribution — percentile curves</SectionHeading>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="chart-card">
          <PercentileCurveRecharts data={pubCurve} title="Publish latency percentile curve" color={C.publish} />
        </div>
        <div className="chart-card">
          <PercentileCurveRecharts data={e2eCurve} title="End-to-end latency percentile curve" color={C.e2e} />
        </div>
      </div>

      {/* ── Latency distribution — histograms ── */}
      <SectionHeading>Latency distribution — histograms</SectionHeading>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="chart-card">
          <HistogramRecharts data={pubHist} title="Publish latency histogram" color={C.publish} />
        </div>
        <div className="chart-card">
          <HistogramRecharts data={e2eHist} title="End-to-end latency histogram" color={C.e2e} />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Build to confirm no errors**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -5
```

Expected: `✓ built in` with no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/components/FinalizedCharts.jsx
git commit -m "feat: add latency time series charts from JSON data, narrow nines table"
```

---

## Task 3: RunDetailPage — remove disclosure, collapse log, pass warmupSamples

**Files:**
- Modify: `control-plane/frontend/src/pages/RunDetailPage.jsx`

**Context:** Three independent changes:

1. **Remove disclosure wrapper** — `RunCharts` in the completed view is currently wrapped in `<details>`. Remove it; render `RunCharts` directly.

2. **Auto-collapse Run Log** — The Run Log is a plain card. Convert it to a `<details>` element. Add `logOpen` state (default `true`). An effect sets `logOpen = false` when `run.status` transitions to `'completed'`. The user can re-open it manually.

3. **Pass warmupSamples to FinalizedCharts** — `warmupSamples` is already computed in the component. Pass it as a prop.

- [ ] **Step 1: Read the current RunDetailPage.jsx**

Read `/Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend/src/pages/RunDetailPage.jsx` in full before touching anything.

- [ ] **Step 2: Add logOpen state**

After the existing `hdrLoading` state declaration, add:

```js
const [logOpen, setLogOpen] = useState(true)
```

- [ ] **Step 3: Add useEffect to auto-collapse log on completion**

After the existing HDR fetch `useEffect` (keyed on `[id, run?.status]`), add:

```js
  useEffect(() => {
    if (run?.status === 'completed') setLogOpen(false)
  }, [run?.status])
```

- [ ] **Step 4: Pass warmupSamples to FinalizedCharts**

Find this line:
```jsx
          {hdrResults && <FinalizedCharts results={hdrResults} />}
```

Replace with:
```jsx
          {hdrResults && <FinalizedCharts results={hdrResults} warmupSamples={warmupSamples} />}
```

- [ ] **Step 5: Remove the disclosure wrapper from the completed-run RunCharts**

Find the entire `<details>` block (the "Raw time series data ▶" one) and its contents:

```jsx
          {/* Collapsed live charts */}
          <details style={{ marginTop: 20 }}>
            <summary style={{
              cursor: 'pointer', fontWeight: 600, fontSize: 14,
              color: 'var(--color-text-muted)', padding: '8px 0', userSelect: 'none',
            }}>
              Raw time series data ▶
            </summary>
            <div style={{ marginTop: 12 }}>
              <RunCharts
                livePoints={livePoints}
                metricsOut={run?.metrics ?? null}
                promSamples={promSamples}
                isLive={false}
                messageSize={messageSize}
                warmupSamples={warmupSamples}
                totalSamples={totalSamples}
                warmupStartedAt={warmupStartedAt}
                benchmarkStartedAt={benchmarkStartedAt}
                workerMemLimitMiB={workerResources?.memory_limit_mib ?? null}
                workerCpuCores={workerResources?.cpu_request_cores ?? null}
                runStartedAt={run?.started_at ?? null}
                expectedMsgSec={expectedMsgSec}
                expectedMBSec={expectedMBSec}
                expectedConsMsgSec={expectedConsMsgSec}
                expectedConsMBSec={expectedConsMBSec}
              />
            </div>
          </details>
```

Replace with (no wrapper, just RunCharts directly):

```jsx
          {/* Run charts — throughput, backlog, worker metrics */}
          <RunCharts
            livePoints={livePoints}
            metricsOut={run?.metrics ?? null}
            promSamples={promSamples}
            isLive={false}
            messageSize={messageSize}
            warmupSamples={warmupSamples}
            totalSamples={totalSamples}
            warmupStartedAt={warmupStartedAt}
            benchmarkStartedAt={benchmarkStartedAt}
            workerMemLimitMiB={workerResources?.memory_limit_mib ?? null}
            workerCpuCores={workerResources?.cpu_request_cores ?? null}
            runStartedAt={run?.started_at ?? null}
            expectedMsgSec={expectedMsgSec}
            expectedMBSec={expectedMBSec}
            expectedConsMsgSec={expectedConsMsgSec}
            expectedConsMBSec={expectedConsMBSec}
          />
```

- [ ] **Step 6: Convert Run Log card to a collapsible details element**

Find the entire Run Log block:

```jsx
      {/* Log output */}
      <div className="card mt-20">
        <div className="card-header">
          <h3>Run Log</h3>
          {!logDone && run.status === 'running' && (
            <span className="text-small text-muted flex items-center gap-8">
              <span className="spinner spinner-dark" /> Live streaming…
            </span>
          )}
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="log-viewer">
            {logs.length === 0 && !logDone ? 'Waiting for log output…' : logs.join('\n')}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
```

Replace with:

```jsx
      {/* Log output */}
      <details
        className="card mt-20"
        style={{ padding: 0 }}
        open={logOpen}
        onToggle={e => setLogOpen(e.target.open)}
      >
        <summary style={{ padding: '12px 20px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          Run Log
          {!logDone && run.status === 'running' && (
            <span className="text-small text-muted flex items-center gap-8">
              <span className="spinner spinner-dark" /> Live streaming…
            </span>
          )}
        </summary>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="log-viewer">
            {logs.length === 0 && !logDone ? 'Waiting for log output…' : logs.join('\n')}
            <div ref={logEndRef} />
          </div>
        </div>
      </details>
```

- [ ] **Step 7: Build and run tests**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -5
npm test 2>&1 | tail -8
```

Expected: build succeeds, 37 tests pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/pages/RunDetailPage.jsx
git commit -m "feat: show all charts on completion, collapse Run Log, pass warmupSamples"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|-------------|------|
| Per-second latency charts from JSON (publish P50/P99/P999) | Tasks 1 + 2 |
| Per-second latency charts from JSON (e2e P50/P99/P999) | Tasks 1 + 2 |
| Warmup region blanked out on latency time series | Task 2 `LatencyTimeSeries` — nulls indices < warmupSamples |
| warmupSamples passed to FinalizedCharts | Task 3 Step 4 |
| No disclosure/hide wrapper on RunCharts after completion | Task 3 Step 5 |
| Run Log auto-collapses on completion | Task 3 Steps 2, 3, 6 |
| Run Log can be re-opened by user | Task 3 Step 6 — `onToggle` handler |
| Nines table max-width 360 | Task 2 Step 5 |
| P50 latency in API timeSeries response | Task 1 |
| Existing backend tests still pass | Task 1 Step 4 |
| Frontend build passes | Tasks 2 + 3 |
| Frontend tests pass | Task 3 Step 7 |

**Placeholder scan:** None found.

**Type consistency:**
- `LatencyTimeSeries` receives `timeSeries` object with keys `publishLatencyP50`, `publishLatencyP99`, `publishLatencyP999`, `endToEndLatencyP50`, `endToEndLatencyP99`, `endToEndLatencyP999` — these match exactly what Task 1 adds to the API response
- `FinalizedCharts` now destructures `timeSeries` and `metadata` from `results` — both are present in the API response shape
- `warmupSamples` is passed from `RunDetailPage` where it's computed as `(workloadParams?.values?.warmupDurationMinutes ?? 1) * 60` — integer, matching the `warmupSamples = 60` default in `FinalizedCharts`
- `sampleRateMs` sourced from `metadata?.sampleRateMillis ?? 1000` — present in API response `metadata` dict
