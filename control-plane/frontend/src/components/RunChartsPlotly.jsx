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

  const hasLatency       = chartPoints.some(p => p.pubP99 != null || p.pubP50 != null)
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

  const xVals = chartPoints.map(p => p.t)
  const promX = promPoints.map(p => p.t)

  const lastT    = chartPoints.length > 0 ? chartPoints[chartPoints.length - 1].t : 0
  const wu       = warmupRect(warmupSamples > 0 && lastT > 0 ? Math.min(warmupSamples, lastT) : null)
  const wuShapes = wu ? [wu] : []

  const workerPods = [...new Set(
    promPoints.flatMap(p => Object.keys(p).filter(k => k.startsWith('workerMem_')).map(k => k.slice('workerMem_'.length)))
  )].sort()

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
                ...(expectedMsgSec > 0 ? [hLine(expectedMsgSec, 'rgba(245,158,11,0.7)')] : []),
                ...(expectedConsMsgSec > 0 && expectedConsMsgSec !== expectedMsgSec ? [hLine(expectedConsMsgSec, 'rgba(74,222,128,0.6)')] : []),
              ],
              annotations: [
                ...(expectedMsgSec > 0 ? [ann(0.98, expectedMsgSec, 'pub target', 'rgba(245,158,11,0.8)')] : []),
                ...(expectedConsMsgSec > 0 && expectedConsMsgSec !== expectedMsgSec ? [ann(0.98, expectedConsMsgSec, 'cons target', 'rgba(74,222,128,0.7)')] : []),
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
                  hLine(85,  'rgba(239,68,68,0.5)'),
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
