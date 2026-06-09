import { useMemo, useState } from 'react'

const C = {
  axis:   '#7a8399',
  text:   '#e8edf8',
  border: '#2a3045',
  bg:     '#1e2538',
}

const SELECT_STYLE = {
  background: '#1e2538', border: '1px solid #2a3045', borderRadius: 4,
  color: '#e8edf8', padding: '3px 8px', fontSize: 12, cursor: 'pointer',
}

function latencyColor(value, min, max) {
  if (value == null) return '#2e3448'
  if (min === max) return 'hsl(120,60%,35%)'
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)))
  return `hsl(${Math.round(120 * (1 - t))}, 68%, 38%)`
}

function cellTextColor(value, min, max) {
  if (value == null) return C.axis
  if (min === max) return '#fff'
  const t = (value - min) / (max - min)
  // dark text on yellow band, white on green and red ends
  return (t > 0.3 && t < 0.72) ? '#111' : '#fff'
}

function SingleHeatmap({ title, metricKey, runs, xAxis, yAxis, paramAxes }) {
  const xVals = paramAxes[xAxis] || []
  const yVals = paramAxes[yAxis] || []

  const cellMap = useMemo(() => {
    const m = {}
    runs.forEach(r => {
      m[`${String(r.sweep_params[xAxis])}::${String(r.sweep_params[yAxis])}`] = r
    })
    return m
  }, [runs, xAxis, yAxis])

  const { min, max } = useMemo(() => {
    const vals = runs.map(r => r[metricKey]).filter(v => v != null)
    return { min: vals.length ? Math.min(...vals) : 0, max: vals.length ? Math.max(...vals) : 1 }
  }, [runs, metricKey])

  const CELL = 76

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 10 }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ padding: '4px 8px', color: C.axis, fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap' }}>
                {yAxis} ↓ &nbsp;/&nbsp; {xAxis} →
              </th>
              {xVals.map(xv => (
                <th key={String(xv)} style={{
                  padding: '4px 8px', color: C.axis, fontSize: 11,
                  textAlign: 'center', minWidth: CELL,
                }}>
                  {String(xv)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {yVals.map(yv => (
              <tr key={String(yv)}>
                <td style={{ padding: '4px 8px', color: C.axis, fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {String(yv)}
                </td>
                {xVals.map(xv => {
                  const run = cellMap[`${String(xv)}::${String(yv)}`]
                  const value = run ? run[metricKey] : null
                  const bg = latencyColor(value, min, max)
                  const fg = cellTextColor(value, min, max)
                  return (
                    <td key={String(xv)} style={{ padding: 3 }}>
                      <div style={{
                        width: CELL, height: CELL, background: bg, borderRadius: 4,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: fg, fontWeight: 600, fontSize: 12,
                      }}>
                        {value != null ? `${value.toFixed(1)}ms` : '—'}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11, color: C.axis }}>
        <span>{min.toFixed(1)}ms</span>
        <div style={{
          width: 100, height: 8, borderRadius: 4,
          background: 'linear-gradient(to right, hsl(120,68%,38%), hsl(60,68%,42%), hsl(0,68%,38%))',
        }} />
        <span>{max.toFixed(1)}ms</span>
      </div>
    </div>
  )
}

export default function SweepHeatmap({ visData }) {
  const { sweep, runs } = visData
  const paramAxes = sweep.parameter_axes || {}
  const axisKeys = Object.keys(paramAxes)

  const [xAxis, setXAxis] = useState(axisKeys[0] || '')
  const [yAxis, setYAxis] = useState(axisKeys[1] || axisKeys[0] || '')
  const [sliceValues, setSliceValues] = useState(() => {
    const sv = {}
    axisKeys.forEach(k => { sv[k] = paramAxes[k]?.[0] })
    return sv
  })
  const [axisError, setAxisError] = useState(null)

  const filteredRuns = useMemo(() => {
    const sliceKeys = axisKeys.filter(k => k !== xAxis && k !== yAxis)
    return runs.filter(r =>
      sliceKeys.every(k => String(r.sweep_params[k]) === String(sliceValues[k]))
    )
  }, [runs, xAxis, yAxis, sliceValues, axisKeys])

  if (axisKeys.length < 2) {
    return (
      <div style={{ color: C.axis, fontSize: 13, padding: 16 }}>
        Heatmap requires at least 2 parameter axes.
      </div>
    )
  }

  function handleXChange(val) {
    if (val === yAxis) { setAxisError('X and Y axes must be different'); return }
    setAxisError(null)
    setXAxis(val)
  }

  function handleYChange(val) {
    if (val === xAxis) { setAxisError('X and Y axes must be different'); return }
    setAxisError(null)
    setYAxis(val)
  }

  const sliceKeys = axisKeys.filter(k => k !== xAxis && k !== yAxis)

  const HEATMAPS = [
    { title: 'Publish p99 (ms)',   key: 'publish_p99'  },
    { title: 'Publish p99.9 (ms)', key: 'publish_p999' },
    { title: 'E2E p99 (ms)',       key: 'e2e_p99'      },
    { title: 'E2E p99.9 (ms)',     key: 'e2e_p999'     },
  ]

  return (
    <div>
      {/* Controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: C.axis }}>X axis</span>
          <select style={SELECT_STYLE} value={xAxis} onChange={e => handleXChange(e.target.value)}>
            {axisKeys.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: C.axis }}>Y axis</span>
          <select style={SELECT_STYLE} value={yAxis} onChange={e => handleYChange(e.target.value)}>
            {axisKeys.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        {sliceKeys.map(k => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: C.axis }}>{k}</span>
            <select
              style={SELECT_STYLE}
              value={String(sliceValues[k])}
              onChange={e => {
                const raw = e.target.value
                const typed = paramAxes[k]?.find(v => String(v) === raw) ?? raw
                setSliceValues(prev => ({ ...prev, [k]: typed }))
              }}
            >
              {(paramAxes[k] || []).map(v => (
                <option key={String(v)} value={String(v)}>{String(v)}</option>
              ))}
            </select>
          </div>
        ))}
        {axisError && (
          <span style={{ fontSize: 12, color: '#ef4444' }}>{axisError}</span>
        )}
      </div>

      {/* 2×2 grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {HEATMAPS.map(({ title, key }) => (
          <div key={key} className="chart-card">
            <SingleHeatmap
              title={title}
              metricKey={key}
              runs={filteredRuns}
              xAxis={xAxis}
              yAxis={yAxis}
              paramAxes={paramAxes}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
