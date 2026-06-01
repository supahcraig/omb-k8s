# Chart Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Plotly dark background, apply nines-transform to percentile curve x-axes, add x-axis hover mode to Plotly, and add a Plotly version of the live run charts with a Recharts/Plotly tab switcher.

**Architecture:** All changes are frontend-only. Tasks 1 and 2 modify `FinalizedCharts.jsx`. Task 3 creates a new `RunChartsPlotly.jsx` mirroring `RunCharts.jsx` with Plotly traces. Task 4 adds a tab switcher to `RunDetailPage.jsx` that switches both the live and historical chart views between the two libraries.

**Tech Stack:** React 18, Recharts 3, plotly.js-dist-min, react-plotly.js

---

## File Map

**Modified:**
- `control-plane/frontend/src/components/FinalizedCharts.jsx` — tasks 1 and 2

**Created:**
- `control-plane/frontend/src/components/RunChartsPlotly.jsx` — task 3

**Modified:**
- `control-plane/frontend/src/pages/RunDetailPage.jsx` — task 4

---

## Task 1: Fix Plotly dark background and add hovermode to FinalizedCharts

**Files:**
- Modify: `control-plane/frontend/src/components/FinalizedCharts.jsx`

**Context:** The Plotly charts render with `paper_bgcolor: '#1e2538'` (a slightly lighter shade) while Recharts uses `#171c28` throughout. The fix is to change `paper_bgcolor` to match. Also, Plotly defaults to `hovermode: 'closest'` (requires cursor near the line) while Recharts shows the tooltip for any x-position — fix this by setting `hovermode: 'x'` on line charts.

- [ ] **Step 1: Read the current FinalizedCharts.jsx**

Read `/Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend/src/components/FinalizedCharts.jsx` and locate `PLOTLY_BASE_LAYOUT` (around line 22) and the `PercentileCurvePlotly` and `HistogramPlotly` functions.

- [ ] **Step 2: Fix paper_bgcolor in PLOTLY_BASE_LAYOUT**

Change `paper_bgcolor: C.paper` to `paper_bgcolor: C.bg`:

```js
const PLOTLY_BASE_LAYOUT = {
  paper_bgcolor: C.bg,   // was C.paper — use same dark bg as Recharts
  plot_bgcolor:  C.bg,
  font:   { color: C.text, size: 11 },
  margin: { t: 36, r: 16, b: 50, l: 60 },
  xaxis: { gridcolor: C.grid, linecolor: C.grid, tickcolor: C.axis, color: C.axis },
  yaxis: { gridcolor: C.grid, linecolor: C.grid, tickcolor: C.axis, color: C.axis },
  showlegend: false,
}
```

- [ ] **Step 3: Add hovermode: 'x' to PercentileCurvePlotly layout**

In `PercentileCurvePlotly`, the `layout` object is constructed inside the function. Add `hovermode: 'x'` to it:

```js
  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    hovermode: 'x',                  // add this line
    title: { text: title, font: { color: C.text, size: 12 }, x: 0.05, y: 0.97 },
    height: 250,
    xaxis: {
      ...PLOTLY_BASE_LAYOUT.xaxis,
      type: 'log',
      tickmode: 'array',
      tickvals: PCT_TICKS,
      ticktext: PCT_TICK_LABELS,
      title: { text: 'Percentile', font: { size: 10, color: C.axis }, standoff: 8 },
    },
    yaxis: {
      ...PLOTLY_BASE_LAYOUT.yaxis,
      title: { text: 'Latency (ms)', font: { size: 10, color: C.axis }, standoff: 8 },
    },
  }
```

Do NOT add `hovermode: 'x'` to `HistogramPlotly` — the default `'closest'` is correct for bar charts.

- [ ] **Step 4: Build to confirm no errors**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -5
```

Expected: `✓ built in` with no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/components/FinalizedCharts.jsx
git commit -m "fix: match Plotly background to Recharts dark theme, add hovermode x on curves"
```

