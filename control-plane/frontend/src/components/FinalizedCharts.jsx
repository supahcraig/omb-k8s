import React, { useMemo } from 'react'
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import Plotly from 'plotly.js-dist-min'
import createPlotlyComponent from 'react-plotly.js/factory'

const Plot = createPlotlyComponent(Plotly)

// Dark theme palette matching the existing RunCharts color scheme
const C = {
  publish:  '#e63946',
  e2e:      '#6ee7b7',
  grid:     '#2a3045',
  axis:     '#7a8399',
  bg:       '#171c28',
  paper:    '#1e2538',
  text:     '#e8edf8',
}

const PLOTLY_BASE_LAYOUT = {
  paper_bgcolor: C.bg,
  plot_bgcolor:  C.bg,
  font:   { color: C.text, size: 11 },
  margin: { t: 36, r: 16, b: 50, l: 60 },
  xaxis: { gridcolor: C.grid, linecolor: C.grid, tickcolor: C.axis, color: C.axis },
  yaxis: { gridcolor: C.grid, linecolor: C.grid, tickcolor: C.axis, color: C.axis },
  showlegend: false,
}


function fmtMs(v, decimals = 3) {
  if (v == null) return '—'
  return v.toFixed(decimals)
}

// ── Nines Table ─────────────────────────────────────────────────────────────

