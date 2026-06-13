import React, { useMemo } from 'react'
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'

// Dark theme palette matching the existing RunCharts color scheme
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

function OmbBadge() {
  return <span className="source-badge source-badge-omb" style={{ marginLeft: 8 }}>omb</span>
}

function ChartHeader({ title }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
      <span style={{ fontSize: 12, color: C.text, fontWeight: 500 }}>{title}</span>
      <OmbBadge />
    </div>
  )
}

function PercentileCurveRecharts({ data, title, color }) {
  if (!data || data.length === 0) return <div style={{ color: C.axis, fontSize: 12, padding: 8 }}>No data</div>
  const ninesX = p => 100 / (100 - Math.min(p, 99.9999))
  const transformed = data.map(pt => ({ ...pt, ninesX: ninesX(pt.percentile) }))
  return (
    <div>
      <ChartHeader title={title} />
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

// ── Histogram — Recharts ─────────────────────────────────────────────────────

function HistogramRecharts({ data, title, color }) {
  if (!data || data.length === 0) return <div style={{ color: C.axis, fontSize: 12, padding: 8 }}>No data</div>
  // Show every 5th tick label to avoid crowding
  const ticks = data.filter((_, i) => i % 5 === 0).map(b => b.bucketLabel)
  return (
    <div>
      <ChartHeader title={title} />
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

      {/* ── Latency distribution — histograms + nines table side by side ── */}
      <SectionHeading>Latency distribution — histograms <OmbBadge /></SectionHeading>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: 12, alignItems: 'stretch' }}>
        <div className="card" style={{ padding: '0 0 4px' }}>
          <NinesTable aggregates={aggregates} />
        </div>
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