---

## Task 2: Apply nines transform to percentile curve x-axes in FinalizedCharts

**Files:**
- Modify: `control-plane/frontend/src/components/FinalizedCharts.jsx`

**Context:** The current log scale on raw percentile values (50–99.999) compresses all labels into a 0.3-decade window (log10(50)=1.70, log10(99.999)=2.00), causing crowding. The industry-standard fix for HDR histograms is the **nines transform**: plot `100 / (100 - p)` on the x-axis instead of `p`. This maps P50→2, P90→10, P99→100, P99.9→1000, P99.99→10000, P99.999→100000 — exactly one decade per "nine", giving natural even spacing on a log scale.

- [ ] **Step 1: Remove PCT_TICKS and PCT_TICK_LABELS constants**

These constants (`const PCT_TICKS = [50, 90, ...]` and `const PCT_TICK_LABELS = ['50', '90', ...]`) are currently used only by the percentile curve charts. After this task they are replaced by the nines-transform tick values. Delete both lines.

- [ ] **Step 2: Replace PercentileCurveRecharts with the nines-transform version**

Replace the entire `PercentileCurveRecharts` function with:

```jsx
function PercentileCurveRecharts({ data, title, color }) {
  if (!data || data.length === 0) return <div style={{ color: C.axis, fontSize: 12, padding: 8 }}>No data</div>
  const ninesX = p => 100 / (100 - Math.min(p, 99.9999))
  const transformed = data.map(pt => ({ ...pt, ninesX: ninesX(pt.percentile) }))
  return (
    <div>
      <div style={{ fontSize: 12, color: C.text, marginBottom: 6, fontWeight: 500 }}>{title}</div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={transformed} margin={{ top: 4, right: 16, bottom: 20, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
          <XAxis
            dataKey="ninesX"
            scale="log"
            type="number"
            domain={[2, 100001]}
            ticks={[2, 10, 100, 1000, 10000, 100000]}
            tickFormatter={v => {
              if (v >= 100000) return '99.999'
              if (v >= 10000)  return '99.99'
              if (v >= 1000)   return '99.9'
              if (v >= 100)    return '99'
              if (v >= 10)     return '90'
              return '50'
            }}
            stroke={C.axis}
            tick={{ fill: C.axis, fontSize: 10 }}
            label={{ value: 'Percentile', position: 'insideBottom', offset: -10, fill: C.axis, fontSize: 10 }}
          />
          <YAxis
            stroke={C.axis}
            tick={{ fill: C.axis, fontSize: 10 }}
            width={50}
            label={{ value: 'ms', angle: -90, position: 'insideLeft', fill: C.axis, fontSize: 10 }}
          />
          <Tooltip
            contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: C.text, fontSize: 11 }}
            formatter={v => [`${v.toFixed(3)} ms`, 'latency']}
            labelFormatter={v => {
              const p = 100 - 100 / v
              if (p >= 99.999) return 'P99.999'
              if (p >= 99.99)  return 'P99.99'
              if (p >= 99.9)   return 'P99.9'
              if (p >= 99)     return 'P99'
              if (p >= 90)     return 'P90'
              return 'P50'
            }}
          />
          <Line type="monotone" dataKey="latencyMs" stroke={color} dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
```

- [ ] **Step 3: Replace PercentileCurvePlotly with the nines-transform version**

Replace the entire `PercentileCurvePlotly` function with:

