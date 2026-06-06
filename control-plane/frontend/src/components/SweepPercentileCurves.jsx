import { useMemo, useState } from 'react'
import {
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'

const RUN_COLORS = [
  '#6366f1', '#e63946', '#6ee7b7', '#f59e0b', '#818cf8',
  '#f97316', '#34d399', '#fb7185', '#38bdf8', '#a78bfa',
]

const C = {
  grid: '#2a3045',
  axis: '#7a8399',
  text: '#e8edf8',
}

function buildMergedData(runs, quantilesKey) {
  const percentileSet = new Set()
  runs.forEach(r => {
    ;(r[quantilesKey] || []).forEach(pt => percentileSet.add(pt.percentile))
  })
  const percentiles = Array.from(percentileSet).sort((a, b) => a - b)

  const runMaps = {}
  runs.forEach(r => {
    runMaps[r.run_id] = {}
    ;(r[quantilesKey] || []).forEach(pt => {
      runMaps[r.run_id][pt.percentile] = pt.latencyMs
    })
  })

  return percentiles.map(p => {
    const ninesX = 100 / (100 - Math.min(p, 99.9999))
    const point = { percentile: p, ninesX }
    runs.forEach(r => {
      point[`run_${r.run_id}`] = runMaps[r.run_id]?.[p] ?? null
    })
    return point
  })
}

function ninesLabel(v) {
  const p = 100 - 100 / v
  if (p >= 99.999) return 'P99.999'
  if (p >= 99.99)  return 'P99.99'
  if (p >= 99.9)   return 'P99.9'
  if (p >= 99)     return 'P99'
  if (p >= 90)     return 'P90'
  return 'P50'
}

function OverlaidChart({ title, mergedData, runs, visibleRuns, colorMap }) {
  const yMax = useMemo(() => {
    let max = 0
    mergedData.forEach(pt => {
      runs.forEach(r => {
        if (!visibleRuns.has(r.run_id)) return
        const v = pt[`run_${r.run_id}`]
        if (v != null && v > max) max = v
      })
    })
    return max > 0 ? max * 1.1 : 10
  }, [mergedData, runs, visibleRuns])

  return (
    <div>
      <div style={{ fontSize: 12, color: C.text, fontWeight: 500, marginBottom: 6 }}>{title}</div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={mergedData} margin={{ top: 4, right: 16, bottom: 24, left: 10 }}>
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
            label={{ value: 'Percentile', position: 'insideBottom', offset: -14, fill: C.axis, fontSize: 10 }}
          />
          <YAxis
            stroke={C.axis}
            tick={{ fill: C.axis, fontSize: 10 }}
            width={50}
            domain={[0, yMax]}
            label={{ value: 'ms', angle: -90, position: 'insideLeft', fill: C.axis, fontSize: 10 }}
          />
          <Tooltip
            contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: C.text, fontSize: 11 }}
            formatter={(v, name) => {
              if (v == null) return null
              const runId = parseInt(name.replace('run_', ''), 10)
              const run = runs.find(r => r.run_id === runId)
              return [`${v.toFixed(3)} ms`, run?.label || name]
            }}
            labelFormatter={ninesLabel}
          />
          {runs.map(r =>
            visibleRuns.has(r.run_id) ? (
              <Line
                key={r.run_id}
                type="monotone"
                dataKey={`run_${r.run_id}`}
                stroke={colorMap[r.run_id]}
                dot={false}
                strokeWidth={2}
                connectNulls
              />
            ) : null
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function SweepPercentileCurves({ visData }) {
  const { runs } = visData
  const [visibleRuns, setVisibleRuns] = useState(() => new Set(runs.map(r => r.run_id)))

  const colorMap = useMemo(() => {
    const map = {}
    runs.forEach((r, i) => { map[r.run_id] = RUN_COLORS[i % RUN_COLORS.length] })
    return map
  }, [runs])

  const pubMerged = useMemo(() => buildMergedData(runs, 'publish_quantiles'), [runs])
  const e2eMerged = useMemo(() => buildMergedData(runs, 'e2e_quantiles'), [runs])

  const hasData = runs.some(r => r.publish_quantiles?.length)

  if (!hasData) {
    return (
      <div style={{ color: C.axis, fontSize: 13, padding: 16 }}>
        No HDR quantile data available yet — runs may still be in progress or HDR parsing incomplete.
      </div>
    )
  }

  function toggleRun(runId) {
    setVisibleRuns(prev => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="chart-card">
          <OverlaidChart
            title="Publish latency — percentile curves"
            mergedData={pubMerged}
            runs={runs}
            visibleRuns={visibleRuns}
            colorMap={colorMap}
          />
        </div>
        <div className="chart-card">
          <OverlaidChart
            title="E2E latency — percentile curves"
            mergedData={e2eMerged}
            runs={runs}
            visibleRuns={visibleRuns}
            colorMap={colorMap}
          />
        </div>
      </div>

      <div style={{
        minWidth: 160, maxWidth: 220,
        background: '#1e2538', border: '1px solid #2a3045',
        borderRadius: 8, padding: '12px 14px', flexShrink: 0,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.06em', color: C.axis, marginBottom: 10,
        }}>
          Runs
        </div>
        {runs.map(r => (
          <label
            key={r.run_id}
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={visibleRuns.has(r.run_id)}
              onChange={() => toggleRun(r.run_id)}
              style={{ accentColor: colorMap[r.run_id], flexShrink: 0 }}
            />
            <span style={{
              width: 12, height: 12, borderRadius: 2,
              background: colorMap[r.run_id], flexShrink: 0,
            }} />
            <span style={{
              fontSize: 12, color: C.text,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              #{r.run_id}: {r.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