function NinesTable({ aggregates }) {
  const { publish, endToEnd } = aggregates
  const rows = [
    { label: 'Avg',    pubKey: 'avg',   e2eKey: 'avg'   },
    { label: 'P50',    pubKey: 'p50',   e2eKey: 'p50'   },
    { label: 'P75',    pubKey: 'p75',   e2eKey: 'p75'   },
    { label: 'P95',    pubKey: 'p95',   e2eKey: 'p95'   },
    { label: 'P99',    pubKey: 'p99',   e2eKey: 'p99'   },
    { label: 'P99.9',  pubKey: 'p999',  e2eKey: 'p999'  },
    { label: 'P99.99', pubKey: 'p9999', e2eKey: 'p9999' },
    { label: 'Max',    pubKey: 'max',   e2eKey: 'max'   },
  ]

  function latencyColor(key, value) {
    if (key !== 'p99' || value == null) return undefined
    if (value > 20) return '#ef4444'
    if (value > 10) return '#f59e0b'
    return undefined
  }

  return (
    <table style={{
      width: '100%', borderCollapse: 'collapse',
      fontSize: 13, color: C.text,
    }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${C.grid}` }}>
          <th style={{ textAlign: 'left', padding: '6px 12px', color: C.axis, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Percentile
          </th>
          <th style={{ textAlign: 'right', padding: '6px 12px', color: C.publish, fontWeight: 600 }}>Publish (ms)</th>
          <th style={{ textAlign: 'right', padding: '6px 12px', color: C.e2e,     fontWeight: 600 }}>E2E (ms)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ label, pubKey, e2eKey }) => {
          const pubVal = publish[pubKey]
          const e2eVal = endToEnd[e2eKey]
          return (
            <tr key={label} style={{ borderBottom: `1px solid rgba(42,48,69,0.5)` }}>
              <td style={{ padding: '5px 12px', color: C.axis, fontWeight: pubKey === 'p99' || pubKey === 'p999' ? 600 : 400 }}>
                {label}
              </td>
              <td style={{ padding: '5px 12px', textAlign: 'right', fontWeight: 600, color: latencyColor(pubKey, pubVal) }}>
                {fmtMs(pubVal)}
              </td>
              <td style={{ padding: '5px 12px', textAlign: 'right', fontWeight: 600, color: latencyColor(e2eKey, e2eVal) }}>
                {fmtMs(e2eVal)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── Percentile Curve — Recharts ──────────────────────────────────────────────

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

// ── Percentile Curve — Plotly ────────────────────────────────────────────────

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

// ── Histogram — Recharts ─────────────────────────────────────────────────────

function HistogramRecharts({ data, title, color }) {
  if (!data || data.length === 0) return <div style={{ color: C.axis, fontSize: 12, padding: 8 }}>No data</div>
  // Show every 5th tick label to avoid crowding
  const ticks = data.filter((_, i) => i % 5 === 0).map(b => b.bucketLabel)
  return (
    <div>
      <div style={{ fontSize: 12, color: C.text, marginBottom: 6, fontWeight: 500 }}>{title}</div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 16, bottom: 20, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
          <XAxis
            dataKey="bucketLabel"
            stroke={C.axis}
            tick={{ fill: C.axis, fontSize: 9 }}
            ticks={ticks}
            label={{ value: 'Latency (ms)', position: 'insideBottom', offset: -10, fill: C.axis, fontSize: 10 }}
          />
          <YAxis
            stroke={C.axis}
            tick={{ fill: C.axis, fontSize: 10 }}
            width={45}
            tickFormatter={v => `${v}%`}
          />
          <Tooltip
            contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: C.text, fontSize: 11 }}
            formatter={v => [`${v.toFixed(2)}%`, '% messages']}
            labelFormatter={v => `~${v} ms`}
          />
          <Bar dataKey="percentage" fill={color} opacity={0.8} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Histogram — Plotly ───────────────────────────────────────────────────────

function HistogramPlotly({ data, title, color }) {
  if (!data || data.length === 0) return <div style={{ color: C.axis, fontSize: 12, padding: 8 }}>No data</div>
  const plotData = [{
    x: data.map(b => parseFloat(b.bucketLabel)),
    y: data.map(b => b.percentage),
    type: 'bar',
    marker: { color, opacity: 0.8 },
    hovertemplate: '~%{x:.2f} ms<br>%{y:.2f}%<extra></extra>',
  }]
  const layout = {
    ...PLOTLY_BASE_LAYOUT,
    title: { text: title, font: { color: C.text, size: 12 }, x: 0.05, y: 0.97 },
    height: 250,
    xaxis: {
      ...PLOTLY_BASE_LAYOUT.xaxis,
      title: { text: 'Latency (ms)', font: { size: 10, color: C.axis }, standoff: 8 },
    },
    yaxis: {
      ...PLOTLY_BASE_LAYOUT.yaxis,
      title: { text: '% messages', font: { size: 10, color: C.axis }, standoff: 8 },
      ticksuffix: '%',
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

// ── Library comparison label ─────────────────────────────────────────────────

function LibLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
      color: C.axis, marginBottom: 4, paddingBottom: 4,
      borderBottom: `1px solid ${C.grid}`,
    }}>
      {children}
    </div>
  )
}

// ── Section heading ──────────────────────────────────────────────────────────

function SectionHeading({ children }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
      color: C.axis, marginBottom: 12, marginTop: 20, paddingBottom: 6,
      borderBottom: `1px solid ${C.grid}`,
    }}>
      {children}
    </div>
  )
}

// ── Main export ──────────────────────────────────────────────────────────────

export default function FinalizedCharts({ results }) {
  if (!results) return null
  const { aggregates, percentileCurves, histograms } = results
  const pubCurve = percentileCurves?.publish  || []
  const e2eCurve = percentileCurves?.endToEnd || []
  const pubHist  = histograms?.publish        || []
  const e2eHist  = histograms?.endToEnd       || []

  return (
    <div>
      {/* ── Results summary — nines table ── */}
      <SectionHeading>Results summary</SectionHeading>
      <div className="card" style={{ padding: '0 0 4px' }}>
        <NinesTable aggregates={aggregates} />
      </div>

      {/* ── Latency distribution — percentile curves ── */}
      <SectionHeading>Latency distribution — percentile curves</SectionHeading>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="chart-card">
          <LibLabel>Recharts</LibLabel>
          <PercentileCurveRecharts
            data={pubCurve}
            title="Publish latency percentile curve"
            color={C.publish}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Plotly</LibLabel>
          <PercentileCurvePlotly
            data={pubCurve}
            title="Publish latency percentile curve"
            color={C.publish}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Recharts</LibLabel>
          <PercentileCurveRecharts
            data={e2eCurve}
            title="End-to-end latency percentile curve"
            color={C.e2e}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Plotly</LibLabel>
          <PercentileCurvePlotly
            data={e2eCurve}
            title="End-to-end latency percentile curve"
            color={C.e2e}
          />
        </div>
      </div>

      {/* ── Latency distribution — histograms ── */}
      <SectionHeading>Latency distribution — histograms</SectionHeading>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="chart-card">
          <LibLabel>Recharts</LibLabel>
          <HistogramRecharts
            data={pubHist}
            title="Publish latency histogram"
            color={C.publish}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Plotly</LibLabel>
          <HistogramPlotly
            data={pubHist}
            title="Publish latency histogram"
            color={C.publish}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Recharts</LibLabel>
          <HistogramRecharts
            data={e2eHist}
            title="End-to-end latency histogram"
            color={C.e2e}
          />
        </div>
        <div className="chart-card">
          <LibLabel>Plotly</LibLabel>
          <HistogramPlotly
            data={e2eHist}
            title="End-to-end latency histogram"
            color={C.e2e}
          />
        </div>
      </div>
    </div>
  )
}