```jsx
function PercentileCurvePlotly({ data, title, color }) {
  if (!data || data.length === 0) return <div style={{ color: C.axis, fontSize: 12, padding: 8 }}>No data</div>
  const ninesX = p => 100 / (100 - Math.min(p, 99.9999))
  const plotData = [{
    x: data.map(pt => ninesX(pt.percentile)),
    y: data.map(pt => pt.latencyMs),
    customdata: data.map(pt => pt.percentile),
    type: 'scatter',
    mode: 'lines',
    line: { color, width: 2 },
    hovertemplate: 'P%{customdata:.3f}<br>%{y:.3f} ms<extra></extra>',
  }]
  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    hovermode: 'x',
    title: { text: title, font: { color: C.text, size: 12 }, x: 0.05, y: 0.97 },
    height: 250,
    xaxis: {
      ...PLOTLY_BASE_LAYOUT.xaxis,
      type: 'log',
      tickmode: 'array',
      tickvals: [2, 10, 100, 1000, 10000, 100000],
      ticktext: ['50', '90', '99', '99.9', '99.99', '99.999'],
      title: { text: 'Percentile', font: { size: 10, color: C.axis }, standoff: 8 },
    },
    yaxis: {
      ...PLOTLY_BASE_LAYOUT.yaxis,
      title: { text: 'Latency (ms)', font: { size: 10, color: C.axis }, standoff: 8 },
    },
  }
  return (
    <Plot
      data={plotData}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: '100%' }}
      useResizeHandler
    />
  )
}
```

- [ ] **Step 4: Build and confirm no errors**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -5
```

Expected: `✓ built in` with no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/components/FinalizedCharts.jsx
git commit -m "feat: apply nines transform to percentile curve x-axes for even log spacing"
```

---

## Task 3: Create RunChartsPlotly component

**Files:**
- Create: `control-plane/frontend/src/components/RunChartsPlotly.jsx`

**Context:** This component accepts the exact same props as `RunCharts` and renders Plotly equivalents of all four chart rows: (1) throughput msg/s, MB/s, backlog; (2) publish and e2e latency; (3) broker metrics (conditional); (4) worker CPU and memory. `RunCharts.jsx` must NOT be modified. All dark-theme colors match the existing `C` palette from `RunCharts.jsx`.

- [ ] **Step 1: Create RunChartsPlotly.jsx**

Create `/Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend/src/components/RunChartsPlotly.jsx`:

```jsx
import React from 'react'
import Plotly from 'plotly.js-dist-min'
import createPlotlyComponent from 'react-plotly.js/factory'
import { normalizeTimeseries, promToChartData } from '../lib/chartDataUtils.js'

const Plot = createPlotlyComponent(Plotly)

const C = {
  grid:         '#2a3045',
  axis:         '#7a8399',
  bg:           '#171c28',
  text:         '#e8edf8',
  publish:      '#e63946',
  consume:      '#4ade80',
  backlog:      '#f59e0b',
  pubP50:       '#6ee7b7',
  pubP99:       '#f59e0b',
  pubP999:      '#fcd34d',
  e2eP50:       '#6ee7b7',
  e2eP99:       '#fcd34d',
  e2eP999:      '#fb923c',
  bytesIn:      '#38bdf8',
  bytesOut:     '#7dd3fc',
  records:      '#a78bfa',
  workerColors: ['#818cf8', '#34d399', '#f97316', '#fbbf24', '#a78bfa', '#38bdf8', '#fb923c', '#4ade80'],
}

const BASE = {
  paper_bgcolor: C.bg,
  plot_bgcolor:  C.bg,
  font:          { color: C.text, size: 10 },
  margin:        { t: 28, r: 10, b: 40, l: 55 },
  xaxis:         { gridcolor: C.grid, linecolor: C.grid, tickcolor: C.axis, color: C.axis },
  yaxis:         { gridcolor: C.grid, linecolor: C.grid, tickcolor: C.axis, color: C.axis },
  legend:        { font: { size: 10, color: C.axis }, bgcolor: 'rgba(0,0,0,0)', x: 0, y: 1 },
  showlegend:    true,
  hovermode:     'x',
  height:        200,
}

function trace(x, y, name, color, dash = 'solid', width = 2) {
  return {
    x, y,
    type: 'scatter', mode: 'lines', name,
    line: { color, width, dash },
    hovertemplate: `${name}: %{y:.2f}<extra></extra>`,
    connectgaps: false,
  }
}

function hLine(y, color, dash = 'dot') {
  return {
    type: 'line', xref: 'paper', x0: 0, x1: 1,
    yref: 'y', y0: y, y1: y,
    line: { color, dash, width: 1.5 },
  }
}

function warmupRect(x1) {
  if (!x1) return null
  return {
    type: 'rect', xref: 'x', x0: 0, x1,
    yref: 'paper', y0: 0, y1: 1,
    fillcolor: 'rgba(255,255,255,0.04)', line: { width: 0 },
  }
}

function ann(x, y, text, color, anchor = 'right') {
  return {
    xref: 'paper', x, yref: 'y', y,
    text, showarrow: false,
    font: { color, size: 9 },
    xanchor: anchor, yanchor: 'bottom',
  }
}

function ChartCard({ title, badge, children }) {
  return (
    <div className="chart-card">
      <div className="chart-card-header">
        <span className="chart-card-title">{title}</span>
        {badge && <span className={`source-badge source-badge-${badge}`}>{badge}</span>}
      </div>
      {children}
    </div>
  )
}

const CFG = { displayModeBar: false, responsive: true }

function _parseBase(isoString) {
  if (!isoString) return null
  const s = isoString.endsWith('Z') ? isoString : isoString + 'Z'
  const ms = new Date(s).getTime()
  return isNaN(ms) ? null : ms
}

export default function RunChartsPlotly({
  livePoints = [],
  metricsOut = null,
  promSamples = [],
  isLive = false,
  messageSize = 1024,
  warmupSamples = 60,
  totalSamples = 360,
  warmupStartedAt = null,
  benchmarkStartedAt = null,
  workerMemLimitMiB = null,
  workerCpuCores = null,
  runStartedAt = null,
  expectedMsgSec     = 0,
  expectedMBSec      = 0,
  expectedConsMsgSec = 0,
  expectedConsMBSec  = 0,
}) {
  const rawPoints   = livePoints.length > 0 ? livePoints : (metricsOut ? normalizeTimeseries(metricsOut, messageSize) : [])
  const chartPoints = rawPoints.map(p => p.backlog != null && p.backlog < 0 ? { ...p, backlog: 0 } : p)
  const promPoints  = promToChartData(promSamples)

  const hasLatency      = chartPoints.some(p => p.pubP99 != null || p.pubP50 != null)
  const hasBrokerMetrics = promPoints.some(p => p.bytesInMBSec != null || p.bytesOutMBSec != null)
  const hasWorkerMetrics = promPoints.some(p => p.workerCpuPct != null || p.workerMemMiB != null)

  if (!isLive && chartPoints.length === 0 && promPoints.length === 0) return null

  const isShortRun    = totalSamples <= 300
  const xTickInterval = totalSamples <= 300 ? 30 : totalSamples <= 1800 ? 300 : 600
  const xTicks        = Array.from({ length: Math.floor(totalSamples / xTickInterval) + 1 }, (_, i) => i * xTickInterval)
  const timeOpts      = isShortRun
    ? { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour12: false, hour: '2-digit', minute: '2-digit' }

  const runStartedAtMs = _parseBase(runStartedAt)
  const ombTimeBase    = warmupStartedAt ?? runStartedAtMs
  const promTimeBase   = runStartedAtMs

  function fmtTick(base) {
    return t => base
      ? new Date(base + t * 1000).toLocaleTimeString([], timeOpts)
      : isShortRun ? `${t}s` : `${Math.floor(t / 60)}m`
  }

  function xAxis(base) {
    return {
      ...BASE.xaxis,
      tickmode: 'array',
      tickvals: xTicks,
      ticktext: xTicks.map(fmtTick(base)),
    }
  }

  const xVals   = chartPoints.map(p => p.t)
  const promX   = promPoints.map(p => p.t)

  const lastT   = chartPoints.length > 0 ? chartPoints[chartPoints.length - 1].t : 0
  const wu      = warmupRect(warmupSamples > 0 && lastT > 0 ? Math.min(warmupSamples, lastT) : null)
  const wuShapes = wu ? [wu] : []

  const workerPods = [...new Set(
    promPoints.flatMap(p => Object.keys(p).filter(k => k.startsWith('workerMem_')).map(k => k.slice('workerMem_'.length)))
  )].sort()

  // Null out warmup samples for latency traces (same as Recharts version)
  function latencyVals(key) {
    return chartPoints.map((p, i) => i < warmupSamples ? null : (p[key] ?? null))
  }

  return (
    <div className="run-charts">

      {/* Row 1: Throughput */}
      <div className="charts-row charts-row-3">
        <ChartCard title="Throughput (msg/s)" badge="omb">
          <Plot
            data={[
              trace(xVals, chartPoints.map(p => p.pubMsgSec),  'publish', C.publish),
              trace(xVals, chartPoints.map(p => p.consMsgSec), 'consume', C.consume, 'dot', 1.5),
            ]}
            layout={{
              ...BASE, xaxis: xAxis(ombTimeBase),
              shapes: [
                ...(expectedMsgSec > 0      ? [hLine(expectedMsgSec, 'rgba(245,158,11,0.7)')] : []),
                ...(expectedConsMsgSec > 0 && expectedConsMsgSec !== expectedMsgSec ? [hLine(expectedConsMsgSec, 'rgba(74,222,128,0.6)')] : []),
              ],
              annotations: [
                ...(expectedMsgSec > 0 ? [ann(0.98, expectedMsgSec, 'pub target', 'rgba(245,158,11,0.8)')] : []),
                ...(expectedConsMsgSec > 0 && expectedConsMsgSec !== expectedMsgSec ? [ann(0.98, expectedConsMsgSec, 'cons target', 'rgba(74,222,128,0.7)', 'right')] : []),
              ],
            }}
            config={CFG} style={{ width: '100%' }} useResizeHandler
          />
        </ChartCard>

        <ChartCard title="Throughput (MB/s)" badge="omb">
          <Plot
            data={[
              trace(xVals, chartPoints.map(p => p.pubMBSec),  'publish', C.publish),
              trace(xVals, chartPoints.map(p => p.consMBSec), 'consume', C.consume, 'dot', 1.5),
            ]}
            layout={{
              ...BASE, xaxis: xAxis(ombTimeBase),
              shapes: [
                ...(expectedMBSec > 0 ? [hLine(expectedMBSec, 'rgba(245,158,11,0.7)')] : []),
                ...(expectedConsMBSec > 0 && expectedConsMBSec !== expectedMBSec ? [hLine(expectedConsMBSec, 'rgba(74,222,128,0.6)')] : []),
              ],
              annotations: [
                ...(expectedMBSec > 0 ? [ann(0.98, expectedMBSec, 'pub target', 'rgba(245,158,11,0.8)')] : []),
                ...(expectedConsMBSec > 0 && expectedConsMBSec !== expectedMBSec ? [ann(0.98, expectedConsMBSec, 'cons target', 'rgba(74,222,128,0.7)')] : []),
              ],
            }}
            config={CFG} style={{ width: '100%' }} useResizeHandler
          />
        </ChartCard>

        <ChartCard title="Backlog (msgs)" badge="omb">
          <Plot
            data={[trace(xVals, chartPoints.map(p => p.backlog), 'backlog', C.backlog)]}
            layout={{ ...BASE, xaxis: xAxis(ombTimeBase) }}
            config={CFG} style={{ width: '100%' }} useResizeHandler
          />
        </ChartCard>
      </div>

      {/* Row 2: Latency */}
      {hasLatency && (
        <div className="charts-row charts-row-2">
          <ChartCard title="Publish Latency (ms)" badge="omb">
            <Plot
              data={[
                trace(xVals, latencyVals('pubP50'),  'p50',   C.pubP50,  'dot',  1.5),
                trace(xVals, latencyVals('pubP99'),  'p99',   C.pubP99),
                trace(xVals, latencyVals('pubP999'), 'p99.9', C.pubP999, 'dash', 1.5),
              ]}
              layout={{ ...BASE, xaxis: xAxis(ombTimeBase), shapes: wuShapes }}
              config={CFG} style={{ width: '100%' }} useResizeHandler
            />
          </ChartCard>

          <ChartCard title="E2E Latency (ms)" badge="omb">
            <Plot
              data={[
                trace(xVals, latencyVals('e2eP50'),  'p50',   C.e2eP50,  'dot',  1.5),
                trace(xVals, latencyVals('e2eP99'),  'p99',   C.e2eP99),
                trace(xVals, latencyVals('e2eP999'), 'p99.9', C.e2eP999, 'dash', 1.5),
              ]}
              layout={{ ...BASE, xaxis: xAxis(ombTimeBase), shapes: wuShapes }}
              config={CFG} style={{ width: '100%' }} useResizeHandler
            />
          </ChartCard>
        </div>
      )}

      {/* Row 3: Broker metrics */}
      {hasBrokerMetrics && (
        <div className="charts-row charts-row-2">
          <ChartCard title="Broker Bytes In/Out (MB/s)" badge="redpanda">
            <Plot
              data={[
                trace(promX, promPoints.map(p => p.bytesInMBSec),  'bytes in',  C.bytesIn),
                trace(promX, promPoints.map(p => p.bytesOutMBSec), 'bytes out', C.bytesOut, 'dot', 1.5),
              ]}
              layout={{ ...BASE, xaxis: xAxis(promTimeBase) }}
              config={CFG} style={{ width: '100%' }} useResizeHandler
            />
          </ChartCard>

          <ChartCard title="Records / sec" badge="redpanda">
            <Plot
              data={[trace(promX, promPoints.map(p => p.recordsPerSec), 'records/sec', C.records)]}
              layout={{ ...BASE, xaxis: xAxis(promTimeBase) }}
              config={CFG} style={{ width: '100%' }} useResizeHandler
            />
          </ChartCard>
        </div>
      )}

      {/* Row 4: Worker metrics */}
      {(hasWorkerMetrics || isLive) && (
        <div className="charts-row charts-row-2">
          <ChartCard title={`Worker CPU (%) — ${workerCpuCores ?? 4} cores`} badge="worker">
            <Plot
              data={[
                ...(workerPods.length > 0
                  ? workerPods.map((pod, i) =>
                      trace(promX, promPoints.map(p => p[`workerCpu_${pod}`] ?? null),
                        pod.replace('omb-worker-', 'worker-'), C.workerColors[i % C.workerColors.length])
                    )
                  : [trace(promX, promPoints.map(p => p.workerCpuPct), 'cpu usage', '#f97316')]
                ),
                trace(promX, promPoints.map(p => p.workerThrottlePct), 'throttled', '#ef4444', 'dot', 1.5),
              ]}
              layout={{
                ...BASE,
                xaxis: xAxis(promTimeBase),
                yaxis: { ...BASE.yaxis, rangemode: 'tozero' },
                shapes: [
                  hLine(85, 'rgba(239,68,68,0.5)'),
                  hLine(100, 'rgba(239,68,68,0.7)', 'solid'),
                ],
              }}
              config={CFG} style={{ width: '100%' }} useResizeHandler
            />
          </ChartCard>

          <ChartCard title="Worker Memory (GiB)" badge="worker">
            <Plot
              data={
                workerPods.length > 0
                  ? workerPods.map((pod, i) =>
                      trace(
                        promX,
                        promPoints.map(p => p[`workerMem_${pod}`] != null ? p[`workerMem_${pod}`] / 1024 : null),
                        pod.replace('omb-worker-', 'worker-'),
                        C.workerColors[i % C.workerColors.length]
                      )
                    )
                  : [trace(promX, promPoints.map(p => p.workerMemMiB != null ? p.workerMemMiB / 1024 : null), 'memory', '#818cf8')]
              }
              layout={{
                ...BASE,
                xaxis: xAxis(promTimeBase),
                yaxis: { ...BASE.yaxis, rangemode: 'tozero', ticksuffix: ' GiB' },
                shapes: [{
                  type: 'line', xref: 'paper', x0: 0, x1: 1,
                  yref: 'y',
                  y0: (workerMemLimitMiB ?? 8192) / 1024,
                  y1: (workerMemLimitMiB ?? 8192) / 1024,
                  line: { color: 'rgba(239,68,68,0.4)', dash: 'dot', width: 1.5 },
                }],
              }}
              config={CFG} style={{ width: '100%' }} useResizeHandler
            />
          </ChartCard>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build to confirm no errors**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -5
```

Expected: `✓ built in` with no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/components/RunChartsPlotly.jsx
git commit -m "feat: add RunChartsPlotly component — Plotly equivalents of all live run charts"
```

---

## Task 4: Add Recharts/Plotly tab switcher to RunDetailPage

**Files:**
- Modify: `control-plane/frontend/src/pages/RunDetailPage.jsx`

**Context:** `RunDetailPage` currently renders `RunCharts` for live runs and inside a `<details>` disclosure for completed runs. Add a two-button tab switcher ("Recharts" / "Plotly") that swaps the chart component. The switcher appears once, above the charts, and controls both contexts. `RunCharts` and `RunChartsPlotly` accept identical props.

- [ ] **Step 1: Add the RunChartsPlotly import**

In `RunDetailPage.jsx`, find the existing imports and add one line after the `RunCharts` import:

```js
import RunCharts from '../components/RunCharts.jsx'
import RunChartsPlotly from '../components/RunChartsPlotly.jsx'
```

- [ ] **Step 2: Add chartsTab state**

After the existing `useState` declarations (around line 126 where `hdrResults` and `hdrLoading` live), add:

```js
const [chartsTab, setChartsTab] = useState('recharts')
```

- [ ] **Step 3: Create a shared ChartTabSwitcher element and shared RunCharts props**

In the render section, before the JSX return, add a variable for the tab switcher UI and the shared props object. Place these immediately before the `return (` statement (around line 423):

```js
  const runChartsProps = {
    livePoints,
    metricsOut: run?.metrics ?? null,
    promSamples,
    isLive: run?.status === 'running',
    messageSize,
    warmupSamples,
    totalSamples,
    warmupStartedAt,
    benchmarkStartedAt,
    workerMemLimitMiB: workerResources?.memory_limit_mib ?? null,
    workerCpuCores: workerResources?.cpu_request_cores ?? null,
    runStartedAt: run?.started_at ?? null,
    expectedMsgSec,
    expectedMBSec,
    expectedConsMsgSec,
    expectedConsMBSec,
  }

  const ActiveRunCharts = chartsTab === 'plotly' ? RunChartsPlotly : RunCharts

  const chartSwitcher = (
    <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
      {['recharts', 'plotly'].map(tab => (
        <button
          key={tab}
          onClick={() => setChartsTab(tab)}
          style={{
            padding: '3px 12px',
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            borderRadius: 4,
            border: '1px solid',
            cursor: 'pointer',
            background: chartsTab === tab ? 'rgba(99,102,241,0.2)' : 'transparent',
            borderColor: chartsTab === tab ? 'rgba(99,102,241,0.6)' : 'rgba(122,131,153,0.3)',
            color: chartsTab === tab ? '#a5b4fc' : 'var(--color-text-muted)',
          }}
        >
          {tab}
        </button>
      ))}
    </div>
  )
```

- [ ] **Step 4: Replace the completed-run RunCharts block**

In the completed-run section, find the `<details>` block with "Raw time series data ▶". Replace:

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

With:

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
              {chartSwitcher}
              <ActiveRunCharts {...runChartsProps} isLive={false} />
            </div>
          </details>
```

- [ ] **Step 5: Replace the live-run RunCharts block**

Find the live-run block:

```jsx
      {/* Live run charts — shown during active run */}
      {run.status !== 'completed' && (
        <RunCharts
          livePoints={livePoints}
          metricsOut={run?.metrics ?? null}
          promSamples={promSamples}
          isLive={run?.status === 'running'}
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
      )}
```

Replace with:

```jsx
      {/* Live run charts — shown during active run */}
      {run.status !== 'completed' && (
        <>
          {chartSwitcher}
          <ActiveRunCharts {...runChartsProps} />
        </>
      )}
```

- [ ] **Step 6: Build and run tests**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s/control-plane/frontend
npm run build 2>&1 | tail -5
npm test 2>&1 | tail -10
```

Expected: build `✓ built in`, all 37 tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/cnelson/sandbox/omb_k8s/aws_private/omb-k8s
git add control-plane/frontend/src/pages/RunDetailPage.jsx
git commit -m "feat: add Recharts/Plotly tab switcher to live run charts"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Covered by |
|-------------|------------|
| Plotly background matches Recharts dark theme | Task 1: `paper_bgcolor: C.bg` |
| hovermode: 'x' on Plotly line charts | Task 1: `hovermode: 'x'` in PercentileCurvePlotly layout |
| hovermode not added to histograms | Task 1: explicitly skipped for HistogramPlotly |
| Nines transform on Recharts percentile curves | Task 2: `ninesX = 100/(100-p)`, `dataKey="ninesX"`, domain `[2, 100001]` |
| Nines transform on Plotly percentile curves | Task 2: `x: data.map(pt => ninesX(pt.percentile))`, `tickvals: [2,10,100,1000,10000,100000]` |
| Tooltip shows original percentile label | Task 2: Recharts `labelFormatter` inverts transform; Plotly `customdata` |
| Guard against p=100 division by zero | Task 2: `Math.min(p, 99.9999)` in both functions |
| Plotly live run charts (all 4 rows) | Task 3: RunChartsPlotly with throughput/latency/broker/worker rows |
| Same props interface as RunCharts | Task 3: identical prop list |
| Reference lines (expected rates, CPU 85%/100%) | Task 3: `hLine()` helper + `shapes` in layouts |
| Warmup ReferenceArea equivalent | Task 3: `warmupRect()` helper |
| Per-pod worker colors | Task 3: `workerPods.map()` with `C.workerColors` |
| Tab switcher "Recharts"/"Plotly" | Task 4: `chartsTab` state + buttons |
| Switcher controls both live and collapsed views | Task 4: `ActiveRunCharts` used in both `run.status !== 'completed'` and `<details>` contexts |
| RunCharts.jsx not modified | ✓ — never touched |
| Build passes after each task | ✓ — `npm run build` step in every task |

**Placeholder scan:** None — all steps contain complete code.

**Type consistency:**
- `runChartsProps` object spreads to `<ActiveRunCharts {...runChartsProps} />` — all 14 props match the `RunChartsPlotly` prop list exactly
- `ActiveRunCharts` is either `RunCharts` or `RunChartsPlotly` — both accept identical props
- `ninesX = p => 100 / (100 - Math.min(p, 99.9999))` defined inline in both `PercentileCurveRecharts` and `PercentileCurvePlotly` — same formula, no shared constant needed since it's 2 call sites
- `trace()` helper returns `{ x, y, type, mode, name, line, hovertemplate, connectgaps }` — all consumed directly by Plotly `data` arrays
